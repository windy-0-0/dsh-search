/**
 * dsh-search · 会话标题的第二个来源
 *
 * 标题主要来自会话日志里的 `session/title` 记录（scan.js 已经处理）。但有两类会话
 * 在日志里拿不到标题：
 *   - 日志被清理/轮转后只剩缓存；
 *   - 标题写入发生在日志分段之前，或日志目录已被归档。
 *
 * DSH 自己把"会话列表要用的那点元数据"持久化在
 * `$DSH_HOME/storages/session_projcache.json`（投影缓存），里面就带 title。
 * 把它当作**补充**来源合并进来：日志里有就用日志的，没有才用缓存的，
 * 这样"按标题搜索"才真正覆盖全部会话。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 投影缓存路径。 */
export function projCachePath(home) {
  return join(home, 'storages', 'session_projcache.json')
}

/**
 * 读出缓存里的会话标题。
 * @param home DSH 家目录
 * @returns Array<{ sessionId, title, cwd, createdAt }>；文件缺失或损坏时返回空数组
 */
export function readProjectedTitles(home) {
  let raw
  try {
    raw = readFileSync(projCachePath(home), 'utf8')
  } catch {
    return []
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  const table = parsed?.tables?.sessions
  if (table === null || typeof table !== 'object') return []

  const out = []
  for (const [sessionId, entry] of Object.entries(table)) {
    if (sessionId === '' || entry === null || typeof entry !== 'object') continue
    const title = entry?.rows?.title?.val
    const cwd = entry?.identity?.cwd
    const createdAt = entry?.identity?.createdAt
    const clean = typeof title === 'string' ? title.trim() : ''
    // 没标题也照样收：cwd / createdAt 对"按项目或时间过滤"有用，标题留空即可。
    if (clean === '' && typeof cwd !== 'string' && !Number.isFinite(createdAt)) continue
    out.push({
      sessionId: sessionId.startsWith('session-') ? sessionId : `session-${sessionId}`,
      title: clean === '' ? null : clean,
      cwd: typeof cwd === 'string' && cwd !== '' ? cwd : null,
      createdAt: Number.isFinite(createdAt) ? Number(createdAt) : null,
    })
  }
  return out
}