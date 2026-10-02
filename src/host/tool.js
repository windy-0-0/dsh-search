/**
 * dsh-search · 模型工具（Host 半区）
 *
 * 两个工具，边界清楚：
 *   - `search_dsh`：跨 DSH 的**统一检索入口**。会话标题与全部聊天记录、长期记忆、
 *     （可选）工作区文件一次搜完，返回带出处与片段的紧凑结果。
 *   - `search_dsh_read`：把某条命中整段读回（工具结果里只给片段，避免一次塞满上下文）。
 *
 * 为什么不让模型自己 grep：会话日志是**多帧 zstd**（grep 读不了），而且用户要的是
 * \"标题 + 聊天记录\"这种语义划分；工具只暴露与任务相关的概念（关键词、范围、时间），
 * 不暴露索引、分片、tokenizer 这些实现词汇。
 */

const KIND_LABEL = {
  title: '会话标题',
  user: '用户消息',
  assistant: '助手回复',
  reasoning: '思考过程',
  tool_call: '工具调用',
  tool_result: '工具结果',
  summary: '压缩摘要',
  goal: '会话目标',
  todo: '任务清单',
  command: '用户命令',
  command_result: '命令结果',
  approval: '审批请求',
  inject: '注入消息',
  memory: '长期记忆',
  file: '工作区文件',
  defend: '安全检测',
}

/** 人类可读的时间：本地时区，精确到分钟。 */
function stamp(ms) {
  if (!Number.isFinite(ms)) return null
  const d = new Date(ms)
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 相对时间：结果里比绝对时间更有用。 */
function ago(ms, now) {
  if (!Number.isFinite(ms)) return null
  const diff = now - ms
  if (diff < 60_000) return '刚刚'
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} 天前`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months} 个月前`
  return `${Math.floor(months / 12)} 年前`
}

/** 工具参数 schema（模型可见文案：只说任务相关概念）。 */
export const SEARCH_TOOL = {
  name: 'search_dsh',
  description: [
    '在整个 DSH 里检索关键词：全部历史会话的标题与聊天记录（用户消息、助手回复、思考过程、',
    '工具调用与结果、压缩摘要、会话目标、任务清单）、长期记忆，以及（若已开启）工作区文件。',
    '关键词按“原文子串”匹配：中文连续段必须原样相邻出现，英文词按整词匹配（不分大小写）。',
    '多个词之间是“与”关系；用引号包住可强制整体短语，词前加减号表示排除。',
    '返回按相关度排序的片段与出处；需要看全文时用 search_dsh_read 读回某一条。',
  ].join(''),
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '关键词。多个词用空格分隔（全部命中）；引号内为整体短语；词前减号表示排除。',
      },
      scope: {
        type: 'string',
        enum: ['all', 'sessions', 'memory', 'files'],
        description: '检索范围。all=全部（默认）；sessions=会话标题与聊天记录；memory=长期记忆；files=工作区文件。',
      },
      kinds: {
        type: 'array',
        items: { type: 'string' },
        description: '只在这些记录种类里找：title/user/assistant/reasoning/tool_call/tool_result/summary/goal/todo/command/memory/file。省略则不限。',
      },
      session_id: {
        type: 'string',
        description: '只在这一个会话里找（用于已知会话内的定位）。省略则搜全部会话。',
      },
      cwd: {
        type: 'string',
        description: '只在工作目录等于该路径的会话里找（按项目过滤）。省略则不限。',
      },
      since: {
        type: 'string',
        description: '只找该时间之后的记录，ISO 8601（如 2026-09-01 或 2026-09-01T10:00:00+08:00）。',
      },
      until: {
        type: 'string',
        description: '只找该时间之前的记录，ISO 8601。',
      },
      match: {
        type: 'string',
        enum: ['all', 'any', 'phrase'],
        description: 'all=全部关键词都命中（默认）；any=命中任一即可（召回优先）；phrase=整串当作一个连续短语。',
      },
      limit: {
        type: 'number',
        description: '最多返回几条，默认 30（config.defaultLimit），上限 100。',
      },
    },
    required: ['query'],
  },
}

export const READ_TOOL = {
  name: 'search_dsh_read',
  description: [
    '把 search_dsh 命中结果中的某一条按需读回：doc_id 为结果里的编号，',
    '可选 offset/limit 分段读取（字符为单位），用于长工具结果或长思考过程。',
  ].join(''),
  parameters: {
    type: 'object',
    properties: {
      doc_id: { type: 'number', description: 'search_dsh 结果里的条目编号。' },
      offset: { type: 'number', description: '从第几个字符开始读，默认 0。' },
      limit: { type: 'number', description: '最多读多少个字符，默认 4000，上限 20000。' },
    },
    required: ['doc_id'],
  },
}

/** ISO 8601（含裸日期）→ epoch 毫秒；无法解析返回 undefined。 */
export function parseTime(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const text = value.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const ms = Date.parse(`${text}T00:00:00`)
    return Number.isFinite(ms) ? ms : undefined
  }
  const ms = Date.parse(text)
  return Number.isFinite(ms) ? ms : undefined
}

/** scope → 查询过滤条件。 */
function scopeFilter(scope) {
  if (scope === 'memory') return { memoryOnly: true }
  if (scope === 'sessions') return { memoryOnly: false, kinds: undefined, excludeFiles: true }
  if (scope === 'files') return { kinds: ['file'] }
  return {}
}

/**
 * 渲染检索结果为模型可读文本（紧凑、带出处）。
 * @param result SearchIndex.search 的返回
 * @param query 原始查询（用于片段高亮定位）
 * @returns 纯文本
 */
export function renderResults(result, query, snippetFor) {
  const now = Date.now()
  const lines = []
  const scopeNote = result.relaxed ? '（严格匹配无结果，已放宽为“命中任一关键词”）' : ''
  if (result.hits.length === 0) {
    return `没有找到匹配「${query}」的记录${scopeNote}。可以换关键词、把 match 设为 any，或先运行一次索引。`
  }
  lines.push(`找到 ${result.total} 条匹配「${query}」${scopeNote}，按相关度列出前 ${result.hits.length} 条：`)
  lines.push('')
  result.hits.forEach((hit, index) => {
    const label = KIND_LABEL[hit.kind] ?? hit.kind
    const bits = [`#${hit.id}`]
    if (hit.sessionTitle !== null) bits.push(`会话「${hit.sessionTitle}」`)
    else if (hit.sessionId !== null) bits.push(hit.sessionId)
    bits.push(label)
    if (hit.tool !== null) bits.push(hit.tool)
    if (hit.turn !== null) bits.push(`第 ${hit.turn} 轮`)
    if (hit.time !== null) bits.push(`${stamp(hit.time)}（${ago(hit.time, now)}）`)
    if (hit.path !== null) bits.push(hit.path)
    lines.push(`${index + 1}. ${bits.join(' · ')}`)
    const piece = snippetFor(hit.text, query, 300)
    lines.push(`   ${piece.prefix}${piece.text.replace(/\s+/g, ' ').trim()}${piece.suffix}`)
    lines.push('')
  })
  lines.push('要看某一条的完整原文，用 search_dsh_read 并传入上面的编号（#后面的数字）。')
  return lines.join('\n')
}

/** 渲染整段读回的结果。 */
export function renderDoc(doc, offset, limit) {
  const text = doc.text ?? ''
  const from = Math.max(0, Number(offset ?? 0) || 0)
  const size = Math.min(Math.max(Number(limit ?? 4000) || 4000, 1), 20_000)
  const slice = text.slice(from, from + size)
  const head = [
    `#${doc.id} ${KIND_LABEL[doc.kind] ?? doc.kind}`,
    doc.label === null ? null : doc.label,
    doc.sessionId === null ? null : `会话 ${doc.sessionId}`,
    doc.time === null ? null : stamp(doc.time),
    `${text.length} 字`,
    `${from}-${Math.min(from + size, text.length)}`,
  ].filter(Boolean).join(' · ')
  const more = from + size < text.length ? `\n\n（还有 ${text.length - from - size} 字，继续读请把 offset 设为 ${from + size}）` : ''
  return `${head}\n\n${slice}${more}`
}