/**
 * dsh-search · 查询解析
 *
 * 精度策略（用户要求"必须保证准确和全面"）：
 *   中文逐字成词后，单个汉字是 token。若把"任务看板"拆成 4 个 token 做 AND，
 *   会命中"务任板看"这种没有任何意义的顺序 —— 召回高但精度崩。
 *   因此这里保留**原始连续段**：把查询按"汉字连续段 / 拉丁连续段"切成若干组，
 *   每组内部是短语（汉字组=子串语义），组之间是 AND。
 *
 *   例：`任务看板 cron` → 短语"任务看板" AND 前缀 cron
 *      `"exact phrase" -排除` → 短语 exact phrase AND NOT 排除
 *
 * 同时输出高亮用的原始词串（用户视角的词，而不是拆碎的单字）。
 */

import { tokenize } from './tokenize.js'

const CJK_CHAR = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/
const WORD_CHAR = /[A-Za-z0-9_]/

/** 一个查询组：{ text, cjk, negated, prefix } */
function makeGroup(text, negated = false, prefix = false) {
  const cjk = [...text].some(ch => CJK_CHAR.test(ch))
  return { text, cjk, negated, prefix }
}

/**
 * 把原始查询切成组。
 * @param raw 用户输入
 * @returns { groups, terms, error } —— terms 是用于高亮的原始词串（不含否定组）
 */
export function parseQuery(raw) {
  const text = typeof raw === 'string' ? raw : ''
  const groups = []
  let i = 0
  let negated = false
  let current = ''
  let currentCjk = false
  let inQuotes = false

  const flush = () => {
    if (current === '') return
    groups.push(makeGroup(current, negated))
    current = ''
    negated = false
  }

  while (i < text.length) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        inQuotes = false
        if (current !== '') groups.push(makeGroup(current, negated, false))
        current = ''
        negated = false
        i += 1
        continue
      }
      current += ch
      i += 1
      continue
    }
    if (ch === '"') {
      flush()
      inQuotes = true
      i += 1
      continue
    }
    if (ch === '-' && current === '' && i + 1 < text.length && !/\s/.test(text[i + 1])) {
      negated = true
      i += 1
      continue
    }
    const isCjk = CJK_CHAR.test(ch)
    const isWord = WORD_CHAR.test(ch)
    if (!isCjk && !isWord) {
      flush()
      i += 1
      continue
    }
    if (current === '') {
      currentCjk = isCjk
      current = ch
    } else if (isCjk === currentCjk) {
      current += ch
    } else {
      flush()
      currentCjk = isCjk
      current = ch
    }
    i += 1
  }
  if (inQuotes && current !== '') groups.push(makeGroup(current, negated, false))
  else flush()

  const terms = []
  const seen = new Set()
  for (const group of groups) {
    if (group.negated) continue
    if (seen.has(group.text)) continue
    seen.add(group.text)
    terms.push(group.text)
  }
  if (groups.length === 0) return { groups, terms, error: 'empty-query' }
  if (groups.every(group => group.negated)) return { groups, terms, error: 'only-negative' }
  return { groups, terms, error: undefined }
}

/** FTS5 字符串字面量转义。 */
function literal(term) {
  return `"${term.replace(/"/g, '""')}"`
}

/**
 * 组 → 短语字面量。
 *
 * 关键点：索引里存的是**分词后**的 token 流，所以查询字面量也必须先分词。
 * 直接 `"任务看板"` 会去匹配一个叫「任务看板」的整词（unicode61 把整段汉字当一个词），
 * 而索引里根本没有这个词——必须写成 `"任 务 看 板"`，FTS5 才按相邻短语去匹配
 * 逐字 token，等价于子串语义。拉丁词两种写法都对（查询侧同样会分词），
 * 这里统一走 tokenize，保证"写索引用什么、查索引就用什么"。
 */
function phraseLiteral(text) {
  const tokens = tokenize(text)
  return tokens === '' ? literal(text) : literal(tokens)
}

/**
 * 一个组 → FTS5 表达式。
 *
 * 汉字组必须构造成**一个短语**（`"任 务 看 板"`），而不是把每个字各加引号再用空格连接：
 * FTS5 里 `"任" "务" "看" "板"` 是"四个词都要出现"（顺序无关），会命中"任务板看"
 * 和"看板任务"——召回看着高，精度直接崩。写成单个带引号字符串时 FTS5 才把它当
 * **相邻短语**（token 必须按原序紧挨），逐字 token 化之后正好等价于子串匹配。
 */
function groupExpr(group, mode) {
  const chars = [...group.text]
  if (chars.length === 0) return ''
  // 汉字组恒为短语（子串语义）；单字时退化为普通词。
  if (group.cjk) {
    const body = phraseLiteral(group.text)
    if (chars.length === 1 && mode === 'prefix') return `${body}*`
    return body
  }
  const body = literal(group.text)
  if (mode === 'prefix' || group.prefix) return `${body}*`
  return body
}

/**
 * 构造 FTS5 MATCH 表达式。
 * @param groups parseQuery 的组
 * @param mode 'all'（默认，组间 AND）| 'any'（组间 OR）| 'phrase'（整体一个短语）| 'prefix'（末组前缀）
 */
export function buildMatch(groups, mode = 'all') {
  if (!Array.isArray(groups) || groups.length === 0) return ''
  if (mode === 'phrase') {
    // 整串一个短语：所有词必须原样相邻。中文逐字 token 化后 = 完整子串匹配。
    const whole = groups.filter(g => !g.negated).map(g => g.text).join(' ').trim()
    if (whole === '') return ''
    return phraseLiteral(whole)
  }
  const positive = []
  const negative = []
  groups.forEach((group, index) => {
    const last = index === groups.length - 1
    const expr = groupExpr(group, mode === 'prefix' && last ? 'prefix' : 'all')
    if (expr === '') return
    if (group.negated) negative.push(expr)
    else positive.push(expr)
  })
  if (positive.length === 0 && negative.length === 0) return ''
  const joiner = mode === 'any' ? ' OR ' : ' AND '
  const head = positive.length > 0 ? positive.join(joiner) : ''
  const tail = negative.map(expr => `NOT ${expr}`).join(' ')
  // FTS5 要求 NOT 左侧必须有表达式，纯排除查询（只有 -词）无法表达：
  // 这种情况交给上层报错提示，而不是构造非法 MATCH 让查询整体失败。
  if (head === '') return tail === '' ? '' : ''
  return tail === '' ? head : `(${head}) ${tail}`
}

/** 该查询是否可能在 CJK 子串上有命中（用于决定是否走宽松回退）。 */
export function hasCjkGroup(groups) {
  return groups.some(group => !group.negated && group.cjk && [...group.text].length > 1)
}
