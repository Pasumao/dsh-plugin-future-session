/**
 * dsh-plugin-future-session — FutureSessionRuntime（host 半边）
 *
 * 自研「未来会话」运行时：**不经过 dsh 原生 subagent 体系**（无 ctx.subagents、
 * 无 subagentCatalog、无 subagent/descriptor），由插件直接用核心 Agent 工厂
 * fork 出镜像会话并在后台执行：
 *
 *   1. 读现实会话事件日志，截取「平衡的已完成轮次前缀」作为 seed；
 *   2. ctx.agents.create({ parentAgent, meta: { cwd, parentSession, isSeeded,
 *      delegationDepth: 1 }, seed, inheritedEventCount, agentOptions, signal })
 *      创建一个插件自持的子 agent（缓存前缀与现实会话一致）；
 *      ⚠ 核心 CreateAgentOptions 的会话身份字段名是 **sessionId**（不是 id）：
 *      传错名字等于没传，id 会被 SessionStore 自增铸成 `session-<n>`，
 *      于是撞上已有会话抛 `session "session-N" already exists`
 *      （并伴随 `agent id "undefined" does not match session id`）。
 *      现改为省略 sessionId，让核心原子铸 id，彻底消除撞车。
 *   3. agent.followup(...) 投递接力提示词（source: plugin:<本插件>）；
 *   4. agent.whenIdle() 等待收口（future_return / future_promote 由全局
 *      决策工具落账到 decisions 映射）。
 *
 * @module dsh-plugin-future-session/future
 */
import { randomUUID } from 'node:crypto'
import { CHILD_DENIED_TOOLS } from './shadow.js'
import { blocksToText, log, readPersistedSessionEvents, truncate } from './util.js'

/** 从事件日志截取平衡的已完成轮次前缀（到最后一个 turn/end 为止，含）。 */
export function balancedPrefix(events) {
  if (!Array.isArray(events) || events.length === 0) return []
  let lastTurnEnd = -1
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.type === 'turn/end') { lastTurnEnd = i; break }
  }
  return lastTurnEnd === -1 ? [] : events.slice(0, lastTurnEnd + 1)
}

/** 从「当前未完成轮次」提取用户请求文本（seed 不含开放轮次，须并入接力提示词）。 */
export function pendingUserText(events) {
  if (!Array.isArray(events)) return ''
  const prefixLen = balancedPrefix(events).length
  const parts = []
  for (const event of events.slice(prefixLen)) {
    if (event?.type !== 'user/message') continue
    const data = event?.data ?? event
    const blocks = data?.content ?? data?.blocks
    const text = blocksToText(blocks)
    if (text !== '') parts.push(text)
  }
  return parts.join('\n')
}

/**
 * 从「当前未完成轮次」提取**进度摘要**：现实会话的叙述文本 + 此前各次工具
 * 调用及其结论（影子工具的结论带 [future-session] 标记，剥掉后入摘要）。
 *
 * 为什么需要它（0.4.13，会话 fad64828 实录）：核心 seed 只能重放已闭合轮次
 * （balancedPrefix 截到最后一个 turn/end），现实会话第一轮工具调用时 seed 为
 * 空，且 pendingUserText 只带用户文本——于是同一轮内第 N 个未来会话对前 N-1
 * 个兄弟的结论**完全失明**，每次都从零重做（实录：后续会话重新撞一遍早被
 * 前一个会话踩过的 WMI 沙箱墙）。把本轮已获得的结论随委派提示词带下去，
 * 未来会话才能"接力"而不是"重启"。这段位于分叉点后、逐 fork 唯一，不额外
 * 破坏前缀缓存。
 *
 * 规则：
 *   - 只有**已有结果**的调用入摘要；末尾悬空的 tool/call（正在停摆等待的那次，
 *     即本次委派自身）丢弃；
 *   - 每条结论截断到 maxItem 字符（防失控报告撑爆提示词），总长截断到
 *     maxTotal（保尾：最近的结论最相关）。
 */
export function turnProgressDigest(events, { maxTotal = 24000, maxItem = 4000 } = {}) {
  if (!Array.isArray(events)) return ''
  const prefixLen = balancedPrefix(events).length
  const entries = [] // { kind:'text'|'call', text?, name?, brief?, result? }
  const openCalls = new Map() // callId → entry（等待结果的调用）
  for (const event of events.slice(prefixLen)) {
    const data = event?.data ?? event
    if (event?.type === 'assistant/message') {
      const blocks = data?.content ?? data?.blocks ?? data?.message?.content
      if (!Array.isArray(blocks)) continue
      const text = blocks
        .filter((b) => b?.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text).join('\n').trim()
      if (text !== '') entries.push({ kind: 'text', text })
    } else if (event?.type === 'tool/call') {
      const name = typeof data?.name === 'string' ? data.name : '?'
      let brief = ''
      try {
        const args = typeof data?.arguments === 'string' ? JSON.parse(data.arguments) : data?.arguments
        if (args && typeof args.description === 'string' && args.description !== '') brief = args.description
      } catch { /* 参数摘要尽力而为 */ }
      const entry = { kind: 'call', name, brief, result: '' }
      entries.push(entry)
      const callId = typeof data?.callId === 'string' ? data.callId : ''
      if (callId !== '') openCalls.set(callId, entry)
    } else if (event?.type === 'tool/result') {
      const blocks = data?.message?.content ?? data?.content
      const text = Array.isArray(blocks)
        ? blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n').trim()
        : ''
      if (text === '') continue
      const callId = typeof data?.message?.toolCallId === 'string'
        ? data.message.toolCallId
        : (typeof data?.source?.callId === 'string' ? data.source.callId : '')
      const entry = callId !== '' ? openCalls.get(callId) : undefined
      if (entry !== undefined) {
        entry.result = text.replace(/^\[future-session\]\s*(\[fallback\]\s*)?/, '')
        openCalls.delete(callId)
      } else {
        // 匹配不到 callId：挂在最近一个还没有结果的调用上（事件序保证成立）。
        for (let i = entries.length - 1; i >= 0; i--) {
          if (entries[i]?.kind === 'call' && entries[i].result === '') { entries[i].result = text; break }
        }
      }
    }
  }
  const lines = []
  for (const entry of entries) {
    if (entry.kind === 'text') {
      lines.push(`叙述：${entry.text}`)
    } else if (entry.result !== '') {
      const label = entry.brief !== '' ? `${entry.name}（${entry.brief}）` : entry.name
      lines.push(`已执行 ${label}，结论：${truncate(entry.result, maxItem)}`)
    }
    // result 为空的 call（悬空/停摆中）丢弃
  }
  const joined = lines.join('\n')
  if (joined.length <= maxTotal) return joined
  return `…[future-session 进度摘要截断，仅保留最近的结论]\n${joined.slice(joined.length - maxTotal)}`
}

/**
 * 从事件日志提取最后一条非空 assistant 文本（回退结论用）。
 * **只取 type === 'text' 的正文块**：assistant 消息可能带 reasoning（思维链）
 * 块，把它混进回退结论等于把子会话思考过程泄漏给现实会话（2026-10-11 会话
 * fad64828 实录：回退结果开头是一整段 CoT）。tool-call 块同样无正文语义，
 * 一并排除。
 */
export function lastAssistantText(events) {
  if (!Array.isArray(events)) return ''
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event?.type !== 'assistant/message') continue
    const data = event?.data ?? event
    const blocks = data?.content ?? data?.blocks ?? data?.message?.content
    if (!Array.isArray(blocks)) continue
    const textBlocks = blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string')
    const text = textBlocks.map((b) => b.text).join('\n').trim()
    if (text !== '') return text
  }
  return ''
}

/**
 * promote=merge 的并入摘要：把未来会话自身（end-seed 之后）的完整过程——
 * 叙述、工具调用、结果——压成一段可并入现实会话上下文的文本。
 *
 * 与 turnProgressDigest 的区别：那个是「现实会话本轮已完成进度」的防失明摘要
 * （防兄弟重做），这个是「未来会话自身过程」的忠实转录（保脉络），额度更大、
 * 保留参数与结果原文。
 *
 * @module dsh-plugin-future-session/future
 */

/**
 * @param {Array} events - 未来会话事件日志（活快照或落盘）。
 * @param {object} [options]
 * @param {number} [options.maxTotal=60000] 总长上限（保尾）。
 * @param {number} [options.maxItem=6000] 单条上限。
 */
export function mergeDigest(events, { maxTotal = 60000, maxItem = 6000 } = {}) {
  if (!Array.isArray(events) || events.length === 0) return ''
  const cut = events.findIndex((e) => e?.type === 'session/end-seed')
  const own = cut === -1 ? events : events.slice(cut + 1)
  const lines = []
  const openCalls = new Map()
  for (const event of own) {
    const data = event?.data ?? event
    if (event?.type === 'assistant/message') {
      const blocks = data?.content ?? data?.blocks ?? data?.message?.content
      if (!Array.isArray(blocks)) continue
      const text = blocks
        .filter((b) => b?.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text).join('\n').trim()
      if (text !== '') lines.push(`【叙述】${text}`)
    } else if (event?.type === 'tool/call') {
      const name = typeof data?.name === 'string' ? data.name : '?'
      let brief = ''
      try {
        const args = typeof data?.arguments === 'string' ? JSON.parse(data.arguments) : data?.arguments
        if (args && typeof args.description === 'string' && args.description !== '') brief = args.description
      } catch { /* 尽力而为 */ }
      const entry = { label: brief !== '' ? `${name}（${brief}）` : name, result: '' }
      const callId = typeof data?.callId === 'string' ? data.callId : ''
      if (callId !== '') openCalls.set(callId, entry)
    } else if (event?.type === 'tool/result') {
      const blocks = data?.message?.content ?? data?.content
      const text = Array.isArray(blocks)
        ? blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n').trim()
        : ''
      if (text === '') continue
      const callId = typeof data?.message?.toolCallId === 'string'
        ? data.message.toolCallId
        : (typeof data?.source?.callId === 'string' ? data.source.callId : '')
      const entry = callId !== '' ? openCalls.get(callId) : undefined
      if (entry !== undefined && entry.result === '') {
        entry.result = text
        lines.push(`【调用 ${entry.label} → 结果】${text}`)
        openCalls.delete(callId)
      } else if (entry !== undefined) {
        // 同一调用的后续结果块：追加。
        entry.result += `\n${text}`
        lines.push(`【调用 ${entry.label} → 结果（续）】${text}`)
      } else {
        lines.push(`【结果】${text}`)
      }
    }
  }
  const out = []
  for (const line of lines) {
    if (typeof line !== 'string') continue
    out.push(line.length > maxItem ? `${line.slice(0, maxItem)}…[单条截断]` : line)
  }
  const joined = out.join('\n\n')
  if (joined.length <= maxTotal) return joined
  return `…[future-session 并入摘要截断，仅保留最近过程]\n${joined.slice(joined.length - maxTotal)}`
}

/**
 * 构造未来会话内的 ask_user_* **中继工具**（child 作用域注册，遮蔽全局真卡）。
 *
 * 0.4.x 之前这些工具在子会话里被直接禁用（卡片用户点不到、fork 自卡死）。
 * 现在改为中继：问题经 runtime.pendingAsks 登记后展示在现实会话的工具行折叠框
 * （客户端轮询 /transcript 拿到 pendingQuestion 渲染按钮，POST /answer 回传），
 * 用户作答后本工具 resolve，未来会话原地拿到答案继续干——交互反映到现实会话，
 * 而不是被禁用。
 *
 * @param {object} runtime - FutureSessionRuntime（pendingAsks 宿主）。
 * @param {string} childSessionId - 未来会话 id（登记键）。
 * @returns {Array<object>} ask_user_question / ask_user_choice 两个中继工具定义。
 */
export function createAskRelays(runtime) {
  const RELAY_DESCRIPTION = '向用户提问（由未来会话中继到现实会话界面，用户在你的折叠框里作答）。questions 数组，每项含 id、question、可选 header/options（label+description）/multi_select。用户的选择会以 {answers: {id: 选中的 label}} 返回。'
  const makeRelay = (name) => ({
    name,
    description: RELAY_DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: true,
      required: ['questions'],
      properties: {
        questions: {
          type: 'array',
          description: '问题列表',
          additionalProperties: true,
          items: {
            type: 'object',
            additionalProperties: true,
            required: ['id', 'question'],
            properties: {
              id: { type: 'string' },
              question: { type: 'string' },
              header: { type: 'string' },
              multi_select: { type: 'boolean' },
              options: {
                type: 'array',
                additionalProperties: true,
                items: {
                  type: 'object',
                  additionalProperties: true,
                  required: ['label'],
                  properties: { label: { type: 'string' }, description: { type: 'string' } }
                }
              }
            }
          }
        }
      }
    },
    async execute(args, exec) {
      const questions = Array.isArray(args?.questions) ? args.questions : []
      if (questions.length === 0) throw new Error('questions 不能为空')
      // 登记键取执行时的真实会话 id（与 /transcript、/answer 路由同源）。
      const childSessionId = exec?.agent?.session?.id
      if (typeof childSessionId !== 'string' || childSessionId === '') {
        throw new Error('找不到未来会话身份，无法中继提问')
      }
      const callId = typeof exec?.callId === 'string' ? exec.callId : ''
      const clean = questions
        .filter((q) => q !== null && typeof q === 'object' && typeof q.id === 'string' && typeof q.question === 'string')
        .map((q) => ({
          id: q.id,
          question: q.question,
          header: typeof q.header === 'string' ? q.header : '',
          multi_select: q.multi_select === true,
          options: Array.isArray(q.options)
            ? q.options
                .filter((o) => o !== null && typeof o === 'object' && typeof o.label === 'string')
                .map((o) => ({ label: o.label, description: typeof o.description === 'string' ? o.description : '' }))
            : []
        }))
      if (clean.length === 0) throw new Error('questions 中没有合法条目（每项需 id 与 question）')
      const answer = await runtime.awaitAsk(childSessionId, callId, clean, exec?.signal)
      return { answers: answer, note: '用户已在现实会话作答（未来会话中继）' }
    }
  })
  return [makeRelay('ask_user_question'), makeRelay('ask_user_choice')]
}

export class FutureSessionRuntime {
  /**
   * @param {object} ctx - 宿主上下文（agentLoop + sessionQuery）。
   * @param {object} store - ModeStore。
   * @param {Map} decisions - 决策登记（tools.js 写入）。
   */
  /**
   * @param {object} ctx - 宿主上下文（agentLoop + sessionQuery）。
   * @param {object} store - ModeStore。
   * @param {Map} decisions - 决策登记（tools.js 写入）。
   */
  constructor(ctx, store, decisions) {
    this.ctx = ctx
    this.store = store
    this.decisions = decisions
    /**
     * 未来会话的中继提问登记：childSessionId →
     * { callId, questions, resolve, reject, signal, onAbort, createdAt }。
     * 客户端经 GET /transcript 读到 pendingQuestion，POST /answer 回传作答；
     * awaitAsk 在未来会话工具执行内挂起，作答/取消时 resolve/reject。
     */
    this.pendingAsks = new Map()
  }

  /**
   * 未来会话中继提问：挂起直到用户作答（resolveAsk）或调用方取消。
   * @returns {Promise<Record<string,string>>} qid → 用户选中的 label。
   */
  awaitAsk(childSessionId, callId, questions, signal) {
    return new Promise((resolve, reject) => {
      // 同一未来会话同时只允许一个问题在等待（旧的直接作废）。
      const prev = this.pendingAsks.get(childSessionId)
      if (prev !== undefined) {
        try { prev.reject(new Error('被同会话的新提问取代')) } catch { /* 已 settle */ }
        this.pendingAsks.delete(childSessionId)
      }
      const onAbort = () => {
        if (!this.pendingAsks.has(childSessionId)) return
        this.pendingAsks.delete(childSessionId)
        reject(new Error('未来会话被取消，提问作废'))
      }
      this.pendingAsks.set(childSessionId, {
        callId,
        questions,
        resolve,
        reject,
        signal,
        onAbort,
        createdAt: new Date().toISOString()
      })
      if (signal?.aborted) onAbort()
      else signal?.addEventListener?.('abort', onAbort, { once: true })
    })
  }

  /** 用户作答（HTTP /answer 路由调用）：{qid → label}。 */
  resolveAsk(childSessionId, answers) {
    const pending = this.pendingAsks.get(childSessionId)
    if (pending === undefined) return false
    this.pendingAsks.delete(childSessionId)
    try { pending.signal?.removeEventListener?.('abort', pending.onAbort) } catch { /* 已清理 */ }
    pending.resolve(answers ?? {})
    log(`未来会话 ${childSessionId} 的中继提问已由用户作答`)
    return true
  }

  /** 当前挂起的中继提问（GET /transcript 附带）。 */
  pendingAskOf(childSessionId) {
    const pending = this.pendingAsks.get(childSessionId)
    if (pending === undefined) return null
    return { callId: pending.callId, questions: pending.questions, createdAt: pending.createdAt }
  }

  /** 核心工厂是否可用。 */
  available() {
    return typeof this.ctx.agents?.create === 'function' || typeof this.ctx.agentLoop?.createAgent === 'function'
  }

  /**
   * fork 一个未来会话并投递接力提示词。
   * @param {object} options
   * @param {object} options.parentAgent - 现实会话 agent（exec.agent）。
   * @param {string} options.promptText - 接力提示词全文。
   * @param {AbortSignal} options.signal - 调用方取消（工具 exec.signal）。
   * @returns {Promise<{id:string, agent:object, handle:object, settle:()=>Promise<{aborted:boolean, text:string}>}>}
   */
  async start({ parentAgent, promptText, signal, verbatim = false }) {
    if (!this.available()) {
      throw new Error('宿主缺少 ctx.agents.create，无法 fork 未来会话')
    }
    const parentId = parentAgent?.session?.id
    const parentHeader = parentAgent?.session?.header ?? {}
    if (typeof parentId !== 'string' || parentId === '') {
      throw new Error('找不到现实会话身份，无法 fork')
    }

    // 1) 截 seed 前缀。优先读活会话的内存快照（与原生 fork 提供方同源、
    //    不需要落盘往返）；拿不到再退回 sessionQuery。
    let seed = []
    try {
      const live = parentAgent.session?.snapshotEvents?.()
      if (Array.isArray(live) && live.length > 0) seed = balancedPrefix(live)
    } catch (error) {
      log(`[diag] 读取现实会话活快照失败：${error?.message ?? error}`)
    }
    if (seed.length === 0) {
      try {
        seed = balancedPrefix(await this.ctx.sessionQuery.listEvents(parentId))
      } catch (error) {
        log(`[diag] 读取现实会话日志失败（将用空 seed fork）：${error?.message ?? error}`)
      }
    }

    // 2) 创建插件自持的子 agent（镜像会话）。
    //    契约要点（以 dsh-agent-loop/lib/index.js 为准）：
    //    - 会话身份字段是 **sessionId**，传 `id` 会被静默忽略 → 核心自增铸 id
    //      → 撞已有会话抛 `session "session-N" already exists`。
    //    - `inheritedEventCount` 是 CreateAgentOptions 的顶层字段（与 meta 同级），
    //      放进 meta 会触发 "seeded session requires an inherited event count"。
    //    - `delegationDepth: 1` 让 isTopLevelAgent 判 false（util.js），
    //      未来会话不会被误装影子层（防递归）。
    const meta = {
      isSeeded: true,
      parentSession: parentId,
      origin: 'subagent',
      delegationDepth: 1
    }
    if (typeof parentHeader.cwd === 'string' && parentHeader.cwd !== '') meta.cwd = parentHeader.cwd
    // **agentPreset 必须透传**：preset registry 经 session projection 读
    // `header.agentPreset` 决定 agent 的工具面与提示词段（dsh-session:1708 写入
    // header，dsh-agent-preset-registry/lib/index.js:51 init 读出）。漏传时未来
    // 会话没有 preset → pwsh/glob/read 等核心工具全部不可见，只剩全局注册的
    // 插件工具（future_* 等），根本无法"代劳执行"（2026-10-11 实弹实测）。
    if (parentHeader.agentPreset !== undefined && parentHeader.agentPreset !== null) {
      meta.agentPreset = parentHeader.agentPreset
    }
    //    - **sessionId 必须由插件自铸**（`session-<uuid>`）：核心 SessionStore 的
    //      自增铸造（`session-<n>`）不感知 UUID 命名的既有会话，且失败的 fork
    //      会把铸出的 `session-N` 留在存储里毒化后续铸造 → 反复抛
    //      `session "session-N" already exists`（2026-10-11 实弹测试实锤）。
    const sessionId = `session-${randomUUID()}`

    // setup（创建窗口内装配，原生 fork 同款，见 dsh-subagent-in-process-driver
    // /lib/index.js:171-179 与 dsh-subagent/lib/index.js:510-562）：
    //   ① preset join —— applyChildComposition 的核心：子 agent 经
    //      agentPresets.composeFrom(childCtx, parentCtx) 加入父的 preset 代际，
    //      preset 的工具面与提示词段才会装配到子 agent。**漏掉它 = 子会话空工具
    //      注册表**（0.4.5 只透传 header.agentPreset 是死数据，实弹实测无效）。
    //      preset join 加入的是父的同一代际 → 子会话提示词段与父**完全一致**，
    //      不破坏前缀缓存。
    //   ② 策略继承：把父会话的 sandbox/permission 覆盖与 approval 钉死以
    //      `source:'delegation'` 事件落到子会话日志（对模型提示词不可见，
    //      不产生 token，不破坏缓存）。
    // 注意：**不做**原生 subagent 的「委派范围声明」systemPrompt.context 注入——
    // 那会改写子会话的系统提示词，与父会话产生分叉，破坏前缀缓存（2026-10-11
    // 用户实测指出，0.4.6 引入、0.4.10 移除）。权限受限的事实由核心策略层
    // 保证，模型不需要被告知。
    const setup = (childCtx, child) => {
      try {
        childCtx.get('agentPresets')?.composeFrom(childCtx, parentAgent.ctx)
      } catch (error) {
        log('[diag] preset join 失败：', error?.message ?? error)
      }
      // 交互类工具改为**中继**：问题登记到 pendingAsks，展示在现实会话的工具行
      // 折叠框里由用户作答（POST /answer 回传），未来会话原地拿到答案继续干。
      // 中继注册失败才退回禁用（旧行为：卡片用户点不到、fork 自卡死）。
      try {
        for (const relay of createAskRelays(this)) {
          childCtx.tools.register(relay)
        }
      } catch (error) {
        log('[diag] ask 中继注册失败，退回禁用：', error?.message ?? error)
        try {
          childCtx.tools?.restrict?.({ deny: [...CHILD_DENIED_TOOLS] })
        } catch (restrictError) {
          log('[diag] 子会话工具禁用失败：', restrictError?.message ?? restrictError)
        }
      }
      // 原文并入模式：future_promote 失去意义（并入由宿主自动完成），
      // 禁用以免模型在两种收口间犹豫。
      if (verbatim === true) {
        try {
          childCtx.tools?.restrict?.({ deny: ['future_promote'] })
        } catch (error) {
          log('[diag] verbatim 模式禁用 future_promote 失败：', error?.message ?? error)
        }
      }
      try {
        const permissionPreset = parentAgent.ctx.get('permissionPresets')?.current?.(parentAgent.session)
        const sandboxMode = parentAgent.ctx.get('sandboxPolicy')?.overrideOf?.(parentAgent.session)
        const approvalPolicy = parentAgent.ctx.get('approval') === undefined ? undefined : 'never'
        if (sandboxMode !== undefined) child.session.append('sandbox/mode', { mode: sandboxMode, source: 'delegation' })
        if (approvalPolicy !== undefined) child.session.append('approval/policy', { policy: approvalPolicy, source: 'delegation' })
        if (permissionPreset === 'auto' || permissionPreset === 'danger-full-access') {
          child.session.append('permission/preset', { preset: permissionPreset })
        }
      } catch (error) {
        log('[diag] 策略继承失败：', error?.message ?? error)
      }
    }

    const request = {
      sessionId,
      parentAgent,
      meta,
      agentOptions: parentAgent.options,
      signal,
      setup
    }
    // seed 必须始终显式传递（空数组也行）：核心 Session 构造器在
    // `header.isSeeded && seed === void 0` 时直接抛
    // "seeded session requires an explicit constructor seed"。
    // 现实会话第一轮工具调用时 balancedPrefix 为空（尚无 turn/end），
    // 之前条件省略 seed 字段导致所有 fork 全部失败。
    request.seed = seed
    request.inheritedEventCount = seed.length

    let handle
    try {
      handle = typeof this.ctx.agents?.create === 'function'
        ? await this.ctx.agents.create(request)
        : await this.ctx.agentLoop.createAgent(this.ctx, request)
    } catch (error) {
      log(`[diag] fork 未来会话失败（父 ${parentId}）。请求字段：${Object.keys(request).join(',')}；meta 字段：${Object.keys(meta).join(',')}；seed=${seed.length} 事件；错误：${error?.message ?? error}\n${error?.stack ?? ''}`)
      throw new Error(`fork 未来会话失败：${error?.message ?? error}`)
    }
    const agent = handle?.agent
    if (agent == null) throw new Error('fork 未来会话失败：工厂未返回 agent')
    const realId = String(agent.id ?? agent.session?.id ?? '')

    // 3) 投递接力提示词（followup：独立一轮，唤醒驱动）。
    //    **必须传完整标识消息**（dsh-llm createUserMessage 同形：id + role +
    //    content + source）：v4 会话校验要求 user/message 落盘事件带
    //    `data.id`/`role`/`source`。裸投 content 块会落盘出无标识消息，
    //    会话文件重读即判 corrupt（"session event at seq N lacks an identified
    //    message"），未来会话转录折叠框全部读不出来（2026-10-11 实弹实测）。
    agent.followup({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: promptText }],
      source: { kind: 'user' }
    })

    // 4) settle：等待收口；返回决策无关的原始结局。
    const settle = async () => {
      let aborted = false
      const onAbort = () => {
        aborted = true
        try { agent.cancel('aborted') } catch { /* 已停 */ }
      }
      if (signal?.aborted) onAbort()
      else signal?.addEventListener?.('abort', onAbort, { once: true })
      try {
        await agent.whenIdle()
      } finally {
        signal?.removeEventListener?.('abort', onAbort)
        // 收口时若还有挂起的中继提问，直接作废（防僵尸卡片）。
        const pending = this.pendingAsks.get(realId)
        if (pending !== undefined) {
          this.pendingAsks.delete(realId)
          try { pending.reject(new Error('未来会话已收口，提问作废')) } catch { /* 已 settle */ }
        }
      }
      let text = ''
      // 回退结论提取：优先活快照与落盘文件（sessionQuery 的 FTS 投影没有
      // 事件 payload，listEvents 提不出 assistant 文本）。
      try {
        const live = agent.session?.snapshotEvents?.()
        if (Array.isArray(live) && live.length > 0) text = lastAssistantText(live)
      } catch { /* 走落盘 */ }
      if (text === '') {
        try {
          text = lastAssistantText(readPersistedSessionEvents(realId).events)
        } catch { /* 读不到就空文本，靠 decisions 映射 */ }
      }
      return { aborted, text }
    }

    return { id: realId, agent, handle, settle }
  }
}
