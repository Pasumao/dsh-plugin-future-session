/**
 * dsh-plugin-future-session 自检：不加载 dsh 宿主，直接验证核心模块。
 * 运行：node scripts/selfcheck.mjs
 *
 * 检查项：
 *  1. 包一致性：package.json / cordis.patch.yml / 关键文件齐全 / 无 BOM
 *  2. ModeStore：模式读写、revision 递增、子会话登记与决策落账、孤儿清理、持久化回环
 *  3. lib/future.js：balancedPrefix / pendingUserText / lastAssistantText 纯函数
 *  4. ShadowApplier：影子工具与原工具同名同描述同参数（wire 同形）、OWN_TOOLS
 *     不遮蔽、非 reality 会话不安装；delegate() 的 return / promote / fallback /
 *     aborted 四路径
 *  5. 决策工具：future_return 在子会话记录决策并 concludeTurn、顶层 noop；
 *     future_peek 走 /transcript 同管线（登记校验 → 活快照 → 切割 → 共用摘要器，
 *     0.5.3 缺陷 H：不再读 sessionQuery 元数据投影）；协议段包含双向身份判定说明
 */

import { readFile, rm, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

import {
  name as PLUGIN_NAME,
  STORE_FILE,
  ModeStore,
  ShadowApplier,
  OWN_TOOLS,
  buildDelegationPrompt,
  FutureSessionRuntime,
  balancedPrefix,
  pendingUserText,
  turnProgressDigest,
  lastAssistantText,
  createToolDefinitions,
  PROTOCOL_SECTION,
  summarizeEvents,
  stepsToText,
  mergeDigest,
  ownEventsOf,
  createAskRelays
} from '../lib/index.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const results = []
let failed = 0
const pass = (msg) => { results.push(`  ✅ ${msg}`); console.log(`  ✅ ${msg}`) }
const fail = (msg) => { results.push(`  ❌ ${msg}`); console.error(`  ❌ ${msg}`); failed++ }

async function test1() {
  console.log('[1/5] 包一致性')
  try {
    const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
    assert.equal(pkg.name, PLUGIN_NAME, 'package.json name 与 lib 导出名一致')
    assert.equal(pkg.main, './lib/index.js', 'main 指向 lib/index.js')
    assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml', '声明 bundle patch')
    assert.equal(pkg.peerDependencies?.['@deepseek-ai/cordis'], '^4.0.1', 'peer 依赖 cordis')
    const patch = await readFile(join(ROOT, 'cordis.patch.yml'), 'utf8')
    assert.ok(patch.includes(`id: ${PLUGIN_NAME}`) && patch.includes(`name: ${PLUGIN_NAME}`), 'cordis.patch.yml id/name = 包名')
    assert.equal(pkg.exports?.['./client'], './lib/client.js', '声明 ./client 导出')
    assert.equal(pkg.dsh?.client?.platform, 'web', '声明 web client 平台')
    const clientSrc = await readFile(join(ROOT, 'lib/client.js'), 'utf8')
    assert.ok(clientSrc.includes(`id: '${PLUGIN_NAME}'`), 'client bundle id = 包名')
    assert.ok(clientSrc.includes("ctx.slots.inject('conversation.input.left'"), 'client 注入 conversation.input.left 插槽')
    assert.ok(/exports\.inject\s*=\s*\['slots'\]/.test(clientSrc), 'client 声明 inject slots')
    assert.ok(!clientSrc.includes('require("fs")') && !clientSrc.includes("require('fs')"), 'client 不 require node 内置模块')
    for (const file of ['lib/index.js', 'lib/shadow.js', 'lib/store.js', 'lib/tools.js', 'lib/protocol.js', 'lib/util.js', 'lib/future.js', 'lib/client.js', 'LICENSE', 'README.md']) {
      await readFile(join(ROOT, file), 'utf8')
    }
    const raw = await readFile(join(ROOT, 'package.json'))
    assert.ok(!(raw.byteLength > 2 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf), 'package.json 无 BOM')
    pass('包结构 / 命名 / 关键文件 / 无 BOM 全部一致')
  } catch (error) {
    fail(`包一致性：${error.message}`)
  }
}

async function test2() {
  console.log('[2/5] ModeStore')
  const dir = await mkdir(join(tmpdir(), `dsh-future-session-${Date.now()}`), { recursive: true })
  const file = join(dir, STORE_FILE)
  try {
    const store = new ModeStore(file)
    assert.equal(store.getMode('s1'), 'normal', '默认 normal')
    assert.equal(store.setMode('s1', 'reality').revision, 1, '首次写入 revision=1')
    assert.equal(store.setMode('s1', 'reality').revision, 2, '再次写入 revision 递增')
    assert.ok(store.isReality('s1'), 'isReality 生效')

    store.registerChild('c1', 's1', 'web_search')
    store.registerChild('c2', 's1', 'pwsh')
    store.settleChild('c1', 'return')
    store.settleChild('c2', 'promote')
    assert.equal(store.childrenOf('s1').length, 2, 'childrenOf 按父会话列出')
    assert.equal(store.getChild('c1').decision, 'return', '决策落账 return')
    assert.equal(store.getChild('c2').decision, 'promote', '决策落账 promote')

    // 0.5.3 缺陷 I：收口补账——未落账出口（fallback/abort）补 settledAt，
    // 已落账的 return/promote 不被覆盖。
    const recC1 = store.settleChildIfUnsettled('c1')
    assert.equal(recC1.decision, 'return', '补账不覆盖既有 return 决策')
    assert.ok(recC1.settledAt !== null, '已落账记录 settledAt 保持')
    store.registerChild('c3', 's1', 'grep')
    const recC3 = store.settleChildIfUnsettled('c3')
    assert.equal(recC3.decision, null, '未落账出口补账 decision=null（fallback 形态）')
    assert.ok(recC3.settledAt !== null, '补账盖上 settledAt（running 恒真修复）')
    assert.equal(store.settleChildIfUnsettled('c-none'), null, '未登记会话补账安全 no-op')

    // 0.5.3 启动补账：宿主重启后不存在仍在运行的子会话，历史遗留 settledAt=null
    // 一次性矫正（0.5.3 前 fallback/abort 遗留不再永久「运行中」轮询）。
    store.registerChild('c4', 's1', 'read')
    assert.equal(store.settleAllUnsettled(), 1, 'settleAllUnsettled 只补未落账的（c4）')
    assert.ok(store.getChild('c4').settledAt !== null, '启动补账盖上 settledAt')
    assert.equal(store.settleAllUnsettled(), 0, '全部已落账时补账数为 0')

    await new Promise((resolve) => setTimeout(resolve, 150))
    const store2 = new ModeStore(file)
    assert.ok(store2.isReality('s1'), '持久化回环：模式保留')
    assert.equal(store2.getChild('c2').toolName, 'pwsh', '持久化回环：子会话登记保留')

    store2.pruneSessions(['s1'])
    assert.equal(store2.childrenOf('s1').length, 4, '父会话存活的子登记不清理（c1/c2/c3/c4）')
    assert.equal(store2.getChild('c3').settledAt !== null, true, '补账 settledAt 持久化回环')
    store2.pruneSessions(['other'])
    assert.equal(store2.childrenOf('s1').length, 0, '父会话消失后子登记被清理')
    pass('模式读写 / 决策落账 / 孤儿清理 / 持久化回环全部通过')
  } catch (error) {
    fail(`ModeStore：${error.message}`)
  } finally {
    try { await rm(dir, { recursive: true, force: true }) } catch { /* Windows 句柄延迟释放 */ }
  }
}

function test3() {
  console.log('[3/5] lib/future.js 纯函数')
  try {
    const events = [
      { type: 'user/message', data: { content: [{ type: 'text', text: '第一个请求' }] } },
      { type: 'turn/end' },
      { type: 'user/message', data: { content: [{ type: 'text', text: '当前请求' }] } },
      { type: 'assistant/message', data: { content: [{ type: 'text', text: '我来调用工具' }] } }
    ]
    assert.equal(balancedPrefix(events).length, 2, 'balancedPrefix 截到最后一个 turn/end（含）')
    assert.equal(balancedPrefix([]).length, 0, '空日志 → 空 seed')
    assert.equal(balancedPrefix([{ type: 'user/message' }]).length, 0, '无完成轮次 → 空 seed')
    assert.equal(pendingUserText(events), '当前请求', 'pendingUserText 提取开放轮次里的用户请求')
    assert.equal(pendingUserText([{ type: 'turn/end' }]), '', '无开放轮次 → 空文本')

    // 0.4.13 回归：本轮进度摘要——同轮兄弟的结论必须传给后续 fork（会话 fad64828 实录：全部从零重做）。
    const openTurn = [
      { type: 'turn/end' },
      { type: 'assistant/message', data: { content: [{ type: 'reasoning', text: '思考不入摘要' }, { type: 'text', text: '我先探测系统。' }] } },
      { type: 'tool/call', data: { callId: 'c1', name: 'pwsh', arguments: '{"command":"dir","description":"列目录"}' } },
      { type: 'tool/result', data: { message: { toolCallId: 'c1', content: [{ type: 'text', text: '[future-session] 未来会话代执行 pwsh 的结论：\nWMI 被沙箱拒绝' }] } } },
      { type: 'tool/call', data: { callId: 'c2', name: 'pwsh', arguments: '{"command":"ipconfig","description":"查网络"}' } } // 悬空：正在停摆的本次委派
    ]
    const digest = turnProgressDigest(openTurn)
    assert.ok(digest.includes('WMI 被沙箱拒绝'), '进度摘要含前一个未来会话的结论')
    assert.ok(digest.includes('我先探测系统。'), '进度摘要含现实会话叙述')
    assert.ok(!digest.includes('[future-session]'), '进度摘要剥离 FUTURE_MARKER')
    assert.ok(!digest.includes('查网络'), '悬空调用（停摆中的本次委派）不入摘要')
    assert.ok(!digest.includes('思考不入摘要'), 'reasoning 不入进度摘要')
    assert.equal(turnProgressDigest([{ type: 'user/message' }]), '', '无完成轮次 → 摘要为空')

    const withAssistant = [
      { type: 'assistant/message', data: { content: [{ type: 'text', text: '早期输出' }] } },
      { type: 'tool/result', data: {} },
      { type: 'assistant/message', data: { content: [{ type: 'text', text: '最终结论' }] } }
    ]
    assert.equal(lastAssistantText(withAssistant), '最终结论', 'lastAssistantText 取最后一条非空 assistant')
    assert.equal(lastAssistantText([{ type: 'user/message' }]), '', '无 assistant → 空文本')

    // 0.4.12 回归：reasoning（思维链）块不得混入回退结论（会话 fad64828 实录）。
    const withReasoning = [
      {
        type: 'assistant/message',
        data: {
          content: [
            { type: 'reasoning', text: '内部思考过程不应泄漏' },
            { type: 'text', text: '正文结论' }
          ]
        }
      }
    ]
    assert.equal(lastAssistantText(withReasoning), '正文结论', 'lastAssistantText 排除 reasoning 块')
    const reasoningOnly = [
      {
        type: 'assistant/message',
        data: { content: [{ type: 'reasoning', text: '只有思考没有正文' }] }
      }
    ]
    assert.equal(lastAssistantText(reasoningOnly), '', '只有 reasoning → 空文本（继续向前找）')
    const withToolCall = [
      {
        type: 'assistant/message',
        data: {
          content: [
            { type: 'tool-call', id: 'c1', name: 'pwsh', arguments: '{}' },
            { type: 'text', text: '带工具调用的正文' }
          ]
        }
      }
    ]
    assert.equal(lastAssistantText(withToolCall), '带工具调用的正文', 'tool-call 块不混入文本')

    const rt = new FutureSessionRuntime({ agentLoop: {} }, null, null)
    assert.equal(rt.available(), false, '工厂缺失时 available()=false')
    const rt2 = new FutureSessionRuntime({ agents: { create: async () => {} } }, null, null)
    assert.equal(rt2.available(), true, 'ctx.agents.create 在位时 available()=true')
    const rt3 = new FutureSessionRuntime({ agentLoop: { createAgent: async () => {} } }, null, null)
    assert.equal(rt3.available(), true, '旧 agentLoop.createAgent 仍是回退路径')
    pass('balancedPrefix / pendingUserText / lastAssistantText / available 全部通过')
  } catch (error) {
    fail(`lib/future.js：${error.message}`)
  }
}

/**
 * 回归：fork 请求的字段契约。
 * 契约事故（v0.3.0 实测）：把会话身份写成 `id` 会被核心静默忽略，id 由
 * SessionStore 自增铸成 `session-<n>`，撞上已有会话即抛
 * `session "session-N" already exists`。这里用 stub 钉死字段名。
 */
async function test3b() {
  console.log('[3b/5] fork 请求字段契约（session id 撞车回归）')
  try {
    const parentAgent = {
      id: 'top-1',
      options: { provider: 'deepseek', model: 'x' },
      session: {
        id: 'top-1',
        header: { cwd: 'D:\\ws', agentPreset: 'default' },
        snapshotEvents: () => ([
          { type: 'user/message', seq: 0, data: { content: [{ type: 'text', text: '早前请求' }] } },
          { type: 'turn/end', seq: 1 },
          { type: 'assistant/message', seq: 2, data: { content: [{ type: 'text', text: '开放轮次' }] } }
        ])
      }
    }
    let request = null
    const ctx = {
      agents: { create: async (options) => { request = options; return { agent: { id: 'child-1', followup: () => {}, whenIdle: async () => {}, cancel: () => {} }, handle: {} } } },
      sessionQuery: { listEvents: async () => [] }
    }
    const rt = new FutureSessionRuntime(ctx, null, null)
    const run = await rt.start({ parentAgent, promptText: '接力', signal: undefined })
    assert.ok(request !== null, 'ctx.agents.create 被调用（主路径）')
    assert.equal(request.id, undefined, '❌ 不得传 id（会被静默忽略）')
    assert.match(request.sessionId, /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'sessionId 由插件自铸 UUID（核心自增铸造会撞车：session-N already exists）')
    assert.equal(Object.hasOwn(request, 'id'), false, 'id 字段不存在')
    assert.equal(request.meta.parentSession, 'top-1', 'meta.parentSession = 现实会话')
    assert.equal(request.meta.delegationDepth, 1, 'meta.delegationDepth = 1（未来会话非顶层 → 不装影子层）')
    assert.equal(request.meta.isSeeded, true, 'meta.isSeeded = true')
    assert.equal(request.meta.cwd, 'D:\\ws', 'meta.cwd 沿用现实会话')
    assert.equal(request.meta.agentPreset, 'default', 'meta.agentPreset 透传（漏传 → 未来会话无 preset，核心工具全缺）')
    assert.equal(request.meta.origin, 'subagent', 'meta.origin = subagent（与原生 fork 同形）')
    assert.equal(typeof request.setup, 'function', 'setup 必须传入（preset join / 委派声明 / 策略继承 三件套，漏掉 = 子会话空工具注册表）')
    // setup 可安全执行（各服务缺失时静默降级，不抛错）
    request.setup({ get: () => undefined }, { session: { append: () => {} } })
    assert.equal(request.parentAgent, parentAgent, 'parentAgent 传入（归属/深度）')
    assert.equal(request.seed.length, 2, 'seed = 平衡已完成轮次前缀（到 turn/end 含）')
    assert.equal(request.inheritedEventCount, 2, 'inheritedEventCount 是顶层字段且等于 seed 长度')
    assert.equal(Object.hasOwn(request, 'inheritedEventCount'), true, 'inheritedEventCount 不放进 meta')
    assert.equal(run.id, 'child-1', '返回真实 child id')

    // 无任何已完成轮次 → 空 seed：仍必须显式下发空数组 seed + inheritedEventCount:0。
    // 核心 Session 构造器校验 `header.isSeeded && seed === void 0` 时抛
    // "seeded session requires an explicit constructor seed"——空数组合法，
    // undefined 不合法。现实会话第一轮工具调用必踩此路径。
    let request2 = null
    const ctx2 = {
      agents: { create: async (options) => { request2 = options; return { agent: { id: 'child-2', followup: () => {}, whenIdle: async () => {}, cancel: () => {} }, handle: {} } } },
      sessionQuery: { listEvents: async () => [] }
    }
    const parentDry = { ...parentAgent, session: { ...parentAgent.session, snapshotEvents: () => [] } }
    await new FutureSessionRuntime(ctx2, null, null).start({ parentAgent: parentDry, promptText: '接力' })
    assert.ok(Array.isArray(request2.seed), '空 seed 时仍下发 seed（空数组）')
    assert.equal(request2.seed.length, 0, '空 seed 是空数组而非 undefined')
    assert.equal(request2.inheritedEventCount, 0, '空 seed 时 inheritedEventCount = 0（顶层）')
    pass('fork 请求字段契约（无 id / 无 sessionId / seed 与 inheritedEventCount 顶层成对）全部通过')
  } catch (error) {
    fail(`fork 请求契约：${error.message}`)
  }
}

/** 伪造 FutureSessionRuntime。 */
function makeFakeRuntime({ text = '回退结论', aborted = false, id = 'child-1' } = {}) {
  return {
    available: () => true,
    startCalls: [],
    async start({ parentAgent, promptText }) {
      this.startCalls.push({ parentAgent, promptText })
      return {
        id,
        agent: { id, session: { id, header: { delegationDepth: 1, parentSession: 'top-1' } } },
        handle: { dispose: async () => {} },
        settle: async () => ({ aborted, text })
      }
    }
  }
}

async function test4() {
  console.log('[4/5] ShadowApplier')
  try {
    const store = new ModeStore(join(tmpdir(), `store-${Date.now()}-${Math.random()}.json`))
    store.setMode('top-1', 'reality')
    const decisions = new Map()
    const runtime = makeFakeRuntime()
    const applier = new ShadowApplier({ tools: { schemas: () => schemas } }, store, decisions, runtime)

    const schemas = [
      { name: 'web_search', description: '搜索网络', parameters: { type: 'object', properties: { queries: { type: 'array' } } } },
      { name: 'pwsh', description: '执行命令', parameters: { type: 'object', properties: { command: { type: 'string' } } } },
      { name: 'future_return', description: 'x', parameters: { type: 'object' } }
    ]
    const registered = []
    const agent = {
      id: 'agent-top-1',
      session: { id: 'top-1', header: {} },
      ctx: null
    }
    const view = { tools: { schemas: () => schemas, register: (d) => registered.push(d) } }
    agent.ctx = { inject: (s, cb) => { cb(view); return { dispose: () => {} } } }

    const result = applier.applyToAgent(agent, 'selfcheck')
    assert.equal(result.shadowed, 2, `遮蔽除 OWN_TOOLS 外的全部工具（期望 2，得到 ${result.shadowed}）`)
    assert.equal(registered.length, 2, '注册经 agent 作用域 fiber 落地')
    const webShadow = registered.find((d) => d.name === 'web_search')
    assert.ok(webShadow, 'web_search 被遮蔽')
    assert.equal(webShadow.description, '搜索网络', '描述与原工具一字不差（wire 同形）')
    assert.deepEqual(webShadow.parameters, schemas[0].parameters, 'parameters 与原工具一致（wire 同形）')
    assert.ok(OWN_TOOLS.has('future_return'), 'OWN_TOOLS 包含决策工具')
    assert.ok(!registered.some((d) => OWN_TOOLS.has(d.name)), '决策工具不被遮蔽')

    // 工厂不可用：不安装。
    const applierNoRt = new ShadowApplier(null, store, decisions, makeFakeRuntime())
    applierNoRt.runtime = { available: () => false }
    assert.equal(applierNoRt.applyToAgent(agent, 'x').reason, 'no-provider', '工厂缺失 → no-provider')

    // 非 reality 顶层：不安装。
    store.setMode('top-2', 'normal')
    const agent2 = {
      id: 'a2',
      session: { id: 'top-2', header: {} },
      ctx: { inject: (s, cb) => { cb(view); return { dispose: () => {} } } }
    }
    assert.equal(applier.applyToAgent(agent2, 'x').applied, false, 'normal 会话不安装影子')

    // ---- delegate 四路径 ----
    const fakeExec = { agent: { session: { id: 'top-1', header: {} }, options: {} }, signal: new AbortController().signal }

    const v1 = await applier.delegate({ toolName: 'pwsh', args: { command: 'dir' }, exec: fakeExec })
    assert.equal(v1.mode, 'fallback', '无决策 → 回退未来会话最终输出')
    assert.ok(v1.summary.includes('[future-session]'), '回退结论带标记')
    assert.equal(runtime.startCalls[0].parentAgent.session.id, 'top-1', 'parentAgent 传递现实会话 agent')
    assert.ok(runtime.startCalls[0].promptText.includes('pwsh'), '接力提示词含工具名')
    assert.ok(buildDelegationPrompt('pwsh', '{"command":"dir"}').includes('pwsh'), 'buildDelegationPrompt 含工具名')
    assert.ok(
      buildDelegationPrompt('pwsh', '{"command":"dir"}').includes('范围'),
      'buildDelegationPrompt 含范围约束（0.4.12：防未来会话越界代做整个任务）'
    )
    // 0.5.3 缺陷 I：fallback 出口必须补落账 settledAt（否则 /transcript running 恒真，
    // 折叠框永久「运行中」+ 1.2s 无限轮询；R6 实弹存证）。
    assert.ok(store.getChild('child-1').settledAt !== null, 'fallback 出口补落账 settledAt（缺陷 I）')
    assert.equal(store.getChild('child-1').decision, null, 'fallback 出口 decision=null')

    // 生产时序：决策工具在子会话内先 store.settleChild 再由 delegate 读 decisions——
    // 这里照工具行为补落账，验证 delegate 的收口补账不覆盖既有决策。
    decisions.set('child-1', { type: 'return', payload: '找到了 X 文件', at: '' })
    store.settleChild('child-1', 'return')
    const v2 = await applier.delegate({ toolName: 'pwsh', args: {}, exec: fakeExec })
    assert.equal(v2.mode, 'return', 'future_return 决策 → return 路径')
    assert.ok(v2.summary.includes('找到了 X 文件'), 'return 路径透传结论')
    assert.ok(store.getChild('child-1').toolName === 'pwsh', '子会话登记包含工具名')
    assert.equal(store.getChild('child-1').decision, 'return', 'return 出口后既有决策不被补账覆盖')

    decisions.set('child-1', { type: 'promote', payload: '完整报告', at: '' })
    store.settleChild('child-1', 'promote')
    const v3 = await applier.delegate({ toolName: 'pwsh', args: {}, exec: fakeExec })
    assert.equal(v3.mode, 'promote', 'future_promote 决策 → promote 路径')
    assert.equal(store.getChild('child-1').decision, 'promote', 'promote 出口后既有决策不被补账覆盖')

    const applierAbort = new ShadowApplier(null, store, new Map(), makeFakeRuntime({ aborted: true, id: 'child-2' }))
    await assert.rejects(
      () => applierAbort.delegate({ toolName: 'pwsh', args: {}, exec: fakeExec }),
      /取消/, 'aborted → 抛错（isError）'
    )
    // 0.5.3 缺陷 I：aborted 抛错之前必须已补账（throw 前落账）。
    assert.ok(store.getChild('child-2').settledAt !== null, 'aborted 出口在 throw 前补落账 settledAt（缺陷 I）')
    pass('影子同形 / OWN_TOOLS 排除 / delegate return·promote·fallback·aborted 四路径（含 settledAt 补账）全部通过')
  } catch (error) {
    fail(`ShadowApplier：${error.message}`)
  }
}

async function test5() {
  console.log('[5/5] 决策工具与协议段')
  try {
    const store = new ModeStore(join(tmpdir(), `store-${Date.now()}-${Math.random()}.json`))
    const decisions = new Map()
    const events = [
      { type: 'tool/call', data: { name: 'web_search', arguments: { queries: ['a'] } } },
      { type: 'tool/result', data: { content: [{ type: 'text', text: '结果…' }] } }
    ]
    const fakeCtx = { sessionQuery: { listEvents: async () => events } }
    const defs = createToolDefinitions({ store, decisions, ctx: fakeCtx })

    // 子会话内 future_return：记录决策 + concludeTurn。
    let concluded = false
    const childExec = {
      agent: { session: { id: 'child-9', header: { delegationDepth: 1, parentSession: 'top-9' } } },
      signal: new AbortController().signal,
      concludeTurn: () => { concluded = true }
    }
    const r1 = await defs.futureReturn.execute({ summary: '结论 A' }, childExec)
    assert.equal(r1.status, 'recorded', '子会话 future_return 记录成功')
    assert.ok(concluded, 'concludeTurn 已调用')
    assert.equal(decisions.get('child-9').payload, '结论 A', '决策登记写入')

    // 顶层 reality：noop。
    const topExec = { agent: { session: { id: 'top-9', header: {} } }, signal: new AbortController().signal, concludeTurn: () => {} }
    const r2 = await defs.futureReturn.execute({ summary: 'B' }, topExec)
    assert.equal(r2.status, 'noop', '现实会话 future_return 无副作用')
    const r3 = await defs.futurePromote.execute({ report: 'R' }, topExec)
    assert.equal(r3.status, 'noop', '现实会话 future_promote 无副作用')

    // 空参数抛错。
    await assert.rejects(() => defs.futureReturn.execute({ summary: '' }, childExec), /summary/, '空 summary 拒绝')

    // future_peek（0.5.3 缺陷 H 回归：与 /transcript 同管线——登记校验 → 活快照 →
    // ownEventsOf 切割 → 共用 summarizeEvents/stepsToText；不再读 sessionQuery
    // 元数据投影，返回内容必须有真实载荷）。
    store.registerChild('child-9', 'top-9', 'pwsh')
    const peekEvents = [
      // seed 继承的父会话旧轮（随 end-seed 复放进子会话日志）——不得出现在摘要里。
      { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'R1-MARKER 父会话旧轮' }] } },
      { type: 'session/end-seed', data: { inherited: true } },
      // 子会话自身事件。
      { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '现实会话停摆，请代为执行' }] } },
      { type: 'tool/call', data: { name: 'web_search', arguments: JSON.stringify({ queries: ['a'] }) } },
      { type: 'tool/result', data: { message: { toolCallId: 't9', content: [{ type: 'text', text: '结果…' }] } } }
    ]
    let listEventsCalled = false
    const peekCtx = {
      agents: { get: (id) => (id === 'child-9' ? { session: { snapshotEvents: () => peekEvents } } : undefined) },
      sessionQuery: { listEvents: async () => { listEventsCalled = true; return [] } }
    }
    const peekDefs = createToolDefinitions({ store, decisions, ctx: peekCtx })
    const r4 = await peekDefs.futurePeek.execute({ sessionId: 'child-9' }, topExec)
    assert.equal(r4.found, true, 'peek 找到已登记的未来会话')
    assert.ok(r4.summary.includes('[future-session]'), 'peek 摘要带标记')
    assert.ok(r4.summary.includes('web_search'), 'peek 摘要含工具名（内容质量断言，防元数据垃圾回归）')
    assert.ok(r4.summary.includes('结果…'), 'peek 摘要含结果文本（真实载荷）')
    assert.ok(r4.summary.includes('▶ 工具调用'), 'peek 摘要为按步渲染文本')
    assert.ok(!r4.summary.includes('R1-MARKER'), 'peek 摘要经 ownEventsOf 切割，父会话旧轮不入（缺陷 H）')
    assert.ok(!r4.summary.includes('"seq"') && !r4.summary.includes('✎ 消息'), 'peek 不再输出 FTS 元数据投影垃圾（缺陷 H）')
    assert.equal(listEventsCalled, false, 'peek 主路径不触达 sessionQuery（活快照命中）')
    // 登记校验：父会话自身 / 任意未登记 id → found:false（与 /transcript 404 对齐）。
    const r5 = await peekDefs.futurePeek.execute({ sessionId: 'top-9' }, topExec)
    assert.equal(r5.found, false, 'peek 父会话自身 → 拒绝（越权防护，与 /transcript 对齐）')
    assert.ok(r5.summary.includes('不是本插件登记的未来会话'), '拒绝说明指向「未登记」')
    const r6 = await peekDefs.futurePeek.execute({ sessionId: 'session-random' }, topExec)
    assert.equal(r6.found, false, 'peek 任意未登记会话 → 拒绝')

    // stepsToText：四类步渲染 + 总量保尾截断（peek 文本面）。
    const peekLines = stepsToText([
      { kind: 'user', text: '委派请求' },
      { kind: 'tool', name: 'pwsh', desc: '列目录', text: '{"command":"dir"}' },
      { kind: 'result', ok: false, text: '炸了' }
    ])
    assert.ok(peekLines.includes('✎ 用户：委派请求'), 'stepsToText 渲染用户步')
    assert.ok(peekLines.includes('▶ 工具调用 pwsh（列目录）'), 'stepsToText 渲染工具步（含描述）')
    assert.ok(peekLines.includes('◀ 结果（失败）：炸了'), 'stepsToText 渲染结果步（含失败标记）')
    const longSteps = Array.from({ length: 200 }, (_, i) => ({ kind: 'assistant', text: `step-${i}-${'x'.repeat(200)}` }))
    const tailKept = stepsToText(longSteps, { maxTotal: 1000 })
    assert.ok(tailKept.startsWith('…[future-session 摘要截断'), 'stepsToText 超限保尾截断')
    assert.ok(tailKept.includes('step-199'), '保尾保留最近步骤')
    assert.ok(!tailKept.includes('step-0-'), '保尾丢弃最早步骤')

    // 协议段：双向判定说明齐备。
    assert.ok(PROTOCOL_SECTION.includes('[future-session]'), '协议段含返回标记说明')
    assert.ok(PROTOCOL_SECTION.includes('future_return') && PROTOCOL_SECTION.includes('future_promote') && PROTOCOL_SECTION.includes('future_peek'), '协议段含三个工具说明')
    assert.ok(PROTOCOL_SECTION.includes('完全相同'), '协议段强调同形')
    pass('决策工具分派 / peek / 协议段校验全部通过')
  } catch (error) {
    fail(`决策工具：${error.message}`)
  }
}

async function test6() {
  console.log('[6/6] 折叠框数据面（callId 映射 / 转录摘要 / 展示元数据）')
  try {
    const store = new ModeStore(join(tmpdir(), `store-${Date.now()}-${Math.random()}.json`))
    store.setMode('top-a', 'reality')
    store.registerChild('child-A', 'top-a', 'pwsh')
    // callId 必须与 registerChild 配套：孤儿 callId 不入索引。
    assert.equal(store.linkCall('call-1', 'top-a', 'pwsh', 'child-A').childSessionId, 'child-A', 'linkCall 记录映射')
    store.registerChild('child-B', 'top-a', 'grep')
    store.linkCall('call-2', 'top-a', 'grep', 'child-B')
    assert.equal(store.childOfCall('call-1'), 'child-A', 'childOfCall 正查')
    const calls = store.callsOfParent('top-a')
    assert.equal(calls.length, 2, 'callsOfParent 返回该父会话的全部映射')
    assert.equal(calls[0].toolName, 'pwsh', '映射携带工具名')
    assert.equal(store.callsOfParent('top-b').length, 0, '其他父会话看不到映射')

    // 未登记的子会话（孤儿 callId）不进索引，并在 prune 时被清掉。
    store.linkCall('call-orphan', 'top-a', 'pwsh', 'child-none')
    assert.equal(store.callsOfParent('top-a').length, 2, '未登记子会话的映射不进索引')
    store.pruneSessions(['top-a', 'child-A', 'child-B'])
    assert.equal(store.calls.size, 2, 'prune 清掉孤儿 callId')

    // 工具目录：只增不减 + 全局并集。
    store.noteShadowCatalog('top-a', ['pwsh', 'read'])
    store.noteShadowCatalog('top-a', ['grep'])
    assert.deepEqual(store.catalogFor('top-a'), ['grep', 'pwsh', 'read'], '目录合并去重并排序')
    assert.deepEqual(store.allCatalog(), ['grep', 'pwsh', 'read'], '全局并集')
    assert.deepEqual(store.catalogFor('top-unknown'), ['grep', 'pwsh', 'read'], '未知会话回退全局目录')

    // 持久化回环（含 calls / catalogs）。
    await store.persistNow()
    const reloaded = new ModeStore(store.filePath)
    assert.equal(reloaded.childOfCall('call-1'), 'child-A', 'callId 映射持久化')
    assert.deepEqual(reloaded.catalogFor('top-a'), ['grep', 'pwsh', 'read'], '工具目录持久化')

    // 转录摘要：只保留人看得懂的骨架。
    const steps = summarizeEvents([
      { type: 'user/message', data: { content: [{ type: 'text', text: '找一下原神启动器' }] } },
      { type: 'tool/call', data: { name: 'glob', arguments: { pattern: '**/launcher.exe' } } },
      { type: 'tool/result', data: { content: [{ type: 'text', text: 'D:\\Genshin Impact\\launcher.exe' }] } },
      { type: 'assistant/message', data: { content: [{ type: 'text', text: '找到 1 个' }] } },
      { type: 'turn/end', data: {} }
    ], 500)
    assert.deepEqual(steps.map((s) => s.kind), ['user', 'tool', 'result', 'assistant'], '只输出 user/tool/result/assistant')
    assert.equal(steps[1].name, 'glob', '工具名带出')
    assert.ok(steps[1].text.includes('launcher.exe'), '参数摘要带出')
    assert.equal(steps[2].ok, true, '成功结果 ok=true')
    const errSteps = summarizeEvents([{ type: 'tool/result', data: { isError: true, content: [] } }], 500)
    assert.equal(errSteps[0].ok, false, '失败结果 ok=false')

    // 影子工具的展示元数据（客户端折叠框靠它拿到 childSessionId）。
    const applier = new ShadowApplier(null, store, new Map(), null)
    const shadow = applier.buildShadow({ name: 'pwsh', description: 'd', parameters: { type: 'object', properties: {} } })
    assert.equal(shadow.name, 'pwsh', '影子工具同名')
    assert.equal(shadow.description, 'd', '影子工具同描述')
    assert.equal(typeof shadow.output.presentationMeta, 'function', '带 presentationMeta（可回放展示元数据）')
    const meta = shadow.output.presentationMeta({}, { mode: 'return', summary: 's', childSessionId: 'child-A' })
    assert.equal(meta.futureSession.childSessionId, 'child-A', '元数据带出 childSessionId')
    assert.equal(meta.futureSession.toolName, 'pwsh', '元数据带出工具名')
    const metaEmpty = shadow.output.presentationMeta({}, { mode: 'fallback', summary: 's' })
    assert.equal(typeof metaEmpty, 'object', '缺少 childSessionId 时仍返回合法 JSON')
    pass('折叠框数据面（callId 映射 / 转录摘要 / 展示元数据）全部通过')
  } catch (error) {
    fail(`折叠框数据面：${error.message}`)
  }
}

async function test7() {
  console.log('[7/7] 0.5.0 新能力：raw 附件 / future_fetch / mergeDigest / ask 中继')
  try {
    const file = join(tmpdir(), `dsh-fs-raw-${Date.now()}-${Math.random()}.json`)
    const store = new ModeStore(file)
    const decisions = new Map()
    const fakeCtx = { sessionQuery: { listEvents: async () => [] } }
    const defs = createToolDefinitions({ store, decisions, ctx: fakeCtx })

    // ---- raw 附件落库 + future_fetch 取回 ----
    const childExec = {
      agent: { session: { id: 'child-r', header: { delegationDepth: 1, parentSession: 'top-r' } } },
      signal: new AbortController().signal,
      concludeTurn: () => {}
    }
    const rawText = 'proto  pid\n445    4\n9993   12588\n'
    await defs.futureReturn.execute({ summary: '端口已枚举', raw: rawText }, childExec)
    assert.equal(store.getRaw('child-r'), rawText, 'future_return 的 raw 附件写入 store')
    assert.equal(decisions.get('child-r').hasRaw, true, '决策登记标注 hasRaw')
    const f1 = await defs.futureFetch.execute({ sessionId: 'child-r' }, childExec)
    assert.equal(f1.found, true, 'future_fetch 命中附件')
    assert.ok(f1.raw.includes('9993') && f1.raw.includes('来源：attachment'), 'fetch 返回原始内容与来源标注')
    const f2 = await defs.futureFetch.execute({ sessionId: 'child-r', offset: 14, limit: 4 }, childExec)
    assert.ok(f2.raw.includes('[14, 18)'), 'fetch 支持分段读取（offset/limit）')
    const f3 = await defs.futureFetch.execute({ sessionId: 'child-none' }, childExec)
    assert.equal(f3.found, false, '无附件且无转录 → not-found 指引')

    // raw 空字符串不写附件。
    await defs.futureReturn.execute({ summary: 's2' }, { ...childExec, agent: { session: { id: 'child-r2', header: { delegationDepth: 1, parentSession: 'top-r' } } } })
    assert.equal(store.hasRaw('child-r2'), false, '无 raw 参数不产生附件')

    // ---- return 路径的 future_fetch 提示（delegate 集成） ----
    const runtime = makeFakeRuntime({ id: 'child-rr' })
    const applier = new ShadowApplier(null, store, new Map(), runtime)
    store.setMode('top-x', 'reality')
    store.registerChild('child-rr', 'top-x', 'pwsh')
    store.attachRaw('child-rr', 'X=1')
    const decisions2 = new Map()
    decisions2.set('child-rr', { type: 'return', payload: '结论 R', at: '' })
    applier.decisions = decisions2
    const fakeExec = { agent: { session: { id: 'top-x', header: {} }, options: {} }, signal: new AbortController().signal }
    const vr = await applier.delegate({ toolName: 'pwsh', args: {}, exec: fakeExec })
    assert.ok(vr.summary.includes('future_fetch(sessionId="child-rr")'), 'return 结论带 future_fetch 取回提示')

    // ---- mergeDigest：只取 end-seed 之后、叙述+调用+结果、截断防御 ----
    const digest = mergeDigest([
      { type: 'user/message', data: { content: [{ type: 'text', text: '旧轮次' }] } },
      { type: 'session/end-seed' },
      { type: 'assistant/message', data: { content: [{ type: 'text', text: '我先查端口' }] } },
      { type: 'tool/call', data: { name: 'pwsh', callId: 'c1', arguments: JSON.stringify({ description: 'netstat' }) } },
      { type: 'tool/result', data: { message: { toolCallId: 'c1', content: [{ type: 'text', text: '445 4' }] } } },
      { type: 'assistant/message', data: { content: [{ type: 'reasoning', text: '思考' }, { type: 'text', text: '完成' }] } }
    ])
    assert.ok(digest.includes('我先查端口') && !digest.includes('旧轮次'), 'digest 只含 fork 之后的内容')
    assert.ok(digest.includes('pwsh（netstat）') && digest.includes('445 4'), 'digest 带调用标签与结果')
    assert.ok(digest.includes('完成') && !digest.includes('思考'), 'digest 的 assistant 只取正文（排除 reasoning）')
    const tiny = mergeDigest([{ type: 'assistant/message', data: { content: [{ type: 'text', text: 'x'.repeat(50) }] } }], { maxTotal: 10 })
    assert.ok(tiny.includes('截断'), 'digest 超限保尾截断')

    // ---- promote=merge 路径：并入摘要 + 不再出现「封存」措辞 ----
    decisions2.set('child-rr', { type: 'promote', payload: '需要保留脉络', at: '' })
    const vp = await applier.delegate({ toolName: 'pwsh', args: {}, exec: fakeExec })
    assert.equal(vp.mode, 'promote', 'promote 决策 → merge 路径')
    assert.ok(vp.summary.includes('并入'), 'promote 返回并入语义')
    assert.ok(!vp.summary.includes('转正为现实会话'), '不再宣称转正/封存式切换')

    // ---- ask 中继：awaitAsk 挂起 / resolveAsk 唤醒 / pendingAskOf 暴露 ----
    const rt = new FutureSessionRuntime(fakeCtx, store, new Map())
    const controller = new AbortController()
    const askPromise = rt.awaitAsk('child-ask', 'call-9', [{ id: 'q1', question: '选哪个？', options: [{ label: 'A' }, { label: 'B' }] }], controller.signal)
    const pending = rt.pendingAskOf('child-ask')
    assert.ok(pending !== null && pending.questions[0].id === 'q1', 'pendingAskOf 暴露挂起问题')
    let resolved = null
    askPromise.then((a) => { resolved = a })
    assert.equal(rt.resolveAsk('child-ask', { q1: 'A' }), true, 'resolveAsk 唤醒成功')
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.deepEqual(resolved, { q1: 'A' }, '中继答案按 qid→label 回传')
    assert.equal(rt.resolveAsk('child-ask', {}), false, '重复作答返回 false')
    assert.equal(rt.pendingAskOf('child-ask'), null, '作答后无挂起')

    // 取消路径。
    const controller2 = new AbortController()
    const ask2 = rt.awaitAsk('child-ask2', 'call-10', [{ id: 'q', question: '?' }], controller2.signal)
    controller2.abort()
    await assert.rejects(() => ask2, /取消/, 'signal 取消 → 提问作废')

    // 中继工具本体。
    const relays = createAskRelays(rt)
    assert.equal(relays.length, 2, '生成 question/choice 两个中继')
    assert.deepEqual(relays.map((r) => r.name).sort(), ['ask_user_choice', 'ask_user_question'], '中继工具同名遮蔽')
    const relayExec = { agent: { session: { id: 'child-ask3' } }, signal: new AbortController().signal, callId: 'call-11' }
    const relayRun = relays[0].execute({ questions: [{ id: 'q1', question: '继续吗', options: [{ label: '是' }] }] }, relayExec)
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.ok(rt.pendingAskOf('child-ask3') !== null, '中继 execute 挂起并登记')
    rt.resolveAsk('child-ask3', { q1: '是' })
    const relayOut = await relayRun
    assert.deepEqual(relayOut.answers, { q1: '是' }, '中继返回用户作答')

    // ---- 协议段新内容 ----
    assert.ok(PROTOCOL_SECTION.includes('future_fetch'), '协议段含 future_fetch 指引')
    assert.ok(PROTOCOL_SECTION.includes('raw'), '协议段含 raw 附件指引')
    assert.ok(PROTOCOL_SECTION.includes('豁免'), '协议段含原生 subagent 豁免')
    assert.ok(PROTOCOL_SECTION.includes('中继'), '协议段含交互中继说明')
    assert.ok(PROTOCOL_SECTION.includes('并入'), '协议段含 promote=merge 语义')
    assert.ok(OWN_TOOLS.has('future_fetch'), 'OWN_TOOLS 排除 future_fetch 不被遮蔽')

    // raw 附件持久化回环。
    await store.persistNow()
    const reloaded = new ModeStore(file)
    assert.equal(reloaded.getRaw('child-r'), rawText, 'raw 附件持久化回环')

    // ---- 客户端：AskRelayCard 渲染存在性（不挂宿主，仅静态检查） ----
    const clientSrc = await readFile(join(ROOT, 'lib/client.js'), 'utf8')
    assert.ok(clientSrc.includes('AskRelayCard') && clientSrc.includes('/answer'), '客户端渲染提问卡并回传 /answer')
    assert.ok(clientSrc.includes('已并入'), '客户端 promote 文案改为并入')
    pass('raw 附件 / future_fetch / mergeDigest / ask 中继 / 协议段 / 客户端接线全部通过')
  } catch (error) {
    fail(`0.5.0 新能力：${error.message}`)
  }
}

async function test8() {
  console.log('[8/8] 0.5.1 新能力：原文并入模式 / 工作过程视图挂钩 / 配置回滚')
  try {
    const store = new ModeStore(join(tmpdir(), `dsh-fs-raw8-${Date.now()}-${Math.random()}.json`))
    // ---- reality-raw 模式三态 ----
    assert.equal(store.getMode('top-v'), 'normal', '默认 normal')
    store.setMode('top-v', 'reality-raw')
    assert.ok(store.isReality('top-v'), 'reality-raw 计入 isReality（影子照装）')
    assert.ok(store.isRealityRaw('top-v'), 'isRealityRaw 生效')
    assert.equal(store.isRealityRaw('top-w'), false, '普通 reality 不是 raw')
    assert.equal(store.setMode('top-v', 'bogus'), null, '非法模式拒绝')

    // ---- 委派提示词 verbatim 分支 ----
    const pRaw = buildDelegationPrompt('pwsh', '{}', '', '', true)
    const pSum = buildDelegationPrompt('pwsh', '{}', '', '', false)
    assert.ok(pRaw.includes('原文并入'), 'verbatim 提示词含模式说明')
    assert.ok(!pRaw.includes('范围：你只需执行'), 'verbatim 提示词不含摘要模式的范围约束')
    assert.ok(pSum.includes('范围：你只需执行'), '摘要模式保留范围约束')

    // ---- delegate verbatim 路径：返回 mode=raw + 完整过程 ----
    const runtime = makeFakeRuntime({ id: 'child-v', text: '一句收口' })
    // 给 fake agent 加活快照，喂两步过程。
    runtime.start = async function ({ parentAgent, promptText }) {
      this.startCalls = this.startCalls ?? []
      this.startCalls.push({ parentAgent, promptText })
      const events = [
        { type: 'session/end-seed' },
        { type: 'tool/call', data: { name: 'pwsh', callId: 'vx', arguments: JSON.stringify({ description: 'netstat' }) } },
        { type: 'tool/result', data: { message: { toolCallId: 'vx', content: [{ type: 'text', text: '445 4 System' }] } } }
      ]
      return {
        id: 'child-v',
        agent: { id: 'child-v', session: { id: 'child-v', header: { delegationDepth: 1, parentSession: 'top-v' }, snapshotEvents: () => events } },
        handle: { dispose: async () => {} },
        settle: async () => ({ aborted: false, text: '一句收口' })
      }
    }
    const appended = []
    const decisions = new Map()
    const applier = new ShadowApplier(null, store, decisions, runtime)
    const exec = {
      agent: { session: { id: 'top-v', header: {}, append: (type, data) => appended.push({ type, data }) }, options: {} },
      signal: new AbortController().signal
    }
    decisions.set('child-v', { type: 'return', payload: '摘要被忽略', at: '' })
    const v = await applier.delegate({ toolName: 'pwsh', args: {}, exec })
    assert.equal(v.mode, 'raw', 'verbatim 模式返回 mode=raw')
    assert.ok(v.summary.includes('445 4 System'), '原文并入：工具结果原样进入主会话')
    assert.ok(!v.summary.includes('摘要被忽略'), 'verbatim 模式忽略 future_return 摘要')
    assert.ok(runtime.startCalls[0].promptText.includes('原文并入'), 'verbatim 传入委派提示词')

    // ---- 工作过程视图挂钩：subagent/catalog 事件 ----
    const cat = appended.find((e) => e.type === 'subagent/catalog')
    assert.ok(cat !== undefined, 'delegate 落 subagent/catalog 事件')
    assert.equal(cat.data.version, 0, 'catalog version=0（与原生同形）')
    assert.equal(cat.data.childId, 'child-v', 'catalog childId 用 agent id')
    assert.equal(cat.data.mode, 'continuable', 'catalog mode=continuable')
    assert.ok(typeof cat.data.label === 'string' && cat.data.label.includes('pwsh'), 'catalog label 含工具名')

    // ---- 配置回滚：不再有 childReasoningEffort / childOptions ----
    const indexSrc = await readFile(join(ROOT, 'lib/index.js'), 'utf8')
    assert.ok(!indexSrc.includes('childReasoningEffort'), 'childReasoningEffort 配置已回滚（与主会话同步）')
    const futureSrc = await readFile(join(ROOT, 'lib/future.js'), 'utf8')
    assert.ok(!futureSrc.includes('childOptions'), 'runtime 不再有 childOptions 覆盖')
    assert.ok(futureSrc.includes('verbatim'), 'runtime.start 支持 verbatim')

    // ---- 客户端三态开关 ----
    const clientSrc = await readFile(join(ROOT, 'lib/client.js'), 'utf8')
    assert.ok(clientSrc.includes('reality-raw') && clientSrc.includes('现实·原文'), '客户端三态循环（普通/摘要/原文）')
    pass('原文并入模式 / catalog 挂钩 / 配置回滚全部通过')
  } catch (error) {
    fail(`0.5.1 新能力：${error.message}`)
  }
}

async function test9() {
  console.log('[9] 0.2.1-rc.3+ 回归：多 end-seed 切割 / raw 枚举 / ask 中继 output / 降级链 / 展示卫生 / calls 并集')
  try {
    // ---- §五.1 多 end-seed 切割：0.2.1-rc.3 起轮次切换标记随 seed 复放进子会话
    // 日志，真边界 = 最后一个标记（0.5.1 用 findIndex 命中第一个，折叠框转录与
    // promote 摘要混入父会话已完成轮次——2026-10-31 沙箱实锤）。
    const polluted = [
      { type: 'user/message', data: { content: [{ type: 'text', text: '父会话第 1 轮' }] } },
      { type: 'session/end-seed', data: {} }, // 父会话第 1 轮切换标记（随 seed 复放进来）
      { type: 'assistant/message', data: { content: [{ type: 'text', text: 'step-A 父会话旧轮内容' }] } },
      { type: 'session/end-seed', data: {} }, // 父会话第 2 轮切换标记
      { type: 'assistant/message', data: { content: [{ type: 'text', text: 'step-B 父会话旧轮内容' }] } },
      { type: 'session/end-seed', data: { inherited: true } }, // 构造器追加的真边界
      { type: 'assistant/message', data: { content: [{ type: 'text', text: '子会话自己的叙述' }] } },
      { type: 'tool/call', data: { name: 'pwsh', callId: 'c9', arguments: JSON.stringify({ description: 'dir' }) } },
      { type: 'tool/result', data: { message: { toolCallId: 'c9', content: [{ type: 'text', text: 'a.exe' }] } } }
    ]
    const own = ownEventsOf(polluted)
    assert.equal(own.length, 3, 'ownEventsOf 取最后一个 end-seed 之后（真边界）')
    assert.ok(!own.some((e) => e?.type === 'session/end-seed'), '自有段不含切割标记')
    const digest9 = mergeDigest(polluted)
    assert.ok(digest9.includes('子会话自己的叙述') && digest9.includes('pwsh（dir）') && digest9.includes('a.exe'), 'mergeDigest 只含子会话自身过程')
    assert.ok(!digest9.includes('step-A') && !digest9.includes('step-B') && !digest9.includes('父会话'), 'mergeDigest 不混入父会话旧轮（0.5.1 实锤缺陷 C）')
    // 缺陷 D 同源回归：子会话自身轮无 assistant 正文 → 回退必须为空文本，
    // 而不是命中 seed 前缀里父会话上一轮的最终回答（fallback-check-555 实录）。
    const staleSeed = [
      { type: 'assistant/message', data: { content: [{ type: 'text', text: 'fallback-check-555' }] } },
      { type: 'session/end-seed', data: { inherited: true } },
      { type: 'tool/call', data: { name: 'pwsh', callId: 'cd', arguments: '{}' } },
      { type: 'tool/result', data: { message: { toolCallId: 'cd', content: [{ type: 'text', text: 'ok' }] } } }
    ]
    assert.equal(lastAssistantText(ownEventsOf(staleSeed)), '', '自身轮无 assistant 正文 → 回退为空文本（不取父会话旧回答）')
    assert.equal(ownEventsOf([]).length, 0, '空日志 → 空自有段')
    assert.equal(ownEventsOf([{ type: 'tool/result' }]).length, 1, '无标记 → 全量自有')

    // ---- §五.2 output schema 枚举一致性（0.5.1 缺陷 B）：verbatim 路径返回
    // mode:'raw'，影子 output 枚举缺 'raw' → reality-raw 每次调用必报 invalid output。
    const store9 = new ModeStore(join(tmpdir(), `store9-${Date.now()}-${Math.random()}.json`))
    const applier9 = new ShadowApplier(null, store9, new Map(), null)
    const shadow9 = applier9.buildShadow({ name: 'pwsh', description: 'd', parameters: { type: 'object', properties: {} } })
    assert.deepEqual(
      shadow9.output.schema.properties.mode.enum,
      ['return', 'promote', 'fallback', 'raw'],
      '影子 output mode 枚举含 raw（verbatim 路径合法性）'
    )

    // ---- §五.3 ask 中继 output 声明（0.5.1 缺陷 A）：0.2.1-rc.3 注册强制
    // output { schema, render }，缺失 → 注册被拒 → 禁用回退也失败（agent 作用域）。
    const rt9 = new FutureSessionRuntime({ agentLoop: {} }, store9, new Map())
    for (const relay of createAskRelays(rt9)) {
      assert.equal(typeof relay.output?.render, 'function', `中继 ${relay.name} 声明 output.render`)
      assert.equal(relay.output?.schema?.type, 'object', `中继 ${relay.name} 声明 output.schema`)
      assert.ok(Array.isArray(relay.output?.schema?.required) && relay.output.schema.required.includes('answers'), `中继 ${relay.name} schema 必填 answers`)
    }

    // ---- 降级链 register→restrict→guard（0.5.1 附属：subagent 影子 restrict 也
    // 失败，agent 作用域工具只能 guard 拒执；degraded 名单按会话跟踪并对外暴露）。
    const schemas9 = [
      { name: 'subagent', description: '原生委派', parameters: { type: 'object', properties: {} } },
      { name: 'pwsh', description: '执行命令', parameters: { type: 'object', properties: {} } }
    ]
    const guards = []
    const view9 = {
      tools: {
        schemas: () => schemas9,
        register: (d) => { if (d.name === 'subagent') throw new Error('tool "subagent" is already registered in this scope'); registered9.push(d) },
        restrict: (filter) => { throw new Error(`tools.restrict() names unknown global tool "subagent"` ) },
        guard: (g) => { guards.push(g) }
      }
    }
    const registered9 = []
    const applier9b = new ShadowApplier({ tools: { schemas: () => schemas9 } }, store9, new Map(), makeFakeRuntime())
    const agent9 = { id: 'a9', session: { id: 'top-9', header: {} }, ctx: { inject: (s, cb) => { cb(view9); return { dispose: () => {} } } } }
    store9.setMode('top-9', 'reality')
    const applied9 = applier9b.applyToAgent(agent9, 'selfcheck-guard')
    assert.equal(guards.length, 1, 'restrict 不可用 → 退到 per-agent guard 拒执')
    assert.equal(applied9.degraded.length, 0, 'guard 成功 ≠ degraded（三级降级链兜住）')
    const guardReason = guards[0]({ name: 'subagent' })
    assert.ok(typeof guardReason === 'string' && guardReason.includes('subagent'), 'guard 对目标工具返回拒绝理由')
    assert.equal(guards[0]({ name: 'pwsh' }), undefined, 'guard 对其他工具放行')
    // guard 也不可用 → degraded 落名并对外暴露。
    const view9b = {
      tools: {
        schemas: () => schemas9,
        register: (d) => { if (d.name === 'subagent') throw new Error('tool "subagent" is already registered in this scope'); registered9b.push(d) },
        restrict: () => { throw new Error('unknown global tool') },
        guard: () => { throw new Error('guard unavailable') }
      }
    }
    const registered9b = []
    const applier9c = new ShadowApplier({ tools: { schemas: () => schemas9 } }, store9, new Map(), makeFakeRuntime())
    const agent9b = { id: 'a9b', session: { id: 'top-9', header: {} }, ctx: { inject: (s, cb) => { cb(view9b); return { dispose: () => {} } } } }
    const applied9b = applier9c.applyToAgent(agent9b, 'selfcheck-degraded')
    assert.deepEqual(applied9b.degraded, ['subagent'], 'guard 也不可用 → applied.degraded 落名')
    assert.deepEqual(applier9c.degradedToolsOf('top-9'), ['subagent'], 'degradedToolsOf 按会话暴露（/mode 与 /future status 用）')

    // ---- 展示卫生（0.5.1 缺陷 F）：①宿主上下文拼接消息不入「用户」步
    // ②assistant 只取 text 正文块（tool-call 块不再 JSON 序列化成乱码）。
    const noisy = [
      { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '真用户请求' }] } },
      { type: 'user/message', data: { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'Current runtime context…' }] } },
      { type: 'user/message', data: { source: { kind: 'skill-catalog' }, content: [{ type: 'text', text: '<system-reminder>skills…' }] } },
      { type: 'user/message', data: { source: { kind: 'time-context' }, content: [{ type: 'text', text: '2026-10-31T…' }] } },
      { type: 'assistant/message', data: { content: [{ type: 'reasoning', text: '思考' }, { type: 'tool-call', id: 't1', name: 'pwsh', arguments: '{"command":"dir"}' }, { type: 'text', text: '我来查一下' }] } }
    ]
    const steps9 = summarizeEvents(noisy, 500)
    assert.deepEqual(steps9.map((s) => s.kind), ['user', 'assistant'], '上下文拼接消息（runtime-context/skill-catalog/time-context）不渲染成用户步')
    assert.ok(!steps9[1].text.includes('tool-call') && !steps9[1].text.includes('command'), 'assistant 步不含 tool-call 块序列化噪音')
    assert.ok(steps9[1].text.includes('我来查一下'), 'assistant 步取 text 正文')

    // ---- /calls 并集（0.5.1 缺陷 G 数据面）：owner 无会话身份 → 按 callId 全局匹配。
    const store9b = new ModeStore(join(tmpdir(), `store9b-${Date.now()}-${Math.random()}.json`))
    store9b.registerChild('child-p', 'top-p', 'pwsh')
    store9b.registerChild('child-q', 'top-q', 'glob')
    store9b.linkCall('call-p', 'top-p', 'pwsh', 'child-p')
    store9b.linkCall('call-q', 'top-q', 'glob', 'child-q')
    const union = store9b.allCalls()
    assert.equal(union.length, 2, 'allCalls 返回跨会话并集')
    assert.ok(union.every((c) => typeof c.callId === 'string' && typeof c.childSessionId === 'string'), '并集条目带 callId/childSessionId')
    assert.ok(union[0].parentSessionId !== undefined, '并集条目带 parentSessionId')
    store9b.linkCall('call-orphan', 'top-p', 'pwsh', 'child-none')
    assert.equal(store9b.allCalls().length, 2, '孤儿 callId 不入并集')

    // ---- 客户端兜底改线（静态检查）：无 sessionId 也查 /calls + 运行期重试 + headMeta 取 result/assistant。
    const clientSrc9 = await readFile(join(ROOT, 'lib/client.js'), 'utf8')
    assert.ok(clientSrc9.includes("qs = sessionId !== '' ?"), '客户端 /calls 兜底带可选 sessionId（owner 无会话身份时按 callId 全局匹配）')
    assert.ok(clientSrc9.includes("tries < 30"), '客户端运行期兜底重试（注册竞态防护）')
    assert.ok(clientSrc9.includes("steps[i].kind === 'result' || steps[i].kind === 'assistant'"), '框头摘要取最后非空 result/assistant 文本')
    pass('多 end-seed 切割 / raw 枚举 / ask 中继 output / 三级降级链 / 展示卫生 / calls 并集全部通过')
  } catch (error) {
    fail(`0.2.1-rc.3+ 回归：${error.message}`)
  }
}

const tests = [test1, test2, test3, test3b, test4, test5, test6, test7, test8, test9]
for (const test of tests) await test()
console.log(failed === 0 ? `\n全部通过（${results.length} 项）` : `\n存在失败：${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
