/**
 * dsh-search · Host 半区
 *
 * 一个进程内、可被两个方向同时使用的检索服务：
 *   - **模型**：`search_dsh` / `search_dsh_read` 两个工具；
 *   - **用户**：Web GUI 侧边栏的搜索面板，走 `/plugins/dsh-search/*` 的本地路由。
 *
 * 生命周期与资源纪律（Cordis）：
 *   - 索引库连接、worker、定时器、路由全部挂在 `ctx.effect()` 上，插件卸载即净；
 *   - 索引是**可再生的派生物**，库损坏或 schema 过期时重建是唯一恢复路径，不做兼容迁移；
 *   - 检索走主线程的只读连接（毫秒级），只有"构建/更新"才进 worker。
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { SearchIndex } from './host/index-db.js'
import { readProjectedTitles } from './host/projcache.js'
import { READ_TOOL, SEARCH_TOOL, parseTime, renderDoc, renderResults } from './host/tool.js'
import { dshHome, defaultFileRoots, indexDbPath, memgasRoot, sessionsRoot } from './core/paths.js'
import { snippetFor } from './core/highlight.js'

/** 路由前缀（与客户端 fetch 的路径一致）。 */
const PREFIX = '/plugins/dsh-search'

/** 文本类工具结果的输出声明。 */
const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
}

export const name = 'dsh-search'

/**
 * 硬依赖：工具注册需要 `tools`，自动增量索引需要 `timer`。
 *
 * Cordis 只允许通过 inject 声明后按属性访问服务——没声明就读 `ctx.timer` 会直接
 * 抛 "cannot get property \"timer\" without inject" 而挂载失败。两个服务都在宿主
 * 组合里（cordis-plugin-timer / tools），因此这里声明是安全的；webServer 仍走
 * 可选路径，缺 Web 时检索工具照常可用。
 */
export const inject = ['tools', 'timer']

/**
 * 插件配置 schema。
 *
 * 不能只写一个默认值对象：Cordis 的 loader 在挂载前会调用 `Config['~standard'].validate(raw)`，
 * 没有这个接口就报 "Cannot read properties of undefined (reading 'validate')" 而根本挂不上。
 * 这里手写 Standard Schema 接口，既不引入 schemastery 依赖（本插件目录里没有它），
 * 又能在配置写错时给出人话错误——比静默套默认值好。
 */
const CONFIG_DEFAULTS = {
  /** 是否把工作区文件也纳入索引（默认关闭：会显著拉长构建时间）。 */
  includeFiles: false,
  /** 工作区文件的根目录列表；为空时读取环境变量 DSH_SEARCH_FILE_ROOTS。 */
  fileRoots: [],
  /** 工作区文件的排除子串。 */
  exclude: ['/node_modules/', '/.git/', '/Library/', '/.Trash/'],
  /** 启动后自动增量索引的延迟（毫秒）；0 表示不自动索引。 */
  autoIndexDelayMs: 20_000,
  /** 自动增量索引的间隔（毫秒）；0 表示只做一次。 */
  autoIndexIntervalMs: 30 * 60_000,
  /** 单次检索返回的默认条数。 */
  defaultLimit: 30,
}

const CONFIG_TYPES = {
  includeFiles: 'boolean',
  fileRoots: 'string[]',
  exclude: 'string[]',
  autoIndexDelayMs: 'number',
  autoIndexIntervalMs: 'number',
  defaultLimit: 'number',
}

export const Config = {
  ...CONFIG_DEFAULTS,
  '~standard': {
    version: 1,
    vendor: 'dsh-search',
    validate(value) {
      if (value === undefined || value === null) return { value: { ...CONFIG_DEFAULTS } }
      if (typeof value !== 'object' || Array.isArray(value)) {
        return { issues: [{ message: 'config 必须是一个对象' }] }
      }
      const issues = []
      const out = { ...CONFIG_DEFAULTS }
      for (const [key, raw] of Object.entries(value)) {
        const expected = CONFIG_TYPES[key]
        if (expected === undefined) {
          issues.push({ message: `未知配置项 ${key}`, path: [key] })
          continue
        }
        if (expected === 'string[]') {
          if (!Array.isArray(raw) || raw.some(entry => typeof entry !== 'string')) {
            issues.push({ message: '应为字符串数组', path: [key] })
            continue
          }
        } else if (typeof raw !== expected) {
          issues.push({ message: `应为 ${expected}`, path: [key] })
          continue
        }
        out[key] = raw
      }
      return issues.length > 0 ? { issues } : { value: out }
    },
  },
}

/** 读取 JSON 请求体（有上限，避免大 body 打爆内存）。 */
function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.trim() === '') {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch (error) {
        reject(new Error(`invalid JSON body: ${error instanceof Error ? error.message : String(error)}`))
      }
    })
    req.on('error', reject)
  })
}

/** 统一 JSON 响应。 */
function sendJson(res, payload, status = 200) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** 把查询串里的选项规范化成 SearchIndex.search 的参数。 */
function searchOptions(input, config, limitCap) {
  const limit = Math.min(Math.max(Number(input.limit ?? config.defaultLimit) || config.defaultLimit, 1), limitCap)
  const options = { query: String(input.query ?? ''), limit, mode: typeof input.match === 'string' ? input.match : 'auto' }
  if (Array.isArray(input.kinds) && input.kinds.length > 0) options.kinds = input.kinds.map(String)
  // 工具 schema 用的是 session_id（snake_case，与 kinds/since/until 一致），
  // 路由与内部调用用 sessionId；两个名字都认，否则模型传 session_id 会被静默忽略。
  const sessionId = typeof input.session_id === 'string' && input.session_id !== ''
    ? input.session_id
    : input.sessionId
  if (typeof sessionId === 'string' && sessionId !== '') options.sessionId = sessionId
  if (typeof input.cwd === 'string' && input.cwd !== '') options.cwd = input.cwd
  const since = Number.isFinite(input.since) ? Number(input.since) : parseTime(input.since)
  const until = Number.isFinite(input.until) ? Number(input.until) : parseTime(input.until)
  if (Number.isFinite(since)) options.since = since
  if (Number.isFinite(until)) options.until = until
  return options
}

export function apply(ctx, config = {}) {
  // 走一遍自己的 schema：loader 在真实挂载时会先 validate，直接 apply 的调用方
  // （测试、脚本）也应该拿到同样的默认值填充与报错，否则两条路径行为不一致。
  const validated = Config['~standard'].validate(config)
  if (validated.issues !== undefined) {
    throw new TypeError(`dsh-search 配置无效：${validated.issues.map(i => `${i.path?.join('.') ?? ''} ${i.message}`).join('; ')}`)
  }
  const settings = validated.value
  const home = dshHome()
  const dbPath = indexDbPath(home)
  const roots = Array.isArray(settings.fileRoots) && settings.fileRoots.length > 0
    ? settings.fileRoots
    : defaultFileRoots(process.env, homedir())

  const index = new SearchIndex(dbPath)
  index.open()

  /** 构建状态：worker 是唯一写入者，这里只保存主线程可见的进度快照。 */
  const state = {
    running: false,
    worker: null,
    progress: { phase: 'idle', docs: 0, sessions: 0, memories: 0, startedAt: null, finishedAt: null, lastError: null },
    lastResult: null,
  }

  const status = () => ({
    ok: true,
    index: index.stats(),
    building: state.running,
    progress: { ...state.progress, running: state.running },
    lastResult: state.lastResult,
    dbPath,
    dbExists: existsSync(dbPath),
    sessionsRoot: sessionsRoot(home),
    memgasRoot: memgasRoot(home),
    fileRoots: roots,
    includeFiles: settings.includeFiles === true,
  })

  /** 启动一次构建；已在运行时直接返回"已在运行"。 */
  const startBuild = (options = {}) => {
    if (state.running) return { ok: false, reason: 'already-running', status: status() }
    const workerPath = fileURLToPath(new URL('./worker.js', import.meta.url))
    state.running = true
    state.progress = { phase: 'starting', docs: 0, sessions: 0, memories: 0, startedAt: Date.now(), finishedAt: null, lastError: null }
    const worker = new Worker(workerPath, {
      workerData: {
        dbPath,
        sessionsRoot: sessionsRoot(home),
        memgasRoot: memgasRoot(home),
        home,
        full: options.full === true,
        includeFiles: options.includeFiles === true || settings.includeFiles === true,
        roots,
        exclude: Array.isArray(settings.exclude) ? settings.exclude : [],
      },
    })
    state.worker = worker
    worker.on('message', message => {
      if (message?.type === 'progress') state.progress = { ...message.progress, running: true }
      if (message?.type === 'done') state.lastResult = message.result
      if (message?.type === 'failed') state.progress = { ...state.progress, lastError: String(message.error) }
    })
    worker.on('error', error => {
      state.progress = { ...state.progress, lastError: error instanceof Error ? error.message : String(error) }
    })
    worker.on('exit', () => {
      state.running = false
      state.worker = null
      state.progress = { ...state.progress, running: false, finishedAt: Date.now(), phase: state.progress.lastError === null ? 'idle' : 'error' }
      // worker 是独立连接：它写入的 WAL 由主线程 checkpoint 落盘，并刷新检索连接可见性。
      try {
        index.checkpoint()
      } catch {
        // 有并发读时 checkpoint 可能失败，下次构建或关闭时再试。
      }
    })
    return { ok: true, status: status() }
  }

  const cancelBuild = () => {
    if (!state.running || state.worker === null) return { ok: false, reason: 'not-running' }
    state.worker.postMessage({ type: 'abort' })
    return { ok: true }
  }

  // 模型工具：与用户界面共用同一个索引，保证"模型搜到的"和"人搜到的"一致。
  ctx.effect(() => ctx.tools.register({
    ...SEARCH_TOOL,
    output: TEXT_OUTPUT,
    async execute(args) {
      if (!existsSync(dbPath) || index.stats().docs === 0) {
        return '检索索引还没有建立。请让用户在 DSH Web GUI 的「全局搜索」面板里点一次「建立索引」，或稍等自动索引完成。'
      }
      const options = searchOptions(args ?? {}, settings, 100)
      const scope = String(args?.scope ?? 'all')
      if (scope === 'memory') options.memoryOnly = true
      if (scope === 'sessions') { options.memoryOnly = false; options.excludeFiles = true }
      if (scope === 'files') options.kinds = ['file']
      const result = index.search(options)
      if (result.error !== undefined) return `检索失败：${result.error}`
      return renderResults(result, options.query, snippetFor)
    },
  }), 'dsh-search: search tool')

  ctx.effect(() => ctx.tools.register({
    ...READ_TOOL,
    output: TEXT_OUTPUT,
    async execute(args) {
      const id = Number(args?.doc_id)
      if (!Number.isFinite(id)) return 'doc_id 必须是数字（即 search_dsh 结果里 # 后面的编号）。'
      const doc = index.doc(id)
      if (doc === undefined) return `没有编号为 ${id} 的记录。索引可能已重建，请重新检索。`
      return renderDoc(doc, args?.offset, args?.limit)
    },
  }), 'dsh-search: read tool')

  // 用户界面用的本地路由。没有 Web 服务时整块跳过，工具仍然可用。
  ctx.inject(['webServer'], injected => {
    injected.effect(() => {
      const routes = [
        injected.webServer.register({
          kind: 'exact',
          path: `${PREFIX}/status`,
          handler: (req, res) => sendJson(res, status()),
        }),
        injected.webServer.register({
          kind: 'exact',
          path: `${PREFIX}/search`,
          handler: async (req, res) => {
            try {
              const url = new URL(req.url ?? '', 'http://localhost')
              const input = { ...Object.fromEntries(url.searchParams) }
              if (url.searchParams.has('kinds')) input.kinds = url.searchParams.getAll('kinds')
              const options = searchOptions(input, settings, 200)
              const scope = String(input.scope ?? 'all')
              if (scope === 'memory') options.memoryOnly = true
              if (scope === 'sessions') { options.memoryOnly = false; options.excludeFiles = true }
              if (scope === 'files') options.kinds = ['file']
              const started = Date.now()
              const result = index.search(options)
              if (result.error !== undefined) {
                sendJson(res, { ok: false, error: result.error }, 400)
                return
              }
              // 服务端算好片段与高亮区间：前端只负责渲染，避免同一套匹配逻辑写两遍。
              const hits = result.hits.map(hit => {
                const piece = snippetFor(hit.text, options.query, 260)
                return {
                  id: hit.id,
                  sessionId: hit.sessionId,
                  sessionTitle: hit.sessionTitle,
                  cwd: hit.cwd,
                  kind: hit.kind,
                  label: hit.label,
                  time: hit.time,
                  turn: hit.turn,
                  tool: hit.tool,
                  path: hit.path,
                  memoryId: hit.memoryId,
                  truncated: hit.truncated,
                  alsoAt: hit.alsoAt.map(entry => ({ id: entry.id, kind: entry.kind, seq: entry.seq })),
                  snippet: { prefix: piece.prefix, suffix: piece.suffix, segments: piece.segments },
                }
              })
              sendJson(res, {
                ok: true,
                total: result.total,
                shown: result.shown,
                terms: result.terms,
                mode: result.mode,
                relaxed: result.relaxed === true,
                ms: Date.now() - started,
                hits,
              })
            } catch (error) {
              sendJson(res, { ok: false, error: error instanceof Error ? error.message : String(error) }, 500)
            }
          },
        }),
        injected.webServer.register({
          kind: 'exact',
          path: `${PREFIX}/doc`,
          handler: (req, res) => {
            try {
              const url = new URL(req.url ?? '', 'http://localhost')
              const id = Number(url.searchParams.get('id'))
              if (!Number.isFinite(id)) {
                sendJson(res, { ok: false, error: 'id 必须是数字' }, 400)
                return
              }
              const doc = index.doc(id)
              if (doc === undefined) {
                sendJson(res, { ok: false, error: `没有编号为 ${id} 的记录` }, 404)
                return
              }
              const radius = Math.min(Math.max(Number(url.searchParams.get('radius') ?? 0) || 0, 0), 10)
              sendJson(res, {
                ok: true,
                doc,
                context: radius > 0 && doc.sessionId !== null && doc.seq !== null
                  ? index.context(doc.sessionId, doc.seq, radius)
                  : [],
              })
            } catch (error) {
              sendJson(res, { ok: false, error: error instanceof Error ? error.message : String(error) }, 500)
            }
          },
        }),
        injected.webServer.register({
          kind: 'exact',
          path: `${PREFIX}/sessions`,
          handler: (req, res) => {
            try {
              sendJson(res, { ok: true, sessions: index.listSessions(400) })
            } catch (error) {
              sendJson(res, { ok: false, error: error instanceof Error ? error.message : String(error) }, 500)
            }
          },
        }),
        injected.webServer.register({
          kind: 'exact',
          path: `${PREFIX}/build`,
          handler: async (req, res) => {
            try {
              const body = await readBody(req)
              sendJson(res, startBuild({ full: body.full === true, includeFiles: body.includeFiles === true }))
            } catch (error) {
              sendJson(res, { ok: false, error: error instanceof Error ? error.message : String(error) }, 400)
            }
          },
        }),
        injected.webServer.register({
          kind: 'exact',
          path: `${PREFIX}/cancel`,
          handler: (req, res) => sendJson(res, cancelBuild()),
        }),
      ]
      return () => { for (const dispose of routes) dispose() }
    }, 'dsh-search: web routes')
  })

  // 自动增量索引：延迟首跑（避开启动高峰），之后按间隔续跑。
  // 构建在 worker 里，主线程只做一次 postMessage，因此不会卡住会话。
  const delay = Number(settings.autoIndexDelayMs) || 0
  const interval = Number(settings.autoIndexIntervalMs) || 0
  if (delay > 0) {
    ctx.effect(() => ctx.timer.timeout(() => {
      startBuild({})
      if (interval > 0) {
        const dispose = ctx.timer.interval(() => startBuild({}), interval)
        ctx.effect(() => dispose, 'dsh-search: auto index interval')
      }
    }, delay), 'dsh-search: auto index kickoff')
  }

  // 卸载时：停 worker、关连接。索引文件保留（下次启动继续增量）。
  ctx.effect(() => () => {
    if (state.worker !== null) {
      void state.worker.terminate()
      state.worker = null
    }
    index.close()
  }, 'dsh-search: teardown')

  // 供其它插件/诊断使用：把只读检索面暴露成一个服务。
  ctx.effect(() => ctx.provide('dshSearch', {
    search: options => index.search(options),
    doc: id => index.doc(id),
    status,
    build: startBuild,
    cancel: cancelBuild,
    sessions: limit => index.listSessions(limit),
    projectedTitles: () => readProjectedTitles(home),
  }), 'dsh-search: service')
}