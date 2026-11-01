/**
 * dsh-plugin-future-session — 影子安装器与 fork 委派核心（host 半边）
 *
 * 「现实会话」= 顶层 agent 且 mode=reality：对它可见的每一个工具，在 agent
 * 作用域层注册**同名同 schema 同描述**的影子工具（wire 同形 → 模型与缓存
 * 都无法区分）。影子工具不执行任何实际工作，只触发一次 fork：
 *
 *   FutureSessionRuntime.start()（lib/future.js）
 *   → 直接经核心 Agent 工厂 fork 镜像会话（不经 subagent 体系）
 *   → 现实会话在这一个工具调用里 await（整体停摆，天然串行）
 *   → 未来会话继承现实会话全部已完成轮次前缀（缓存命中），自由使用真工具
 *   → 收口二选一（由未来会话自己决定）：
 *       future_return → 结论成为这次工具调用的返回值（带 [future-session] 标记）
 *       future_promote → 报告登记 + 现实会话收到封存通知
 *
 * 作用域注册不继承给 subagent → 未来会话看到的是全局真工具，不受影子影响。
 * 机制参考 dsh-plugin-context-trim 的 installChannel 模式（agent.ctx.inject
 * 子插件 fiber，dispose 即整代卸载）。
 *
 * @module dsh-plugin-future-session/shadow
 */
import { FUTURE_MARKER, isTopLevelAgent, log, readPersistedSessionEvents, truncate } from './util.js'
import { pendingUserText, turnProgressDigest, mergeDigest } from './future.js'

/** 插件自有工具名：现实会话不遮蔽它们（保持决策工具在两边同形可见）。 */
export const OWN_TOOLS = new Set(['future_return', 'future_promote', 'future_peek', 'future_fetch'])

/**
 * **本地执行工具**：不遮蔽、不委派——输出/状态必须落在现实会话：
 *   - ask_user_question / ask_user_choice：交互卡片必须出现在用户眼前的现实
 *     会话（委派进未来会话 = 用户点不到，现实会话永久停摆，2026-10-11 实测）；
 *   - show_images / present：展示型输出（图片/文件卡）必须渲染在现实会话；
 *   - todo_write / create_goal / get_goal / update_goal / exit_plan_mode：会话级
 *     状态机，属于现实会话本体；
 *   - save_received_images：处理用户附件，属于现实会话。
 */
export const LOCAL_TOOLS = new Set([
  'ask_user_question',
  'ask_user_choice',
  'show_images',
  'present',
  'todo_write',
  'create_goal',
  'get_goal',
  'update_goal',
  'exit_plan_mode',
  'save_received_images'
])

/**
 * 未来会话内**禁用**的工具（child 作用域 restrict）：交互类工具在未来会话里
 * 只会产生一张用户看不到、也无法点击的卡片，把未来会话自己卡死。需要用户
 * 输入时它应当 future_return 说明并交还决策（协议段有此指引）。
 */
export const CHILD_DENIED_TOOLS = ['ask_user_question', 'ask_user_choice']

/**
 * 委派提示词：**最小忠实中继**，不改写、不布道、不扩权。
 * 只含：① 开放轮次的原始用户请求（逐字——seed 不含开放轮次）② 停摆中的
 * 那次工具调用。身份判定与收口规则已在全局协议段（protocol.js）且两边
 * 同形，这里不重复——分叉点之后的任何额外 token 都是对缓存命中的破坏。
 */
export function buildDelegationPrompt(toolName, argsJson, userText = '', progressDigest = '', verbatim = false) {
  const lines = []
  if (typeof userText === 'string' && userText !== '') lines.push(userText, '')
  // 本轮进度（0.4.13）：核心 seed 只能重放已闭合轮次，同一轮内的兄弟结论
  // 若不随行，后续未来会话会对此前成果完全失明、从零重做（会话 fad64828
  // 实录）。这段位于分叉点后、逐 fork 唯一，不额外破坏前缀缓存。
  if (typeof progressDigest === 'string' && progressDigest !== '') {
    lines.push('本轮此前进度（现实会话已获得的结果，直接复用，不要重做）：')
    lines.push(progressDigest, '')
  }
  lines.push('现实会话已在这条工具调用上停摆，请代为执行并按协议收口：')
  lines.push(`工具：${toolName}`)
  lines.push(`参数：${argsJson}`)
  if (verbatim === true) {
    // 原文并入模式（reality-raw）：宿主把本会话的全部调用与结果原样并入现实
    // 会话——摘要没有存在意义，模型只需把活干完、一句话收口。
    lines.push('模式：原文并入——你的全部工具调用与结果会被原样并入现实会话。执行完上述调用后，用一句简短的 future_return 收口即可（无需写详细摘要，也不要调用 future_promote）。')
    return lines.join('\n')
  }
  // 范围约束（0.4.12）：上面附带的用户请求只是背景上下文。0.4.10 把提示词
  // 最小化时连同范围声明一并删掉，叠加全局协议段的「接力完成工作」措辞，
  // 未来会话会自行把整个用户任务做完（2026-10-11 会话 fad64828 实录：一次
  // pwsh 委派跑了 58 步 / 10 分钟 / 1.5MB，从未调用 future_return）。这几行
  // 位于分叉点之后、且随工具名+参数逐 fork 唯一，不额外破坏前缀缓存。
  lines.push('范围：你只需执行上面这一个工具调用——拿到结果后立即调用 future_return 把结果作为结论交还（无法执行时 future_return 说明原因）。用户任务的其余部分仍由现实会话推进，不要越界代做。')
  return lines.join('\n')
}

export class ShadowApplier {
  /**
   * @param {object} ctx - 宿主上下文。
   * @param {object} store - ModeStore。
   * @param {Map} decisions - 未来会话决策登记（tools.js 与本模块共享）。
   * @param {object} runtime - FutureSessionRuntime（lib/future.js）。
   */
  constructor(ctx, store, decisions, runtime) {
    this.ctx = ctx
    this.store = store
    this.decisions = decisions
    this.runtime = runtime
    /** @type {Map<string, {generation:number, channels:object[], tools:string[]}>} */
    this.agentState = new Map()
    this.degraded = false
  }

  /**
   * 对一个 agent 应用影子层（同步编排；注册体经 inject fiber 微任务落地）。
   * 只对「顶层 + mode=reality」生效；其余 agent 直接清理可能的旧代际。
   */
  applyToAgent(agent, cause) {
    if (agent === null || agent === undefined || agent.ctx === undefined || agent.ctx === null || agent.session === undefined) {
      return { applied: false, shadowed: 0 }
    }
    const sessionId = agent.session.id
    const state = this.stateOf(agent.id)
    if (!isTopLevelAgent(agent) || !this.store.isReality(sessionId)) {
      this.disposeGeneration(state)
      return { applied: false, shadowed: 0 }
    }

    if (this.runtime == null || !this.runtime.available()) {
      log(`[diag] 跳过影子安装：核心 Agent 工厂不可用（ctx.agents.create 类型=${typeof this.ctx?.agents?.create}）`)
      this.disposeGeneration(state)
      return { applied: false, shadowed: 0, reason: 'no-provider' }
    }

    // 枚举 agent 视角的工具面（同名同描述同 parameters → wire 同形）。
    let schemas = []
    try {
      schemas = this.ctx.tools.schemas(agent)
    } catch (error) {
      log(`[diag] 枚举工具面失败：${error?.message ?? error}`)
    }

    // 记录本会话可见的完整工具名集合（客户端折叠框按工具名预注册 keyed 视图；
    // 客户端注册是单调的、不能撤销，所以必须用「全集」而不是本次实际遮蔽的子集）。
    const visibleNames = schemas
      .filter((schema) => typeof schema?.name === 'string' && schema.name !== '')
      .map((schema) => schema.name)
      .sort()
    if (visibleNames.length > 0) {
      state.catalog = visibleNames
      this.store.noteShadowCatalog(sessionId, visibleNames)
    }

    // 幂等：先 dispose 上一代，再重建（同层同名重复注册只拿到 no-op disposer）。
    this.disposeGeneration(state)
    state.generation++
    state.tools = []
    state.degraded = []
    state.sessionId = sessionId
    const generation = state.generation
    const self = this

    const targets = schemas.filter((schema) => typeof schema?.name === 'string' && !OWN_TOOLS.has(schema.name) && !LOCAL_TOOLS.has(schema.name))
    if (targets.length === 0) {
      log(`[diag] 工具面为空（schemas=${schemas.length}），无影子可装（${cause}）`)
      return { applied: false, shadowed: 0 }
    }

    this.installChannel(agent.ctx, ['tools'], state.channels, (sctx) => {
      if (state.generation !== generation) return
      let installed = 0
      const failed = []
      const denied = [] // restrict 隐藏成功的名单
      const guarded = [] // 只能 guard 拒执的名单（agent 作用域工具，restrict 不认）
      for (const schema of targets) {
        try {
          sctx.tools.register(self.buildShadow(schema))
          installed++
        } catch (error) {
          // 同名冲突（如核心 agent 作用域层的 subagent 工具）→ 降级为隐藏：
          // 现实会话不应走原生子智能体委派。restrict 只认全局工具名
          // （agent 作用域工具会抛 `names unknown global tool`）→ 再退 0.2.x 的
          // per-agent guard 拒执：模型调用时拿到明确的拒绝理由，而不是静默走
          // 原生委派（2026-10-31 web 宿主实测：subagent 影子 restrict 也失败）。
          const message = error?.message ?? String(error)
          if (message.includes('already registered')) {
            try {
              sctx.tools.restrict({ deny: [schema.name] })
              denied.push(schema.name)
              installed++
            } catch (restrictError) {
              try {
                sctx.tools.guard((exec) => (
                  exec !== null && typeof exec === 'object' && exec?.name === schema.name
                    ? `工具 ${schema.name} 在现实会话中不可直接调用（本会话的工具调用由未来会话代执行，原生委派已禁用）：请改用其他工具推进任务`
                    : undefined
                ))
                guarded.push(schema.name)
                installed++
              } catch (guardError) {
                self.degraded = true
                state.degraded.push(schema.name)
                failed.push(`${schema.name}: register=${message}; restrict=${restrictError?.message ?? restrictError}; guard=${guardError?.message ?? guardError}`)
              }
            }
          } else {
            self.degraded = true
            state.degraded.push(schema.name)
            failed.push(`${schema.name}: ${message}`)
          }
        }
      }
      if (denied.length > 0) log(`影子与 ${denied.map((n) => `"${n}"`).join('、')} 同名冲突，已改为隐藏（restrict）`)
      if (guarded.length > 0) log(`影子与 ${guarded.map((n) => `"${n}"`).join('、')} 同名冲突且 restrict 不可用（agent 作用域工具），已改为 guard 拒执`)
      if (failed.length > 0) log(`[diag] 影子注册失败 ${failed.length}/${targets.length}：\n  ${failed.join('\n  ')}`)
      if (installed > 0) log(`已为现实会话 ${sessionId} 安装 ${installed}/${targets.length} 个影子工具（${cause}，agent=${agent.id}）`)
      if (installed > 0) state.tools = targets.map((schema) => schema.name)
      if (installed === 0) log(`[diag] 全部影子注册失败（${cause}）`)
    })

    return { applied: true, shadowed: targets.length, degraded: [...state.degraded] }
  }

  /** 构造一个影子工具定义：名/schema/描述与原工具一字不差，execute 只委派。 */
  buildShadow(schema) {
    const self = this
    const toolName = schema.name
    return {
      name: toolName,
      description: schema.description,
      parameters: schema.parameters,
      output: {
        schema: {
          type: 'object',
          properties: {
            // 补 'raw'：原文并入（reality-raw）路径返回 mode:'raw'，0.2.1-rc.3 起
            // harness 严格校验 output schema，缺枚举值 → 每次调用必报
            // `"value.mode" must be one of ["return","promote","fallback"]`。
            mode: { type: 'string', enum: ['return', 'promote', 'fallback', 'raw'] },
            summary: { type: 'string' },
            childSessionId: { type: 'string' }
          },
          required: ['mode', 'summary']
        },
        render: (_args, value) => [{ type: 'text', text: String(value?.summary ?? '') }],
        // 客户端折叠框数据面：把未来会话 id 作为**可回放的展示元数据**随工具结果
        // 持久化（ToolOutputDefinition.presentationMeta，只对顶层调用计算）。客户端
        // 工具行从结果块的 meta 里读 childSessionId，即可拉取该未来会话的转录。
        presentationMeta: (_args, value) => ({
          futureSession: {
            childSessionId: typeof value?.childSessionId === 'string' ? value.childSessionId : '',
            mode: typeof value?.mode === 'string' ? value.mode : '',
            toolName
          }
        })
      },
      async execute(args, exec) {
        return self.delegate({ toolName, args, exec })
      }
    }
  }

  /**
   * fork 委派核心：现实会话在这里停摆等待未来会话收口。
   * 未来会话 = 插件自研 FutureSessionRuntime 直接用核心 Agent 工厂 fork 的
   * 镜像会话（不经 subagent 体系，见 lib/future.js）。
   * @returns {{ mode:string, summary:string, childSessionId?:string }} 规范值。
   * @throws 未来会话异常结束时抛错（注册表转为 isError 工具结果）。
   */
  async delegate({ toolName, args, exec }) {
    const parent = exec.agent
    const parentSessionId = parent?.session?.id
    let argsJson
    try {
      argsJson = JSON.stringify(args ?? {})
    } catch {
      argsJson = String(args)
    }
    // 原始用户请求逐字随行（seed 只含已完成轮次，开放轮次的用户消息须补上）。
    let userText = ''
    let progressDigest = ''
    try {
      const events = parent?.session?.snapshotEvents?.() ?? []
      userText = pendingUserText(events)
      progressDigest = turnProgressDigest(events)
    } catch { /* 拿不到就只带工具调用 */ }
    // 原文并入模式（reality-raw）：fork 照常，但收口不走摘要。
    const verbatim = parentSessionId != null && this.store.isRealityRaw(parentSessionId)
    const promptText = buildDelegationPrompt(toolName, argsJson, userText, progressDigest, verbatim)
    if (this.runtime == null || !this.runtime.available()) {
      throw new Error('宿主缺少 ctx.agents.create，无法 fork 未来会话')
    }
    const callId = typeof exec?.callId === 'string' ? exec.callId : ''

    let run
    try {
      run = await this.runtime.start({ parentAgent: parent, promptText, signal: exec.signal, verbatim })
    } catch (error) {
      log(`[diag] fork 未来会话失败（${toolName}，现实会话 ${parentSessionId}）：${error?.message ?? error}\n${error?.stack ?? ''}`)
      throw new Error(`派出未来会话失败（${error?.message ?? error}）`)
    }

    // 先登记再等待。
    const childId = run.id
    if (parentSessionId != null) this.store.registerChild(childId, parentSessionId, toolName)
    if (callId !== '' && parentSessionId != null) this.store.linkCall(callId, parentSessionId, toolName, childId)
    // 工作过程视图（transcriptView）：向父会话落一条与原生 subagent 同形的
    // `subagent/catalog` 事件，客户端就会把该未来会话当作可展开的内联子代理，
    // 其内部过程（仅 end-seed 之后的新增部分，与原生 seeded 子代理同规则）
    // 直接出现在现实会话的工作过程视图里，不必依赖折叠框。
    try {
      parent.session?.append?.('subagent/catalog', {
        version: 0,
        childId: typeof run.agent?.id === 'string' && run.agent.id !== '' ? run.agent.id : childId,
        childCreatedAt: Date.now(),
        mode: 'continuable',
        label: `${toolName} · 未来会话`
      })
    } catch (error) {
      log('[diag] subagent/catalog 落盘失败（工作过程视图不可见，折叠框不受影响）：', error?.message ?? error)
    }
    log(`现实会话 ${parentSessionId} 停摆等待：${toolName} → 未来会话 ${childId}`)

    let outcome
    try {
      outcome = await run.settle()
    } catch (error) {
      // 0.5.3 缺陷 I：settle 自身抛错（whenIdle 异常等）也是收口，补账后重抛——
      // 否则该未来会话的 settledAt 永远 null，客户端永久「运行中」轮询。
      this.store.settleChildIfUnsettled(childId)
      throw error
    } finally {
      try { await run.handle?.dispose?.() } catch { /* dispose 失败不影响结果处理 */ }
    }
    // 0.5.3 缺陷 I：收口补账。settle 返回即未来会话已结束，此后**所有**出口
    // （aborted 抛错 / 原文并入 raw / fallback 空·非空）都必须带上 settledAt，
    // 否则 /transcript 的 running 恒真 → 折叠框永久「运行中」+ 1.2s 无限轮询。
    // return/promote 已由决策工具在子会话内落账，这里 no-op（不覆盖既有决策）。
    this.store.settleChildIfUnsettled(childId)
    if (outcome.aborted) {
      this.decisions.delete(childId)
      throw new Error('未来会话被取消（aborted）')
    }

    // 原文并入模式：无视 future_return 的摘要——把未来会话这段时间里的全部
    // 工具调用与返回值原样塞进主会话（作为本次工具结果）。此模式下
    // future_promote 已在子会话禁用（并入是自动发生的，无需转正工具）。
    if (verbatim) {
      this.decisions.delete(childId)
      let digest = ''
      try {
        const live = run.agent?.session?.snapshotEvents?.()
        if (Array.isArray(live) && live.length > 0) digest = mergeDigest(live, { maxTotal: 200000, maxItem: 20000 })
      } catch { /* 走落盘 */ }
      if (digest === '') {
        try {
          digest = mergeDigest(readPersistedSessionEvents(childId).events, { maxTotal: 200000, maxItem: 20000 })
        } catch { /* 空转录 */ }
      }
      return {
        mode: 'raw',
        summary: `${FUTURE_MARKER} 未来会话（原文并入模式）代执行 ${toolName} 的完整过程：\n${digest === '' ? '（未来会话未产生任何工具调用；结论：' + truncate(outcome.text, 4000) + '）' : digest}`,
        childSessionId: childId
      }
    }

    const decision = this.decisions.get(childId)
    if (decision?.type === 'return') {
      this.decisions.delete(childId)
      const rawHint = this.store.hasRaw(childId)
        ? `（原始输出已保存：需要细节时用 future_fetch(sessionId="${childId}") 直接读取，不要重新执行命令）`
        : ''
      return {
        mode: 'return',
        summary: `${FUTURE_MARKER} 未来会话代执行 ${toolName} 的结论${rawHint}：\n${truncate(decision.payload)}`,
        childSessionId: childId
      }
    }
    if (decision?.type === 'promote') {
      this.decisions.delete(childId)
      // promote = merge（0.5.0）：不再封存现实会话、不需要用户切换——把未来会话
      // 自身的过程（叙述+调用+结果）作为本次工具结果并入现实会话上下文，现实
      // 会话直接基于完整脉络继续推进。同时在现实会话事件流里落一条系统消息，
      // 让用户在主转录里能看到「已并入」这个事实。
      let digest = ''
      try {
        const live = run.agent?.session?.snapshotEvents?.()
        if (Array.isArray(live) && live.length > 0) digest = mergeDigest(live)
      } catch { /* 走落盘 */ }
      if (digest === '') {
        try {
          digest = mergeDigest(readPersistedSessionEvents(childId).events)
        } catch { /* 拿不到就只有 report */ }
      }
      // 0.4.x 曾在现实会话事件流里 append 一条 `system/message` 通告「已并入」；
      // 0.2.1-rc.3 起该类型是 surface-eligible 事件，append 强制要求 surfaceOp
      // 标记（`session event "system/message" is surface-eligible and requires a
      // surfaceOp marker`），且带 surfaceOp:'append' 的 system 消息会进入模型
      // 可见面并与核心的系统提示词系列管理冲突——正确取舍是不再注入模型上下文，
      // 「已并入」事实由三处既有通道承载：本次工具结果文本（模型）、客户端折叠框
      // 「已并入」标签与 foot 说明（用户）、store.children 的 promote 落账（持久）。
      return {
        mode: 'promote',
        summary: `${FUTURE_MARKER} 未来会话调用了 future_promote：其完整过程已并入本会话（你未被封存，直接基于以下脉络继续工作，不要重新获取已有数据）。并入动机：${truncate(decision.payload, 4000)}\n\n——并入的过程脉络——\n${digest === '' ? '（过程转录不可用，只有上述动机报告）' : truncate(digest)}`,
        childSessionId: childId
      }
    }

    // 未显式决策：回退用未来会话最终 assistant 文本。**必须显式标注这是回退**
    // （0.4.12：此前伪装成正常「代执行结论」，而失控的未来会话可能交回的是
    // 整份任务报告而非本次委派工具的结果——现实会话需要知道区别），并截断
    // 防御超长输出。
    const fallbackText = truncate(outcome.text)
    if (fallbackText === '') {
      return { mode: 'fallback', summary: `${FUTURE_MARKER} 未来会话完成，但未产出结论（也未调用 future_return/future_promote）。` }
    }
    return {
      mode: 'fallback',
      summary: `${FUTURE_MARKER} [fallback] 未来会话未调用 future_return，以下是其最终输出（未必是本次 ${toolName} 委派的结果，可能越界执行了更多工作）：\n${fallbackText}`,
      childSessionId: childId
    }
  }

  /** 在 agent 作用域层安装一个注册通道（子插件 fiber，dispose 即卸载）。 */
  installChannel(agentCtx, services, channels, install) {
    if (agentCtx !== null && typeof agentCtx.inject === 'function') {
      try {
        const fiber = agentCtx.inject(services, (sctx) => install(sctx))
        channels.push(fiber)
        return
      } catch (error) {
        this.degraded = true
        log(`通道 ${services.join('+')} 安装失败：`, error?.message ?? error)
        return
      }
    }
    install(agentCtx)
  }

  stateOf(agentId) {
    let state = this.agentState.get(agentId)
    if (state === undefined) {
      state = { generation: 0, channels: [], tools: [], catalog: [], sessionId: '', degraded: [] }
      this.agentState.set(agentId, state)
    }
    return state
  }

  /**
   * 某个会话本轮安装中「影子装不上、隐藏与拒执也失败」的工具名（暴露给
   * /mode 与 /future status：降级工具会绕过委派直接本地执行，需要让用户知道）。
   * @param {string} sessionId
   */
  degradedToolsOf(sessionId) {
    for (const state of this.agentState.values()) {
      if (state.sessionId === sessionId) return [...(state.degraded ?? [])]
    }
    return []
  }

  /**
   * 本插件登记过的影子工具名（去重、稳定序）：客户端据此为这些 wire 工具名
   * 注册 keyed 折叠框视图。
   */
  shadowedTools() {
    const out = new Set()
    for (const state of this.agentState.values()) {
      for (const name of state.tools ?? []) out.add(name)
    }
    return [...out].sort()
  }

  /**
   * 某个会话当前被遮蔽的工具名（供 /tools?sessionId= 用；会话不在线时空数组）。
   * @param {string} sessionId
   */
  shadowedToolsOf(sessionId) {
    for (const state of this.agentState.values()) {
      if (state.sessionId === sessionId) return [...(state.tools ?? [])]
    }
    return []
  }

  disposeGeneration(state) {
    for (const fiber of state.channels) {
      try {
        if (fiber !== null && typeof fiber?.dispose === 'function') fiber.dispose()
      } catch { /* unwind 失败不阻塞其余清理 */ }
    }
    state.channels = []
  }

  /** 插件卸载：清掉所有代际簿记。 */
  disposeAll() {
    for (const state of this.agentState.values()) this.disposeGeneration(state)
    this.agentState.clear()
  }
}
