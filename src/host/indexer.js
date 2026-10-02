/**
 * dsh-search · 索引编排
 *
 * 一次"构建/更新"的完整流程，以及它的进度与取消语义：
 *   1. 会话语料：先按文件的字节游标增量扫；只有解析出**新文档**的文件才写库。
 *      文件变小（被重写）→ 删掉该会话旧文档后全量重扫。
 *   2. 记忆语料：m_*.md 按 mtime 判断是否需要重扫（文件小、数量少，全量也很便宜）。
 *   3. 工作区文件语料（可选）：按根目录递归，带排除规则；单文件上限与总量上限。
 *
 * 并发与取消：
 *   - 同一时刻只允许一个构建在跑（互斥锁）；重复请求返回"已在运行"。
 *   - abort() 在批次之间生效：已写入的批次保留（索引是可再生的），状态标为 cancelled。
 *   - 进度是**可读快照**，不持有任何 live 对象：{ phase, done, total, docs, startedAt, ... }。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { clipDocText } from '../core/extract.js'
import { readProjectedTitles } from './projcache.js'
import { scanMemories, scanSessions } from './scan.js'

/** 单文件索引上限（工作区文件）：超过则跳过并在状态里报告。 */
export const FILE_MAX_BYTES = 2 * 1024 * 1024

/** 工作区文件的总量上限：防止一次误配根目录把索引撑爆。 */
export const FILE_TOTAL_LIMIT = 200_000

const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', 'out',
  '.next', '.nuxt', '.cache', '.parcel-cache', 'coverage', '.pnpm-store',
  'target', 'bin', 'obj', '.idea', '.vscode', '.DS_Store',
])

const TEXT_EXT = new Set([
  '.md', '.markdown', '.txt', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.jsonc',
  '.yml', '.yaml', '.toml', '.ini', '.cfg', '.conf', '.css', '.scss', '.less', '.html', '.htm',
  '.xml', '.svg', '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd', '.py', '.rb', '.go',
  '.rs', '.java', '.kt', '.swift', '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.php', '.lua',
  '.sql', '.graphql', '.proto', '.vue', '.svelte', '.astro', '.env', '.gitignore', '.dockerfile',
  '.csv', '.tsv', '.log', '.patch', '.diff', '.lock',
])

/** 无扩展名但值得索引的常见文件。 */
const TEXT_BASENAMES = new Set(['dockerfile', 'makefile', 'readme', 'license', 'agents.md', 'claude.md'])

/** 判断一个文件是否按文本索引。 */
function isTextFile(name) {
  const lower = name.toLowerCase()
  const dot = lower.lastIndexOf('.')
  if (dot <= 0) return TEXT_BASENAMES.has(lower)
  return TEXT_EXT.has(lower.slice(dot))
}

export class Indexer {
  /**
   * @param index SearchIndex 实例
   * @param paths { sessionsRoot, memgasRoot }
   */
  constructor(index, paths) {
    this.index = index
    this.paths = paths
    this.running = false
    this.abortRequested = false
    this.progress = {
      phase: 'idle',
      running: false,
      docs: 0,
      sessions: 0,
      memories: 0,
      files: 0,
      malformed: 0,
      skipped: 0,
      startedAt: null,
      finishedAt: null,
      lastError: null,
      lastResult: null,
    }
  }

  /** 当前进度快照（纯数据）。 */
  snapshot() {
    return { ...this.progress, running: this.running }
  }

  /** 请求取消：在批次之间生效。 */
  abort() {
    if (this.running) this.abortRequested = true
    return this.abortRequested
  }

  /**
   * 构建/更新索引。
   * @param options { roots?: string[], full?: boolean, includeFiles?: boolean }
   * @returns 结果汇总
   */
  async build(options = {}) {
    if (this.running) return { ok: false, reason: 'already-running', progress: this.snapshot() }
    this.running = true
    this.abortRequested = false
    const started = Date.now()
    this.progress = {
      ...this.progress,
      phase: 'sessions',
      running: true,
      docs: 0,
      sessions: 0,
      memories: 0,
      files: 0,
      malformed: 0,
      skipped: 0,
      startedAt: started,
      finishedAt: null,
      lastError: null,
    }
    try {
      if (options.full === true) this.index.reset()
      const result = {
        sessions: await this.#buildSessions(options),
        titles: this.#applyProjectedTitles(),
        memories: await this.#buildMemories(options),
        files: null,
      }
      if (options.includeFiles === true && Array.isArray(options.roots) && options.roots.length > 0) {
        result.files = await this.#buildFiles(options)
      }
      const cancelled = this.abortRequested
      this.progress = {
        ...this.progress,
        phase: cancelled ? 'cancelled' : 'idle',
        running: false,
        finishedAt: Date.now(),
        lastResult: {
          ok: true,
          cancelled,
          ms: Date.now() - started,
          docs: this.progress.docs,
          sessions: result.sessions,
          memories: result.memories,
          files: result.files,
        },
      }
      this.index.checkpoint()
      return { ok: true, cancelled, result, progress: this.snapshot() }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.progress = {
        ...this.progress,
        phase: 'error',
        running: false,
        finishedAt: Date.now(),
        lastError: message,
      }
      return { ok: false, reason: message, progress: this.snapshot() }
    } finally {
      this.running = false
      this.abortRequested = false
    }
  }

  /** 会话语料：增量扫描 + 分批写入。 */
  async #buildSessions(options) {
    const known = this.index.fileStates()
    const pending = []
    let written = 0
    const flush = () => {
      if (pending.length === 0) return
      written += this.index.writeBatch(pending.splice(0, pending.length))
      this.progress.docs = written
    }

    const totals = scanSessions(this.paths.sessionsRoot, known, {
      onHeader: header => {
        if (header.id !== undefined && header.id !== '') {
          this.index.upsertSession({
            sessionId: header.id,
            projectKey: header.projectKey,
            cwd: header.cwd,
            createdAt: header.createdAt,
            parentSession: header.parentSession,
            origin: header.origin,
            agentPreset: header.agentPreset,
            delegationDepth: header.delegationDepth,
          })
        }
      },
      onTitle: info => {
        this.index.upsertSession({ sessionId: info.sessionId, projectKey: info.projectKey, title: info.title })
      },
      onDoc: doc => {
        const clipped = clipDocText(doc.text)
        pending.push({
          sessionId: doc.sessionId,
          projectKey: doc.projectKey,
          kind: doc.kind,
          label: doc.label,
          seq: doc.seq,
          time: doc.time,
          turn: doc.turn,
          step: doc.step,
          tool: doc.tool,
          text: clipped.text,
          truncated: clipped.truncated,
        })
        if (pending.length >= 4000) flush()
      },
      onFile: state => {
        flush()
        // 只有在"文件被重写"（scanSessionDir 判定 reset）时才丢弃旧文档重来。
        // 未变化的文件根本不会走到这里；确实变空了的文件由下面的 docs 归零处理。
        if (state.reset === true) this.index.deleteSession(state.sessionId)
        this.index.saveFileState(state)
        // docs 是**会话累计文档数**，不是本次扫描的增量。
        // 增量扫描（unchanged / 只追加）时 state.docs 是"这次新增几条"，
        // 直接写进去会把已有会话的文档数打回 0，UI 的会话下拉就只剩刚扫到的那几个。
        // 真实条数以 docs 表为准：重扫（reset）后它已经被删干净，所以这个查询天然自洽。
        this.index.upsertSession({
          sessionId: state.sessionId,
          projectKey: state.projectKey,
          docs: this.index.countDocs(state.sessionId),
          lastTime: state.lastTime,
        })
        this.progress.sessions += 1
        if (this.abortRequested) throw new AbortError()
      },
    })

    flush()
    this.progress.malformed += totals.malformed
    this.progress.skipped += totals.corrupt + totals.missing
    this.progress.docs = written
    return { ...totals, written }
  }

  /**
   * 用投影缓存补标题。
   *
   * 会话日志里的 `session/title` 记录是首选来源（最权威、随日志一起更新）；
   * 但被清理过日志的会话就只剩缓存里那一份标题。这里只补**日志里没有标题**的会话，
   * 所以不会覆盖更新的日志标题。
   *
   * 标题文档本身要进全文索引（用户明确要求"标题也要能搜"），因此补标题时
   * 同时写一条 kind='title' 的文档；已经有 title 文档的会话跳过，避免重复。
   */
  #applyProjectedTitles() {
    const home = this.paths.home
    if (typeof home !== 'string' || home === '') return { scanned: 0, titled: 0, docs: 0 }
    const entries = readProjectedTitles(home)
    if (entries.length === 0) return { scanned: 0, titled: 0, docs: 0 }

    const db = this.index.open()
    const withTitle = new Set(
      db.prepare("select session_id from docs where kind = 'title'").all().map(row => String(row.session_id)),
    )
    const pending = []
    let titled = 0
    for (const entry of entries) {
      if (entry.title !== null && !withTitle.has(entry.sessionId)) {
        pending.push({
          sessionId: entry.sessionId,
          projectKey: null,
          kind: 'title',
          label: '会话标题',
          text: entry.title,
          time: entry.createdAt,
        })
        titled += 1
      }
      this.index.upsertSession({
        sessionId: entry.sessionId,
        title: entry.title,
        cwd: entry.cwd,
        createdAt: entry.createdAt,
      })
    }
    const docs = pending.length > 0 ? this.index.writeBatch(pending) : 0
    this.progress.docs += docs
    return { scanned: entries.length, titled, docs }
  }

  /** 记忆语料：全量重扫（文件少、体积小）。 */
  async #buildMemories(options) {
    this.progress.phase = 'memories'
    const pending = []
    let written = 0
    const totals = scanMemories(this.paths.memgasRoot, {
      onDoc: doc => {
        const clipped = clipDocText(doc.text)
        pending.push({
          kind: 'memory',
          label: doc.label,
          text: clipped.text,
          truncated: clipped.truncated,
          memoryId: doc.memoryId,
          scope: doc.scope,
          status: doc.status,
          // 记忆的时间戳来自 front-matter 的 created_at；丢了它，记忆命中就没有
          // 相对时间显示，`since`/`until` 过滤也会把它们整类排除。
          time: Number.isFinite(doc.createdAt) ? doc.createdAt : null,
          path: doc.path,
        })
      },
    })
    if (pending.length > 0) {
      // 记忆是"全量重扫"：先清掉这批记忆 id 的旧文档，避免重复累积。
      const ids = new Set(pending.map(doc => doc.memoryId))
      for (const id of ids) this.index.deleteMemory(id)
      written = this.index.writeBatch(pending)
    }
    this.progress.memories = totals.docs
    this.progress.docs += written
    return { ...totals, written }
  }

  /** 工作区文件语料（可选）：按根目录递归文本文件。 */
  async #buildFiles(options) {
    this.progress.phase = 'files'
    const roots = Array.isArray(options.roots) ? options.roots : []
    const exclude = Array.isArray(options.exclude) ? options.exclude : []
    const pending = []
    let written = 0
    let scanned = 0
    let skipped = 0
    const flush = () => {
      if (pending.length === 0) return
      written += this.index.writeBatch(pending.splice(0, pending.length))
    }
    const seen = new Set()
    const walk = root => {
      let entries
      try {
        entries = readdirSync(root, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (this.abortRequested) throw new AbortError()
        if (scanned >= FILE_TOTAL_LIMIT) return
        const full = join(root, entry.name)
        if (exclude.some(pattern => full.includes(pattern))) continue
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue
          if (entry.name.startsWith('.') && entry.name !== '.dsh') continue
          walk(full)
          continue
        }
        if (!entry.isFile()) continue
        if (!isTextFile(entry.name)) continue
        let stat
        try {
          stat = statSync(full)
        } catch {
          continue
        }
        if (stat.size === 0 || stat.size > FILE_MAX_BYTES) {
          skipped += 1
          continue
        }
        scanned += 1
        let text
        try {
          text = readFileSync(full, 'utf8')
        } catch {
          skipped += 1
          continue
        }
        if (text.includes('\u0000')) {
          skipped += 1
          continue
        }
        const rel = relative(root, full)
        const clipped = clipDocText(text)
        pending.push({
          kind: 'file',
          label: `工作区文件 · ${rel.split(sep).pop() ?? rel}`,
          text: clipped.text,
          truncated: clipped.truncated,
          path: full,
        })
        seen.add(full)
        if (pending.length >= 2000) flush()
      }
    }
    for (const root of roots) {
      try {
        const stat = statSync(root)
        if (stat.isDirectory()) walk(root)
      } catch {
        continue
      }
    }
    flush()
    this.progress.files = written
    this.progress.docs += written
    this.progress.skipped += skipped
    return { roots: roots.length, scanned, written, skipped }
  }
}

/** 取消信号：在扫描回调里抛出，交给 build() 的统一 catch 处理。 */
export class AbortError extends Error {
  constructor() {
    super('indexing cancelled')
    this.name = 'AbortError'
  }
}
