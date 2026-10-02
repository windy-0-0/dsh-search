/**
 * dsh-search · 片段截取与高亮
 *
 * 不依赖 FTS5 的 snippet()/highlight()：那两个函数工作在 FTS 自己的 token 流上，
 * 对\"中文逐字成词\"这种切法给出的片段会碎成单字。这里直接在原文上做匹配，
 * 因此：
 *   - 中文按**子串**语义高亮（相邻单字命中会被合并成连续高亮块）；
 *   - 拉丁词按大小写不敏感的子串高亮；
 *   - 片段围绕**命中密度最高**的区域截取，前后加省略号；
 *   - 所有偏移都是 UTF-16 码元下标，可直接用于 JS 字符串切片与 React 渲染。
 */

import { queryTerms } from './tokenize.js'
import { parseQuery } from './query.js'

const CJK_CHAR = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/
const LATIN_WORD = /[A-Za-z0-9_]/

/** 该 token 是否纯 CJK。 */
function pureCjk(term) {
  if (term === '') return false
  for (const ch of term) {
    if (!CJK_CHAR.test(ch)) return false
  }
  return true
}

/**
 * 找出文本中所有命中区间。
 * @param text 原文
 * @param terms 查询词（tokenize 后的 token）
 * @returns 已合并、按起点排序的 [start, end) 区间
 */
export function findRanges(text, terms) {
  if (typeof text !== 'string' || text === '' || !Array.isArray(terms) || terms.length === 0) return []
  const lowered = text.toLowerCase()
  const ranges = []
  for (const term of terms) {
    if (typeof term !== 'string' || term === '') continue
    const needle = pureCjk(term) ? term : term.toLowerCase()
    const haystack = pureCjk(term) ? text : lowered
    let from = 0
    for (;;) {
      const at = haystack.indexOf(needle, from)
      if (at < 0) break
      ranges.push([at, at + needle.length])
      from = at + Math.max(1, needle.length)
      if (ranges.length > 4000) break
    }
    if (ranges.length > 4000) break
  }
  if (ranges.length === 0) return []
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const merged = [ranges[0]]
  for (let i = 1; i < ranges.length; i += 1) {
    const last = merged[merged.length - 1]
    const cur = ranges[i]
    if (cur[0] <= last[1]) {
      if (cur[1] > last[1]) last[1] = cur[1]
    } else merged.push(cur)
  }
  return merged
}

/** 把区间列表变成可直接渲染的分段数组（matched 标记是否命中）。 */
export function segments(text, ranges) {
  const out = []
  let cursor = 0
  for (const [start, end] of ranges) {
    if (start > cursor) out.push({ text: text.slice(cursor, start), matched: false })
    out.push({ text: text.slice(start, end), matched: true })
    cursor = end
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), matched: false })
  return out
}

/** 避免在代理对（emoji 等）中间切断。 */
function safeStart(text, index) {
  let i = index
  if (i <= 0) return 0
  const code = text.charCodeAt(i)
  if (code >= 0xdc00 && code <= 0xdfff) i -= 1
  return i
}

function safeEnd(text, index) {
  let i = index
  if (i >= text.length) return text.length
  const code = text.charCodeAt(i)
  if (code >= 0xdc00 && code <= 0xdfff) i += 1
  return i
}

/** 把命中密集的区域挑出来：返回第一个高密度窗口的起点。 */
function windowStart(ranges, limit) {
  if (ranges.length === 0) return 0
  let bestStart = ranges[0][0]
  let bestCount = 0
  for (let i = 0; i < ranges.length; i += 1) {
    const start = ranges[i][0]
    let count = 0
    for (let j = i; j < ranges.length && ranges[j][0] - start <= limit; j += 1) count += 1
    if (count > bestCount) {
      bestCount = count
      bestStart = start
    }
  }
  return bestStart
}

/**
 * 生成片段（带省略号标记与内部偏移）。
 * @param text 原文
 * @param terms 查询词
 * @param width 片段目标宽度（UTF-16 码元）
 * @returns { text, prefix, suffix, segments } —— segments 的偏移相对返回的 text
 */
export function snippet(text, terms, width = 220) {
  const source = typeof text === 'string' ? text : ''
  if (source === '') return { text: '', prefix: '', suffix: '', segments: [] }
  const ranges = findRanges(source, terms)
  if (ranges.length === 0) {
    const flat = source.replace(/\s+/g, ' ').trim()
    const head = flat.slice(0, width)
    return { text: head, prefix: '', suffix: flat.length > head.length ? '…' : '', segments: [{ text: head, matched: false }] }
  }
  const anchor = windowStart(ranges, width)
  const half = Math.floor(width / 2)
  let start = safeStart(source, Math.max(0, anchor - half))
  let end = safeEnd(source, Math.min(source.length, start + width))
  if (end - start < width) start = safeStart(source, Math.max(0, end - width))
  const slice = source.slice(start, end)
  const local = []
  for (const [rs, re] of ranges) {
    if (re <= start || rs >= end) continue
    local.push([Math.max(0, rs - start), Math.min(slice.length, re - start)])
  }
  return {
    text: slice,
    prefix: start > 0 ? '…' : '',
    suffix: end < source.length ? '…' : '',
    segments: segments(slice, local),
  }
}

/** 便捷入口：直接从查询串生成片段。 */
export function snippetFor(text, query, width = 220) {
  // 高亮用「用户视角的词」（整段"任务看板"）而不是逐字 token：findRanges 对纯汉字词
  // 按子串匹配，相邻命中会自然合成一个高亮块；逐字 token 会把任意位置的单字也点亮。
  const parsed = parseQuery(query)
  const terms = parsed.terms.length > 0 ? parsed.terms : queryTerms(query)
  return snippet(text, terms, width)
}