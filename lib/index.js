// src/index.js
import { existsSync } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";

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
function queryTerms(query) {
  const raw = tokenize(query);
  if (raw === "") return [];
  const seen = /* @__PURE__ */ new Set();
  const terms = [];
  for (const term of raw.split(" ")) {
    if (term === "" || seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
  }
  return terms;
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
  groups.forEach((group, index) => {
    const last = index === groups.length - 1;
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

// src/host/tool.js
var KIND_LABEL = {
  title: "\u4F1A\u8BDD\u6807\u9898",
  user: "\u7528\u6237\u6D88\u606F",
  assistant: "\u52A9\u624B\u56DE\u590D",
  reasoning: "\u601D\u8003\u8FC7\u7A0B",
  tool_call: "\u5DE5\u5177\u8C03\u7528",
  tool_result: "\u5DE5\u5177\u7ED3\u679C",
  summary: "\u538B\u7F29\u6458\u8981",
  goal: "\u4F1A\u8BDD\u76EE\u6807",
  todo: "\u4EFB\u52A1\u6E05\u5355",
  command: "\u7528\u6237\u547D\u4EE4",
  command_result: "\u547D\u4EE4\u7ED3\u679C",
  approval: "\u5BA1\u6279\u8BF7\u6C42",
  inject: "\u6CE8\u5165\u6D88\u606F",
  memory: "\u957F\u671F\u8BB0\u5FC6",
  file: "\u5DE5\u4F5C\u533A\u6587\u4EF6",
  defend: "\u5B89\u5168\u68C0\u6D4B"
};
function stamp(ms) {
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function ago(ms, now) {
  if (!Number.isFinite(ms)) return null;
  const diff = now - ms;
  if (diff < 6e4) return "\u521A\u521A";
  const minutes = Math.floor(diff / 6e4);
  if (minutes < 60) return `${minutes} \u5206\u949F\u524D`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} \u5C0F\u65F6\u524D`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} \u5929\u524D`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} \u4E2A\u6708\u524D`;
  return `${Math.floor(months / 12)} \u5E74\u524D`;
}
var SEARCH_TOOL = {
  name: "search_dsh",
  description: [
    "\u5728\u6574\u4E2A DSH \u91CC\u68C0\u7D22\u5173\u952E\u8BCD\uFF1A\u5168\u90E8\u5386\u53F2\u4F1A\u8BDD\u7684\u6807\u9898\u4E0E\u804A\u5929\u8BB0\u5F55\uFF08\u7528\u6237\u6D88\u606F\u3001\u52A9\u624B\u56DE\u590D\u3001\u601D\u8003\u8FC7\u7A0B\u3001",
    "\u5DE5\u5177\u8C03\u7528\u4E0E\u7ED3\u679C\u3001\u538B\u7F29\u6458\u8981\u3001\u4F1A\u8BDD\u76EE\u6807\u3001\u4EFB\u52A1\u6E05\u5355\uFF09\u3001\u957F\u671F\u8BB0\u5FC6\uFF0C\u4EE5\u53CA\uFF08\u82E5\u5DF2\u5F00\u542F\uFF09\u5DE5\u4F5C\u533A\u6587\u4EF6\u3002",
    "\u5173\u952E\u8BCD\u6309\u201C\u539F\u6587\u5B50\u4E32\u201D\u5339\u914D\uFF1A\u4E2D\u6587\u8FDE\u7EED\u6BB5\u5FC5\u987B\u539F\u6837\u76F8\u90BB\u51FA\u73B0\uFF0C\u82F1\u6587\u8BCD\u6309\u6574\u8BCD\u5339\u914D\uFF08\u4E0D\u5206\u5927\u5C0F\u5199\uFF09\u3002",
    "\u591A\u4E2A\u8BCD\u4E4B\u95F4\u662F\u201C\u4E0E\u201D\u5173\u7CFB\uFF1B\u7528\u5F15\u53F7\u5305\u4F4F\u53EF\u5F3A\u5236\u6574\u4F53\u77ED\u8BED\uFF0C\u8BCD\u524D\u52A0\u51CF\u53F7\u8868\u793A\u6392\u9664\u3002",
    "\u8FD4\u56DE\u6309\u76F8\u5173\u5EA6\u6392\u5E8F\u7684\u7247\u6BB5\u4E0E\u51FA\u5904\uFF1B\u9700\u8981\u770B\u5168\u6587\u65F6\u7528 search_dsh_read \u8BFB\u56DE\u67D0\u4E00\u6761\u3002"
  ].join(""),
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "\u5173\u952E\u8BCD\u3002\u591A\u4E2A\u8BCD\u7528\u7A7A\u683C\u5206\u9694\uFF08\u5168\u90E8\u547D\u4E2D\uFF09\uFF1B\u5F15\u53F7\u5185\u4E3A\u6574\u4F53\u77ED\u8BED\uFF1B\u8BCD\u524D\u51CF\u53F7\u8868\u793A\u6392\u9664\u3002"
      },
      scope: {
        type: "string",
        enum: ["all", "sessions", "memory", "files"],
        description: "\u68C0\u7D22\u8303\u56F4\u3002all=\u5168\u90E8\uFF08\u9ED8\u8BA4\uFF09\uFF1Bsessions=\u4F1A\u8BDD\u6807\u9898\u4E0E\u804A\u5929\u8BB0\u5F55\uFF1Bmemory=\u957F\u671F\u8BB0\u5FC6\uFF1Bfiles=\u5DE5\u4F5C\u533A\u6587\u4EF6\u3002"
      },
      kinds: {
        type: "array",
        items: { type: "string" },
        description: "\u53EA\u5728\u8FD9\u4E9B\u8BB0\u5F55\u79CD\u7C7B\u91CC\u627E\uFF1Atitle/user/assistant/reasoning/tool_call/tool_result/summary/goal/todo/command/memory/file\u3002\u7701\u7565\u5219\u4E0D\u9650\u3002"
      },
      session_id: {
        type: "string",
        description: "\u53EA\u5728\u8FD9\u4E00\u4E2A\u4F1A\u8BDD\u91CC\u627E\uFF08\u7528\u4E8E\u5DF2\u77E5\u4F1A\u8BDD\u5185\u7684\u5B9A\u4F4D\uFF09\u3002\u7701\u7565\u5219\u641C\u5168\u90E8\u4F1A\u8BDD\u3002"
      },
      cwd: {
        type: "string",
        description: "\u53EA\u5728\u5DE5\u4F5C\u76EE\u5F55\u7B49\u4E8E\u8BE5\u8DEF\u5F84\u7684\u4F1A\u8BDD\u91CC\u627E\uFF08\u6309\u9879\u76EE\u8FC7\u6EE4\uFF09\u3002\u7701\u7565\u5219\u4E0D\u9650\u3002"
      },
      since: {
        type: "string",
        description: "\u53EA\u627E\u8BE5\u65F6\u95F4\u4E4B\u540E\u7684\u8BB0\u5F55\uFF0CISO 8601\uFF08\u5982 2026-09-01 \u6216 2026-09-01T10:00:00+08:00\uFF09\u3002"
      },
      until: {
        type: "string",
        description: "\u53EA\u627E\u8BE5\u65F6\u95F4\u4E4B\u524D\u7684\u8BB0\u5F55\uFF0CISO 8601\u3002"
      },
      match: {
        type: "string",
        enum: ["all", "any", "phrase"],
        description: "all=\u5168\u90E8\u5173\u952E\u8BCD\u90FD\u547D\u4E2D\uFF08\u9ED8\u8BA4\uFF09\uFF1Bany=\u547D\u4E2D\u4EFB\u4E00\u5373\u53EF\uFF08\u53EC\u56DE\u4F18\u5148\uFF09\uFF1Bphrase=\u6574\u4E32\u5F53\u4F5C\u4E00\u4E2A\u8FDE\u7EED\u77ED\u8BED\u3002"
      },
      limit: {
        type: "number",
        description: "\u6700\u591A\u8FD4\u56DE\u51E0\u6761\uFF0C\u9ED8\u8BA4 30\uFF08config.defaultLimit\uFF09\uFF0C\u4E0A\u9650 100\u3002"
      }
    },
    required: ["query"]
  }
};
var READ_TOOL = {
  name: "search_dsh_read",
  description: [
    "\u628A search_dsh \u547D\u4E2D\u7ED3\u679C\u4E2D\u7684\u67D0\u4E00\u6761\u6309\u9700\u8BFB\u56DE\uFF1Adoc_id \u4E3A\u7ED3\u679C\u91CC\u7684\u7F16\u53F7\uFF0C",
    "\u53EF\u9009 offset/limit \u5206\u6BB5\u8BFB\u53D6\uFF08\u5B57\u7B26\u4E3A\u5355\u4F4D\uFF09\uFF0C\u7528\u4E8E\u957F\u5DE5\u5177\u7ED3\u679C\u6216\u957F\u601D\u8003\u8FC7\u7A0B\u3002"
  ].join(""),
  parameters: {
    type: "object",
    properties: {
      doc_id: { type: "number", description: "search_dsh \u7ED3\u679C\u91CC\u7684\u6761\u76EE\u7F16\u53F7\u3002" },
      offset: { type: "number", description: "\u4ECE\u7B2C\u51E0\u4E2A\u5B57\u7B26\u5F00\u59CB\u8BFB\uFF0C\u9ED8\u8BA4 0\u3002" },
      limit: { type: "number", description: "\u6700\u591A\u8BFB\u591A\u5C11\u4E2A\u5B57\u7B26\uFF0C\u9ED8\u8BA4 4000\uFF0C\u4E0A\u9650 20000\u3002" }
    },
    required: ["doc_id"]
  }
};
function parseTime(value) {
  if (typeof value !== "string" || value.trim() === "") return void 0;
  const text = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const ms2 = Date.parse(`${text}T00:00:00`);
    return Number.isFinite(ms2) ? ms2 : void 0;
  }
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : void 0;
}
function renderResults(result, query, snippetFor2) {
  const now = Date.now();
  const lines = [];
  const scopeNote = result.relaxed ? "\uFF08\u4E25\u683C\u5339\u914D\u65E0\u7ED3\u679C\uFF0C\u5DF2\u653E\u5BBD\u4E3A\u201C\u547D\u4E2D\u4EFB\u4E00\u5173\u952E\u8BCD\u201D\uFF09" : "";
  if (result.hits.length === 0) {
    return `\u6CA1\u6709\u627E\u5230\u5339\u914D\u300C${query}\u300D\u7684\u8BB0\u5F55${scopeNote}\u3002\u53EF\u4EE5\u6362\u5173\u952E\u8BCD\u3001\u628A match \u8BBE\u4E3A any\uFF0C\u6216\u5148\u8FD0\u884C\u4E00\u6B21\u7D22\u5F15\u3002`;
  }
  lines.push(`\u627E\u5230 ${result.total} \u6761\u5339\u914D\u300C${query}\u300D${scopeNote}\uFF0C\u6309\u76F8\u5173\u5EA6\u5217\u51FA\u524D ${result.hits.length} \u6761\uFF1A`);
  lines.push("");
  result.hits.forEach((hit, index) => {
    const label = KIND_LABEL[hit.kind] ?? hit.kind;
    const bits = [`#${hit.id}`];
    if (hit.sessionTitle !== null) bits.push(`\u4F1A\u8BDD\u300C${hit.sessionTitle}\u300D`);
    else if (hit.sessionId !== null) bits.push(hit.sessionId);
    bits.push(label);
    if (hit.tool !== null) bits.push(hit.tool);
    if (hit.turn !== null) bits.push(`\u7B2C ${hit.turn} \u8F6E`);
    if (hit.time !== null) bits.push(`${stamp(hit.time)}\uFF08${ago(hit.time, now)}\uFF09`);
    if (hit.path !== null) bits.push(hit.path);
    lines.push(`${index + 1}. ${bits.join(" \xB7 ")}`);
    const piece = snippetFor2(hit.text, query, 300);
    lines.push(`   ${piece.prefix}${piece.text.replace(/\s+/g, " ").trim()}${piece.suffix}`);
    lines.push("");
  });
  lines.push("\u8981\u770B\u67D0\u4E00\u6761\u7684\u5B8C\u6574\u539F\u6587\uFF0C\u7528 search_dsh_read \u5E76\u4F20\u5165\u4E0A\u9762\u7684\u7F16\u53F7\uFF08#\u540E\u9762\u7684\u6570\u5B57\uFF09\u3002");
  return lines.join("\n");
}
function renderDoc(doc, offset, limit) {
  const text = doc.text ?? "";
  const from = Math.max(0, Number(offset ?? 0) || 0);
  const size = Math.min(Math.max(Number(limit ?? 4e3) || 4e3, 1), 2e4);
  const slice = text.slice(from, from + size);
  const head = [
    `#${doc.id} ${KIND_LABEL[doc.kind] ?? doc.kind}`,
    doc.label === null ? null : doc.label,
    doc.sessionId === null ? null : `\u4F1A\u8BDD ${doc.sessionId}`,
    doc.time === null ? null : stamp(doc.time),
    `${text.length} \u5B57`,
    `${from}-${Math.min(from + size, text.length)}`
  ].filter(Boolean).join(" \xB7 ");
  const more = from + size < text.length ? `

\uFF08\u8FD8\u6709 ${text.length - from - size} \u5B57\uFF0C\u7EE7\u7EED\u8BFB\u8BF7\u628A offset \u8BBE\u4E3A ${from + size}\uFF09` : "";
  return `${head}

${slice}${more}`;
}

// src/core/paths.js
import { homedir } from "node:os";
import { isAbsolute, join as join2, resolve } from "node:path";
function expandHome(path, home = homedir()) {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join2(home, path.slice(2));
  return path;
}
function dshHome(env = process.env, home = homedir()) {
  const raw = env.DSH_HOME;
  if (typeof raw === "string" && raw.trim() !== "") {
    const expanded = expandHome(raw.trim(), home);
    return isAbsolute(expanded) ? expanded : resolve(expanded);
  }
  return join2(home, ".dsh");
}
function sessionsRoot(home = dshHome()) {
  return join2(home, "sessions");
}
function memgasRoot(home = dshHome()) {
  return join2(home, "memgas");
}
function indexDir(home = dshHome()) {
  return join2(home, "search");
}
function indexDbPath(home = dshHome()) {
  return join2(indexDir(home), "index.sqlite");
}
function defaultFileRoots(env = process.env, home = homedir()) {
  const raw = env.DSH_SEARCH_FILE_ROOTS;
  if (typeof raw !== "string" || raw.trim() === "") return [];
  return raw.split(",").map((entry) => expandHome(entry.trim(), home)).filter((entry) => entry !== "");
}

// src/core/highlight.js
var CJK_CHAR2 = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;
function pureCjk(term) {
  if (term === "") return false;
  for (const ch of term) {
    if (!CJK_CHAR2.test(ch)) return false;
  }
  return true;
}
function findRanges(text, terms) {
  if (typeof text !== "string" || text === "" || !Array.isArray(terms) || terms.length === 0) return [];
  const lowered = text.toLowerCase();
  const ranges = [];
  for (const term of terms) {
    if (typeof term !== "string" || term === "") continue;
    const needle = pureCjk(term) ? term : term.toLowerCase();
    const haystack = pureCjk(term) ? text : lowered;
    let from = 0;
    for (; ; ) {
      const at = haystack.indexOf(needle, from);
      if (at < 0) break;
      ranges.push([at, at + needle.length]);
      from = at + Math.max(1, needle.length);
      if (ranges.length > 4e3) break;
    }
    if (ranges.length > 4e3) break;
  }
  if (ranges.length === 0) return [];
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [ranges[0]];
  for (let i = 1; i < ranges.length; i += 1) {
    const last = merged[merged.length - 1];
    const cur = ranges[i];
    if (cur[0] <= last[1]) {
      if (cur[1] > last[1]) last[1] = cur[1];
    } else merged.push(cur);
  }
  return merged;
}
function segments(text, ranges) {
  const out = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start > cursor) out.push({ text: text.slice(cursor, start), matched: false });
    out.push({ text: text.slice(start, end), matched: true });
    cursor = end;
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), matched: false });
  return out;
}
function safeStart(text, index) {
  let i = index;
  if (i <= 0) return 0;
  const code = text.charCodeAt(i);
  if (code >= 56320 && code <= 57343) i -= 1;
  return i;
}
function safeEnd(text, index) {
  let i = index;
  if (i >= text.length) return text.length;
  const code = text.charCodeAt(i);
  if (code >= 56320 && code <= 57343) i += 1;
  return i;
}
function windowStart(ranges, limit) {
  if (ranges.length === 0) return 0;
  let bestStart = ranges[0][0];
  let bestCount = 0;
  for (let i = 0; i < ranges.length; i += 1) {
    const start = ranges[i][0];
    let count = 0;
    for (let j = i; j < ranges.length && ranges[j][0] - start <= limit; j += 1) count += 1;
    if (count > bestCount) {
      bestCount = count;
      bestStart = start;
    }
  }
  return bestStart;
}
function snippet(text, terms, width = 220) {
  const source = typeof text === "string" ? text : "";
  if (source === "") return { text: "", prefix: "", suffix: "", segments: [] };
  const ranges = findRanges(source, terms);
  if (ranges.length === 0) {
    const flat = source.replace(/\s+/g, " ").trim();
    const head = flat.slice(0, width);
    return { text: head, prefix: "", suffix: flat.length > head.length ? "\u2026" : "", segments: [{ text: head, matched: false }] };
  }
  const anchor = windowStart(ranges, width);
  const half = Math.floor(width / 2);
  let start = safeStart(source, Math.max(0, anchor - half));
  let end = safeEnd(source, Math.min(source.length, start + width));
  if (end - start < width) start = safeStart(source, Math.max(0, end - width));
  const slice = source.slice(start, end);
  const local = [];
  for (const [rs, re] of ranges) {
    if (re <= start || rs >= end) continue;
    local.push([Math.max(0, rs - start), Math.min(slice.length, re - start)]);
  }
  return {
    text: slice,
    prefix: start > 0 ? "\u2026" : "",
    suffix: end < source.length ? "\u2026" : "",
    segments: segments(slice, local)
  };
}
function snippetFor(text, query, width = 220) {
  const parsed = parseQuery(query);
  const terms = parsed.terms.length > 0 ? parsed.terms : queryTerms(query);
  return snippet(text, terms, width);
}

// src/index.js
var PREFIX = "/plugins/dsh-search";
var TEXT_OUTPUT = {
  schema: { type: "string" },
  render: (_args, value) => [{ type: "text", text: String(value) }]
};
var name = "dsh-search";
var inject = ["tools", "timer"];
var CONFIG_DEFAULTS = {
  /** 是否把工作区文件也纳入索引（默认关闭：会显著拉长构建时间）。 */
  includeFiles: false,
  /** 工作区文件的根目录列表；为空时读取环境变量 DSH_SEARCH_FILE_ROOTS。 */
  fileRoots: [],
  /** 工作区文件的排除子串。 */
  exclude: ["/node_modules/", "/.git/", "/Library/", "/.Trash/"],
  /** 启动后自动增量索引的延迟（毫秒）；0 表示不自动索引。 */
  autoIndexDelayMs: 2e4,
  /** 自动增量索引的间隔（毫秒）；0 表示只做一次。 */
  autoIndexIntervalMs: 30 * 6e4,
  /** 单次检索返回的默认条数。 */
  defaultLimit: 30
};
var CONFIG_TYPES = {
  includeFiles: "boolean",
  fileRoots: "string[]",
  exclude: "string[]",
  autoIndexDelayMs: "number",
  autoIndexIntervalMs: "number",
  defaultLimit: "number"
};
var Config = {
  ...CONFIG_DEFAULTS,
  "~standard": {
    version: 1,
    vendor: "dsh-search",
    validate(value) {
      if (value === void 0 || value === null) return { value: { ...CONFIG_DEFAULTS } };
      if (typeof value !== "object" || Array.isArray(value)) {
        return { issues: [{ message: "config \u5FC5\u987B\u662F\u4E00\u4E2A\u5BF9\u8C61" }] };
      }
      const issues = [];
      const out = { ...CONFIG_DEFAULTS };
      for (const [key, raw] of Object.entries(value)) {
        const expected = CONFIG_TYPES[key];
        if (expected === void 0) {
          issues.push({ message: `\u672A\u77E5\u914D\u7F6E\u9879 ${key}`, path: [key] });
          continue;
        }
        if (expected === "string[]") {
          if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string")) {
            issues.push({ message: "\u5E94\u4E3A\u5B57\u7B26\u4E32\u6570\u7EC4", path: [key] });
            continue;
          }
        } else if (typeof raw !== expected) {
          issues.push({ message: `\u5E94\u4E3A ${expected}`, path: [key] });
          continue;
        }
        out[key] = raw;
      }
      return issues.length > 0 ? { issues } : { value: out };
    }
  }
};
function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve2, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.trim() === "") {
        resolve2({});
        return;
      }
      try {
        resolve2(JSON.parse(raw));
      } catch (error) {
        reject(new Error(`invalid JSON body: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
    req.on("error", reject);
  });
}
function sendJson(res, payload, status = 200) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}
function searchOptions(input, config, limitCap) {
  const limit = Math.min(Math.max(Number(input.limit ?? config.defaultLimit) || config.defaultLimit, 1), limitCap);
  const options = { query: String(input.query ?? ""), limit, mode: typeof input.match === "string" ? input.match : "auto" };
  if (Array.isArray(input.kinds) && input.kinds.length > 0) options.kinds = input.kinds.map(String);
  const sessionId = typeof input.session_id === "string" && input.session_id !== "" ? input.session_id : input.sessionId;
  if (typeof sessionId === "string" && sessionId !== "") options.sessionId = sessionId;
  if (typeof input.cwd === "string" && input.cwd !== "") options.cwd = input.cwd;
  const since = Number.isFinite(input.since) ? Number(input.since) : parseTime(input.since);
  const until = Number.isFinite(input.until) ? Number(input.until) : parseTime(input.until);
  if (Number.isFinite(since)) options.since = since;
  if (Number.isFinite(until)) options.until = until;
  return options;
}
function apply(ctx, config = {}) {
  const validated = Config["~standard"].validate(config);
  if (validated.issues !== void 0) {
    throw new TypeError(`dsh-search \u914D\u7F6E\u65E0\u6548\uFF1A${validated.issues.map((i) => `${i.path?.join(".") ?? ""} ${i.message}`).join("; ")}`);
  }
  const settings = validated.value;
  const home = dshHome();
  const dbPath = indexDbPath(home);
  const roots = Array.isArray(settings.fileRoots) && settings.fileRoots.length > 0 ? settings.fileRoots : defaultFileRoots(process.env, homedir2());
  const index = new SearchIndex(dbPath);
  index.open();
  const state = {
    running: false,
    worker: null,
    progress: { phase: "idle", docs: 0, sessions: 0, memories: 0, startedAt: null, finishedAt: null, lastError: null },
    lastResult: null
  };
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
    includeFiles: settings.includeFiles === true
  });
  const startBuild = (options = {}) => {
    if (state.running) return { ok: false, reason: "already-running", status: status() };
    const workerPath = fileURLToPath(new URL("./worker.js", import.meta.url));
    state.running = true;
    state.progress = { phase: "starting", docs: 0, sessions: 0, memories: 0, startedAt: Date.now(), finishedAt: null, lastError: null };
    const worker = new Worker(workerPath, {
      workerData: {
        dbPath,
        sessionsRoot: sessionsRoot(home),
        memgasRoot: memgasRoot(home),
        home,
        full: options.full === true,
        includeFiles: options.includeFiles === true || settings.includeFiles === true,
        roots,
        exclude: Array.isArray(settings.exclude) ? settings.exclude : []
      }
    });
    state.worker = worker;
    worker.on("message", (message) => {
      if (message?.type === "progress") state.progress = { ...message.progress, running: true };
      if (message?.type === "done") state.lastResult = message.result;
      if (message?.type === "failed") state.progress = { ...state.progress, lastError: String(message.error) };
    });
    worker.on("error", (error) => {
      state.progress = { ...state.progress, lastError: error instanceof Error ? error.message : String(error) };
    });
    worker.on("exit", () => {
      state.running = false;
      state.worker = null;
      state.progress = { ...state.progress, running: false, finishedAt: Date.now(), phase: state.progress.lastError === null ? "idle" : "error" };
      try {
        index.checkpoint();
      } catch {
      }
    });
    return { ok: true, status: status() };
  };
  const cancelBuild = () => {
    if (!state.running || state.worker === null) return { ok: false, reason: "not-running" };
    state.worker.postMessage({ type: "abort" });
    return { ok: true };
  };
  ctx.effect(() => ctx.tools.register({
    ...SEARCH_TOOL,
    output: TEXT_OUTPUT,
    async execute(args) {
      if (!existsSync(dbPath) || index.stats().docs === 0) {
        return "\u68C0\u7D22\u7D22\u5F15\u8FD8\u6CA1\u6709\u5EFA\u7ACB\u3002\u8BF7\u8BA9\u7528\u6237\u5728 DSH Web GUI \u7684\u300C\u5168\u5C40\u641C\u7D22\u300D\u9762\u677F\u91CC\u70B9\u4E00\u6B21\u300C\u5EFA\u7ACB\u7D22\u5F15\u300D\uFF0C\u6216\u7A0D\u7B49\u81EA\u52A8\u7D22\u5F15\u5B8C\u6210\u3002";
      }
      const options = searchOptions(args ?? {}, settings, 100);
      const scope = String(args?.scope ?? "all");
      if (scope === "memory") options.memoryOnly = true;
      if (scope === "sessions") {
        options.memoryOnly = false;
        options.excludeFiles = true;
      }
      if (scope === "files") options.kinds = ["file"];
      const result = index.search(options);
      if (result.error !== void 0) return `\u68C0\u7D22\u5931\u8D25\uFF1A${result.error}`;
      return renderResults(result, options.query, snippetFor);
    }
  }), "dsh-search: search tool");
  ctx.effect(() => ctx.tools.register({
    ...READ_TOOL,
    output: TEXT_OUTPUT,
    async execute(args) {
      const id = Number(args?.doc_id);
      if (!Number.isFinite(id)) return "doc_id \u5FC5\u987B\u662F\u6570\u5B57\uFF08\u5373 search_dsh \u7ED3\u679C\u91CC # \u540E\u9762\u7684\u7F16\u53F7\uFF09\u3002";
      const doc = index.doc(id);
      if (doc === void 0) return `\u6CA1\u6709\u7F16\u53F7\u4E3A ${id} \u7684\u8BB0\u5F55\u3002\u7D22\u5F15\u53EF\u80FD\u5DF2\u91CD\u5EFA\uFF0C\u8BF7\u91CD\u65B0\u68C0\u7D22\u3002`;
      return renderDoc(doc, args?.offset, args?.limit);
    }
  }), "dsh-search: read tool");
  ctx.inject(["webServer"], (injected) => {
    injected.effect(() => {
      const routes = [
        injected.webServer.register({
          kind: "exact",
          path: `${PREFIX}/status`,
          handler: (req, res) => sendJson(res, status())
        }),
        injected.webServer.register({
          kind: "exact",
          path: `${PREFIX}/search`,
          handler: async (req, res) => {
            try {
              const url = new URL(req.url ?? "", "http://localhost");
              const input = { ...Object.fromEntries(url.searchParams) };
              if (url.searchParams.has("kinds")) input.kinds = url.searchParams.getAll("kinds");
              const options = searchOptions(input, settings, 200);
              const scope = String(input.scope ?? "all");
              if (scope === "memory") options.memoryOnly = true;
              if (scope === "sessions") {
                options.memoryOnly = false;
                options.excludeFiles = true;
              }
              if (scope === "files") options.kinds = ["file"];
              const started = Date.now();
              const result = index.search(options);
              if (result.error !== void 0) {
                sendJson(res, { ok: false, error: result.error }, 400);
                return;
              }
              const hits = result.hits.map((hit) => {
                const piece = snippetFor(hit.text, options.query, 260);
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
                  alsoAt: hit.alsoAt.map((entry) => ({ id: entry.id, kind: entry.kind, seq: entry.seq })),
                  snippet: { prefix: piece.prefix, suffix: piece.suffix, segments: piece.segments }
                };
              });
              sendJson(res, {
                ok: true,
                total: result.total,
                shown: result.shown,
                terms: result.terms,
                mode: result.mode,
                relaxed: result.relaxed === true,
                ms: Date.now() - started,
                hits
              });
            } catch (error) {
              sendJson(res, { ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
            }
          }
        }),
        injected.webServer.register({
          kind: "exact",
          path: `${PREFIX}/doc`,
          handler: (req, res) => {
            try {
              const url = new URL(req.url ?? "", "http://localhost");
              const id = Number(url.searchParams.get("id"));
              if (!Number.isFinite(id)) {
                sendJson(res, { ok: false, error: "id \u5FC5\u987B\u662F\u6570\u5B57" }, 400);
                return;
              }
              const doc = index.doc(id);
              if (doc === void 0) {
                sendJson(res, { ok: false, error: `\u6CA1\u6709\u7F16\u53F7\u4E3A ${id} \u7684\u8BB0\u5F55` }, 404);
                return;
              }
              const radius = Math.min(Math.max(Number(url.searchParams.get("radius") ?? 0) || 0, 0), 10);
              sendJson(res, {
                ok: true,
                doc,
                context: radius > 0 && doc.sessionId !== null && doc.seq !== null ? index.context(doc.sessionId, doc.seq, radius) : []
              });
            } catch (error) {
              sendJson(res, { ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
            }
          }
        }),
        injected.webServer.register({
          kind: "exact",
          path: `${PREFIX}/sessions`,
          handler: (req, res) => {
            try {
              sendJson(res, { ok: true, sessions: index.listSessions(400) });
            } catch (error) {
              sendJson(res, { ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
            }
          }
        }),
        injected.webServer.register({
          kind: "exact",
          path: `${PREFIX}/build`,
          handler: async (req, res) => {
            try {
              const body = await readBody(req);
              sendJson(res, startBuild({ full: body.full === true, includeFiles: body.includeFiles === true }));
            } catch (error) {
              sendJson(res, { ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
            }
          }
        }),
        injected.webServer.register({
          kind: "exact",
          path: `${PREFIX}/cancel`,
          handler: (req, res) => sendJson(res, cancelBuild())
        })
      ];
      return () => {
        for (const dispose of routes) dispose();
      };
    }, "dsh-search: web routes");
  });
  const delay = Number(settings.autoIndexDelayMs) || 0;
  const interval = Number(settings.autoIndexIntervalMs) || 0;
  if (delay > 0) {
    ctx.effect(() => ctx.timer.timeout(() => {
      startBuild({});
      if (interval > 0) {
        const dispose = ctx.timer.interval(() => startBuild({}), interval);
        ctx.effect(() => dispose, "dsh-search: auto index interval");
      }
    }, delay), "dsh-search: auto index kickoff");
  }
  ctx.effect(() => () => {
    if (state.worker !== null) {
      void state.worker.terminate();
      state.worker = null;
    }
    index.close();
  }, "dsh-search: teardown");
  ctx.effect(() => ctx.provide("dshSearch", {
    search: (options) => index.search(options),
    doc: (id) => index.doc(id),
    status,
    build: startBuild,
    cancel: cancelBuild,
    sessions: (limit) => index.listSessions(limit),
    projectedTitles: () => readProjectedTitles(home)
  }), "dsh-search: service");
}
export {
  Config,
  apply,
  inject,
  name
};
