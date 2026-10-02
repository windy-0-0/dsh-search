/**
 * dsh-search · 索引库（SQLite + FTS5）
 *
 * 为什么用 FTS5 而不是自己写倒排：node:sqlite 是 Node 内置的（无原生依赖、无编译、
 * 无供应链风险），FTS5 自带 BM25 排序、前缀查询与事务一致性。全量语料约 1.2GB 文本、
 * 数百万文档，自建倒排在内存与查询延迟上都不划算。
 *
 * 关键设计：
 *   - `docs` 存全文（检索要能出片段、要能整段读回）；`docs_fts` 是 contentless 索引
 *     （`content=''` + `contentless_delete=1`），只存 token 流，省一半以上空间，
 *     且支持按 rowid 删除 —— 增量重建时不必整库重来。
 *   - 写入按批事务提交：一批 2000 行，兼顾速度与"中途失败只回滚一批"。
 *   - `files` 表记住每个会话文件消费到的字节偏移，实现真正的增量索引。
 *   - 排序 = BM25 相关度 × 时间新鲜度 × 命中种类权重：
 *       用户消息/标题 权重最高（你要找的多半是自己说过的话或某个会话），
 *       工具结果次之，思考过程最低。
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { tokenize } from '../core/tokenize.js'
import { buildMatch, parseQuery } from '../core/query.js'

/** 索引 schema 版本；结构变化时整库重建。 */
export const SCHEMA_VERSION = 1

/** 文档种类在排序里的权重（越大越优先）。 */
const KIND_WEIGHT = {
  title: 1.45,
  user: 1.30,
  goal: 1.20,
  summary: 1.15,
  assistant: 1.05,
  todo: 1.0,
  command: 1.0,
  command_result: 0.95,
  approval: 0.95,
  memory: 1.25,
  inject: 1.0,
  tool_call: 0.92,
  tool_result: 0.85,
  reasoning: 0.75,
  defend: 0.7,
  file: 0.95,
}

const INSERT_BATCH = 2000

export class SearchIndex {
  /**
   * @param dbPath 索引库绝对路径
   */
  constructor(dbPath) {
    this.dbPath = dbPath
    this.db = null
    this.txDepth = 0
  }

  /** 打开（必要时创建）索引库并确保 schema 就绪。 */
  open() {
    if (this.db !== null) return this.db
    mkdirSync(dirname(this.dbPath), { recursive: true })
    const db = new DatabaseSync(this.dbPath)
    db.exec('pragma journal_mode = wal')
    db.exec('pragma synchronous = normal')
    db.exec('pragma temp_store = memory')
    this.db = db
    this.#ensureSchema()
    return db
  }

  /** 关闭索引库（幂等）。 */
  close() {
    if (this.db === null) return
    try {
      this.db.close()
    } catch {
      // 已经关闭或进程退出中：无需处理。
    }
    this.db = null
  }

  #ensureSchema() {
    const db = this.db
    const versionRow = (() => {
      try {
        const row = db.prepare('select value from meta where key = ?').get('schema_version')
        return row === undefined ? 0 : Number(row.value)
      } catch {
        return -1
      }
    })()
    if (versionRow === SCHEMA_VERSION) return

    // 结构不匹配（含首次建库、旧版本）→ 重建。索引是可再生数据，重建是唯一安全路径。
    db.exec('drop table if exists docs_fts')
    db.exec('drop table if exists docs')
    db.exec('drop table if exists files')
    db.exec('drop table if exists sessions')
    db.exec('drop table if exists meta')
    db.exec(`
      create table meta (key text primary key, value text)
    `)
    db.exec(`
      create table docs (
        id integer primary key,
        session_id text,
        project_key text,
        kind text not null,
        label text,
        seq integer,
        time integer,
        turn integer,
        step integer,
        tool text,
        memory_id text,
        scope text,
        status text,
        path text,
        truncated integer default 0,
        text text not null
      )
    `)
    db.exec(`
      create virtual table docs_fts using fts5(
        tok,
        content='',
        contentless_delete=1,
        tokenize="unicode61 remove_diacritics 2"
      )
    `)
    db.exec(`
      create table files (
        session_id text primary key,
        project_key text,
        dir text,
        size integer,
        byte_offset integer,
        docs integer,
        scanned_at integer
      )
    `)
    db.exec(`
      create table sessions (
        session_id text primary key,
        project_key text,
        title text,
        cwd text,
        created_at integer,
        parent_session text,
        origin text,
        agent_preset text,
        delegation_depth integer,
        docs integer,
        last_time integer,
        updated_at integer
      )
    `)
    db.exec('create index docs_session on docs(session_id)')
    db.exec('create index docs_kind on docs(kind)')
    db.exec('create index docs_time on docs(time)')
    db.exec('create index docs_memory on docs(memory_id)')
    db.prepare('insert into meta(key, value) values(?, ?)').run('schema_version', String(SCHEMA_VERSION))
    db.prepare('insert into meta(key, value) values(?, ?)').run('built_at', String(Date.now()))
  }

  /** 某个会话当前真实存在的文档条数（重扫后即为新值，天然自洽）。 */
  countDocs(sessionId) {
    const row = this.open().prepare('select count(*) as n from docs where session_id = ?').get(sessionId)
    return Number(row?.n ?? 0)
  }

  /** 已索引会话文件的游标状态：Map<sessionId, {byteOffset, size, docs}>。 */
  fileStates() {
    const map = new Map()
    const rows = this.open().prepare('select session_id, byte_offset, size, docs from files').all()
    for (const row of rows) {
      map.set(String(row.session_id), {
        byteOffset: Number(row.byte_offset ?? 0),
        size: Number(row.size ?? 0),
        docs: Number(row.docs ?? 0),
      })
    }
    return map
  }

  /** 会话元数据（标题/工作目录等）由扫描器在索引时写入。 */
  upsertSession(meta) {
    const db = this.open()
    const existing = db.prepare('select session_id, title, cwd, created_at, parent_session, origin, agent_preset, delegation_depth, docs, last_time from sessions where session_id = ?').get(meta.sessionId)
    const merged = {
      sessionId: meta.sessionId,
      projectKey: meta.projectKey ?? existing?.project_key ?? null,
      title: meta.title ?? existing?.title ?? null,
      cwd: meta.cwd ?? existing?.cwd ?? null,
      createdAt: meta.createdAt ?? existing?.created_at ?? null,
      parentSession: meta.parentSession ?? existing?.parent_session ?? null,
      origin: meta.origin ?? existing?.origin ?? null,
      agentPreset: meta.agentPreset ?? existing?.agent_preset ?? null,
      delegationDepth: meta.delegationDepth ?? existing?.delegation_depth ?? null,
      docs: meta.docs ?? existing?.docs ?? 0,
      lastTime: meta.lastTime ?? existing?.last_time ?? null,
      updatedAt: Date.now(),
    }
    db.prepare(`
      insert into sessions(session_id, project_key, title, cwd, created_at, parent_session, origin, agent_preset, delegation_depth, docs, last_time, updated_at)
      values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(session_id) do update set
        project_key = excluded.project_key,
        title = coalesce(excluded.title, sessions.title),
        cwd = coalesce(excluded.cwd, sessions.cwd),
        created_at = coalesce(excluded.created_at, sessions.created_at),
        parent_session = coalesce(excluded.parent_session, sessions.parent_session),
        origin = coalesce(excluded.origin, sessions.origin),
        agent_preset = coalesce(excluded.agent_preset, sessions.agent_preset),
        delegation_depth = coalesce(excluded.delegation_depth, sessions.delegation_depth),
        docs = excluded.docs,
        last_time = coalesce(excluded.last_time, sessions.last_time),
        updated_at = excluded.updated_at
    `).run(
      merged.sessionId, merged.projectKey, merged.title, merged.cwd, merged.createdAt,
      merged.parentSession, merged.origin, merged.agentPreset, merged.delegationDepth,
      merged.docs, merged.lastTime, merged.updatedAt,
    )
  }

  /** 记录某个会话文件消费到的偏移。 */
  saveFileState(state) {
    this.open().prepare(`
      insert into files(session_id, project_key, dir, size, byte_offset, docs, scanned_at)
      values(?, ?, ?, ?, ?, ?, ?)
      on conflict(session_id) do update set
        project_key = excluded.project_key,
        dir = excluded.dir,
        size = excluded.size,
        byte_offset = excluded.byte_offset,
        docs = excluded.docs,
        scanned_at = excluded.scanned_at
    `).run(state.sessionId, state.projectKey, state.dir, state.size, state.byteOffset, state.docs, Date.now())
  }

  /** 删除某个会话的全部文档（重扫前清理）。 */
  deleteSession(sessionId) {
    const db = this.open()
    const ids = db.prepare('select id from docs where session_id = ?').all(sessionId)
    const delFts = db.prepare('delete from docs_fts where rowid = ?')
    for (const row of ids) delFts.run(row.id)
    db.prepare('delete from docs where session_id = ?').run(sessionId)
  }

  /** 删除某个记忆的全部文档。 */
  deleteMemory(memoryId) {
    const db = this.open()
    const ids = db.prepare('select id from docs where memory_id = ?').all(memoryId)
    const delFts = db.prepare('delete from docs_fts where rowid = ?')
    for (const row of ids) delFts.run(row.id)
    db.prepare('delete from docs where memory_id = ?').run(memoryId)
  }

  /** 清空会话/记忆语料（不动 schema）；工作区文件语料单独清。 */
  clearCorpus(kinds) {
    const db = this.open()
    const list = Array.isArray(kinds) ? kinds : ['session', 'memory']
    for (const kind of list) {
      const ids = kind === 'memory'
        ? db.prepare('select id from docs where memory_id is not null').all()
        : db.prepare('select id from docs where kind != ? and memory_id is null').all('memory')
      const delFts = db.prepare('delete from docs_fts where rowid = ?')
      for (const row of ids) delFts.run(row.id)
      if (kind === 'memory') db.exec('delete from docs where memory_id is not null')
      else db.prepare('delete from docs where kind != ? and memory_id is null').run('memory')
    }
  }

  /** 全库清空（保留 schema 与 meta）。 */
  reset() {
    const db = this.open()
    db.exec('delete from docs_fts')
    db.exec('delete from docs')
    db.exec('delete from files')
    db.exec('delete from sessions')
    db.prepare('update meta set value = ? where key = ?').run(String(Date.now()), 'built_at')
  }

  /** 提交一批文档（自动分批事务）。 */
  writeBatch(docs) {
    if (!Array.isArray(docs) || docs.length === 0) return 0
    const db = this.open()
    const insDoc = db.prepare(`
      insert into docs(session_id, project_key, kind, label, seq, time, turn, step, tool, memory_id, scope, status, path, truncated, text)
      values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const insFts = db.prepare('insert into docs_fts(rowid, tok) values(?, ?)')
    let written = 0
    let i = 0
    while (i < docs.length) {
      const slice = docs.slice(i, i + INSERT_BATCH)
      i += INSERT_BATCH
      db.exec('begin')
      try {
        for (const doc of slice) {
          const info = insDoc.run(
            doc.sessionId ?? null, doc.projectKey ?? null, doc.kind, doc.label ?? null,
            doc.seq ?? null, doc.time ?? null, doc.turn ?? null, doc.step ?? null,
            doc.tool ?? null, doc.memoryId ?? null, doc.scope ?? null, doc.status ?? null,
            doc.path ?? null, doc.truncated ? 1 : 0, doc.text ?? '',
          )
          const id = Number(info.lastInsertRowid)
          const tok = tokenize(`${doc.label ?? ''} ${doc.text ?? ''}`)
          if (tok !== '') insFts.run(id, tok)
          written += 1
        }
        db.exec('commit')
      } catch (error) {
        try {
          db.exec('rollback')
        } catch {
          // 回滚失败：连接可能已损坏，交给上层重建。
        }
        throw error
      }
    }
    this.touch()
    return written
  }

  /** 记下"索引内容最后更新于"。写入是唯一会改变内容的事件，所以由写入方调用。 */
  touch() {
    this.open().prepare(`
      insert into meta(key, value) values('refreshed_at', ?)
      on conflict(key) do update set value = excluded.value
    `).run(String(Date.now()))
  }

  /** 运行一次 checkpoint，把 WAL 落到主库（空闲时调用，避免 WAL 无限增长）。 */
  checkpoint() {
    try {
      this.open().exec('pragma wal_checkpoint(truncate)')
    } catch {
      // 有并发读时 checkpoint 可能失败，下次再试。
    }
  }

  /** 索引统计：文档数、会话数、种类分布、库体积。 */
  stats() {
    const db = this.open()
    const docs = Number(db.prepare('select count(*) as n from docs').get().n ?? 0)
    const sessions = Number(db.prepare('select count(*) as n from sessions').get().n ?? 0)
    const memories = Number(db.prepare('select count(*) as n from docs where memory_id is not null').get().n ?? 0)
    const byKind = db.prepare('select kind, count(*) as n from docs group by kind order by n desc').all()
    const last = db.prepare('select max(time) as t from docs').get()
    const builtAt = db.prepare('select value from meta where key = ?').get('built_at')
    const refreshedAt = db.prepare('select value from meta where key = ?').get('refreshed_at')
    return {
      docs,
      sessions,
      memories,
      byKind: byKind.map(row => ({ kind: String(row.kind), count: Number(row.n) })),
      latestDocTime: last?.t === null || last?.t === undefined ? null : Number(last.t),
      // builtAt 是"建库"时间（schema 创建那一刻），只在重建时变；
      // 界面要的是"索引内容最后更新于"，所以另记一个每次写入都刷新的时间。
      builtAt: builtAt === undefined ? null : Number(builtAt.value),
      refreshedAt: refreshedAt === undefined ? null : Number(refreshedAt.value),
    }
  }

  /** 会话下拉列表（供 UI 过滤）。 */
  listSessions(limit = 300) {
    return this.open().prepare(`
      select s.session_id, s.title, s.cwd, s.project_key, s.docs, s.last_time, s.origin
      from sessions s
      where s.docs > 0
      order by coalesce(s.last_time, s.created_at, 0) desc
      limit ?
    `).all(limit).map(row => ({
      sessionId: String(row.session_id),
      title: row.title === null || row.title === undefined ? null : String(row.title),
      cwd: row.cwd === null || row.cwd === undefined ? null : String(row.cwd),
      projectKey: row.project_key === null || row.project_key === undefined ? null : String(row.project_key),
      docs: Number(row.docs ?? 0),
      lastTime: row.last_time === null || row.last_time === undefined ? null : Number(row.last_time),
      origin: row.origin === null || row.origin === undefined ? null : String(row.origin),
    }))
  }

  /** 会话详情（含标题、文档数、时间范围）。 */
  sessionInfo(sessionId) {
    const row = this.open().prepare('select * from sessions where session_id = ?').get(sessionId)
    if (row === undefined) return undefined
    return {
      sessionId: String(row.session_id),
      title: row.title === null || row.title === undefined ? null : String(row.title),
      cwd: row.cwd === null || row.cwd === undefined ? null : String(row.cwd),
      projectKey: row.project_key === null || row.project_key === undefined ? null : String(row.project_key),
      createdAt: row.created_at === null || row.created_at === undefined ? null : Number(row.created_at),
      parentSession: row.parent_session === null || row.parent_session === undefined ? null : String(row.parent_session),
      origin: row.origin === null || row.origin === undefined ? null : String(row.origin),
      agentPreset: row.agent_preset === null || row.agent_preset === undefined ? null : String(row.agent_preset),
      delegationDepth: row.delegation_depth === null || row.delegation_depth === undefined ? null : Number(row.delegation_depth),
      docs: Number(row.docs ?? 0),
      lastTime: row.last_time === null || row.last_time === undefined ? null : Number(row.last_time),
    }
  }

  /**
   * 检索。
   * @param options { query, mode, kinds, sessionId, projectKey, since, until, limit, offset, context }
   * @returns { hits, total, terms, mode, relaxed }
   */
  search(options) {
    const db = this.open()
    const query = typeof options.query === 'string' ? options.query : ''
    const parsed = parseQuery(query)
    if (parsed.error !== undefined) return { hits: [], total: 0, terms: [], mode: options.mode ?? 'all', relaxed: false }

    const limit = Math.min(Math.max(Number(options.limit ?? 30) || 30, 1), 200)
    const offset = Math.max(Number(options.offset ?? 0) || 0, 0)
    const mode = typeof options.mode === 'string' ? options.mode : 'auto'
    const attempts = mode === 'auto' ? ['all', 'any'] : [mode]

    let lastResult = null
    for (let i = 0; i < attempts.length; i += 1) {
      const matchMode = attempts[i]
      const match = buildMatch(parsed.groups, matchMode === 'auto' ? 'all' : matchMode)
      if (match === '') break
      const result = this.#runSearch({ match, parsed, options, limit, offset, matchMode })
      lastResult = result
      if (result.total > 0) return { ...result, relaxed: i > 0 }
    }
    return lastResult ?? { hits: [], total: 0, terms: parsed.terms, mode, relaxed: false }
  }

  #runSearch({ match, parsed, options, limit, offset, matchMode }) {
    const db = this.open()
    const where = []
    const params = []
    if (Array.isArray(options.kinds) && options.kinds.length > 0) {
      where.push(`d.kind in (${options.kinds.map(() => '?').join(', ')})`)
      params.push(...options.kinds)
    }
    if (typeof options.sessionId === 'string' && options.sessionId !== '') {
      where.push('d.session_id = ?')
      params.push(options.sessionId)
    }
    if (typeof options.projectKey === 'string' && options.projectKey !== '') {
      where.push('d.project_key = ?')
      params.push(options.projectKey)
    }
    // 按工作目录过滤：文档表本身不存 cwd（同一会话的 cwd 固定），所以过滤的是 join 上来的会话行。
    if (typeof options.cwd === 'string' && options.cwd !== '') {
      where.push('s.cwd = ?')
      params.push(options.cwd)
    }
    if (Number.isFinite(options.since)) {
      where.push('coalesce(d.time, 0) >= ?')
      params.push(options.since)
    }
    if (Number.isFinite(options.until)) {
      where.push('coalesce(d.time, 0) <= ?')
      params.push(options.until)
    }
    if (options.memoryOnly === true) where.push('d.memory_id is not null')
    if (options.memoryOnly === false) where.push('d.memory_id is null')
    // 工作区文件也是 memory_id is null，所以"只要会话"必须显式排掉 kind='file'，
    // 否则打开 includeFiles 之后 scope=sessions 会混进文件命中。
    if (options.excludeFiles === true) where.push("d.kind != 'file'")
    const filter = where.length > 0 ? `and ${where.join(' and ')}` : ''

    const sql = `
      select d.id, d.session_id, d.project_key, d.kind, d.label, d.seq, d.time, d.turn, d.step,
             d.tool, d.memory_id, d.scope, d.status, d.path, d.truncated, d.text,
             bm25(docs_fts) as score,
             s.title as session_title, s.cwd as session_cwd, s.origin as session_origin
      from docs_fts f
      join docs d on d.id = f.rowid
      left join sessions s on s.session_id = d.session_id
      where docs_fts match ? ${filter}
      order by score
      limit ? offset ?
    `
    let rows
    try {
      rows = db.prepare(sql).all(match, ...params, limit * 4, offset)
    } catch (error) {
      return { hits: [], total: 0, terms: parsed.terms, mode: matchMode, error: error instanceof Error ? error.message : String(error) }
    }

    const countSql = `
      select count(*) as n
      from docs_fts f
      join docs d on d.id = f.rowid
      left join sessions s on s.session_id = d.session_id
      where docs_fts match ? ${filter}
    `
    let total = rows.length
    try {
      total = Number(db.prepare(countSql).get(match, ...params).n ?? rows.length)
    } catch {
      // 计数失败时用当前页数量兜底，不影响结果可用性。
    }

    const now = Date.now()
    const ranked = []
    for (const row of rows) {
      const weight = KIND_WEIGHT[String(row.kind)] ?? 0.9
      const rawScore = Number(row.score ?? 0)
      // bm25 越小越相关；取负转成"越大越好"，再乘种类权重与时间新鲜度。
      const relevance = -rawScore
      const age = row.time === null || row.time === undefined ? Number.POSITIVE_INFINITY : now - Number(row.time)
      const days = Number.isFinite(age) ? age / 86_400_000 : 999
      const freshness = 1 + 0.35 / (1 + days / 7)
      ranked.push({
        id: Number(row.id),
        sessionId: row.session_id === null || row.session_id === undefined ? null : String(row.session_id),
        sessionTitle: row.session_title === null || row.session_title === undefined ? null : String(row.session_title),
        cwd: row.session_cwd === null || row.session_cwd === undefined ? null : String(row.session_cwd),
        origin: row.session_origin === null || row.session_origin === undefined ? null : String(row.session_origin),
        projectKey: row.project_key === null || row.project_key === undefined ? null : String(row.project_key),
        kind: String(row.kind),
        label: row.label === null || row.label === undefined ? null : String(row.label),
        seq: row.seq === null || row.seq === undefined ? null : Number(row.seq),
        time: row.time === null || row.time === undefined ? null : Number(row.time),
        turn: row.turn === null || row.turn === undefined ? null : Number(row.turn),
        step: row.step === null || row.step === undefined ? null : Number(row.step),
        tool: row.tool === null || row.tool === undefined ? null : String(row.tool),
        memoryId: row.memory_id === null || row.memory_id === undefined ? null : String(row.memory_id),
        scope: row.scope === null || row.scope === undefined ? null : String(row.scope),
        status: row.status === null || row.status === undefined ? null : String(row.status),
        path: row.path === null || row.path === undefined ? null : String(row.path),
        truncated: Number(row.truncated ?? 0) === 1,
        text: String(row.text ?? ''),
        score: relevance * weight * freshness,
        alsoAt: [],
      })
    }
    ranked.sort((a, b) => b.score - a.score)
    const deduped = this.#collapse(ranked)
    return {
      hits: deduped.slice(0, limit),
      // total 是"命中条数"，与去重后的列表长度不同：用户要的是"到底有多少条相关记录"，
      // 而不是"去掉重复后还剩几条"，所以这里报原始命中数，另给 shown 说明实际列出多少。
      total,
      shown: deduped.length,
      terms: parsed.terms,
      mode: matchMode,
    }
  }

  /**
   * 同一段文本在日志里出现多次是常态：`agent/inbox/spliced` 会把同一条用户消息
   * 再记一遍（同一会话内 inject 与 user 文本相同），子 agent 会话还会继承父会话前缀。
   * 这些重复命中会把"前 20 条"整个占满，用户看到一堆一模一样的行。
   *
   * 去重键是「同会话 + 同文本前 200 字」：保留得分最高的一条，并在其
   * `alsoAt` 上记下被折叠的其它位置（用户仍能看到"在别处也出现过"）。
   * 不同会话的相同文本**不合并**——那通常正是用户想对比的两处上下文。
   */
  #collapse(rows) {
    const kept = []
    const byKey = new Map()
    for (const row of rows) {
      const key = `${row.sessionId ?? ''}\u0000${row.text.slice(0, 200)}`
      const previous = byKey.get(key)
      if (previous === undefined) {
        byKey.set(key, row)
        kept.push(row)
        continue
      }
      // 同一处内容：优先保留"更权威"的种类（用户消息 > 注入回显 > 工具结果）。
      const better = (KIND_WEIGHT[row.kind] ?? 0.9) > (KIND_WEIGHT[previous.kind] ?? 0.9)
      if (better) {
        previous.alsoAt.push({ id: previous.id, kind: previous.kind, seq: previous.seq })
        byKey.set(key, row)
        const at = kept.indexOf(previous)
        if (at >= 0) kept[at] = row
        row.alsoAt.push(...previous.alsoAt)
      } else {
        previous.alsoAt.push({ id: row.id, kind: row.kind, seq: row.seq })
      }
    }
    return kept
  }

  /** 按会话 + seq 邻域取文档（结果详情里的上下文）。 */
  context(sessionId, seq, radius = 3) {
    const db = this.open()
    const rows = db.prepare(`
      select id, kind, label, seq, time, turn, step, tool, truncated, text
      from docs
      where session_id = ? and seq is not null and seq between ? and ?
      order by seq
    `).all(sessionId, Number(seq) - radius, Number(seq) + radius)
    return rows.map(row => ({
      id: Number(row.id),
      kind: String(row.kind),
      label: row.label === null || row.label === undefined ? null : String(row.label),
      seq: Number(row.seq),
      time: row.time === null || row.time === undefined ? null : Number(row.time),
      turn: row.turn === null || row.turn === undefined ? null : Number(row.turn),
      step: row.step === null || row.step === undefined ? null : Number(row.step),
      tool: row.tool === null || row.tool === undefined ? null : String(row.tool),
      truncated: Number(row.truncated ?? 0) === 1,
      text: String(row.text ?? ''),
    }))
  }

  /** 取一条文档全文（结果展开用）。 */
  doc(id) {
    const row = this.open().prepare('select * from docs where id = ?').get(id)
    if (row === undefined) return undefined
    return {
      id: Number(row.id),
      sessionId: row.session_id === null || row.session_id === undefined ? null : String(row.session_id),
      kind: String(row.kind),
      label: row.label === null || row.label === undefined ? null : String(row.label),
      seq: row.seq === null || row.seq === undefined ? null : Number(row.seq),
      time: row.time === null || row.time === undefined ? null : Number(row.time),
      turn: row.turn === null || row.turn === undefined ? null : Number(row.turn),
      step: row.step === null || row.step === undefined ? null : Number(row.step),
      tool: row.tool === null || row.tool === undefined ? null : String(row.tool),
      memoryId: row.memory_id === null || row.memory_id === undefined ? null : String(row.memory_id),
      path: row.path === null || row.path === undefined ? null : String(row.path),
      truncated: Number(row.truncated ?? 0) === 1,
      text: String(row.text ?? ''),
    }
  }
}
