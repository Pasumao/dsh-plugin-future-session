/**
 * dsh-plugin-future-session — 通用工具（host 半边）
 *
 * @module dsh-plugin-future-session/util
 */
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** 持久化目录（$DSH_HOME，默认 ~/.dsh）。 */
export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** 诊断日志文件（Desktop 宿主 console 不可见，必须落盘才能排查）。 */
export const LOG_FILE = join(dshHome(), 'dsh-plugin-future-session.log')

/** 统一日志前缀 + 落盘。 */
export function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map((a) => (typeof a === 'string' ? a : safeJson(a))).join(' ')}`
  console.log('[dsh-plugin-future-session]', ...args)
  try {
    appendFileSync(LOG_FILE, `${line}\n`, 'utf8')
  } catch { /* 落盘失败不影响运行 */ }
}

function safeJson(value) {
  try { return JSON.stringify(value) } catch { return String(value) }
}

/** 会话是否为顶层（现实候选）：delegationDepth 缺失或为 0。 */
export function isTopLevelAgent(agent) {
  const depth = agent?.session?.header?.delegationDepth
  return depth == null || depth === 0
}

/** 会话是否为 subagent 子会话（未来会话候选）。 */
export function isChildAgent(agent) {
  return !isTopLevelAgent(agent) || typeof agent?.session?.header?.parentSession === 'string'
}

/**
 * 从 ContentBlock[] 提取纯文本（子会话 output / 工具结果通用）。
 * 未知块类型按 JSON 序列化兜底，保证信息不丢。
 */
export function blocksToText(blocks) {
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue
    if (typeof block.text === 'string') parts.push(block.text)
    else parts.push(JSON.stringify(block))
  }
  return parts.join('\n').trim()
}

/** 截断文本到 max 字符（保尾不保头：结论一般在末尾，保留后半段更安全则翻转说明）。 */
export function truncate(text, max = 60000) {
  if (typeof text !== 'string' || text.length <= max) return text
  return `${text.slice(0, max)}\n…[future-session 截断，原长 ${text.length} 字符]`
}

/** 未来会话结论标记前缀（现实会话模型靠它自检身份）。 */
export const FUTURE_MARKER = '[future-session]'

/** zstd 帧 magic（落盘会话文件是多帧 zstd，Node 的解压器只处理第一帧）。 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD])

/**
 * 读取一个已落盘会话的全部事件（带 payload）。
 *
 * 为什么不走 ctx.sessionQuery.listEvents：那背后是 FTS 搜索索引，事件投影
 * 只有 {sessionId, seq, type, time, surface} 元数据，**没有 data 载荷**——
 * 转录摘要 / 回退结论提取全部拿不到内容（2026-10-11 debug=1 实测）。
 * 落盘文件为多帧 zstd 压缩的 jsonl：按 magic 切帧逐帧解压再逐行 parse。
 * @param {string} sessionId - 会话 id。
 * @returns {{events: Array, error?: string}} events 为解析出的事件（可能为空）。
 */
export function readPersistedSessionEvents(sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '' || !/^[A-Za-z0-9._-]+$/.test(sessionId)) {
    return { events: [], error: 'invalid-session-id' }
  }
  const root = join(dshHome(), 'sessions')
  let dir = null
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const candidate = join(root, entry.name, sessionId, 'session.v4.jsonl.zstd')
      if (existsSync(candidate)) { dir = candidate; break }
    }
  } catch (error) {
    return { events: [], error: `scan-failed: ${error?.message ?? error}` }
  }
  if (dir === null) return { events: [], error: 'file-not-found' }
  let buf
  try {
    buf = readFileSync(dir)
  } catch (error) {
    return { events: [], error: `read-failed: ${error?.message ?? error}` }
  }
  // 切帧 + 逐帧解压
  const offsets = []
  let pos = 0
  while (true) {
    const i = buf.indexOf(ZSTD_MAGIC, pos)
    if (i === -1) break
    offsets.push(i)
    pos = i + 1
  }
  const chunks = []
  try {
    for (let i = 0; i < offsets.length; i++) {
      chunks.push(zstdDecompressSync(buf.subarray(offsets[i], i + 1 < offsets.length ? offsets[i + 1] : buf.length)))
    }
  } catch (error) {
    return { events: [], error: `decompress-failed: ${error?.message ?? error}` }
  }
  const events = []
  for (const line of Buffer.concat(chunks).toString('utf8').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try { events.push(JSON.parse(trimmed)) } catch { /* 跳过坏行 */ }
  }
  return { events }
}
