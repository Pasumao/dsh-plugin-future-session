/**
 * dsh-plugin-future-session — 决策与保底工具（host 半边）
 *
 * 三个工具全部**全局注册**：现实会话与未来会话看到同名同 schema 的工具面
 * （wire 同形是前缀缓存命中的前提）。身份不靠提示词宣告，而由工具返回
 * 内容自检：真工具返回原始数据；现实会话的影子工具返回带 [future-session]
 * 标记的结论。
 *
 *   future_return  未来会话收口①：中间过程无用，只回结论（成为现实会话
 *                  那次工具调用的返回值），随后封存。
 *   future_promote 未来会话收口②：过程对后续有用，转正自己为现实会话，
 *                  原现实会话封存。
 *   future_peek    现实会话保底：查看某个未来会话内部发生了什么（尽量别用）。
 *
 * @module dsh-plugin-future-session/tools
 */
import { FUTURE_MARKER, isChildAgent, log, readPersistedSessionEvents } from './util.js'
import { ownEventsOf, stepsToText, summarizeEvents } from './future.js'

/** 文本块快捷构造。 */
const text = (t) => [{ type: 'text', text: String(t) }]

/**
 * 创建三个工具定义（纯数据 + 闭包分派，不直接触碰 ctx 注册表）。
 * @param {object} deps
 * @param {object} deps.store - ModeStore 实例。
 * @param {Map<string, {type:'return'|'promote', payload:string, at:string}>} deps.decisions
 *   未来会话决策登记（childSessionId → 决策）。影子委派核心在 run settle 后
 *   优先读取这里，而不是依赖子会话最后一条 assistant 消息（concludeTurn 后
 *   未必还有机会输出）。
 * @param {object} deps.ctx - 宿主上下文（仅 future_peek 用于活快照/元数据投影兜底）。
 */
export function createToolDefinitions({ store, decisions, ctx }) {
  const isFuture = (exec) => isChildAgent(exec.agent)

  const futureReturn = {
    name: 'future_return',
    description: '未来会话收口：本次委派的中间过程（文件列表、原始输出等）对后续没有直接价值时，把自包含的结论交还现实会话并封存自己。summary 必须精炼、自包含、包含关键数据——它就是现实会话看到的工具返回值。若原始输出含后续可能要逐项核对的结构化数据（端口表、版本清单、凭据位置等），把它放进 raw 参数：现实会话可用 future_fetch 免重执行地取回，避免摘要压掉关键细节。',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: '给现实会话的结论。自包含：现实会话看不到你的任何中间过程。' },
        raw: { type: 'string', description: '可选：本次工具调用的原始输出全文（或关键结构化数据）。会作为附件保存，现实会话可用 future_fetch(childSessionId) 直接读取，不需要重新执行命令。含结构化清单时强烈建议附上。' }
      },
      required: ['summary'],
      additionalProperties: false
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          summary: { type: 'string' }
        },
        required: ['status']
      },
      render: (_args, value) => text(`future_return: ${value?.status ?? 'done'}${value?.summary ? ` — ${value.summary}` : ''}`)
    },
    async execute(args, exec) {
      const summary = typeof args?.summary === 'string' ? args.summary.trim() : ''
      if (summary === '') throw new Error('summary 不能为空：给现实会话一句自包含的结论')
      if (!isFuture(exec)) {
        return { status: 'noop', summary: '你在现实会话：无需收口，你的工具调用本就由未来会话代执行。' }
      }
      const childId = exec.agent.session.id
      const raw = typeof args?.raw === 'string' ? args.raw : ''
      if (raw !== '') {
        try {
          store.attachRaw(childId, raw)
        } catch (error) {
          log(`[diag] raw 附件保存失败（${childId}）：${error?.message ?? error}`)
        }
      }
      decisions.set(childId, { type: 'return', payload: summary, at: new Date().toISOString(), hasRaw: raw !== '' })
      store.settleChild(childId, 'return')
      log(`未来会话 ${childId} 决定只回结论${raw !== '' ? '（附原始输出）' : ''}`)
      exec.concludeTurn()
      return { status: 'recorded', summary, rawAttached: raw !== '' }
    }
  }

  const futurePromote = {
    name: 'future_promote',
    description: '未来会话收口：把本次委派的中间过程**并入**现实会话上下文（现实会话不封存、继续原地推进，无需用户切换会话）。适用于：① 完成委派需要 ≥3 次工具调用、过程含后续要引用的连续脉络；② 摘要装不下后续需要的结构化细节；③ 你需要与用户交互（配合中继的 ask_user_* 工具）。report 给出动机与要点，你的完整过程（叙述+调用+结果）会自动并入现实会话。',
    parameters: {
      type: 'object',
      properties: {
        report: { type: 'string', description: '并入报告：为什么这段过程值得保留（动机）+ 当前状态与要点。完整过程会自动并入，report 不必复述全部细节。' }
      },
      required: ['report'],
      additionalProperties: false
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          report: { type: 'string' }
        },
        required: ['status']
      },
      render: (_args, value) => text(`future_promote: ${value?.status ?? 'done'}`)
    },
    async execute(args, exec) {
      const report = typeof args?.report === 'string' ? args.report.trim() : ''
      if (report === '') throw new Error('report 不能为空：给出并入动机与当前状态')
      if (!isFuture(exec)) {
        return { status: 'noop', report: '你在现实会话：不存在转正，你已经是现实会话。' }
      }
      const childId = exec.agent.session.id
      decisions.set(childId, { type: 'promote', payload: report, at: new Date().toISOString() })
      store.settleChild(childId, 'promote')
      log(`未来会话 ${childId} 决定把过程并入现实会话（promote=merge）`)
      exec.concludeTurn()
      return { status: 'merged', report }
    }
  }

  const futureFetch = {
    name: 'future_fetch',
    description: '取回某个未来会话随 future_return 保存的原始输出附件（raw），不重新执行任何命令。优先用它获取细节（端口→PID 映射、版本清单、配置原文等），只在没有附件时才考虑重新委派执行；future_peek 是最终兜底。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '未来会话的 session id（从之前结论里的 childSessionId / future_fetch 提示取得）' },
        offset: { type: 'number', description: '可选：从 raw 的第几个字符开始读（长输出分段读取），默认 0' },
        limit: { type: 'number', description: '可选：最多读取多少字符，默认 60000' }
      },
      required: ['sessionId'],
      additionalProperties: false
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          found: { type: 'boolean' },
          raw: { type: 'string' }
        },
        required: ['found', 'raw']
      },
      render: (_args, value) => text(value?.found ? `${String(value?.raw ?? '').slice(0, 2000)}` : 'future_fetch: 无附件')
    },
    async execute(args, exec) {
      const sessionId = typeof args?.sessionId === 'string' ? args.sessionId : ''
      if (sessionId === '') throw new Error('sessionId 不能为空')
      const offset = Number.isSafeInteger(args?.offset) && args.offset > 0 ? args.offset : 0
      const limit = Number.isSafeInteger(args?.limit) && args.limit > 0 ? Math.min(args.limit, 200000) : 60000
      // ① 优先读 future_return 存的 raw 附件。
      let raw = store.getRaw(sessionId)
      let source = 'attachment'
      // ② 没有附件：兜底从该子会话落盘转录里抽原始工具结果（仍不重执行命令）。
      //    按最后一个 end-seed 切割（0.2.1-rc.3 起轮次切换标记会随 seed 复放，
      //    findIndex 命中的第一个标记会把父会话历史并进 fetch 结果）。
      if (raw === null) {
        try {
          const { events } = readPersistedSessionEvents(sessionId)
          const own = ownEventsOf(events)
          const parts = []
          for (const event of own) {
            if (event?.type === 'tool/result') {
              const data = event?.data ?? event
              const blocks = data?.message?.content ?? data?.content
              const textValue = Array.isArray(blocks)
                ? blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n').trim()
                : ''
              if (textValue !== '') parts.push(textValue)
            } else if (event?.type === 'assistant/message') {
              const data = event?.data ?? event
              const blocks = data?.content ?? data?.blocks ?? data?.message?.content
              const textValue = Array.isArray(blocks)
                ? blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n').trim()
                : ''
              if (textValue !== '') parts.push(`[assistant] ${textValue}`)
            }
          }
          if (parts.length > 0) { raw = parts.join('\n\n'); source = 'transcript' }
        } catch { /* 读不到就走 not-found */ }
      }
      if (raw === null) {
        return { found: false, raw: `未来会话 ${sessionId} 没有 raw 附件，也没有可读的落盘转录。可以考虑重新委派执行，或用 future_peek 查看过程摘要。` }
      }
      const total = raw.length
      const slice = offset >= total ? '' : raw.slice(offset, offset + limit)
      return {
        found: true,
        raw: `${FUTURE_MARKER} 未来会话 ${sessionId} 的原始输出（来源：${source}，全文 ${total} 字符，本次返回 [${offset}, ${Math.min(offset + limit, total)})）：\n${slice}`
      }
    }
  }

  const futurePeek = {
    name: 'future_peek',
    description: '保底工具：查看某个未来会话（fork 子会话）内部发生了什么，返回按步摘要。尽量别用——正常情况下结论已由未来会话自包含地返回。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '未来会话的 session id（可从之前结论的 childSessionId 字段取得）' },
        limit: { type: 'number', description: '每个工具结果摘要的最大字符数，默认 400' }
      },
      required: ['sessionId'],
      additionalProperties: false
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          found: { type: 'boolean' },
          summary: { type: 'string' }
        },
        required: ['found', 'summary']
      },
      render: (_args, value) => text(value?.summary ?? 'future_peek: 无内容')
    },
    async execute(args, exec) {
      const sessionId = typeof args?.sessionId === 'string' ? args.sessionId : ''
      const limit = Number.isFinite(args?.limit) && args.limit > 0 ? Math.floor(args.limit) : 400
      if (sessionId === '') throw new Error('sessionId 不能为空')
      // ⑤ 登记校验：与 /transcript 的 404 unknown-future-session 对齐（0.5.2 核验
      //    缺陷 H——此前 peek 父会话自身/任意会话照样返回，还称其为「未来会话」）。
      if (store.getChild(sessionId) === null) {
        return {
          found: false,
          summary: `会话 ${sessionId} 不是本插件登记的未来会话（future_peek 只能查看现实会话 fork 出来的未来会话；id 从委派结论的 childSessionId 字段取得）。`
        }
      }
      // ①② 读取管线与 /transcript 同源（0.5.2 核验缺陷 H：peek 是全插件最后一个
      //    仍走 sessionQuery.listEvents 的读取点——那是 FTS 元数据投影，没有 data
      //    载荷，返回的是 `✎ 消息 {"sessionId":…}` 之类的纯元数据垃圾）：
      //    活 agent 内存快照 → 落盘文件（多帧 zstd，带 payload）→ 元数据投影兜底。
      let events = []
      let note = ''
      try {
        const liveAgent = ctx.agents?.get?.(sessionId)
        const live = liveAgent?.session?.snapshotEvents?.()
        if (Array.isArray(live) && live.length > 0) events = live
      } catch { /* 活快照不可用，走落盘 */ }
      if (events.length === 0) {
        const persisted = readPersistedSessionEvents(sessionId)
        if (persisted.events.length > 0) events = persisted.events
        else if (persisted.error && persisted.error !== 'file-not-found') note = `落盘读取：${persisted.error}`
      }
      if (events.length === 0) {
        try {
          events = await ctx.sessionQuery.listEvents(sessionId, { signal: exec.signal })
          if (note === '') note = '仅有元数据投影（负载不可用）'
        } catch (error) {
          return { found: false, summary: `读取未来会话 ${sessionId} 失败：${error?.message ?? error}` }
        }
      }
      if (!Array.isArray(events) || events.length === 0) {
        return {
          found: false,
          summary: `${FUTURE_MARKER} 未来会话 ${sessionId} 尚无可读过程（刚 fork 或转录不可读${note === '' ? '' : `；${note}`}）。`
        }
      }
      // ③ 只摘要子会话自身（最后一个 session/end-seed 之后）：父会话旧轮随 seed
      //    复放进子会话日志，不切割会把现实会话已看过的历史再报一遍。
      const own = ownEventsOf(events)
      // ④ 与 /transcript 共用同一个摘要器（展示卫生规则一致）+ 文本渲染。
      const steps = summarizeEvents(own, limit)
      const body = stepsToText(steps)
      if (body === '') {
        return {
          found: true,
          summary: `${FUTURE_MARKER} 未来会话 ${sessionId} 暂无可摘要内容（${own.length} 个自有事件）${note === '' ? '' : `；${note}`}。`
        }
      }
      return {
        found: true,
        summary: `${FUTURE_MARKER} 未来会话 ${sessionId} 按步摘要（${steps.length} 步 / ${own.length} 事件）${note === '' ? '' : ` ⚠ ${note}`}：\n${body}`
      }
    }
  }

  return { futureReturn, futurePromote, futurePeek, futureFetch }
}
