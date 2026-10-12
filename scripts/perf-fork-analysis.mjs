#!/usr/bin/env node
/**
 * fork 性能剖析：对一次「开启未来会话」的会话导出（含 subagents/）做逐 fork
 * 耗时拆解，找出核心瓶颈。
 *
 * 用法：node scripts/perf-fork-analysis.mjs <导出目录> [--top N]
 *   导出目录 = 解包后的会话记录根（含 session.v4.jsonl 与 subagents/<id>/…）
 *
 * 输出：
 *   - 每个 fork 的相位拆解：fork+首轮 LLM（create→首条 assistant）、真工具执行
 *     （call→result 之和）、收口轮 LLM（末次真结果→future_return 落账）、残余
 *   - 汇总：各相位均值/中位/占比；委派提示词长度与总时长的相关性
 *   - 对照：纯 host 开销微基准（balancedPrefix / turnProgressDigest 跑真实事件流）
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'

const root = process.argv[2]
if (root === undefined || root === '') {
  console.error('用法：node scripts/perf-fork-analysis.mjs <导出目录> [--top N]')
  process.exit(1)
}
const topN = Number.parseInt((process.argv.find((a, i) => process.argv[i - 1] === '--top') ?? '12'), 10)

const parse = (p) => readFileSync(p, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
const t = (e) => (e?.time !== undefined ? e.time : null)

/** 拆解一个 fork 的相位。 */
function phases(events) {
  const first = events.find(t)
  if (first === undefined) return null
  const t0 = first.time
  const last = events[events.length - 1]
  const total = (last.time ?? t0) - t0
  const firstAssistant = events.find((e) => e.type === 'assistant/message')
  const turn1 = firstAssistant !== undefined ? firstAssistant.time - t0 : total
  let exec = 0
  const open = new Map()
  let lastToolResultAt = null
  let nTools = 0
  for (const e of events) {
    if (e.type === 'tool/call') {
      open.set(e.data?.callId ?? `?${e.seq}`, { at: e.time, name: e.data?.name })
    } else if (e.type === 'tool/result') {
      const key = e.data?.message?.toolCallId ?? e.data?.source?.callId ?? `?${e.seq}`
      const call = open.get(key) ?? [...open.values()].pop()
      if (call !== undefined) {
        if (call.name !== 'future_return' && call.name !== 'future_promote') {
          exec += e.time - call.at
          nTools++
          lastToolResultAt = e.time
        }
        open.delete(key)
      }
    }
  }
  // 收口调用（future_return/promote 的 tool/call）时间点。
  const returnCall = events.find((e) => e.type === 'tool/call' && (e.data?.name === 'future_return' || e.data?.name === 'future_promote'))
  const returnAt = returnCall?.time ?? null
  const closeStart = lastToolResultAt ?? (firstAssistant !== undefined ? firstAssistant.time : t0)
  const close = returnAt !== null ? returnAt - closeStart : 0
  const other = Math.max(0, total - turn1 - exec - close)
  return { total, turn1, exec, close, other, nTools }
}

const subDir = join(root, 'subagents')
const rows = []
for (const dir of readdirSync(subDir, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue
  const p = join(subDir, dir.name, 'session.v4.jsonl')
  let events
  try { events = parse(p) } catch { continue }
  const ph = phases(events)
  if (ph === null) continue
  const deleg = events.filter((e) => e.type === 'user/message')
  const delegLen = deleg.length > 0 ? JSON.stringify(deleg[deleg.length - 1].data?.content ?? '').length : 0
  const isFork = dir.name.startsWith('session-')
  rows.push({ id: dir.name, isFork, delegLen, ...ph })
}

const forks = rows.filter((r) => r.isFork)
const stat = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  const sum = s.reduce((a, b) => a + b, 0)
  return { n: s.length, avg: sum / s.length, p50: s[Math.floor(s.length / 2)], max: s[s.length - 1], sum }
}
const f2 = (x) => `${(x / 1000).toFixed(1)}s`
const T = forks.reduce((a, r) => a + r.total, 0)
const A = forks.reduce((a, r) => a + r.turn1, 0)
const E = forks.reduce((a, r) => a + r.exec, 0)
const C = forks.reduce((a, r) => a + r.close, 0)
const O = forks.reduce((a, r) => a + r.other, 0)

console.log(`fork 总数：${forks.length}（另有非 session- 前缀子代理 ${rows.length - forks.length} 个，未计入）\n`)
console.log('相位（对全部 fork 累计）：')
console.log(`  fork创建+首轮LLM（读到委派→发起真工具） : ${f2(A)}  ${(A / T * 100).toFixed(1)}%`)
console.log(`  真工具执行（call→result 之和）           : ${f2(E)}  ${(E / T * 100).toFixed(1)}%`)
console.log(`  收口轮LLM（末次真结果→future_return）    : ${f2(C)}  ${(C / T * 100).toFixed(1)}%`)
console.log(`  残余（轮间调度/落盘/dispose）            : ${f2(O)}  ${(O / T * 100).toFixed(1)}%`)
console.log(`  合计                                     : ${f2(T)}\n`)
for (const key of ['total', 'turn1', 'exec', 'close', 'other']) {
  const s = stat(forks.map((r) => r[key]))
  console.log(`${key.padEnd(6)} avg=${f2(s.avg)} p50=${f2(s.p50)} max=${f2(s.max)} sum=${f2(s.sum)}`)
}
console.log('')
console.log('耗时 Top：')
for (const r of [...forks].sort((a, b) => b.total - a.total).slice(0, topN)) {
  console.log(`  ${r.id.slice(0, 20).padEnd(20)} total=${f2(r.total).padStart(7)} turn1=${f2(r.turn1).padStart(7)} exec=${f2(r.exec).padStart(7)}(${r.nTools}次) close=${f2(r.close).padStart(7)} deleg=${(r.delegLen / 1000).toFixed(1)}KB`)
}
// 相关性：委派提示词长度 vs turn1 / total（零方差时输出 n/a）
const corr = (xs, ys) => {
  const n = xs.length
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  let num = 0; let dx = 0; let dy = 0
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); dx += (xs[i] - mx) ** 2; dy += (ys[i] - my) ** 2 }
  if (dx === 0 || dy === 0) return NaN
  return num / Math.sqrt(dx * dy)
}
const corrT1 = corr(forks.map((r) => r.delegLen), forks.map((r) => r.turn1))
const corrTot = corr(forks.map((r) => r.delegLen), forks.map((r) => r.total))
console.log(`\n相关性：委派提示词长度 ↔ turn1 = ${Number.isNaN(corrT1) ? 'n/a（长度无方差）' : corrT1.toFixed(2)}；↔ total = ${Number.isNaN(corrTot) ? 'n/a（长度无方差）' : corrTot.toFixed(2)}`)

// 微基准：纯 host 函数跑真实主会话事件流（排除 host JS 是瓶颈的可能）。
try {
  const { turnProgressDigest, balancedPrefix } = await import('../lib/index.js')
  const main = parse(join(root, 'session.v4.jsonl'))
  const t0 = performance.now()
  const N = 200
  for (let i = 0; i < N; i++) { balancedPrefix(main); turnProgressDigest(main) }
  const per = (performance.now() - t0) / N
  console.log(`\n微基准：balancedPrefix+turnProgressDigest 跑主会话全部 ${main.length} 事件，均值 ${per.toFixed(2)} ms/次 —— 相比秒级 LLM 相位可忽略`)
} catch { /* lib 不可用就跳过 */ }
