/**
 * dsh-plugin-future-session — 会话入口（host 半边）
 *
 * 现实/未来会话插件：
 *   - 一段**全局共享**的系统提示词协议段（现实与未来一字不差 → wire 同形，
 *     前缀缓存命中）；
 *   - 三个全局工具 future_return / future_promote / future_peek（同形可见，
 *     只在未来会话内产生效果）；
 *   - `/future on|off|status` 命令按会话切换「现实会话」模式；
 *   - agent/created（含 resume）对「顶层 + mode=reality」安装影子工具层：
 *     任何工具调用都不本地执行，而是 fork 出继承全部上下文的未来会话代劳，
 *     由它自主决定只回结论还是转正。
 *
 * 零运行时依赖：不 import 任何 @deepseek-ai/* 包。
 *
 * @module dsh-plugin-future-session
 */
import { join } from 'node:path'
import { ShadowApplier } from './shadow.js'
import { FutureSessionRuntime, ownEventsOf, summarizeEvents } from './future.js'
import { ModeStore } from './store.js'
import { createToolDefinitions } from './tools.js'
import { PROTOCOL_SECTION } from './protocol.js'
import { dshHome, log, readPersistedSessionEvents } from './util.js'

export const name = 'dsh-plugin-future-session'
/** 需要的宿主端服务：agentLoop（核心 Agent 工厂，fork 未来会话）、tools（影子注册与枚举）、systemPrompt（协议段）、agents（agent/created + 热应用）、sessionQuery（seed 读取 / 保底查看 / 孤儿清理）、commands（/future）、webServer（客户端开关路由）。 */
export const inject = ['agentLoop', 'tools', 'systemPrompt', 'agents', 'sessionQuery', 'commands', 'webServer']

/** HTTP 路由前缀（客户端滑动开关数据面）。 */
export const ROUTE_PREFIX = '/dsh-plugin-future-session'

/** 持久化文件（$DSH_HOME 下，UTF-8 无 BOM，原子写入）。 */
export const STORE_FILE = 'dsh-plugin-future-session.json'

/** 配置归一化。 */
function normalizeConfig(config = {}) {
  return {
    enabled: config?.enabled !== false,
    maxDepth: Number.isSafeInteger(config?.maxDepth) && config.maxDepth >= 1 ? config.maxDepth : 1,
    protocolSection: config?.protocolSection === false ? false : true
  }
}

// summarizeEvents（折叠框 / future_peek 共用的按步摘要器）0.5.3 起住在
// lib/future.js（纯事件处理函数），此处仅导入使用并保持导出不变。

export function apply(ctx, config = {}) {
  const cfg = normalizeConfig(config)
  if (!cfg.enabled) return

  const store = new ModeStore(join(dshHome(), STORE_FILE))
  /** 未来会话决策登记（tools.js 写入，shadow.js 读取）。 */
  const decisions = new Map()
  const runtime = new FutureSessionRuntime(ctx, store, decisions)
  const applier = new ShadowApplier(ctx, store, decisions, runtime)
  const definitions = createToolDefinitions({ store, decisions, ctx })

  // ---- 全局共享协议段（现实与未来同形）----
  if (cfg.protocolSection && ctx.systemPrompt && typeof ctx.systemPrompt.section === 'function') {
    ctx.effect(() => ctx.systemPrompt.section({
      name: 'future-session-protocol',
      order: 910,
      text: PROTOCOL_SECTION
    }), 'dsh-plugin-future-session: protocol section')
  }

  // ---- 三个全局工具（两边同形可见）----
  ctx.effect(() => {
    const disposers = [
      ctx.tools.register(definitions.futureReturn),
      ctx.tools.register(definitions.futurePromote),
      ctx.tools.register(definitions.futurePeek),
      ctx.tools.register(definitions.futureFetch)
    ]
    return () => {
      for (const dispose of disposers) {
        try { dispose() } catch { /* 已卸载 */ }
      }
    }
  }, 'dsh-plugin-future-session: decision tools')

  // ---- agent/created 接线：纯同步编排（异步只发生在影子工具 execute 内）----
  ctx.on('agent/created', (payload) => {
    try {
      applier.applyToAgent(payload?.agent, 'agent-created')
    } catch (error) {
      log('agent/created 应用失败：', error?.message ?? error)
    }
  })

  // ---- /future 命令：按会话切换现实模式 ----
  if (ctx.commands && typeof ctx.commands.register === 'function') {
    ctx.effect(() => ctx.commands.register({
      name: 'future',
      description: '现实/未来会话模式：/future on 开启（本会话工具调用全部由未来会话代执行），/future off 关闭，/future status 查看状态',
      input: { kind: 'text', hint: 'on | off | status' },
      recordInput: true,
      async handler(invocation) {
        const agent = invocation?.agent
        const sessionId = agent?.session?.id
        if (typeof sessionId !== 'string' || sessionId === '') {
          return { kind: 'error', text: '找不到当前会话' }
        }
        const arg = (invocation.rawInput ?? '').trim().toLowerCase()
          if (arg === 'on' || arg === '开启') {
            store.setMode(sessionId, 'reality')
            const result = applier.applyToAgent(agent, 'command-on')
            if (result.reason === 'no-provider') {
              return { kind: 'error', text: '已记录模式，但核心 Agent 工厂（ctx.agentLoop）不可用，影子工具未安装（委派会失败）' }
            }
            const degradedNote = Array.isArray(result.degraded) && result.degraded.length > 0
              ? `⚠ ${result.degraded.length} 个工具降级失败（会绕过委派直接本地执行）：${result.degraded.join('、')}`
              : ''
            return { kind: 'success', text: `本会话已进入现实会话模式（摘要返回）：已遮蔽 ${result.shadowed} 个工具为影子工具。此后任何工具调用都会派出未来会话代劳，主上下文只保留蒸馏结论。${degradedNote}` }
          }
        if (arg === 'raw' || arg === '原文') {
          store.setMode(sessionId, 'reality-raw')
          const result = applier.applyToAgent(agent, 'command-raw')
          if (result.reason === 'no-provider') {
            return { kind: 'error', text: '已记录模式，但核心 Agent 工厂（ctx.agentLoop）不可用，影子工具未安装（委派会失败）' }
          }
          return { kind: 'success', text: `本会话已进入现实会话模式（原文并入）：已遮蔽 ${result.shadowed} 个工具。未来会话的全部工具调用与返回值会原样塞进主会话（不做摘要压缩，也不需要 future_promote）。` }
        }
        if (arg === 'off' || arg === '关闭') {
          store.setMode(sessionId, 'normal')
          applier.applyToAgent(agent, 'command-off')
          return { kind: 'success', text: '本会话已退出现实会话模式，工具恢复本地执行。' }
        }
        const mode = store.getMode(sessionId)
        const children = store.childrenOf(sessionId)
        const degraded = applier.degradedToolsOf?.(sessionId) ?? []
        const modeText = mode === 'reality' ? '现实会话（摘要返回）' : mode === 'reality-raw' ? '现实会话（原文并入）' : '普通会话'
        return {
          kind: 'success',
          text: `当前模式：${modeText}；累计未来会话 ${children.length} 个${children.length > 0 ? `（${children.map((c) => `${c.toolName}→${c.decision ?? '未决策'}`).join('、')}）` : ''}${degraded.length > 0 ? `；⚠ 降级失败工具：${degraded.join('、')}` : ''}。可用：/future on（摘要）· /future raw（原文并入）· /future off`
        }
      }
    }), 'dsh-plugin-future-session: /future command')
  }

  // ---- HTTP 路由：客户端滑动开关数据面（loopback-only，同 context-trim 模式）----
  const json = (res, status, body) => {
    const text = JSON.stringify(body)
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(text)
  }
  const loopbackOnly = (req) => {
    const addr = req.socket?.remoteAddress ?? ''
    if (addr !== '127.0.0.1' && addr !== '::1' && addr !== '::ffff:127.0.0.1') return false
    const host = typeof req.headers?.host === 'string' ? req.headers.host.toLowerCase() : ''
    const port = typeof ctx.webServer?.port === 'number' ? String(ctx.webServer.port) : ''
    if (host === '' || port === '') return false
    return host === `127.0.0.1:${port}` || host === `localhost:${port}`
  }
  const readBody = async (req) => {
    const chunks = []
    let received = 0
    for await (const chunk of req) {
      received += chunk.byteLength
      if (received > 64 * 1024) {
        req.destroy()
        return null
      }
      chunks.push(chunk)
    }
    if (chunks.length === 0) return {}
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      return null
    }
  }

  if (ctx.webServer && typeof ctx.webServer.register === 'function') {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: async (req, res) => {
        try {
          if (!loopbackOnly(req)) {
            json(res, 403, { error: 'loopback-only' })
            return
          }
          const url = new URL(req.url ?? '/', 'http://dsh.internal')
          const path = url.pathname.slice(ROUTE_PREFIX.length).replace(/^\/+/, '')
          const method = (req.method ?? 'GET').toUpperCase()

          // ---- GET /tools[?sessionId=] ----
          // 本插件登记过的影子工具名（按工具名注册 keyed 客户端折叠框）。
          // 客户端注册是单调的、不能撤销，所以这里返回的是「全集」：不带 sessionId
          // 时给所有已知会话的并集，带 sessionId 时优先给该会话的目录。
          if (path === 'tools' && method === 'GET') {
            const sessionId = url.searchParams.get('sessionId') ?? ''
            json(res, 200, {
              sessionId,
              tools: sessionId === '' ? store.allCatalog() : store.catalogFor(sessionId)
            })
            return
          }

          // ---- GET /mode?sessionId= ----
          if (path === 'mode' && method === 'GET') {
            const sessionId = url.searchParams.get('sessionId') ?? ''
            if (sessionId === '') {
              json(res, 400, { error: 'sessionId-required' })
              return
            }
            json(res, 200, {
              sessionId,
              mode: store.getMode(sessionId),
              providerReady: runtime.available(),
              children: store.childrenOf(sessionId).length,
              degraded: applier.degradedToolsOf?.(sessionId) ?? []
            })
            return
          }

          // ---- GET /calls[?sessionId=] ----
          // 客户端折叠框：把「工具调用 id → 未来会话 id」索引交给客户端，工具调用行
          // 据此在行内挂折叠框。（结果块 meta 里也有 childSessionId，这条路由是给
          // 历史会话/降级场景的第二条路。）0.5.2 起允许省略 sessionId：0.2.1 起核心
          // 交给 keyed toolview 的 owner 不带会话身份，客户端只能在**运行期**按
          // callId 全局匹配（callId 由核心铸造、全局唯一）——这是「运行中自动展开
          // 轮询」与 ask 提问卡 GUI 可达的前提。省略时返回全部映射并集（保尾 2000 条）。
          if (path === 'calls' && method === 'GET') {
            const sessionId = url.searchParams.get('sessionId') ?? ''
            if (sessionId === '') {
              json(res, 200, { sessionId: '', calls: store.allCalls() })
              return
            }
            json(res, 200, { sessionId, calls: store.callsOfParent(sessionId) })
            return
          }

          // ---- GET /transcript?sessionId=&limit= ----
          // 未来会话的按步转录（只允许本插件登记过的未来会话，避免越权读任意会话）。
          if (path === 'transcript' && method === 'GET') {
            const sessionId = url.searchParams.get('sessionId') ?? ''
            const limitRaw = Number(url.searchParams.get('limit'))
            const limit = Number.isSafeInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 4000) : 800
            if (sessionId === '') {
              json(res, 400, { error: 'sessionId-required' })
              return
            }
            const child = store.getChild(sessionId)
            if (child === null) {
              json(res, 404, { error: 'unknown-future-session' })
              return
            }
            // 读取顺序：① 活 agent 内存快照（最实时）→ ② 落盘文件（多帧 zstd，
            // 带 payload；sessionQuery 的 FTS 投影没有 data 载荷，只作最后兜底）。
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
                events = await ctx.sessionQuery.listEvents(sessionId)
                if (note === '') note = '仅有元数据投影（负载不可用）'
              } catch (error) {
                json(res, 200, {
                  sessionId,
                  info: child,
                  running: child.settledAt === null,
                  steps: [],
                  note: `读取未来会话失败：${error?.message ?? error}`
                })
                return
              }
            }
            // 去重：seed 继承的前缀是现实会话里用户已看过的内容，折叠框只显示
            // fork 之后新增的部分——从最后一个 `session/end-seed` 继承切割标记
            // 之后开始摘要（0.2.1-rc.3 起轮次切换标记会随 seed 复放，取最后一个
            // 才是真边界，findIndex 会把父会话已完成轮次混进折叠框）。
            events = ownEventsOf(events)
            // 中继提问：未来会话正挂起等用户作答时，把问题带给客户端折叠框渲染。
            const pendingQuestion = runtime.pendingAskOf(sessionId)
            json(res, 200, {
              sessionId,
              info: { ...child, hasRaw: store.hasRaw(sessionId) },
              running: child.settledAt === null,
              steps: summarizeEvents(events, limit),
              ...(pendingQuestion === null ? {} : { pendingQuestion }),
              ...(note === '' ? {} : { note })
            })
            return
          }

          // ---- POST /answer { childSessionId, answers } ----
          // 中继提问的作答回传：客户端折叠框里的选项按钮点击后 POST 到这里，
          // runtime.resolveAsk 唤醒挂起在未来会话工具执行内的 Promise。
          if (path === 'answer' && method === 'POST') {
            const body = await readBody(req)
            if (body === null || typeof body !== 'object') {
              json(res, 400, { error: 'invalid-json' })
              return
            }
            const childSessionId = typeof body.childSessionId === 'string' ? body.childSessionId : ''
            const answers = body.answers !== null && typeof body.answers === 'object' ? body.answers : {}
            if (childSessionId === '') {
              json(res, 400, { error: 'childSessionId-required' })
              return
            }
            const pending = runtime.pendingAskOf(childSessionId)
            if (pending === null) {
              json(res, 404, { error: 'no-pending-question' })
              return
            }
            const ok = runtime.resolveAsk(childSessionId, answers)
            json(res, 200, { ok, childSessionId })
            return
          }

          // ---- PUT /mode { sessionId, mode } ----
          if (path === 'mode' && method === 'PUT') {
            const body = await readBody(req)
            if (body === null || typeof body !== 'object') {
              json(res, 400, { error: 'invalid-json' })
              return
            }
            const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
            const mode = body.mode === 'reality' || body.mode === 'reality-raw' || body.mode === 'normal' ? body.mode : null
            if (sessionId === '' || mode === null) {
              json(res, 400, { error: 'sessionId-and-mode-required' })
              return
            }
            store.setMode(sessionId, mode)
            // 热生效：会话有活 agent 则立即重装/卸载影子层。
            let shadowed = 0
            let applied = false
            let reason = null
            const live = ctx.agents?.get?.(sessionId)
            if (live !== undefined) {
              const result = applier.applyToAgent(live, mode === 'normal' ? 'toggle-off' : 'toggle-on')
              applied = result.applied
              shadowed = result.shadowed
              reason = result.reason ?? null
            }
            json(res, 200, { ok: true, sessionId, mode, applied, shadowed, reason, degraded: applier.degradedToolsOf?.(sessionId) ?? [] })
            return
          }

          json(res, 404, { error: 'not-found', path })
        } catch (error) {
          log('路由处理失败：', error?.message ?? error)
          try {
            json(res, 500, { error: 'internal-error', message: error?.message ?? String(error) })
          } catch { /* 响应头已发出 */ }
        }
      }
    }), 'dsh-plugin-future-session: routes')
  }

  // ---- 启动收尾：未收口补账 + 孤儿会话键清理 + 活 agent 补捞。 ----
  queueMicrotask(() => {
    // 启动补账（0.5.3 缺陷 I 收尾）：宿主启动时不可能存在仍在运行的未来会话
    // （fork 是进程内镜像，随宿主消亡），历史遗留的 settledAt=null 记录
    // （0.5.3 前 fallback/abort 不落账）一次性矫正，客户端不再永久轮询。
    try {
      store.settleAllUnsettled()
    } catch (error) {
      log('[diag] 启动补账失败：', error?.message ?? error)
    }
    // 补捞：宿主可能在插件 apply 之前就已恢复上个会话的 agent（典型时序：
    // 桌面端启动即恢复会话 → agent/created 先于插件监听器注册发出 → 影子层
    // 永远装不上，现实会话静默退化为本地直跑）。对当前所有活 agent 重放
    // applyToAgent：mode=reality 的重装影子，其余的清旧代际（幂等）。
    try {
      const live = ctx.agents?.list?.() ?? []
      for (const agent of Array.isArray(live) ? live : []) {
        try {
          applier.applyToAgent(agent, 'startup-catchup')
        } catch (error) {
          log('startup-catchup 应用失败：', error?.message ?? error)
        }
      }
    } catch (error) {
      log('[diag] 活 agent 枚举失败：', error?.message ?? error)
    }
    Promise.resolve(ctx.sessionQuery.listSessions().catch(() => null)).then((records) => {
      if (Array.isArray(records)) {
        store.pruneSessions(records.map((r) => r?.header?.id ?? r?.id).filter((id) => typeof id === 'string'))
      }
    }).catch(() => {})
  })

  // ---- 卸载清理。 ----
  ctx.effect(() => () => {
    applier.disposeAll()
  }, 'dsh-plugin-future-session: dispose')
}

// 内部构件命名导出（供 selfcheck 冒烟测试；运行时只用上面的 apply）。
export { ModeStore } from './store.js'
export { ShadowApplier, OWN_TOOLS, buildDelegationPrompt } from './shadow.js'
export { FutureSessionRuntime, balancedPrefix, pendingUserText, turnProgressDigest, lastAssistantText, mergeDigest, ownEventsOf, createAskRelays, summarizeEvents, stepsToText } from './future.js'
export { createToolDefinitions } from './tools.js'
export { PROTOCOL_SECTION } from './protocol.js'
