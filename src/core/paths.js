/**
 * dsh-search · 路径事实源
 *
 * 只解析 DSH 家目录与三类语料的根目录，不做任何遍历：
 *   - 会话日志：$DSH_HOME/sessions/<项目键>/<会话段>/session.jsonl[.zstd]
 *   - 长期记忆：$DSH_HOME 下 memgas 的 project-… 各项目目录里 memories 的 m_… .md
 *   - 工作区文件：由配置显式给出的根目录（默认关闭）
 */
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/** 展开前导 ~（按当前平台风格）。 */
export function expandHome(path, home = homedir()) {
  if (path === '~') return home
  if (path.startsWith('~/')) return join(home, path.slice(2))
  return path
}

/** 解析 DSH 家目录：DSH_HOME 环境变量优先，否则 ~/.dsh。 */
export function dshHome(env = process.env, home = homedir()) {
  const raw = env.DSH_HOME
  if (typeof raw === 'string' && raw.trim() !== '') {
    const expanded = expandHome(raw.trim(), home)
    return isAbsolute(expanded) ? expanded : resolve(expanded)
  }
  return join(home, '.dsh')
}

/** 会话日志根目录。 */
export function sessionsRoot(home = dshHome()) {
  return join(home, 'sessions')
}

/** 长期记忆根目录。 */
export function memgasRoot(home = dshHome()) {
  return join(home, 'memgas')
}

/** 本插件自己的数据目录（索引库、状态文件）。 */
export function indexDir(home = dshHome()) {
  return join(home, 'search')
}

/** 索引库绝对路径。 */
export function indexDbPath(home = dshHome()) {
  return join(indexDir(home), 'index.sqlite')
}

/** 宿主日志根目录（`<home>/logs`）。UI 里能看日志很重要：索引失败时用户要能自查。 */
export function logsRoot(home = dshHome()) {
  return join(home, 'logs')
}

/**
 * 索引要覆盖的项目工作目录。
 *
 * 会话日志只存在于 `$DSH_HOME/sessions`，所以"聊天记录"这一层天然完整；
 * 这个列表决定的是**工作区文件**语料要不要一起进索引，以及哪些目录要排除。
 * 默认不索引工作区文件：1.2GB 的文本量会让首次构建从 40 秒涨到分钟级，
 * 而用户要的"标题和聊天记录"已经在会话语料里了。需要时在 cordis.yml 里打开。
 */
export function defaultFileRoots(env = process.env, home = homedir()) {
  const raw = env.DSH_SEARCH_FILE_ROOTS
  if (typeof raw !== 'string' || raw.trim() === '') return []
  return raw.split(',')
    .map(entry => expandHome(entry.trim(), home))
    .filter(entry => entry !== '')
}

/** 项目键解码：--Users-mac-foo-- → /Users/mac/foo。
 *  DSH 用 ~XXXX~ 转义特殊字符（空格等），这里只做展示用的人类可读还原。 */
export function decodeProjectKey(key) {
  if (typeof key !== 'string' || key.length < 4) return key
  const body = key.startsWith('--') && key.endsWith('--') ? key.slice(2, -2) : key
  const dashed = body.replace(/-/g, '/')
  const restored = dashed.replace(/~([0-9A-Fa-f]{4})~/g, (_, hex) => {
    try {
      return String.fromCharCode(Number.parseInt(hex, 16))
    } catch {
      return _
    }
  })
  return restored.startsWith('/') ? restored : `/${restored}`
}