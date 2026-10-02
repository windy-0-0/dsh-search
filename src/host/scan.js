/**
 * dsh-search · 语料扫描
 *
 * 三类语料，各自一个扫描器，都只负责\"把原文变成文档流\"，不碰索引：
 *   1. 会话日志  $DSH_HOME/sessions/<项目键>/<会话段>/session.jsonl[.zstd]
 *   2. 长期记忆  $DSH_HOME 下 memgas 的 project-… 目录里 memories 的 m_… .md
 *   3. 工作区文件（可选，配置里显式给出根目录才启用）
 *
 * 会话日志支持**增量**：帧是独立可解压的，因此记住\"已消费到哪个字节\"就能
 * 只解压新追加的帧；文件变小（被重写/压缩）才退回全量重扫。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { extract } from '../core/extract.js'
import { decodeFrame, decodeTornFrame, scanFrames } from './zstd.js'

/** 会话日志文件名（zstd 与明文两种）。 */
function logFileNames() {
  return ['session.jsonl.zstd', 'session.jsonl']
}

/** 目录名 → 会话 id：段名可能带也可能不带 `session-` 前缀。 */
export function canonicalSessionId(segment) {
  return segment.startsWith('session-') ? segment : `session-${segment}`
}

/** 逐行解析 JSONL 文本；坏行计入 malformed 而不是抛错（日志可能含半行）。 */
export function parseLines(text, onRecord, stats) {
  let cursor = 0
  for (;;) {
    const at = text.indexOf('\n', cursor)
    if (at < 0) break
    const line = text.slice(cursor, at)
    cursor = at + 1
    if (line === '' || line === '\r') continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      if (stats !== undefined) stats.malformed += 1
      continue
    }
    onRecord(record)
  }
  return cursor
}

/**
 * 扫描单个会话目录。
 * @param dir 会话目录绝对路径
 * @param projectKey 项目键目录名
 * @param state 已索引状态 { size, byteOffset, docs } 或 undefined（首次）
 * @param sink 回调 { onHeader(h), onTitle(t), onDoc(d) }
 * @returns 扫描统计与新的游标状态
 */
export function scanSessionDir(dir, projectKey, state, sink, limits = {}) {
  const stats = { docs: 0, malformed: 0, files: 0, reset: false, bytes: 0, nextOffset: 0, size: 0, lastTime: undefined }
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return { ...stats, missing: true }
  }
  const name = logFileNames().find(candidate => names.includes(candidate))
  if (name === undefined) return { ...stats, missing: true }
  const path = join(dir, name)
  let stat
  try {
    stat = statSync(path)
  } catch {
    return { ...stats, missing: true }
  }
  stats.files = 1
  stats.size = stat.size

  const useFrames = name.endsWith('.zstd')

  // 文件没长过：zstd 看字节游标，明文看 size。直接返回"未变化"，
  // 既不重扫、也不让上层把"本次 0 条文档"误判成"该会话已无内容"而误删索引。
  const unchanged = state !== undefined
    && state.docs > 0
    && (useFrames ? stat.size === state.byteOffset : stat.size === state.size)
  if (unchanged) {
    return { ...stats, docs: 0, nextOffset: state.byteOffset, unchanged: true }
  }

  // 增量还是全量：只有"变大了"才可能续读；变小或没记录过游标就全量重来。
  const incremental = state !== undefined
    && Number.isFinite(state.byteOffset)
    && state.byteOffset > 0
    && stat.size >= state.byteOffset
    && useFrames

  if (!incremental && state !== undefined && state.docs > 0) stats.reset = true

  let buffer
  try {
    buffer = readFileSync(path)
  } catch {
    return { ...stats, missing: true }
  }

  const sessionId = canonicalSessionId(dir.split('/').pop() ?? '')
  const ctx = { sessionId, projectKey }
  /** 解码起点（绝对字节偏移）。0 = 全量重扫。 */
  let from = incremental ? state.byteOffset : 0

  let scan
  if (useFrames) {
    try {
      // scanFrames 收到的偏移相对传入的子缓冲，因此下面解码时要加回 from。
      scan = scanFrames(buffer.subarray(from))
    } catch {
      // 游标不再落在帧边界（文件被重写/人工改坏）→ 退回全量重扫一次；
      // 全量仍失败才放弃本文件，不影响其它会话。
      if (from === 0) return { ...stats, corrupt: true }
      from = 0
      stats.reset = true
      try {
        scan = scanFrames(buffer)
      } catch {
        return { ...stats, corrupt: true }
      }
    }
  }

  let consumed = from
  let pieces = ''
  if (useFrames) {
    for (const range of scan.frames) {
      const absolute = [from + range[0], from + range[1]]
      let text
      try {
        text = decodeFrame(buffer, absolute)
      } catch {
        stats.malformed += 1
        continue
      }
      stats.bytes += text.length
      pieces += text
      consumed = absolute[1]
    }
    if (scan.tornStart !== undefined) {
      // 半帧（活会话正在追加）：解出已有部分但不推进游标，下一轮从该帧重新读。
      const partial = decodeTornFrame(buffer, from + scan.tornStart)
      if (partial !== '') {
        stats.bytes += partial.length
        pieces += partial
      }
    }
  } else {
    // 明文 JSONL：整文件一次读完，游标只记 size 用于判断是否需要重扫。
    pieces = buffer.toString('utf8')
    stats.bytes += pieces.length
    consumed = buffer.length
  }

  stats.nextOffset = useFrames ? consumed : 0

  // 扫描器是"逐会话"顺序执行的，因此可以在回调上补会话上下文：
  // 索引器需要知道每条文档属于哪个会话，而 extract() 本身是纯函数、不该持有会话状态。
  parseLines(pieces, record => {
    const result = extract(record, ctx)
    if (result.header !== undefined) sink.onHeader({ ...result.header, sessionId, projectKey })
    if (result.title !== undefined) sink.onTitle({ sessionId, projectKey, title: result.title, seq: null, time: null })
    for (const doc of result.docs) {
      sink.onDoc({ ...doc, sessionId, projectKey })
      stats.docs += 1
      if (Number.isFinite(doc.time) && (stats.lastTime === undefined || doc.time > stats.lastTime)) {
        stats.lastTime = doc.time
      }
    }
  }, stats)

  return stats
}

/**
 * 扫描全部会话目录。
 * @param root sessions 根目录
 * @param known 已知文件状态 Map<会话id, {byteOffset, size, docs}>
 * @param sink 文档回调集合
 */
export function scanSessions(root, known, sink) {
  const totals = { sessions: 0, docs: 0, malformed: 0, corrupt: 0, reset: 0, missing: 0, bytes: 0, unchanged: 0 }
  let projects
  try {
    projects = readdirSync(root)
  } catch {
    return totals
  }
  for (const projectKey of projects) {
    const projectDir = join(root, projectKey)
    let stat
    try {
      stat = statSync(projectDir)
    } catch {
      continue
    }
    if (!stat.isDirectory()) continue
    let segments
    try {
      segments = readdirSync(projectDir)
    } catch {
      continue
    }
    for (const segment of segments) {
      const dir = join(projectDir, segment)
      let dirStat
      try {
        dirStat = statSync(dir)
      } catch {
        continue
      }
      if (!dirStat.isDirectory()) continue
      const sessionId = canonicalSessionId(segment)
      const state = known.get(sessionId)
      totals.sessions += 1
      const result = scanSessionDir(dir, projectKey, state, sink)
      if (result.missing === true) {
        totals.missing += 1
        continue
      }
      if (result.corrupt === true) {
        totals.corrupt += 1
        continue
      }
      if (result.reset === true) totals.reset += 1
      if (result.unchanged === true) totals.unchanged += 1
      totals.docs += result.docs
      totals.malformed += result.malformed
      totals.bytes += result.bytes
      sink.onFile({
        sessionId,
        projectKey,
        dir,
        size: result.size,
        byteOffset: result.nextOffset,
        docs: result.docs,
        reset: result.reset === true,
        unchanged: result.unchanged === true,
        lastTime: result.lastTime,
      })
    }
  }
  return totals
}

/**
 * 扫描长期记忆（memgas）。每个 m_*.md 是一个带 YAML 头的记忆文件，
 * 正文是 Markdown；索引\"正文 + 关键头部字段\"，并保留 id 便于溯源。
 */
export function scanMemories(root, sink) {
  const totals = { files: 0, docs: 0 }
  let projects
  try {
    projects = readdirSync(root)
  } catch {
    return totals
  }
  for (const project of projects) {
    const memoriesDir = join(root, project, 'memories')
    let entries
    try {
      entries = readdirSync(memoriesDir)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.endsWith('.md')) continue
      const path = join(memoriesDir, entry)
      let raw
      try {
        raw = readFileSync(path, 'utf8')
      } catch {
        continue
      }
      totals.files += 1
      const id = entry.replace(/\.md$/, '')
      const { meta, body } = splitFrontMatter(raw)
      const text = body.trim()
      if (text === '') continue
      sink.onDoc({
        kind: 'memory',
        label: `长期记忆 · ${typeof meta.kind === 'string' ? meta.kind : 'note'}`,
        text,
        memoryId: id,
        scope: typeof meta.scope === 'string' ? meta.scope : project,
        status: typeof meta.status === 'string' ? meta.status : 'active',
        createdAt: Number.isFinite(meta.created_at) ? meta.created_at : null,
        path,
      })
      totals.docs += 1
    }
  }
  return totals
}

/** 拆分 Markdown 前置的 YAML 头（只做浅层 key: value 解析，够用且不引依赖）。 */
export function splitFrontMatter(raw) {
  const meta = {}
  if (typeof raw !== 'string' || !raw.startsWith('---')) return { meta, body: raw }
  const end = raw.indexOf('\n---', 3)
  if (end < 0) return { meta, body: raw }
  const head = raw.slice(3, end)
  const body = raw.slice(end + 4)
  for (const line of head.split('\n')) {
    const at = line.indexOf(':')
    if (at <= 0) continue
    const key = line.slice(0, at).trim()
    let value = line.slice(at + 1).trim()
    if (value.startsWith('\"') && value.endsWith('\"') && value.length >= 2) value = value.slice(1, -1)
    if (value === 'null') value = null
    else if (/^-?\d+$/.test(value)) value = Number(value)
    else if (/^-?\d+\.\d+$/.test(value)) value = Number(value)
    meta[key] = value
  }
  return { meta, body }
}