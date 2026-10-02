// src/host/worker.js
import { parentPort, workerData } from "node:worker_threads";

// src/host/index-db.js
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// src/core/tokenize.js
var CJK_GLOBAL = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/g;
var NON_TOKEN = /[^A-Za-z0-9_\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]+/g;
var MULTI_SPACE = / +/g;
function tokenize(text) {
  if (typeof text !== "string" || text === "") return "";
  const spaced = text.replace(CJK_GLOBAL, " $& ");
  const split = spaced.replace(NON_TOKEN, " ").replace(MULTI_SPACE, " ").trim();
  return split;
}

// src/core/query.js
var CJK_CHAR = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;
var WORD_CHAR = /[A-Za-z0-9_]/;
function makeGroup(text, negated = false, prefix = false) {
  const cjk = [...text].some((ch) => CJK_CHAR.test(ch));
  return { text, cjk, negated, prefix };
}
function parseQuery(raw) {
  const text = typeof raw === "string" ? raw : "";
  const groups = [];
  let i = 0;
  let negated = false;
  let current = "";
  let currentCjk = false;
  let inQuotes = false;
  const flush = () => {
    if (current === "") return;
    groups.push(makeGroup(current, negated));
    current = "";
    negated = false;
  };
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        inQuotes = false;
        if (current !== "") groups.push(makeGroup(current, negated, false));
        current = "";
        negated = false;
        i += 1;
        continue;
      }
      current += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      flush();
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === "-" && current === "" && i + 1 < text.length && !/\s/.test(text[i + 1])) {
      negated = true;
      i += 1;
      continue;
    }
    const isCjk = CJK_CHAR.test(ch);
    const isWord = WORD_CHAR.test(ch);
    if (!isCjk && !isWord) {
      flush();
      i += 1;
      continue;
    }
    if (current === "") {
      currentCjk = isCjk;
      current = ch;
    } else if (isCjk === currentCjk) {
      current += ch;
    } else {
      flush();
      currentCjk = isCjk;
      current = ch;
    }
    i += 1;
  }
  if (inQuotes && current !== "") groups.push(makeGroup(current, negated, false));
  else flush();
  const terms = [];
  const seen = /* @__PURE__ */ new Set();
  for (const group of groups) {
    if (group.negated) continue;
    if (seen.has(group.text)) continue;
    seen.add(group.text);
    terms.push(group.text);
  }
  if (groups.length === 0) return { groups, terms, error: "empty-query" };
  if (groups.every((group) => group.negated)) return { groups, terms, error: "only-negative" };
  return { groups, terms, error: void 0 };
}
function literal(term) {
  return `"${term.replace(/"/g, '""')}"`;
}
function phraseLiteral(text) {
  const tokens = tokenize(text);
  return tokens === "" ? literal(text) : literal(tokens);
}
function groupExpr(group, mode) {
  const chars = [...group.text];
  if (chars.length === 0) return "";
  if (group.cjk) {
    const body2 = phraseLiteral(group.text);
    if (chars.length === 1 && mode === "prefix") return `${body2}*`;
    return body2;
  }
  const body = literal(group.text);
  if (mode === "prefix" || group.prefix) return `${body}*`;
  return body;
}
function buildMatch(groups, mode = "all") {
  if (!Array.isArray(groups) || groups.length === 0) return "";
  if (mode === "phrase") {
    const whole = groups.filter((g) => !g.negated).map((g) => g.text).join(" ").trim();
    if (whole === "") return "";
    return phraseLiteral(whole);
  }
  const positive = [];
  const negative = [];
  groups.forEach((group, index2) => {
    const last = index2 === groups.length - 1;
    const expr = groupExpr(group, mode === "prefix" && last ? "prefix" : "all");
    if (expr === "") return;
    if (group.negated) negative.push(expr);
    else positive.push(expr);
  });
  if (positive.length === 0 && negative.length === 0) return "";
  const joiner = mode === "any" ? " OR " : " AND ";
  const head = positive.length > 0 ? positive.join(joiner) : "";
  const tail = negative.map((expr) => `NOT ${expr}`).join(" ");
  if (head === "") return tail === "" ? "" : "";
  return tail === "" ? head : `(${head}) ${tail}`;
}

// src/host/index-db.js
var SCHEMA_VERSION = 1;
var KIND_WEIGHT = {
  title: 1.45,
  user: 1.3,
  goal: 1.2,
  summary: 1.15,
  assistant: 1.05,
  todo: 1,
  command: 1,
  command_result: 0.95,
  approval: 0.95,
  memory: 1.25,
  inject: 1,
  tool_call: 0.92,
  tool_result: 0.85,
  reasoning: 0.75,
  defend: 0.7,
  file: 0.95
};
var INSERT_BATCH = 2e3;
var SearchIndex = class {
  /**
   * @param dbPath 索引库绝对路径
   */
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
    this.txDepth = 0;
  }
  /** 打开（必要时创建）索引库并确保 schema 就绪。 */
  open() {
    if (this.db !== null) return this.db;
    mkdirSync(dirname(this.dbPath), { recursive: true });
    const db = new DatabaseSync(this.dbPath);
    db.exec("pragma journal_mode = wal");
    db.exec("pragma synchronous = normal");
    db.exec("pragma temp_store = memory");
    this.db = db;
    this.#ensureSchema();
    return db;
  }
  /** 关闭索引库（幂等）。 */
  close() {
    if (this.db === null) return;
    try {
      this.db.close();
    } catch {
    }
    this.db = null;
  }
  #ensureSchema() {
    const db = this.db;
    const versionRow = (() => {
      try {
        const row = db.prepare("select value from meta where key = ?").get("schema_version");
        return row === void 0 ? 0 : Number(row.value);
      } catch {
        return -1;
      }
    })();
    if (versionRow === SCHEMA_VERSION) return;
    db.exec("drop table if exists docs_fts");
    db.exec("drop table if exists docs");
    db.exec("drop table if exists files");
    db.exec("drop table if exists sessions");
    db.exec("drop table if exists meta");
    db.exec(`
      create table meta (key text primary key, value text)
    `);
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
    `);
    db.exec(`
      create virtual table docs_fts using fts5(
        tok,
        content='',
        contentless_delete=1,
        tokenize="unicode61 remove_diacritics 2"
      )
    `);
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
    `);
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
    `);
    db.exec("create index docs_session on docs(session_id)");
    db.exec("create index docs_kind on docs(kind)");
    db.exec("create index docs_time on docs(time)");
    db.exec("create index docs_memory on docs(memory_id)");
    db.prepare("insert into meta(key, value) values(?, ?)").run("schema_version", String(SCHEMA_VERSION));
    db.prepare("insert into meta(key, value) values(?, ?)").run("built_at", String(Date.now()));
  }
  /** 某个会话当前真实存在的文档条数（重扫后即为新值，天然自洽）。 */
  countDocs(sessionId) {
    const row = this.open().prepare("select count(*) as n from docs where session_id = ?").get(sessionId);
    return Number(row?.n ?? 0);
  }
  /** 已索引会话文件的游标状态：Map<sessionId, {byteOffset, size, docs}>。 */
  fileStates() {
    const map = /* @__PURE__ */ new Map();
    const rows = this.open().prepare("select session_id, byte_offset, size, docs from files").all();
    for (const row of rows) {
      map.set(String(row.session_id), {
        byteOffset: Number(row.byte_offset ?? 0),
        size: Number(row.size ?? 0),
        docs: Number(row.docs ?? 0)
      });
    }
    return map;
  }
  /** 会话元数据（标题/工作目录等）由扫描器在索引时写入。 */
  upsertSession(meta) {
    const db = this.open();
    const existing = db.prepare("select session_id, title, cwd, created_at, parent_session, origin, agent_preset, delegation_depth, docs, last_time from sessions where session_id = ?").get(meta.sessionId);
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
      updatedAt: Date.now()
    };
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
      merged.sessionId,
      merged.projectKey,
      merged.title,
      merged.cwd,
      merged.createdAt,
      merged.parentSession,
      merged.origin,
      merged.agentPreset,
      merged.delegationDepth,
      merged.docs,
      merged.lastTime,
      merged.updatedAt
    );
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
    `).run(state.sessionId, state.projectKey, state.dir, state.size, state.byteOffset, state.docs, Date.now());
  }
  /** 删除某个会话的全部文档（重扫前清理）。 */
  deleteSession(sessionId) {
    const db = this.open();
    const ids = db.prepare("select id from docs where session_id = ?").all(sessionId);
    const delFts = db.prepare("delete from docs_fts where rowid = ?");
    for (const row of ids) delFts.run(row.id);
    db.prepare("delete from docs where session_id = ?").run(sessionId);
  }
  /** 删除某个记忆的全部文档。 */
  deleteMemory(memoryId) {
    const db = this.open();
    const ids = db.prepare("select id from docs where memory_id = ?").all(memoryId);
    const delFts = db.prepare("delete from docs_fts where rowid = ?");
    for (const row of ids) delFts.run(row.id);
    db.prepare("delete from docs where memory_id = ?").run(memoryId);
  }
  /** 清空会话/记忆语料（不动 schema）；工作区文件语料单独清。 */
  clearCorpus(kinds) {
    const db = this.open();
    const list = Array.isArray(kinds) ? kinds : ["session", "memory"];
    for (const kind of list) {
      const ids = kind === "memory" ? db.prepare("select id from docs where memory_id is not null").all() : db.prepare("select id from docs where kind != ? and memory_id is null").all("memory");
      const delFts = db.prepare("delete from docs_fts where rowid = ?");
      for (const row of ids) delFts.run(row.id);
      if (kind === "memory") db.exec("delete from docs where memory_id is not null");
      else db.prepare("delete from docs where kind != ? and memory_id is null").run("memory");
    }
  }
  /** 全库清空（保留 schema 与 meta）。 */
  reset() {
    const db = this.open();
    db.exec("delete from docs_fts");
    db.exec("delete from docs");
    db.exec("delete from files");
    db.exec("delete from sessions");
    db.prepare("update meta set value = ? where key = ?").run(String(Date.now()), "built_at");
  }
  /** 提交一批文档（自动分批事务）。 */
  writeBatch(docs) {
    if (!Array.isArray(docs) || docs.length === 0) return 0;
    const db = this.open();
    const insDoc = db.prepare(`
      insert into docs(session_id, project_key, kind, label, seq, time, turn, step, tool, memory_id, scope, status, path, truncated, text)
      values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insFts = db.prepare("insert into docs_fts(rowid, tok) values(?, ?)");
    let written = 0;
    let i = 0;
    while (i < docs.length) {
      const slice = docs.slice(i, i + INSERT_BATCH);
      i += INSERT_BATCH;
      db.exec("begin");
      try {
        for (const doc of slice) {
          const info = insDoc.run(
            doc.sessionId ?? null,
            doc.projectKey ?? null,
            doc.kind,
            doc.label ?? null,
            doc.seq ?? null,
            doc.time ?? null,
            doc.turn ?? null,
            doc.step ?? null,
            doc.tool ?? null,
            doc.memoryId ?? null,
            doc.scope ?? null,
            doc.status ?? null,
            doc.path ?? null,
            doc.truncated ? 1 : 0,
            doc.text ?? ""
          );
          const id = Number(info.lastInsertRowid);
          const tok = tokenize(`${doc.label ?? ""} ${doc.text ?? ""}`);
          if (tok !== "") insFts.run(id, tok);
          written += 1;
        }
        db.exec("commit");
      } catch (error) {
        try {
          db.exec("rollback");
        } catch {
        }
        throw error;
      }
    }
    this.touch();
    return written;
  }
  /** 记下"索引内容最后更新于"。写入是唯一会改变内容的事件，所以由写入方调用。 */
  touch() {
    this.open().prepare(`
      insert into meta(key, value) values('refreshed_at', ?)
      on conflict(key) do update set value = excluded.value
    `).run(String(Date.now()));
  }
  /** 运行一次 checkpoint，把 WAL 落到主库（空闲时调用，避免 WAL 无限增长）。 */
  checkpoint() {
    try {
      this.open().exec("pragma wal_checkpoint(truncate)");
    } catch {
    }
  }
  /** 索引统计：文档数、会话数、种类分布、库体积。 */
  stats() {
    const db = this.open();
    const docs = Number(db.prepare("select count(*) as n from docs").get().n ?? 0);
    const sessions = Number(db.prepare("select count(*) as n from sessions").get().n ?? 0);
    const memories = Number(db.prepare("select count(*) as n from docs where memory_id is not null").get().n ?? 0);
    const byKind = db.prepare("select kind, count(*) as n from docs group by kind order by n desc").all();
    const last = db.prepare("select max(time) as t from docs").get();
    const builtAt = db.prepare("select value from meta where key = ?").get("built_at");
    const refreshedAt = db.prepare("select value from meta where key = ?").get("refreshed_at");
    return {
      docs,
      sessions,
      memories,
      byKind: byKind.map((row) => ({ kind: String(row.kind), count: Number(row.n) })),
      latestDocTime: last?.t === null || last?.t === void 0 ? null : Number(last.t),
      // builtAt 是"建库"时间（schema 创建那一刻），只在重建时变；
      // 界面要的是"索引内容最后更新于"，所以另记一个每次写入都刷新的时间。
      builtAt: builtAt === void 0 ? null : Number(builtAt.value),
      refreshedAt: refreshedAt === void 0 ? null : Number(refreshedAt.value)
    };
  }
  /** 会话下拉列表（供 UI 过滤）。 */
  listSessions(limit = 300) {
    return this.open().prepare(`
      select s.session_id, s.title, s.cwd, s.project_key, s.docs, s.last_time, s.origin
      from sessions s
      where s.docs > 0
      order by coalesce(s.last_time, s.created_at, 0) desc
      limit ?
    `).all(limit).map((row) => ({
      sessionId: String(row.session_id),
      title: row.title === null || row.title === void 0 ? null : String(row.title),
      cwd: row.cwd === null || row.cwd === void 0 ? null : String(row.cwd),
      projectKey: row.project_key === null || row.project_key === void 0 ? null : String(row.project_key),
      docs: Number(row.docs ?? 0),
      lastTime: row.last_time === null || row.last_time === void 0 ? null : Number(row.last_time),
      origin: row.origin === null || row.origin === void 0 ? null : String(row.origin)
    }));
  }
  /** 会话详情（含标题、文档数、时间范围）。 */
  sessionInfo(sessionId) {
    const row = this.open().prepare("select * from sessions where session_id = ?").get(sessionId);
    if (row === void 0) return void 0;
    return {
      sessionId: String(row.session_id),
      title: row.title === null || row.title === void 0 ? null : String(row.title),
      cwd: row.cwd === null || row.cwd === void 0 ? null : String(row.cwd),
      projectKey: row.project_key === null || row.project_key === void 0 ? null : String(row.project_key),
      createdAt: row.created_at === null || row.created_at === void 0 ? null : Number(row.created_at),
      parentSession: row.parent_session === null || row.parent_session === void 0 ? null : String(row.parent_session),
      origin: row.origin === null || row.origin === void 0 ? null : String(row.origin),
      agentPreset: row.agent_preset === null || row.agent_preset === void 0 ? null : String(row.agent_preset),
      delegationDepth: row.delegation_depth === null || row.delegation_depth === void 0 ? null : Number(row.delegation_depth),
      docs: Number(row.docs ?? 0),
      lastTime: row.last_time === null || row.last_time === void 0 ? null : Number(row.last_time)
    };
  }
  /**
   * 检索。
   * @param options { query, mode, kinds, sessionId, projectKey, since, until, limit, offset, context }
   * @returns { hits, total, terms, mode, relaxed }
   */
  search(options) {
    const db = this.open();
    const query = typeof options.query === "string" ? options.query : "";
    const parsed = parseQuery(query);
    if (parsed.error !== void 0) return { hits: [], total: 0, terms: [], mode: options.mode ?? "all", relaxed: false };
    const limit = Math.min(Math.max(Number(options.limit ?? 30) || 30, 1), 200);
    const offset = Math.max(Number(options.offset ?? 0) || 0, 0);
    const mode = typeof options.mode === "string" ? options.mode : "auto";
    const attempts = mode === "auto" ? ["all", "any"] : [mode];
    let lastResult = null;
    for (let i = 0; i < attempts.length; i += 1) {
      const matchMode = attempts[i];
      const match = buildMatch(parsed.groups, matchMode === "auto" ? "all" : matchMode);
      if (match === "") break;
      const result = this.#runSearch({ match, parsed, options, limit, offset, matchMode });
      lastResult = result;
      if (result.total > 0) return { ...result, relaxed: i > 0 };
    }
    return lastResult ?? { hits: [], total: 0, terms: parsed.terms, mode, relaxed: false };
  }
  #runSearch({ match, parsed, options, limit, offset, matchMode }) {
    const db = this.open();
    const where = [];
    const params = [];
    if (Array.isArray(options.kinds) && options.kinds.length > 0) {
      where.push(`d.kind in (${options.kinds.map(() => "?").join(", ")})`);
      params.push(...options.kinds);
    }
    if (typeof options.sessionId === "string" && options.sessionId !== "") {
      where.push("d.session_id = ?");
      params.push(options.sessionId);
    }
    if (typeof options.projectKey === "string" && options.projectKey !== "") {
      where.push("d.project_key = ?");
      params.push(options.projectKey);
    }
    if (typeof options.cwd === "string" && options.cwd !== "") {
      where.push("s.cwd = ?");
      params.push(options.cwd);
    }
    if (Number.isFinite(options.since)) {
      where.push("coalesce(d.time, 0) >= ?");
      params.push(options.since);
    }
    if (Number.isFinite(options.until)) {
      where.push("coalesce(d.time, 0) <= ?");
      params.push(options.until);
    }
    if (options.memoryOnly === true) where.push("d.memory_id is not null");
    if (options.memoryOnly === false) where.push("d.memory_id is null");
    if (options.excludeFiles === true) where.push("d.kind != 'file'");
    const filter = where.length > 0 ? `and ${where.join(" and ")}` : "";
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
    `;
    let rows;
    try {
      rows = db.prepare(sql).all(match, ...params, limit * 4, offset);
    } catch (error) {
      return { hits: [], total: 0, terms: parsed.terms, mode: matchMode, error: error instanceof Error ? error.message : String(error) };
    }
    const countSql = `
      select count(*) as n
      from docs_fts f
      join docs d on d.id = f.rowid
      left join sessions s on s.session_id = d.session_id
      where docs_fts match ? ${filter}
    `;
    let total = rows.length;
    try {
      total = Number(db.prepare(countSql).get(match, ...params).n ?? rows.length);
    } catch {
    }
    const now = Date.now();
    const ranked = [];
    for (const row of rows) {
      const weight = KIND_WEIGHT[String(row.kind)] ?? 0.9;
      const rawScore = Number(row.score ?? 0);
      const relevance = -rawScore;
      const age = row.time === null || row.time === void 0 ? Number.POSITIVE_INFINITY : now - Number(row.time);
      const days = Number.isFinite(age) ? age / 864e5 : 999;
      const freshness = 1 + 0.35 / (1 + days / 7);
      ranked.push({
        id: Number(row.id),
        sessionId: row.session_id === null || row.session_id === void 0 ? null : String(row.session_id),
        sessionTitle: row.session_title === null || row.session_title === void 0 ? null : String(row.session_title),
        cwd: row.session_cwd === null || row.session_cwd === void 0 ? null : String(row.session_cwd),
        origin: row.session_origin === null || row.session_origin === void 0 ? null : String(row.session_origin),
        projectKey: row.project_key === null || row.project_key === void 0 ? null : String(row.project_key),
        kind: String(row.kind),
        label: row.label === null || row.label === void 0 ? null : String(row.label),
        seq: row.seq === null || row.seq === void 0 ? null : Number(row.seq),
        time: row.time === null || row.time === void 0 ? null : Number(row.time),
        turn: row.turn === null || row.turn === void 0 ? null : Number(row.turn),
        step: row.step === null || row.step === void 0 ? null : Number(row.step),
        tool: row.tool === null || row.tool === void 0 ? null : String(row.tool),
        memoryId: row.memory_id === null || row.memory_id === void 0 ? null : String(row.memory_id),
        scope: row.scope === null || row.scope === void 0 ? null : String(row.scope),
        status: row.status === null || row.status === void 0 ? null : String(row.status),
        path: row.path === null || row.path === void 0 ? null : String(row.path),
        truncated: Number(row.truncated ?? 0) === 1,
        text: String(row.text ?? ""),
        score: relevance * weight * freshness,
        alsoAt: []
      });
    }
    ranked.sort((a, b) => b.score - a.score);
    const deduped = this.#collapse(ranked);
    return {
      hits: deduped.slice(0, limit),
      // total 是"命中条数"，与去重后的列表长度不同：用户要的是"到底有多少条相关记录"，
      // 而不是"去掉重复后还剩几条"，所以这里报原始命中数，另给 shown 说明实际列出多少。
      total,
      shown: deduped.length,
      terms: parsed.terms,
      mode: matchMode
    };
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
    const kept = [];
    const byKey = /* @__PURE__ */ new Map();
    for (const row of rows) {
      const key = `${row.sessionId ?? ""}\0${row.text.slice(0, 200)}`;
      const previous = byKey.get(key);
      if (previous === void 0) {
        byKey.set(key, row);
        kept.push(row);
        continue;
      }
      const better = (KIND_WEIGHT[row.kind] ?? 0.9) > (KIND_WEIGHT[previous.kind] ?? 0.9);
      if (better) {
        previous.alsoAt.push({ id: previous.id, kind: previous.kind, seq: previous.seq });
        byKey.set(key, row);
        const at = kept.indexOf(previous);
        if (at >= 0) kept[at] = row;
        row.alsoAt.push(...previous.alsoAt);
      } else {
        previous.alsoAt.push({ id: row.id, kind: row.kind, seq: row.seq });
      }
    }
    return kept;
  }
  /** 按会话 + seq 邻域取文档（结果详情里的上下文）。 */
  context(sessionId, seq, radius = 3) {
    const db = this.open();
    const rows = db.prepare(`
      select id, kind, label, seq, time, turn, step, tool, truncated, text
      from docs
      where session_id = ? and seq is not null and seq between ? and ?
      order by seq
    `).all(sessionId, Number(seq) - radius, Number(seq) + radius);
    return rows.map((row) => ({
      id: Number(row.id),
      kind: String(row.kind),
      label: row.label === null || row.label === void 0 ? null : String(row.label),
      seq: Number(row.seq),
      time: row.time === null || row.time === void 0 ? null : Number(row.time),
      turn: row.turn === null || row.turn === void 0 ? null : Number(row.turn),
      step: row.step === null || row.step === void 0 ? null : Number(row.step),
      tool: row.tool === null || row.tool === void 0 ? null : String(row.tool),
      truncated: Number(row.truncated ?? 0) === 1,
      text: String(row.text ?? "")
    }));
  }
  /** 取一条文档全文（结果展开用）。 */
  doc(id) {
    const row = this.open().prepare("select * from docs where id = ?").get(id);
    if (row === void 0) return void 0;
    return {
      id: Number(row.id),
      sessionId: row.session_id === null || row.session_id === void 0 ? null : String(row.session_id),
      kind: String(row.kind),
      label: row.label === null || row.label === void 0 ? null : String(row.label),
      seq: row.seq === null || row.seq === void 0 ? null : Number(row.seq),
      time: row.time === null || row.time === void 0 ? null : Number(row.time),
      turn: row.turn === null || row.turn === void 0 ? null : Number(row.turn),
      step: row.step === null || row.step === void 0 ? null : Number(row.step),
      tool: row.tool === null || row.tool === void 0 ? null : String(row.tool),
      memoryId: row.memory_id === null || row.memory_id === void 0 ? null : String(row.memory_id),
      path: row.path === null || row.path === void 0 ? null : String(row.path),
      truncated: Number(row.truncated ?? 0) === 1,
      text: String(row.text ?? "")
    };
  }
};

// src/host/indexer.js
import { readdirSync as readdirSync2, readFileSync as readFileSync3, statSync as statSync2 } from "node:fs";
import { join as join3, relative, sep } from "node:path";

// src/core/extract.js
var DOC_INDEX_LIMIT = 32 * 1024 * 1024;
function textOfContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    if (typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n").trim();
}
function blocksOfType(content, type) {
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    if (block.type !== type) continue;
    if (typeof block.text === "string") out.push(block.text);
  }
  return out;
}
function argsText(args) {
  if (typeof args === "string") return args;
  if (args === null || args === void 0) return "";
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}
function clip(text, limit = DOC_INDEX_LIMIT) {
  if (typeof text !== "string") return { text: "", truncated: false };
  if (text.length <= limit) return { text, truncated: false };
  return { text: text.slice(0, limit), truncated: true };
}
function extract(record, ctx) {
  if (record === null || typeof record !== "object") return { docs: [] };
  const type = record.type;
  if (typeof type !== "string") return { docs: [] };
  const data = record.data !== null && typeof record.data === "object" ? record.data : {};
  const seq = Number.isFinite(record.seq) ? record.seq : Number.isFinite(record.seq0) ? record.seq0 : null;
  const time = Number.isFinite(record.time) ? record.time : Number.isFinite(record.time0) ? record.time0 : null;
  const turn = Number.isFinite(data.turn) ? data.turn : null;
  const step = Number.isFinite(data.step) ? data.step : null;
  const base = { seq, time, turn, step };
  switch (type) {
    case "session": {
      return {
        docs: [],
        header: {
          id: typeof record.id === "string" ? record.id : ctx.sessionId,
          cwd: typeof record.cwd === "string" ? record.cwd : null,
          createdAt: Number.isFinite(record.createdAt) ? record.createdAt : null,
          parentSession: typeof record.parentSession === "string" ? record.parentSession : null,
          origin: typeof record.origin === "string" ? record.origin : null,
          agentPreset: typeof record.agentPreset === "string" ? record.agentPreset : null,
          delegationDepth: Number.isFinite(record.delegationDepth) ? record.delegationDepth : null
        }
      };
    }
    case "session/title": {
      const title = typeof data.title === "string" ? data.title : "";
      if (title === "") return { docs: [] };
      return { title, docs: [{ ...base, kind: "title", label: "\u4F1A\u8BDD\u6807\u9898", text: title }] };
    }
    case "user/message": {
      const text = textOfContent(data.content);
      if (text === "") return { docs: [] };
      return { docs: [{ ...base, kind: "user", label: "\u7528\u6237\u6D88\u606F", text }] };
    }
    case "agent/inbox/spliced": {
      const inserted = Array.isArray(data.inserted) ? data.inserted : [];
      const docs = [];
      for (const message of inserted) {
        const text = textOfContent(message?.content);
        if (text === "") continue;
        const kind = message?.source?.kind === "user" ? "user" : "inject";
        docs.push({ ...base, kind, label: kind === "user" ? "\u7528\u6237\u63D2\u8BDD" : "\u6CE8\u5165\u6D88\u606F", text });
      }
      return { docs };
    }
    case "assistant/message": {
      const content = data.message?.content;
      const docs = [];
      const reasoning = blocksOfType(content, "reasoning").join("\n\n").trim();
      if (reasoning !== "") docs.push({ ...base, kind: "reasoning", label: "\u601D\u8003\u8FC7\u7A0B", text: reasoning });
      const text = blocksOfType(content, "text").join("\n\n").trim();
      if (text !== "") docs.push({ ...base, kind: "assistant", label: "\u52A9\u624B\u56DE\u590D", text });
      return { docs };
    }
    case "tool/call": {
      const name = typeof data.name === "string" ? data.name : "tool";
      const args = argsText(data.arguments);
      const text = `${name} ${args}`.trim();
      if (text === "") return { docs: [] };
      return { docs: [{ ...base, kind: "tool_call", label: `\u5DE5\u5177\u8C03\u7528 \xB7 ${name}`, text, tool: name }] };
    }
    case "tool/result": {
      const message = data.message;
      const content = message?.content;
      const parts = [];
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block === null || typeof block !== "object") continue;
          if (Array.isArray(block.content)) parts.push(textOfContent(block.content));
          else if (typeof block.text === "string") parts.push(block.text);
        }
      }
      const text = parts.filter(Boolean).join("\n").trim();
      if (text === "") return { docs: [] };
      const toolCallId = content?.[0]?.toolCallId ?? null;
      const isError = content?.[0]?.isError === true;
      return { docs: [{ ...base, kind: "tool_result", label: isError ? "\u5DE5\u5177\u7ED3\u679C\uFF08\u9519\u8BEF\uFF09" : "\u5DE5\u5177\u7ED3\u679C", text, toolCallId }] };
    }
    case "compaction/summary": {
      const text = Array.isArray(data.summary) ? textOfContent(data.summary) : "";
      if (text === "") return { docs: [] };
      return { docs: [{ ...base, kind: "summary", label: "\u4E0A\u4E0B\u6587\u538B\u7F29\u6458\u8981", text }] };
    }
    case "goal/change": {
      const objective = data.goal?.objective;
      if (typeof objective !== "string" || objective === "") return { docs: [] };
      const operation = typeof data.operation === "string" ? data.operation : "change";
      if (operation === "complete" || operation === "pause") return { docs: [] };
      return { docs: [{ ...base, kind: "goal", label: "\u4F1A\u8BDD\u76EE\u6807", text: objective }] };
    }
    case "todo/write": {
      const todos = Array.isArray(data.todos) ? data.todos : [];
      const text = todos.map((item) => `[${item?.status ?? "?"}] ${item?.content ?? ""}`).join("\n").trim();
      if (text === "") return { docs: [] };
      return { docs: [{ ...base, kind: "todo", label: "\u4EFB\u52A1\u6E05\u5355", text }] };
    }
    case "command/run": {
      const name = typeof data.name === "string" ? data.name : "";
      const args = typeof data.args === "string" ? data.args : "";
      const text = `${name} ${args}`.trim();
      if (text === "") return { docs: [] };
      return { docs: [{ ...base, kind: "command", label: "\u7528\u6237\u547D\u4EE4", text }] };
    }
    case "command/done": {
      const text = typeof data.text === "string" ? data.text.trim() : "";
      if (text === "") return { docs: [] };
      return { docs: [{ ...base, kind: "command_result", label: "\u547D\u4EE4\u7ED3\u679C", text }] };
    }
    case "approval/asked": {
      const toolName = typeof data.toolName === "string" ? data.toolName : "";
      const reason = typeof data.reason === "string" ? data.reason : "";
      const text = `${toolName} ${reason}`.trim();
      if (text === "") return { docs: [] };
      return { docs: [{ ...base, kind: "approval", label: "\u5BA1\u6279\u8BF7\u6C42", text }] };
    }
    case "defend/detection": {
      const text = `${data.category ?? ""} ${data.ruleId ?? ""} ${data.secretType ?? ""}`.trim();
      if (text === "") return { docs: [] };
      return { docs: [{ ...base, kind: "defend", label: "\u5B89\u5168\u68C0\u6D4B", text }] };
    }
    default:
      return { docs: [] };
  }
}
function clipDocText(text) {
  return clip(text);
}

// src/host/projcache.js
import { readFileSync } from "node:fs";
import { join } from "node:path";
function projCachePath(home) {
  return join(home, "storages", "session_projcache.json");
}
function readProjectedTitles(home) {
  let raw;
  try {
    raw = readFileSync(projCachePath(home), "utf8");
  } catch {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const table = parsed?.tables?.sessions;
  if (table === null || typeof table !== "object") return [];
  const out = [];
  for (const [sessionId, entry] of Object.entries(table)) {
    if (sessionId === "" || entry === null || typeof entry !== "object") continue;
    const title = entry?.rows?.title?.val;
    const cwd = entry?.identity?.cwd;
    const createdAt = entry?.identity?.createdAt;
    const clean = typeof title === "string" ? title.trim() : "";
    if (clean === "" && typeof cwd !== "string" && !Number.isFinite(createdAt)) continue;
    out.push({
      sessionId: sessionId.startsWith("session-") ? sessionId : `session-${sessionId}`,
      title: clean === "" ? null : clean,
      cwd: typeof cwd === "string" && cwd !== "" ? cwd : null,
      createdAt: Number.isFinite(createdAt) ? Number(createdAt) : null
    });
  }
  return out;
}

// src/host/scan.js
import { readdirSync, readFileSync as readFileSync2, statSync } from "node:fs";
import { join as join2 } from "node:path";

// src/host/zstd.js
import { constants, zstdDecompressSync } from "node:zlib";
var ZSTD_MAGIC = 4247762216;
function scanFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt zstd log: invalid frame magic at byte ${offset}`);
    }
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) throw new Error(`corrupt zstd log: reserved frame-header bit at byte ${offset - 1}`);
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? singleSegment ? 1 : 0 : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (; ; ) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = blockHeader >>> 1 & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error(`corrupt zstd log: reserved block type at byte ${offset - 3}`);
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push([start, offset]);
  }
  return { frames };
}
function decodeFrame(buffer, [start, end]) {
  return zstdDecompressSync(buffer.subarray(start, end)).toString("utf8");
}
function decodeTornFrame(buffer, start) {
  try {
    return zstdDecompressSync(buffer.subarray(start), { finishFlush: constants.ZSTD_e_flush }).toString("utf8");
  } catch {
    return "";
  }
}

// src/host/scan.js
function logFileNames() {
  return ["session.jsonl.zstd", "session.jsonl"];
}
function canonicalSessionId(segment) {
  return segment.startsWith("session-") ? segment : `session-${segment}`;
}
function parseLines(text, onRecord, stats) {
  let cursor = 0;
  for (; ; ) {
    const at = text.indexOf("\n", cursor);
    if (at < 0) break;
    const line = text.slice(cursor, at);
    cursor = at + 1;
    if (line === "" || line === "\r") continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      if (stats !== void 0) stats.malformed += 1;
      continue;
    }
    onRecord(record);
  }
  return cursor;
}
function scanSessionDir(dir, projectKey, state, sink, limits = {}) {
  const stats = { docs: 0, malformed: 0, files: 0, reset: false, bytes: 0, nextOffset: 0, size: 0, lastTime: void 0 };
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return { ...stats, missing: true };
  }
  const name = logFileNames().find((candidate) => names.includes(candidate));
  if (name === void 0) return { ...stats, missing: true };
  const path = join2(dir, name);
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return { ...stats, missing: true };
  }
  stats.files = 1;
  stats.size = stat.size;
  const useFrames = name.endsWith(".zstd");
  const unchanged = state !== void 0 && state.docs > 0 && (useFrames ? stat.size === state.byteOffset : stat.size === state.size);
  if (unchanged) {
    return { ...stats, docs: 0, nextOffset: state.byteOffset, unchanged: true };
  }
  const incremental = state !== void 0 && Number.isFinite(state.byteOffset) && state.byteOffset > 0 && stat.size >= state.byteOffset && useFrames;
  if (!incremental && state !== void 0 && state.docs > 0) stats.reset = true;
  let buffer;
  try {
    buffer = readFileSync2(path);
  } catch {
    return { ...stats, missing: true };
  }
  const sessionId = canonicalSessionId(dir.split("/").pop() ?? "");
  const ctx = { sessionId, projectKey };
  let from = incremental ? state.byteOffset : 0;
  let scan;
  if (useFrames) {
    try {
      scan = scanFrames(buffer.subarray(from));
    } catch {
      if (from === 0) return { ...stats, corrupt: true };
      from = 0;
      stats.reset = true;
      try {
        scan = scanFrames(buffer);
      } catch {
        return { ...stats, corrupt: true };
      }
    }
  }
  let consumed = from;
  let pieces = "";
  if (useFrames) {
    for (const range of scan.frames) {
      const absolute = [from + range[0], from + range[1]];
      let text;
      try {
        text = decodeFrame(buffer, absolute);
      } catch {
        stats.malformed += 1;
        continue;
      }
      stats.bytes += text.length;
      pieces += text;
      consumed = absolute[1];
    }
    if (scan.tornStart !== void 0) {
      const partial = decodeTornFrame(buffer, from + scan.tornStart);
      if (partial !== "") {
        stats.bytes += partial.length;
        pieces += partial;
      }
    }
  } else {
    pieces = buffer.toString("utf8");
    stats.bytes += pieces.length;
    consumed = buffer.length;
  }
  stats.nextOffset = useFrames ? consumed : 0;
  parseLines(pieces, (record) => {
    const result = extract(record, ctx);
    if (result.header !== void 0) sink.onHeader({ ...result.header, sessionId, projectKey });
    if (result.title !== void 0) sink.onTitle({ sessionId, projectKey, title: result.title, seq: null, time: null });
    for (const doc of result.docs) {
      sink.onDoc({ ...doc, sessionId, projectKey });
      stats.docs += 1;
      if (Number.isFinite(doc.time) && (stats.lastTime === void 0 || doc.time > stats.lastTime)) {
        stats.lastTime = doc.time;
      }
    }
  }, stats);
  return stats;
}
function scanSessions(root, known, sink) {
  const totals = { sessions: 0, docs: 0, malformed: 0, corrupt: 0, reset: 0, missing: 0, bytes: 0, unchanged: 0 };
  let projects;
  try {
    projects = readdirSync(root);
  } catch {
    return totals;
  }
  for (const projectKey of projects) {
    const projectDir = join2(root, projectKey);
    let stat;
    try {
      stat = statSync(projectDir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    let segments;
    try {
      segments = readdirSync(projectDir);
    } catch {
      continue;
    }
    for (const segment of segments) {
      const dir = join2(projectDir, segment);
      let dirStat;
      try {
        dirStat = statSync(dir);
      } catch {
        continue;
      }
      if (!dirStat.isDirectory()) continue;
      const sessionId = canonicalSessionId(segment);
      const state = known.get(sessionId);
      totals.sessions += 1;
      const result = scanSessionDir(dir, projectKey, state, sink);
      if (result.missing === true) {
        totals.missing += 1;
        continue;
      }
      if (result.corrupt === true) {
        totals.corrupt += 1;
        continue;
      }
      if (result.reset === true) totals.reset += 1;
      if (result.unchanged === true) totals.unchanged += 1;
      totals.docs += result.docs;
      totals.malformed += result.malformed;
      totals.bytes += result.bytes;
      sink.onFile({
        sessionId,
        projectKey,
        dir,
        size: result.size,
        byteOffset: result.nextOffset,
        docs: result.docs,
        reset: result.reset === true,
        unchanged: result.unchanged === true,
        lastTime: result.lastTime
      });
    }
  }
  return totals;
}
function scanMemories(root, sink) {
  const totals = { files: 0, docs: 0 };
  let projects;
  try {
    projects = readdirSync(root);
  } catch {
    return totals;
  }
  for (const project of projects) {
    const memoriesDir = join2(root, project, "memories");
    let entries;
    try {
      entries = readdirSync(memoriesDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const path = join2(memoriesDir, entry);
      let raw;
      try {
        raw = readFileSync2(path, "utf8");
      } catch {
        continue;
      }
      totals.files += 1;
      const id = entry.replace(/\.md$/, "");
      const { meta, body } = splitFrontMatter(raw);
      const text = body.trim();
      if (text === "") continue;
      sink.onDoc({
        kind: "memory",
        label: `\u957F\u671F\u8BB0\u5FC6 \xB7 ${typeof meta.kind === "string" ? meta.kind : "note"}`,
        text,
        memoryId: id,
        scope: typeof meta.scope === "string" ? meta.scope : project,
        status: typeof meta.status === "string" ? meta.status : "active",
        createdAt: Number.isFinite(meta.created_at) ? meta.created_at : null,
        path
      });
      totals.docs += 1;
    }
  }
  return totals;
}
function splitFrontMatter(raw) {
  const meta = {};
  if (typeof raw !== "string" || !raw.startsWith("---")) return { meta, body: raw };
  const end = raw.indexOf("\n---", 3);
  if (end < 0) return { meta, body: raw };
  const head = raw.slice(3, end);
  const body = raw.slice(end + 4);
  for (const line of head.split("\n")) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    let value = line.slice(at + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
    if (value === "null") value = null;
    else if (/^-?\d+$/.test(value)) value = Number(value);
    else if (/^-?\d+\.\d+$/.test(value)) value = Number(value);
    meta[key] = value;
  }
  return { meta, body };
}

// src/host/indexer.js
var FILE_MAX_BYTES = 2 * 1024 * 1024;
var FILE_TOTAL_LIMIT = 2e5;
var SKIP_DIRS = /* @__PURE__ */ new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".cache",
  ".parcel-cache",
  "coverage",
  ".pnpm-store",
  "target",
  "bin",
  "obj",
  ".idea",
  ".vscode",
  ".DS_Store"
]);
var TEXT_EXT = /* @__PURE__ */ new Set([
  ".md",
  ".markdown",
  ".txt",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".jsonc",
  ".yml",
  ".yaml",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".css",
  ".scss",
  ".less",
  ".html",
  ".htm",
  ".xml",
  ".svg",
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".ps1",
  ".bat",
  ".cmd",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".swift",
  ".c",
  ".h",
  ".cc",
  ".cpp",
  ".hpp",
  ".cs",
  ".php",
  ".lua",
  ".sql",
  ".graphql",
  ".proto",
  ".vue",
  ".svelte",
  ".astro",
  ".env",
  ".gitignore",
  ".dockerfile",
  ".csv",
  ".tsv",
  ".log",
  ".patch",
  ".diff",
  ".lock"
]);
var TEXT_BASENAMES = /* @__PURE__ */ new Set(["dockerfile", "makefile", "readme", "license", "agents.md", "claude.md"]);
function isTextFile(name) {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot <= 0) return TEXT_BASENAMES.has(lower);
  return TEXT_EXT.has(lower.slice(dot));
}
var Indexer = class {
  /**
   * @param index SearchIndex 实例
   * @param paths { sessionsRoot, memgasRoot }
   */
  constructor(index2, paths) {
    this.index = index2;
    this.paths = paths;
    this.running = false;
    this.abortRequested = false;
    this.progress = {
      phase: "idle",
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
      lastResult: null
    };
  }
  /** 当前进度快照（纯数据）。 */
  snapshot() {
    return { ...this.progress, running: this.running };
  }
  /** 请求取消：在批次之间生效。 */
  abort() {
    if (this.running) this.abortRequested = true;
    return this.abortRequested;
  }
  /**
   * 构建/更新索引。
   * @param options { roots?: string[], full?: boolean, includeFiles?: boolean }
   * @returns 结果汇总
   */
  async build(options = {}) {
    if (this.running) return { ok: false, reason: "already-running", progress: this.snapshot() };
    this.running = true;
    this.abortRequested = false;
    const started = Date.now();
    this.progress = {
      ...this.progress,
      phase: "sessions",
      running: true,
      docs: 0,
      sessions: 0,
      memories: 0,
      files: 0,
      malformed: 0,
      skipped: 0,
      startedAt: started,
      finishedAt: null,
      lastError: null
    };
    try {
      if (options.full === true) this.index.reset();
      const result = {
        sessions: await this.#buildSessions(options),
        titles: this.#applyProjectedTitles(),
        memories: await this.#buildMemories(options),
        files: null
      };
      if (options.includeFiles === true && Array.isArray(options.roots) && options.roots.length > 0) {
        result.files = await this.#buildFiles(options);
      }
      const cancelled = this.abortRequested;
      this.progress = {
        ...this.progress,
        phase: cancelled ? "cancelled" : "idle",
        running: false,
        finishedAt: Date.now(),
        lastResult: {
          ok: true,
          cancelled,
          ms: Date.now() - started,
          docs: this.progress.docs,
          sessions: result.sessions,
          memories: result.memories,
          files: result.files
        }
      };
      this.index.checkpoint();
      return { ok: true, cancelled, result, progress: this.snapshot() };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.progress = {
        ...this.progress,
        phase: "error",
        running: false,
        finishedAt: Date.now(),
        lastError: message
      };
      return { ok: false, reason: message, progress: this.snapshot() };
    } finally {
      this.running = false;
      this.abortRequested = false;
    }
  }
  /** 会话语料：增量扫描 + 分批写入。 */
  async #buildSessions(options) {
    const known = this.index.fileStates();
    const pending = [];
    let written = 0;
    const flush = () => {
      if (pending.length === 0) return;
      written += this.index.writeBatch(pending.splice(0, pending.length));
      this.progress.docs = written;
    };
    const totals = scanSessions(this.paths.sessionsRoot, known, {
      onHeader: (header) => {
        if (header.id !== void 0 && header.id !== "") {
          this.index.upsertSession({
            sessionId: header.id,
            projectKey: header.projectKey,
            cwd: header.cwd,
            createdAt: header.createdAt,
            parentSession: header.parentSession,
            origin: header.origin,
            agentPreset: header.agentPreset,
            delegationDepth: header.delegationDepth
          });
        }
      },
      onTitle: (info) => {
        this.index.upsertSession({ sessionId: info.sessionId, projectKey: info.projectKey, title: info.title });
      },
      onDoc: (doc) => {
        const clipped = clipDocText(doc.text);
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
          truncated: clipped.truncated
        });
        if (pending.length >= 4e3) flush();
      },
      onFile: (state) => {
        flush();
        if (state.reset === true) this.index.deleteSession(state.sessionId);
        this.index.saveFileState(state);
        this.index.upsertSession({
          sessionId: state.sessionId,
          projectKey: state.projectKey,
          docs: this.index.countDocs(state.sessionId),
          lastTime: state.lastTime
        });
        this.progress.sessions += 1;
        if (this.abortRequested) throw new AbortError();
      }
    });
    flush();
    this.progress.malformed += totals.malformed;
    this.progress.skipped += totals.corrupt + totals.missing;
    this.progress.docs = written;
    return { ...totals, written };
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
    const home = this.paths.home;
    if (typeof home !== "string" || home === "") return { scanned: 0, titled: 0, docs: 0 };
    const entries = readProjectedTitles(home);
    if (entries.length === 0) return { scanned: 0, titled: 0, docs: 0 };
    const db = this.index.open();
    const withTitle = new Set(
      db.prepare("select session_id from docs where kind = 'title'").all().map((row) => String(row.session_id))
    );
    const pending = [];
    let titled = 0;
    for (const entry of entries) {
      if (entry.title !== null && !withTitle.has(entry.sessionId)) {
        pending.push({
          sessionId: entry.sessionId,
          projectKey: null,
          kind: "title",
          label: "\u4F1A\u8BDD\u6807\u9898",
          text: entry.title,
          time: entry.createdAt
        });
        titled += 1;
      }
      this.index.upsertSession({
        sessionId: entry.sessionId,
        title: entry.title,
        cwd: entry.cwd,
        createdAt: entry.createdAt
      });
    }
    const docs = pending.length > 0 ? this.index.writeBatch(pending) : 0;
    this.progress.docs += docs;
    return { scanned: entries.length, titled, docs };
  }
  /** 记忆语料：全量重扫（文件少、体积小）。 */
  async #buildMemories(options) {
    this.progress.phase = "memories";
    const pending = [];
    let written = 0;
    const totals = scanMemories(this.paths.memgasRoot, {
      onDoc: (doc) => {
        const clipped = clipDocText(doc.text);
        pending.push({
          kind: "memory",
          label: doc.label,
          text: clipped.text,
          truncated: clipped.truncated,
          memoryId: doc.memoryId,
          scope: doc.scope,
          status: doc.status,
          // 记忆的时间戳来自 front-matter 的 created_at；丢了它，记忆命中就没有
          // 相对时间显示，`since`/`until` 过滤也会把它们整类排除。
          time: Number.isFinite(doc.createdAt) ? doc.createdAt : null,
          path: doc.path
        });
      }
    });
    if (pending.length > 0) {
      const ids = new Set(pending.map((doc) => doc.memoryId));
      for (const id of ids) this.index.deleteMemory(id);
      written = this.index.writeBatch(pending);
    }
    this.progress.memories = totals.docs;
    this.progress.docs += written;
    return { ...totals, written };
  }
  /** 工作区文件语料（可选）：按根目录递归文本文件。 */
  async #buildFiles(options) {
    this.progress.phase = "files";
    const roots = Array.isArray(options.roots) ? options.roots : [];
    const exclude = Array.isArray(options.exclude) ? options.exclude : [];
    const pending = [];
    let written = 0;
    let scanned = 0;
    let skipped = 0;
    const flush = () => {
      if (pending.length === 0) return;
      written += this.index.writeBatch(pending.splice(0, pending.length));
    };
    const seen = /* @__PURE__ */ new Set();
    const walk = (root) => {
      let entries;
      try {
        entries = readdirSync2(root, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (this.abortRequested) throw new AbortError();
        if (scanned >= FILE_TOTAL_LIMIT) return;
        const full = join3(root, entry.name);
        if (exclude.some((pattern) => full.includes(pattern))) continue;
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue;
          if (entry.name.startsWith(".") && entry.name !== ".dsh") continue;
          walk(full);
          continue;
        }
        if (!entry.isFile()) continue;
        if (!isTextFile(entry.name)) continue;
        let stat;
        try {
          stat = statSync2(full);
        } catch {
          continue;
        }
        if (stat.size === 0 || stat.size > FILE_MAX_BYTES) {
          skipped += 1;
          continue;
        }
        scanned += 1;
        let text;
        try {
          text = readFileSync3(full, "utf8");
        } catch {
          skipped += 1;
          continue;
        }
        if (text.includes("\0")) {
          skipped += 1;
          continue;
        }
        const rel = relative(root, full);
        const clipped = clipDocText(text);
        pending.push({
          kind: "file",
          label: `\u5DE5\u4F5C\u533A\u6587\u4EF6 \xB7 ${rel.split(sep).pop() ?? rel}`,
          text: clipped.text,
          truncated: clipped.truncated,
          path: full
        });
        seen.add(full);
        if (pending.length >= 2e3) flush();
      }
    };
    for (const root of roots) {
      try {
        const stat = statSync2(root);
        if (stat.isDirectory()) walk(root);
      } catch {
        continue;
      }
    }
    flush();
    this.progress.files = written;
    this.progress.docs += written;
    this.progress.skipped += skipped;
    return { roots: roots.length, scanned, written, skipped };
  }
};
var AbortError = class extends Error {
  constructor() {
    super("indexing cancelled");
    this.name = "AbortError";
  }
};

// src/host/worker.js
var index = new SearchIndex(workerData.dbPath);
index.open();
var indexer = new Indexer(index, {
  sessionsRoot: workerData.sessionsRoot,
  memgasRoot: workerData.memgasRoot,
  home: workerData.home
});
var lastSent = 0;
var timer = setInterval(() => {
  const snapshot = indexer.snapshot();
  if (snapshot.docs !== lastSent) {
    lastSent = snapshot.docs;
    parentPort.postMessage({ type: "progress", progress: snapshot });
  }
}, 500);
parentPort.on("message", (message) => {
  if (message?.type === "abort") indexer.abort();
});
function finish(message) {
  clearInterval(timer);
  parentPort.postMessage(message);
  parentPort.unref();
}
try {
  const result = await indexer.build({
    full: workerData.full === true,
    includeFiles: workerData.includeFiles === true,
    roots: workerData.roots,
    exclude: workerData.exclude
  });
  finish({ type: "done", result });
} catch (error) {
  finish({
    type: "failed",
    error: error instanceof Error ? error.message : String(error)
  });
} finally {
  index.close();
}
