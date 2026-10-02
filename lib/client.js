window.__ModuleLoader__.load({ id: "dsh-search", factory: (require) => {
var module = { exports: {} };
var exports = module.exports;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client.js
var client_exports = {};
__export(client_exports, {
  apply: () => apply,
  inject: () => inject,
  name: () => name
});
module.exports = __toCommonJS(client_exports);
var import_react = require("react");
var PREFIX = "/plugins/dsh-search";
var KIND_LABEL = {
  title: "\u6807\u9898",
  user: "\u6211",
  assistant: "\u52A9\u624B",
  reasoning: "\u601D\u8003",
  tool_call: "\u5DE5\u5177\u8C03\u7528",
  tool_result: "\u5DE5\u5177\u7ED3\u679C",
  summary: "\u6458\u8981",
  goal: "\u76EE\u6807",
  todo: "\u4EFB\u52A1",
  command: "\u547D\u4EE4",
  command_result: "\u547D\u4EE4\u7ED3\u679C",
  approval: "\u5BA1\u6279",
  inject: "\u6CE8\u5165",
  memory: "\u8BB0\u5FC6",
  file: "\u6587\u4EF6",
  defend: "\u5B89\u5168"
};
var KIND_COLOR = {
  title: "#e8c76a",
  user: "#7ee0a0",
  assistant: "#8fd0ff",
  memory: "#c79bff",
  summary: "#e8c76a",
  goal: "#e8c76a",
  todo: "#e8c76a",
  reasoning: "#9a9a9a",
  tool_call: "#9aa8c0",
  tool_result: "#8b98ad",
  command: "#7ee0a0",
  command_result: "#8b98ad",
  approval: "#ffb27a",
  inject: "#8b98ad",
  file: "#7ad0d0",
  defend: "#ff9a9a"
};
var styles = {
  entry: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    width: "100%",
    padding: "6px 10px",
    borderRadius: 8,
    border: "1px solid transparent",
    background: "transparent",
    color: "inherit",
    cursor: "pointer",
    fontSize: 13,
    textAlign: "left"
  },
  overlay: {
    position: "fixed",
    inset: 0,
    zIndex: 3e3,
    background: "rgba(0,0,0,0.45)",
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "center",
    padding: "8vh 16px 16px"
  },
  panel: {
    width: "min(920px, 100%)",
    maxHeight: "84vh",
    display: "flex",
    flexDirection: "column",
    background: "#1b1c1f",
    color: "#e8e8e8",
    border: "1px solid #ffffff20",
    borderRadius: 14,
    boxShadow: "0 18px 60px rgba(0,0,0,0.5)",
    overflow: "hidden",
    fontSize: 13
  },
  bar: { display: "flex", gap: 8, alignItems: "center", padding: "12px 14px", borderBottom: "1px solid #ffffff14", flexWrap: "wrap" },
  input: {
    flex: "1 1 320px",
    minWidth: 200,
    padding: "9px 12px",
    borderRadius: 8,
    border: "1px solid #ffffff26",
    background: "#00000040",
    color: "inherit",
    fontSize: 14,
    outline: "none"
  },
  select: { padding: "8px 10px", borderRadius: 8, border: "1px solid #ffffff26", background: "#00000040", color: "inherit", fontSize: 12 },
  button: { padding: "8px 12px", borderRadius: 8, border: "1px solid #ffffff26", background: "#ffffff14", color: "inherit", cursor: "pointer", fontSize: 12 },
  buttonDim: { padding: "8px 12px", borderRadius: 8, border: "1px solid #ffffff1a", background: "#ffffff0a", color: "#bbb", cursor: "pointer", fontSize: 12 },
  status: { padding: "6px 14px", fontSize: 12, color: "#9a9a9a", borderBottom: "1px solid #ffffff10", display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" },
  body: { overflowY: "auto", padding: "4px 0 12px" },
  hit: { padding: "9px 14px", borderBottom: "1px solid #ffffff0d", cursor: "pointer" },
  hitHead: { display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap", marginBottom: 3 },
  badge: { fontSize: 11, padding: "1px 6px", borderRadius: 5, border: "1px solid #ffffff20", color: "#ddd" },
  hitTitle: { fontWeight: 600, color: "#e8e8e8" },
  meta: { color: "#8b8b8b", fontSize: 11 },
  snippet: { color: "#c8c8c8", lineHeight: 1.6, wordBreak: "break-word" },
  mark: { background: "#ffd76a40", color: "#ffe9a8", borderRadius: 2, padding: "0 1px" },
  empty: { padding: "24px 16px", color: "#9a9a9a", textAlign: "center" },
  err: { padding: "10px 14px", color: "#ff9a9a", fontSize: 12 },
  full: {
    margin: "8px 0 0",
    padding: "8px 10px",
    background: "#00000040",
    border: "1px solid #ffffff12",
    borderRadius: 8,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    maxHeight: 320,
    overflow: "auto",
    fontFamily: "ui-monospace, monospace",
    fontSize: 12,
    lineHeight: 1.55
  }
};
function stamp(ms) {
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function ago(ms) {
  if (!Number.isFinite(ms)) return "";
  const diff = Date.now() - ms;
  if (diff < 6e4) return "\u521A\u521A";
  const m = Math.floor(diff / 6e4);
  if (m < 60) return `${m} \u5206\u949F\u524D`;
  const hrs = Math.floor(m / 60);
  if (hrs < 24) return `${hrs} \u5C0F\u65F6\u524D`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days} \u5929\u524D`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} \u4E2A\u6708\u524D`;
  return `${Math.floor(months / 12)} \u5E74\u524D`;
}
function Snippet({ snippet }) {
  if (snippet === void 0 || snippet === null) return null;
  const children = [];
  snippet.segments.forEach((segment, index) => {
    children.push(segment.matched ? (0, import_react.createElement)("mark", { key: index, style: styles.mark }, segment.text) : (0, import_react.createElement)("span", { key: index }, segment.text));
  });
  return (0, import_react.createElement)("div", { style: styles.snippet }, snippet.prefix ?? "", ...children, snippet.suffix ?? "");
}
function Hit({ hit, onOpenSession }) {
  const [expanded, setExpanded] = (0, import_react.useState)(null);
  const [busy, setBusy] = (0, import_react.useState)(false);
  const toggle = (0, import_react.useCallback)(async () => {
    if (expanded !== null) {
      setExpanded(null);
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`${PREFIX}/doc?id=${hit.id}`, { cache: "no-store" });
      const data = await res.json();
      setExpanded(data.ok ? String(data.doc.text ?? "") : `\u8BFB\u53D6\u5931\u8D25\uFF1A${data.error ?? "\u672A\u77E5\u9519\u8BEF"}`);
    } catch (cause) {
      setExpanded(`\u8BFB\u53D6\u5931\u8D25\uFF1A${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setBusy(false);
    }
  }, [expanded, hit.id]);
  const head = [(0, import_react.createElement)("span", { key: "k", style: { ...styles.badge, color: KIND_COLOR[hit.kind] ?? "#ddd" } }, KIND_LABEL[hit.kind] ?? hit.kind)];
  if (hit.sessionTitle !== null && hit.sessionTitle !== void 0) head.push((0, import_react.createElement)("span", { key: "t", style: styles.hitTitle }, hit.sessionTitle));
  else if (hit.sessionId !== null) head.push((0, import_react.createElement)("span", { key: "t", style: styles.hitTitle }, hit.sessionId));
  if (hit.tool !== null && hit.tool !== void 0) head.push((0, import_react.createElement)("span", { key: "tool", style: styles.meta }, hit.tool));
  if (hit.turn !== null && hit.turn !== void 0) head.push((0, import_react.createElement)("span", { key: "turn", style: styles.meta }, `\u7B2C ${hit.turn} \u8F6E`));
  if (Number.isFinite(hit.time)) head.push((0, import_react.createElement)("span", { key: "time", style: styles.meta }, `${stamp(hit.time)} \xB7 ${ago(hit.time)}`));
  if (hit.path !== null && hit.path !== void 0) head.push((0, import_react.createElement)("span", { key: "path", style: styles.meta }, hit.path));
  if (Array.isArray(hit.alsoAt) && hit.alsoAt.length > 0) head.push((0, import_react.createElement)("span", { key: "also", style: styles.meta }, `\u53E6\u89C1 ${hit.alsoAt.length} \u5904`));
  const actions = [];
  if (hit.sessionId !== null) {
    actions.push((0, import_react.createElement)("button", {
      key: "open",
      type: "button",
      style: styles.buttonDim,
      onClick: (event) => {
        event.stopPropagation();
        onOpenSession(hit.sessionId);
      }
    }, "\u6253\u5F00\u4F1A\u8BDD"));
  }
  actions.push((0, import_react.createElement)("button", {
    key: "full",
    type: "button",
    style: styles.buttonDim,
    onClick: (event) => {
      event.stopPropagation();
      void toggle();
    }
  }, busy ? "\u8BFB\u53D6\u4E2D\u2026" : expanded === null ? "\u539F\u6587" : "\u6536\u8D77"));
  return (0, import_react.createElement)(
    "div",
    { style: styles.hit, "data-dsh-plugin": "dsh-search", "data-dsh-part": "hit" },
    (0, import_react.createElement)("div", { style: styles.hitHead }, ...head),
    (0, import_react.createElement)(Snippet, { snippet: hit.snippet }),
    (0, import_react.createElement)("div", { style: { marginTop: 6, display: "flex", gap: 6 } }, ...actions),
    expanded === null ? null : (0, import_react.createElement)("pre", { style: styles.full }, expanded)
  );
}
function SearchPanel({ onClose, onOpenSession }) {
  const [query, setQuery] = (0, import_react.useState)("");
  const [scope, setScope] = (0, import_react.useState)("all");
  const [match, setMatch] = (0, import_react.useState)("all");
  const [result, setResult] = (0, import_react.useState)(null);
  const [busy, setBusy] = (0, import_react.useState)(false);
  const [error, setError] = (0, import_react.useState)("");
  const [status, setStatus] = (0, import_react.useState)(null);
  const inputRef = (0, import_react.useRef)(null);
  const loadStatus = (0, import_react.useCallback)(async () => {
    try {
      const res = await fetch(`${PREFIX}/status`, { cache: "no-store" });
      const data = await res.json();
      if (data.ok) setStatus(data);
    } catch {
    }
  }, []);
  (0, import_react.useEffect)(() => {
    void loadStatus();
  }, [loadStatus]);
  (0, import_react.useEffect)(() => {
    if (status?.building !== true) return void 0;
    const timer = setInterval(() => {
      void loadStatus();
    }, 1200);
    return () => clearInterval(timer);
  }, [status?.building, loadStatus]);
  (0, import_react.useEffect)(() => {
    inputRef.current?.focus();
    const onKey = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const run = (0, import_react.useCallback)(async () => {
    const text = query.trim();
    if (text === "") return;
    setBusy(true);
    setError("");
    try {
      const params = new URLSearchParams({ query: text, scope, match, limit: "60" });
      const res = await fetch(`${PREFIX}/search?${params.toString()}`, { cache: "no-store" });
      const data = await res.json();
      if (!data.ok) {
        setError(data.error ?? "\u68C0\u7D22\u5931\u8D25");
        setResult(null);
      } else {
        setResult(data);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setResult(null);
    } finally {
      setBusy(false);
    }
  }, [query, scope, match]);
  const build = (0, import_react.useCallback)(async (full) => {
    setError("");
    try {
      const res = await fetch(`${PREFIX}/build`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ full })
      });
      const data = await res.json();
      if (!data.ok && data.reason !== "already-running") setError(data.error ?? "\u542F\u52A8\u7D22\u5F15\u5931\u8D25");
      await loadStatus();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [loadStatus]);
  const stats = status?.index ?? null;
  const statusLine = (0, import_react.useMemo)(() => {
    if (status === null) return "\u7D22\u5F15\u72B6\u6001\u8BFB\u53D6\u4E2D\u2026";
    if (status.building === true) {
      const p = status.progress ?? {};
      return `\u6B63\u5728\u7D22\u5F15\uFF1A\u5DF2\u5199\u5165 ${p.docs ?? 0} \u6761 \xB7 \u4F1A\u8BDD ${p.sessions ?? 0} \u4E2A \xB7 \u8BB0\u5FC6 ${p.memories ?? 0} \u6761\uFF08\u9636\u6BB5 ${p.phase ?? "-"}\uFF09`;
    }
    if (stats === null || stats.docs === 0) return "\u7D22\u5F15\u5C1A\u672A\u5EFA\u7ACB\uFF0C\u70B9\u53F3\u4FA7\u300C\u5EFA\u7ACB\u7D22\u5F15\u300D\u5F00\u59CB\uFF08\u9996\u6B21\u7EA6 40 \u79D2\uFF09";
    const bits = [`\u5DF2\u7D22\u5F15 ${stats.docs} \u6761`, `\u4F1A\u8BDD ${stats.sessions} \u4E2A`, `\u8BB0\u5FC6 ${stats.memories} \u6761`];
    const refreshed = stats.refreshedAt ?? stats.builtAt;
    if (Number.isFinite(refreshed) && refreshed !== null) bits.push(`\u66F4\u65B0\u4E8E ${stamp(refreshed)}`);
    if (status.lastResult?.ok === true) bits.push(`\u4E0A\u6B21\u8017\u65F6 ${(status.lastResult.ms / 1e3).toFixed(1)} \u79D2`);
    return bits.join(" \xB7 ");
  }, [status, stats]);
  const hits = result?.hits ?? [];
  return (0, import_react.createElement)(
    "div",
    { style: styles.overlay, onMouseDown: (event) => {
      if (event.target === event.currentTarget) onClose();
    } },
    (0, import_react.createElement)(
      "div",
      { style: styles.panel, "data-dsh-plugin": "dsh-search", "data-dsh-part": "panel" },
      (0, import_react.createElement)(
        "div",
        { style: styles.bar },
        (0, import_react.createElement)("input", {
          ref: inputRef,
          style: styles.input,
          value: query,
          placeholder: "\u5728\u6574\u4E2A DSH \u91CC\u641C\u7D22\uFF1A\u4F1A\u8BDD\u6807\u9898\u3001\u804A\u5929\u8BB0\u5F55\u3001\u957F\u671F\u8BB0\u5FC6\u2026",
          onChange: (event) => setQuery(event.target.value),
          onKeyDown: (event) => {
            if (event.key === "Enter") void run();
          }
        }),
        (0, import_react.createElement)(
          "select",
          { style: styles.select, value: scope, onChange: (event) => setScope(event.target.value) },
          (0, import_react.createElement)("option", { value: "all" }, "\u5168\u90E8"),
          (0, import_react.createElement)("option", { value: "sessions" }, "\u4EC5\u4F1A\u8BDD"),
          (0, import_react.createElement)("option", { value: "memory" }, "\u4EC5\u8BB0\u5FC6")
        ),
        (0, import_react.createElement)(
          "select",
          { style: styles.select, value: match, onChange: (event) => setMatch(event.target.value) },
          (0, import_react.createElement)("option", { value: "all" }, "\u5168\u90E8\u8BCD\u547D\u4E2D"),
          (0, import_react.createElement)("option", { value: "any" }, "\u4EFB\u4E00\u547D\u4E2D"),
          (0, import_react.createElement)("option", { value: "phrase" }, "\u6574\u4E32\u77ED\u8BED")
        ),
        (0, import_react.createElement)("button", { type: "button", style: busy ? styles.buttonDim : styles.button, onClick: () => void run() }, busy ? "\u641C\u7D22\u4E2D\u2026" : "\u641C\u7D22"),
        (0, import_react.createElement)("button", { type: "button", style: styles.buttonDim, onClick: onClose }, "\u5173\u95ED")
      ),
      (0, import_react.createElement)(
        "div",
        { style: styles.status },
        (0, import_react.createElement)("span", null, statusLine),
        status?.building === true ? (0, import_react.createElement)("button", { type: "button", style: styles.buttonDim, onClick: () => void fetch(`${PREFIX}/cancel`, { method: "POST" }) }, "\u505C\u6B62") : null,
        status?.building === true ? null : (0, import_react.createElement)("button", { type: "button", style: styles.buttonDim, onClick: () => void build(false) }, "\u66F4\u65B0\u7D22\u5F15"),
        status?.building === true ? null : (0, import_react.createElement)("button", { type: "button", style: styles.buttonDim, onClick: () => void build(true) }, "\u91CD\u5EFA\u7D22\u5F15")
      ),
      error !== "" ? (0, import_react.createElement)("div", { style: styles.err }, error) : null,
      (0, import_react.createElement)(
        "div",
        { style: styles.body },
        result === null ? (0, import_react.createElement)("div", { style: styles.empty }, "\u8F93\u5165\u5173\u952E\u8BCD\u540E\u56DE\u8F66\u3002\u591A\u4E2A\u8BCD\u7528\u7A7A\u683C\u5206\u9694\uFF08\u90FD\u8981\u547D\u4E2D\uFF09\uFF1B\u5F15\u53F7\u5185\u4E3A\u6574\u4E32\u77ED\u8BED\uFF1B\u8BCD\u524D\u51CF\u53F7\u8868\u793A\u6392\u9664\u3002") : hits.length === 0 ? (0, import_react.createElement)("div", { style: styles.empty }, `\u6CA1\u6709\u627E\u5230\u5339\u914D\u300C${result.terms?.join(" ") ?? query}\u300D\u7684\u8BB0\u5F55\u3002\u53EF\u4EE5\u6362\u5173\u952E\u8BCD\uFF0C\u6216\u628A\u5339\u914D\u65B9\u5F0F\u6539\u6210\u300C\u4EFB\u4E00\u547D\u4E2D\u300D\u3002`) : (0, import_react.createElement)(
          "div",
          null,
          (0, import_react.createElement)(
            "div",
            { style: { ...styles.status, borderBottom: "none" } },
            (0, import_react.createElement)("span", null, `\u547D\u4E2D ${result.total} \u6761${result.relaxed ? "\uFF08\u4E25\u683C\u5339\u914D\u65E0\u7ED3\u679C\uFF0C\u5DF2\u653E\u5BBD\u4E3A\u4EFB\u4E00\u547D\u4E2D\uFF09" : ""}\uFF0C\u5217\u51FA\u524D ${hits.length} \u6761 \xB7 ${result.ms} \u6BEB\u79D2`)
          ),
          ...hits.map((hit) => (0, import_react.createElement)(Hit, { key: hit.id, hit, onOpenSession }))
        )
      )
    )
  );
}
function SearchEntry(props) {
  const [open, setOpen] = (0, import_react.useState)(false);
  const wide = props?.wide !== false;
  const openSession = (0, import_react.useCallback)((sessionId) => {
    try {
      props?.sessions?.open?.(sessionId);
      setOpen(false);
    } catch {
    }
  }, [props]);
  return (0, import_react.createElement)(
    "div",
    { "data-dsh-plugin": "dsh-search", "data-dsh-part": "entry" },
    (0, import_react.createElement)(
      "button",
      {
        type: "button",
        style: styles.entry,
        title: "\u5168\u5C40\u641C\u7D22\uFF08\u4F1A\u8BDD\u6807\u9898 / \u804A\u5929\u8BB0\u5F55 / \u957F\u671F\u8BB0\u5FC6\uFF09",
        onClick: () => setOpen(true)
      },
      (0, import_react.createElement)("span", { style: { fontSize: 14, lineHeight: 1 } }, "\u2315"),
      wide ? (0, import_react.createElement)("span", null, "\u5168\u5C40\u641C\u7D22") : null
    ),
    open ? (0, import_react.createElement)(SearchPanel, { onClose: () => setOpen(false), onOpenSession: openSession }) : null
  );
}
var name = "dsh-search-client";
var inject = ["slots", "sessions"];
function apply(ctx) {
  ctx.effect(() => {
    const dispose = ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
      name: "sidebar.footer.action",
      id: "dsh-search",
      // 排在设置等既有入口前面：搜索是高频动作。
      order: -10,
      label: () => "\u5168\u5C40\u641C\u7D22",
      inject: () => ({ sessions: ctx.get("sessions") })
    }, SearchEntry));
    return () => {
      dispose();
    };
  }, "dsh-search: sidebar entry");
}
return module.exports; } });
