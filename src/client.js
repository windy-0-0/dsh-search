/**
 * dsh-search · 浏览器半区：侧边栏「全局搜索」入口 + 全屏搜索面板
 *
 * 与模型侧共用同一个索引（同一套 `/plugins/dsh-search/*` 本地路由），因此
 * 「人搜到的」和「模型搜到的」永远一致。
 *
 * 交互原则：
 *   - 打开即聚焦输入框，回车检索；结果里命中处高亮，点标题直接跳到那个会话；
 *   - 片段与高亮区间由 Host 算好（同一套匹配逻辑不写两遍），前端只渲染；
 *   - 索引状态常驻显示：没建索引时给一个明确的「建立索引」按钮，而不是让用户猜；
 *   - 不轮询：只有构建进行中才按秒拉状态，构建结束就停。
 */

import { createElement as h, useCallback, useEffect, useMemo, useRef, useState } from 'react'

const PREFIX = '/plugins/dsh-search'

const KIND_LABEL = {
  title: '标题',
  user: '我',
  assistant: '助手',
  reasoning: '思考',
  tool_call: '工具调用',
  tool_result: '工具结果',
  summary: '摘要',
  goal: '目标',
  todo: '任务',
  command: '命令',
  command_result: '命令结果',
  approval: '审批',
  inject: '注入',
  memory: '记忆',
  file: '文件',
  defend: '安全',
}

/** 种类的着色：一眼区分"谁说的"。 */
const KIND_COLOR = {
  title: '#e8c76a',
  user: '#7ee0a0',
  assistant: '#8fd0ff',
  memory: '#c79bff',
  summary: '#e8c76a',
  goal: '#e8c76a',
  todo: '#e8c76a',
  reasoning: '#9a9a9a',
  tool_call: '#9aa8c0',
  tool_result: '#8b98ad',
  command: '#7ee0a0',
  command_result: '#8b98ad',
  approval: '#ffb27a',
  inject: '#8b98ad',
  file: '#7ad0d0',
  defend: '#ff9a9a',
}

const styles = {
  entry: {
    display: 'flex', alignItems: 'center', gap: 8, width: '100%',
    padding: '6px 10px', borderRadius: 8, border: '1px solid transparent',
    background: 'transparent', color: 'inherit', cursor: 'pointer',
    fontSize: 13, textAlign: 'left',
  },
  overlay: {
    position: 'fixed', inset: 0, zIndex: 3000,
    background: 'rgba(0,0,0,0.45)', display: 'flex',
    alignItems: 'flex-start', justifyContent: 'center', padding: '8vh 16px 16px',
  },
  panel: {
    width: 'min(920px, 100%)', maxHeight: '84vh', display: 'flex', flexDirection: 'column',
    background: '#1b1c1f', color: '#e8e8e8', border: '1px solid #ffffff20',
    borderRadius: 14, boxShadow: '0 18px 60px rgba(0,0,0,0.5)', overflow: 'hidden',
    fontSize: 13,
  },
  bar: { display: 'flex', gap: 8, alignItems: 'center', padding: '12px 14px', borderBottom: '1px solid #ffffff14', flexWrap: 'wrap' },
  input: {
    flex: '1 1 320px', minWidth: 200, padding: '9px 12px', borderRadius: 8,
    border: '1px solid #ffffff26', background: '#00000040', color: 'inherit', fontSize: 14, outline: 'none',
  },
  select: { padding: '8px 10px', borderRadius: 8, border: '1px solid #ffffff26', background: '#00000040', color: 'inherit', fontSize: 12 },
  button: { padding: '8px 12px', borderRadius: 8, border: '1px solid #ffffff26', background: '#ffffff14', color: 'inherit', cursor: 'pointer', fontSize: 12 },
  buttonDim: { padding: '8px 12px', borderRadius: 8, border: '1px solid #ffffff1a', background: '#ffffff0a', color: '#bbb', cursor: 'pointer', fontSize: 12 },
  status: { padding: '6px 14px', fontSize: 12, color: '#9a9a9a', borderBottom: '1px solid #ffffff10', display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' },
  body: { overflowY: 'auto', padding: '4px 0 12px' },
  hit: { padding: '9px 14px', borderBottom: '1px solid #ffffff0d', cursor: 'pointer' },
  hitHead: { display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap', marginBottom: 3 },
  badge: { fontSize: 11, padding: '1px 6px', borderRadius: 5, border: '1px solid #ffffff20', color: '#ddd' },
  hitTitle: { fontWeight: 600, color: '#e8e8e8' },
  meta: { color: '#8b8b8b', fontSize: 11 },
  snippet: { color: '#c8c8c8', lineHeight: 1.6, wordBreak: 'break-word' },
  mark: { background: '#ffd76a40', color: '#ffe9a8', borderRadius: 2, padding: '0 1px' },
  empty: { padding: '24px 16px', color: '#9a9a9a', textAlign: 'center' },
  err: { padding: '10px 14px', color: '#ff9a9a', fontSize: 12 },
  full: {
    margin: '8px 0 0', padding: '8px 10px', background: '#00000040', border: '1px solid #ffffff12',
    borderRadius: 8, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 320, overflow: 'auto',
    fontFamily: 'ui-monospace, monospace', fontSize: 12, lineHeight: 1.55,
  },
}

/** 时间：本地时区，精确到分钟。 */
function stamp(ms) {
  if (!Number.isFinite(ms)) return ''
  const d = new Date(ms)
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 相对时间。 */
function ago(ms) {
  if (!Number.isFinite(ms)) return ''
  const diff = Date.now() - ms
  if (diff < 60_000) return '刚刚'
  const m = Math.floor(diff / 60_000)
  if (m < 60) return `${m} 分钟前`
  const hrs = Math.floor(m / 60)
  if (hrs < 24) return `${hrs} 小时前`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `${days} 天前`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months} 个月前`
  return `${Math.floor(months / 12)} 年前`
}

/** 渲染带高亮的分段。 */
function Snippet({ snippet }) {
  if (snippet === undefined || snippet === null) return null
  const children = []
  snippet.segments.forEach((segment, index) => {
    children.push(segment.matched
      ? h('mark', { key: index, style: styles.mark }, segment.text)
      : h('span', { key: index }, segment.text))
  })
  return h('div', { style: styles.snippet }, snippet.prefix ?? '', ...children, snippet.suffix ?? '')
}

/** 一条结果：标题行 + 片段；点标题跳会话，点「原文」展开全文。 */
function Hit({ hit, onOpenSession }) {
  const [expanded, setExpanded] = useState(null)
  const [busy, setBusy] = useState(false)

  const toggle = useCallback(async () => {
    if (expanded !== null) {
      setExpanded(null)
      return
    }
    setBusy(true)
    try {
      const res = await fetch(`${PREFIX}/doc?id=${hit.id}`, { cache: 'no-store' })
      const data = await res.json()
      setExpanded(data.ok ? String(data.doc.text ?? '') : `读取失败：${data.error ?? '未知错误'}`)
    } catch (cause) {
      setExpanded(`读取失败：${cause instanceof Error ? cause.message : String(cause)}`)
    } finally {
      setBusy(false)
    }
  }, [expanded, hit.id])

  const head = [h('span', { key: 'k', style: { ...styles.badge, color: KIND_COLOR[hit.kind] ?? '#ddd' } }, KIND_LABEL[hit.kind] ?? hit.kind)]
  if (hit.sessionTitle !== null && hit.sessionTitle !== undefined) head.push(h('span', { key: 't', style: styles.hitTitle }, hit.sessionTitle))
  else if (hit.sessionId !== null) head.push(h('span', { key: 't', style: styles.hitTitle }, hit.sessionId))
  if (hit.tool !== null && hit.tool !== undefined) head.push(h('span', { key: 'tool', style: styles.meta }, hit.tool))
  if (hit.turn !== null && hit.turn !== undefined) head.push(h('span', { key: 'turn', style: styles.meta }, `第 ${hit.turn} 轮`))
  if (Number.isFinite(hit.time)) head.push(h('span', { key: 'time', style: styles.meta }, `${stamp(hit.time)} · ${ago(hit.time)}`))
  if (hit.path !== null && hit.path !== undefined) head.push(h('span', { key: 'path', style: styles.meta }, hit.path))
  if (Array.isArray(hit.alsoAt) && hit.alsoAt.length > 0) head.push(h('span', { key: 'also', style: styles.meta }, `另见 ${hit.alsoAt.length} 处`))

  const actions = []
  if (hit.sessionId !== null) {
    actions.push(h('button', {
      key: 'open', type: 'button', style: styles.buttonDim,
      onClick: event => { event.stopPropagation(); onOpenSession(hit.sessionId) },
    }, '打开会话'))
  }
  actions.push(h('button', {
    key: 'full', type: 'button', style: styles.buttonDim,
    onClick: event => { event.stopPropagation(); void toggle() },
  }, busy ? '读取中…' : (expanded === null ? '原文' : '收起')))

  return h('div', { style: styles.hit, 'data-dsh-plugin': 'dsh-search', 'data-dsh-part': 'hit' },
    h('div', { style: styles.hitHead }, ...head),
    h(Snippet, { snippet: hit.snippet }),
    h('div', { style: { marginTop: 6, display: 'flex', gap: 6 } }, ...actions),
    expanded === null ? null : h('pre', { style: styles.full }, expanded),
  )
}

/** 搜索面板本体。 */
function SearchPanel({ onClose, onOpenSession }) {
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState('all')
  const [match, setMatch] = useState('all')
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState(null)
  const inputRef = useRef(null)

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch(`${PREFIX}/status`, { cache: 'no-store' })
      const data = await res.json()
      if (data.ok) setStatus(data)
    } catch {
      // 状态拉取失败不影响检索本身；下一轮再试。
    }
  }, [])

  useEffect(() => { void loadStatus() }, [loadStatus])

  // 只在构建进行中轮询：构建结束立即停，不空转。
  useEffect(() => {
    if (status?.building !== true) return undefined
    const timer = setInterval(() => { void loadStatus() }, 1200)
    return () => clearInterval(timer)
  }, [status?.building, loadStatus])

  useEffect(() => {
    inputRef.current?.focus()
    const onKey = event => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const run = useCallback(async () => {
    const text = query.trim()
    if (text === '') return
    setBusy(true)
    setError('')
    try {
      const params = new URLSearchParams({ query: text, scope, match, limit: '60' })
      const res = await fetch(`${PREFIX}/search?${params.toString()}`, { cache: 'no-store' })
      const data = await res.json()
      if (!data.ok) {
        setError(data.error ?? '检索失败')
        setResult(null)
      } else {
        setResult(data)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setResult(null)
    } finally {
      setBusy(false)
    }
  }, [query, scope, match])

  const build = useCallback(async (full) => {
    setError('')
    try {
      const res = await fetch(`${PREFIX}/build`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ full }),
      })
      const data = await res.json()
      if (!data.ok && data.reason !== 'already-running') setError(data.error ?? '启动索引失败')
      await loadStatus()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [loadStatus])

  const stats = status?.index ?? null
  const statusLine = useMemo(() => {
    if (status === null) return '索引状态读取中…'
    if (status.building === true) {
      const p = status.progress ?? {}
      return `正在索引：已写入 ${p.docs ?? 0} 条 · 会话 ${p.sessions ?? 0} 个 · 记忆 ${p.memories ?? 0} 条（阶段 ${p.phase ?? '-'}）`
    }
    if (stats === null || stats.docs === 0) return '索引尚未建立，点右侧「建立索引」开始（首次约 40 秒）'
    const bits = [`已索引 ${stats.docs} 条`, `会话 ${stats.sessions} 个`, `记忆 ${stats.memories} 条`]
    const refreshed = stats.refreshedAt ?? stats.builtAt
    if (Number.isFinite(refreshed) && refreshed !== null) bits.push(`更新于 ${stamp(refreshed)}`)
    if (status.lastResult?.ok === true) bits.push(`上次耗时 ${(status.lastResult.ms / 1000).toFixed(1)} 秒`)
    return bits.join(' · ')
  }, [status, stats])

  const hits = result?.hits ?? []

  return h('div', { style: styles.overlay, onMouseDown: event => { if (event.target === event.currentTarget) onClose() } },
    h('div', { style: styles.panel, 'data-dsh-plugin': 'dsh-search', 'data-dsh-part': 'panel' },
      h('div', { style: styles.bar },
        h('input', {
          ref: inputRef,
          style: styles.input,
          value: query,
          placeholder: '在整个 DSH 里搜索：会话标题、聊天记录、长期记忆…',
          onChange: event => setQuery(event.target.value),
          onKeyDown: event => { if (event.key === 'Enter') void run() },
        }),
        h('select', { style: styles.select, value: scope, onChange: event => setScope(event.target.value) },
          h('option', { value: 'all' }, '全部'),
          h('option', { value: 'sessions' }, '仅会话'),
          h('option', { value: 'memory' }, '仅记忆'),
        ),
        h('select', { style: styles.select, value: match, onChange: event => setMatch(event.target.value) },
          h('option', { value: 'all' }, '全部词命中'),
          h('option', { value: 'any' }, '任一命中'),
          h('option', { value: 'phrase' }, '整串短语'),
        ),
        h('button', { type: 'button', style: busy ? styles.buttonDim : styles.button, onClick: () => void run() }, busy ? '搜索中…' : '搜索'),
        h('button', { type: 'button', style: styles.buttonDim, onClick: onClose }, '关闭'),
      ),
      h('div', { style: styles.status },
        h('span', null, statusLine),
        status?.building === true
          ? h('button', { type: 'button', style: styles.buttonDim, onClick: () => void fetch(`${PREFIX}/cancel`, { method: 'POST' }) }, '停止')
          : null,
        status?.building === true
          ? null
          : h('button', { type: 'button', style: styles.buttonDim, onClick: () => void build(false) }, '更新索引'),
        status?.building === true
          ? null
          : h('button', { type: 'button', style: styles.buttonDim, onClick: () => void build(true) }, '重建索引'),
      ),
      error !== '' ? h('div', { style: styles.err }, error) : null,
      h('div', { style: styles.body },
        result === null
          ? h('div', { style: styles.empty }, '输入关键词后回车。多个词用空格分隔（都要命中）；引号内为整串短语；词前减号表示排除。')
          : (hits.length === 0
            ? h('div', { style: styles.empty }, `没有找到匹配「${result.terms?.join(' ') ?? query}」的记录。可以换关键词，或把匹配方式改成「任一命中」。`)
            : h('div', null,
              h('div', { style: { ...styles.status, borderBottom: 'none' } },
                h('span', null, `命中 ${result.total} 条${result.relaxed ? '（严格匹配无结果，已放宽为任一命中）' : ''}，列出前 ${hits.length} 条 · ${result.ms} 毫秒`)),
              ...hits.map(hit => h(Hit, { key: hit.id, hit, onOpenSession })),
            )),
      ),
    ),
  )
}

/** 侧边栏入口：一个按钮，点开面板。 */
function SearchEntry(props) {
  const [open, setOpen] = useState(false)
  const wide = props?.wide !== false

  const openSession = useCallback(sessionId => {
    try {
      props?.sessions?.open?.(sessionId)
      setOpen(false)
    } catch {
      // 会话已归档或不存在：面板保持打开，用户还能继续看结果。
    }
  }, [props])

  return h('div', { 'data-dsh-plugin': 'dsh-search', 'data-dsh-part': 'entry' },
    h('button', {
      type: 'button',
      style: styles.entry,
      title: '全局搜索（会话标题 / 聊天记录 / 长期记忆）',
      onClick: () => setOpen(true),
    },
      h('span', { style: { fontSize: 14, lineHeight: 1 } }, '⌕'),
      wide ? h('span', null, '全局搜索') : null,
    ),
    open ? h(SearchPanel, { onClose: () => setOpen(false), onOpenSession: openSession }) : null,
  )
}

export const name = 'dsh-search-client'

/** 侧边栏入口 + 打开会话。 */
export const inject = ['slots', 'sessions']

export function apply(ctx) {
  ctx.effect(() => {
    const dispose = ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
      name: 'sidebar.footer.action',
      id: 'dsh-search',
      // 排在设置等既有入口前面：搜索是高频动作。
      order: -10,
      label: () => '全局搜索',
      inject: () => ({ sessions: ctx.get('sessions') }),
    }, SearchEntry))
    return () => { dispose() }
  }, 'dsh-search: sidebar entry')
}