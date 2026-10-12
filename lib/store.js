/**
 * dsh-plugin-future-session — ModeStore（host 半边）
 *
 * 内存缓存（同步读写，agent/created 与命令路径零 await 的热路径）+ JSON
 * 持久化（原子写、串行队列，杜绝 tmp 竞态）。
 *
 * 数据模型：
 *   sessions: sessionId → { mode: 'reality' | 'normal', revision, updatedAt }
 *   children: childSessionId → { parentSessionId, toolName, createdAt,
 *                                settledAt, decision: 'return' | 'promote' | null }
 *   calls:    callId → childSessionId（Phase 2 客户端折叠框：工具调用行按 callId
 *             找到对应未来会话，再拉它的转录）
 *   raws:     childSessionId → { raw, at }（future_return 的原始输出附件：
 *             现实会话可用 future_fetch 免重执行地取回，取代「回去重跑命令」）
 *
 * @module dsh-plugin-future-session/store
 */
import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { log } from './util.js'

export class ModeStore {
  constructor(filePath) {
    this.filePath = filePath
    /** @type {Map<string, {mode:'reality'|'normal', revision:number, updatedAt:string}>} */
    this.sessions = new Map()
    /** @type {Map<string, {parentSessionId:string, toolName:string, createdAt:string, settledAt:string|null, decision:'return'|'promote'|null}>} */
    this.children = new Map()
    /** @type {Map<string, string>} callId → childSessionId */
    this.calls = new Map()
    /** @type {Map<string, {raw:string, at:string}>} childSessionId → future_return 的原始输出附件（带容量与单条上限） */
    this.raws = new Map()
    /** @type {Map<string, string[]>} parentSessionId → 该会话可见的工具名（客户端 keyed 视图用） */
    this.catalogs = new Map()
    this.saving = false
    this.dirty = false
    /** 写盘串行队列：直接 persist() 与调度写盘共用。 */
    this.writeQueue = Promise.resolve()
    this.loadSync()
  }

  loadSync() {
    try {
      const raw = readFileSync(this.filePath, 'utf8')
      const data = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw)
      if (data !== null && typeof data === 'object') {
        for (const [id, rec] of Object.entries(data.sessions ?? {})) {
          if (rec && typeof rec === 'object' && (rec.mode === 'reality' || rec.mode === 'reality-raw' || rec.mode === 'normal')) {
            this.sessions.set(id, {
              mode: rec.mode,
              revision: Number(rec.revision) || 0,
              updatedAt: typeof rec.updatedAt === 'string' ? rec.updatedAt : ''
            })
          }
        }
        for (const [id, rec] of Object.entries(data.children ?? {})) {
          if (rec && typeof rec === 'object' && typeof rec.parentSessionId === 'string') {
            this.children.set(id, {
              parentSessionId: rec.parentSessionId,
              toolName: typeof rec.toolName === 'string' ? rec.toolName : '',
              createdAt: typeof rec.createdAt === 'string' ? rec.createdAt : '',
              settledAt: typeof rec.settledAt === 'string' ? rec.settledAt : null,
              decision: rec.decision === 'return' || rec.decision === 'promote' ? rec.decision : null
            })
          }
        }
        for (const [callId, childId] of Object.entries(data.calls ?? {})) {
          if (typeof callId === 'string' && typeof childId === 'string' && this.children.has(childId)) {
            this.calls.set(callId, childId)
          }
        }
        for (const [sessionId, names] of Object.entries(data.catalogs ?? {})) {
          if (typeof sessionId === 'string' && Array.isArray(names)) {
            const clean = names.filter((n) => typeof n === 'string' && n !== '')
            if (clean.length > 0) this.catalogs.set(sessionId, [...new Set(clean)].sort())
          }
        }
        for (const [childId, rec] of Object.entries(data.raws ?? {})) {
          if (typeof childId === 'string' && rec && typeof rec === 'object' && typeof rec.raw === 'string' && rec.raw !== '') {
            this.raws.set(childId, { raw: rec.raw, at: typeof rec.at === 'string' ? rec.at : '' })
          }
        }
      }
      log(`已加载 ${this.sessions.size} 个会话模式、${this.children.size} 条未来会话登记、${this.calls.size} 条调用映射、${this.catalogs.size} 份工具目录、${this.raws.size} 份原始输出附件`)
    } catch {
      log('无历史数据（首次启动或文件损坏，使用空库）')
    }
  }

  serialize() {
    return JSON.stringify({
      version: 1,
      sessions: Object.fromEntries(this.sessions),
      children: Object.fromEntries(this.children),
      calls: Object.fromEntries(this.calls),
      catalogs: Object.fromEntries(this.catalogs),
      raws: Object.fromEntries(this.raws)
    }, null, 2)
  }

  /** 异步原子持久化（串行队列）。 */
  scheduleSave() {
    if (this.saving) {
      this.dirty = true
      return
    }
    this.saving = true
    const run = async () => {
      while (this.saving) {
        this.dirty = false
        try {
          await this.persistNow()
        } catch (error) {
          log('写盘失败（下一轮重试）：', error?.message ?? error)
        }
        if (!this.dirty) break
      }
      this.saving = false
    }
    this.writeQueue = this.writeQueue.then(run, run)
  }

  async persistNow() {
    await mkdir(dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp`
    await writeFile(tmp, this.serialize(), 'utf8')
    await rename(tmp, this.filePath)
  }

  // ---- 会话模式 ----

  getMode(sessionId) {
    return this.sessions.get(sessionId)?.mode ?? 'normal'
  }

  isReality(sessionId) {
    const mode = this.getMode(sessionId)
    return mode === 'reality' || mode === 'reality-raw'
  }

  /** 是否为「原文并入」模式（reality-raw）：fork 的全部调用与结果原样塞回主会话。 */
  isRealityRaw(sessionId) {
    return this.getMode(sessionId) === 'reality-raw'
  }

  /** 设置模式；返回写入后的记录。不校验调用方权限（命令层负责）。 */
  setMode(sessionId, mode) {
    if (mode !== 'reality' && mode !== 'reality-raw' && mode !== 'normal') return null
    const prev = this.sessions.get(sessionId)
    const rec = { mode, revision: (prev?.revision ?? 0) + 1, updatedAt: new Date().toISOString() }
    this.sessions.set(sessionId, rec)
    this.scheduleSave()
    return rec
  }

  // ---- 未来会话登记 ----

  registerChild(childSessionId, parentSessionId, toolName) {
    const prev = this.children.get(childSessionId)
    const rec = {
      parentSessionId,
      toolName,
      createdAt: prev?.createdAt ?? new Date().toISOString(),
      settledAt: prev?.settledAt ?? null,
      decision: prev?.decision ?? null
    }
    this.children.set(childSessionId, rec)
    this.scheduleSave()
    return rec
  }

  /** 决策落账（return / promote）。 */
  settleChild(childSessionId, decision) {
    const rec = this.children.get(childSessionId)
    if (rec === undefined) return null
    rec.decision = decision
    rec.settledAt = new Date().toISOString()
    this.scheduleSave()
    return rec
  }

  getChild(childSessionId) {
    return this.children.get(childSessionId) ?? null
  }

  // ---- 工具调用 → 未来会话 映射（客户端折叠框数据面） ----

  /**
   * 登记「哪次工具调用派生了哪个未来会话」（工具调用开始时就写，早于结果返回）。
   * @param {string} callId - 工具调用 id（exec.callId）。
   * @param {string} parentSessionId - 现实会话 id。
   * @param {string} toolName - 被遮蔽的工具名。
   * @param {string} childSessionId - 未来会话 id。
   */
  linkCall(callId, parentSessionId, toolName, childSessionId) {
    if (typeof callId !== 'string' || callId === '' || typeof childSessionId !== 'string' || childSessionId === '') return null
    this.calls.set(callId, childSessionId)
    this.scheduleSave()
    return { callId, parentSessionId, toolName, childSessionId }
  }

  /** 按工具调用 id 查未来会话 id（客户端折叠框用）。 */
  childOfCall(callId) {
    return this.calls.get(callId) ?? null
  }

  /**
   * 列出一个现实会话的委派记录（时间序），供客户端建立 callId → 未来会话 索引。
   * @param {string} parentSessionId - 现实会话 id。
   */
  callsOfParent(parentSessionId) {
    const out = []
    for (const [callId, childId] of this.calls) {
      const child = this.children.get(childId)
      if (child === undefined || child.parentSessionId !== parentSessionId) continue
      out.push({
        callId,
        childSessionId: childId,
        toolName: child.toolName,
        createdAt: child.createdAt,
        settledAt: child.settledAt,
        decision: child.decision
      })
    }
    return out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
  }

  // ---- future_return 原始输出附件（future_fetch 数据面） ----

  /** 单条 raw 上限（字符）：再大说明委派本身失控，不值得全量保存。 */
  static RAW_MAX_CHARS = 200000
  /** raws 条目上限：防长期运行无限膨胀（按 at 淘汰最旧）。 */
  static RAW_MAX_ENTRIES = 200

  /**
   * 登记某个未来会话的原始输出附件（future_return 的 raw 参数）。
   * @param {string} childSessionId
   * @param {string} raw - 原始输出全文（会被截断到 RAW_MAX_CHARS）。
   */
  attachRaw(childSessionId, raw) {
    if (typeof childSessionId !== 'string' || childSessionId === '') return null
    const text = typeof raw === 'string' ? raw : ''
    if (text === '') return null
    const clipped = text.length > ModeStore.RAW_MAX_CHARS
      ? `${text.slice(0, ModeStore.RAW_MAX_CHARS)}\n…[future-session raw 截断，原长 ${text.length} 字符]`
      : text
    this.raws.set(childSessionId, { raw: clipped, at: new Date().toISOString() })
    if (this.raws.size > ModeStore.RAW_MAX_ENTRIES) {
      // 淘汰最旧的附件（保新弃旧：最近的委派最可能被 future_fetch）。
      let oldestKey = null
      let oldestAt = null
      for (const [key, rec] of this.raws) {
        if (oldestAt === null || rec.at < oldestAt) { oldestAt = rec.at; oldestKey = key }
      }
      if (oldestKey !== null) this.raws.delete(oldestKey)
    }
    this.scheduleSave()
    return this.raws.get(childSessionId)
  }

  /** 取某个未来会话的原始输出附件（没有则 null）。 */
  getRaw(childSessionId) {
    return this.raws.get(childSessionId)?.raw ?? null
  }

  /** 某个未来会话是否带原始输出附件（transcript 路由给客户端提示用）。 */
  hasRaw(childSessionId) {
    return this.raws.has(childSessionId)
  }

  // ---- 影子工具目录（客户端 keyed 折叠框视图按工具名预注册） ----

  /**
   * 记录某个现实会话可见的工具名（只增不减：客户端注册单调，撤销会留空洞）。
   * @param {string} sessionId
   * @param {string[]} names
   */
  noteShadowCatalog(sessionId, names) {
    if (typeof sessionId !== 'string' || sessionId === '' || !Array.isArray(names)) return
    const prev = this.catalogs.get(sessionId) ?? []
    const merged = [...new Set([...prev, ...names.filter((n) => typeof n === 'string' && n !== '')])].sort()
    if (merged.length === prev.length) return
    this.catalogs.set(sessionId, merged)
    this.scheduleSave()
  }

  /** 某个会话可见的工具名（没有记录时回退全局目录）。 */
  catalogFor(sessionId) {
    const perSession = this.catalogs.get(sessionId)
    if (Array.isArray(perSession) && perSession.length > 0) return perSession
    return this.allCatalog()
  }

  /** 全部会话的工具名并集（客户端启动时的预注册清单）。 */
  allCatalog() {
    const out = new Set()
    for (const names of this.catalogs.values()) for (const name of names) out.add(name)
    return [...out].sort()
  }

  /** 按父会话列出未来会话（时间序）。 */
  childrenOf(parentSessionId) {
    return [...this.children.values()]
      .filter((rec) => rec.parentSessionId === parentSessionId)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
  }

  /** 会话语料清理：剔除已不存在的会话键（防无限膨胀）。 */
  pruneSessions(knownIds) {
    const known = new Set(knownIds)
    let removed = 0
    for (const id of this.sessions.keys()) {
      if (!known.has(id)) { this.sessions.delete(id); removed++ }
    }
    for (const id of this.children.keys()) {
      if (!known.has(id) && !known.has(this.children.get(id)?.parentSessionId)) {
        this.children.delete(id); removed++
      }
    }
    for (const [callId, childId] of this.calls) {
      if (!this.children.has(childId)) { this.calls.delete(callId); removed++ }
    }
    for (const sessionId of this.catalogs.keys()) {
      if (!known.has(sessionId)) { this.catalogs.delete(sessionId); removed++ }
    }
    for (const childId of this.raws.keys()) {
      if (!known.has(childId) && !known.has(this.children.get(childId)?.parentSessionId)) {
        this.raws.delete(childId); removed++
      }
    }
    if (removed > 0) {
      log(`清理 ${removed} 条孤儿记录`)
      this.scheduleSave()
    }
  }
}
