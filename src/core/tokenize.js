/**
 * dsh-search · 分词与查询构造
 *
 * 唯一事实源：写索引与查索引用同一个 tokenize，否则两者永远对不上。
 *
 * 规则：
 *   - CJK（中日韩汉字/假名/谚文）**逐字成词**——FTS5 的 unicode61 会把整段中文
 *     当成一个词，导致"关键词"搜不到"键词测"；逐字切分后配短语查询就等价于子串匹配。
 *   - 拉丁字母/数字/下划线连成一个词（保留词形，便于前缀查询）。
 *   - 其余字符（标点、空白、emoji）一律成为词边界。
 *
 * 实现用两次正则替换而不是逐字符循环：全量语料是 GB 级文本，逐字符 JS 循环
 * 会成为索引瓶颈（实测同一份语料逐字符约 40s，正则替换约 6s）。
 */

/** 逐字成词的表意文字区段。 */
const CJK_GLOBAL = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/g
/** 逐字成词后的合法 token 字符集（拉丁词 + 表意文字），其余一律变分隔符。 */
const NON_TOKEN = /[^A-Za-z0-9_\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]+/g
const CJK_SINGLE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/
const MULTI_SPACE = / +/g

/** 文本 → 以空格分隔的 token 串（写进 FTS 的形式）。 */
export function tokenize(text) {
  if (typeof text !== 'string' || text === '') return ''
  const spaced = text.replace(CJK_GLOBAL, ' $& ')
  const split = spaced.replace(NON_TOKEN, ' ').replace(MULTI_SPACE, ' ').trim()
  return split
}

/** 原始查询串 → token 数组（去重保序）。 */
export function queryTerms(query) {
  const raw = tokenize(query)
  if (raw === '') return []
  const seen = new Set()
  const terms = []
  for (const term of raw.split(' ')) {
    if (term === '' || seen.has(term)) continue
    seen.add(term)
    terms.push(term)
  }
  return terms
}

/** FTS5 字符串字面量转义：双引号包裹，内部双引号翻倍。 */
function literal(term) {
  return `"${term.replace(/"/g, '""')}"`
}

/**
 * 构造 FTS5 MATCH 表达式。
 * @param terms 已分词的查询项
 * @param mode 'phrase' 全部词按原序相邻（CJK 等价子串匹配）；
 *             'and' 全部出现即可；'any' 任一出现（召回优先）；
 *             'prefix' 末词前缀匹配（边打边搜）。
 */
export function buildMatch(terms, mode = 'and') {
  if (terms.length === 0) return ''
  const quoted = terms.map(literal)
  if (mode === 'phrase') return quoted.join(' ')
  if (mode === 'any') return quoted.join(' OR ')
  if (mode === 'prefix') {
    const head = quoted.slice(0, -1)
    const last = `"${terms[terms.length - 1].replace(/"/g, '""')}"*`
    return [...head, last].join(' AND ')
  }
  return quoted.join(' AND ')
}

/** 判断某个字符是否是 CJK（供高亮与片段逻辑复用）。 */
export function isCjk(ch) {
  return typeof ch === 'string' && ch !== '' && CJK_SINGLE.test(ch)
}

/** 该 token 是否只由 CJK 组成（决定片段匹配是否按子串语义处理）。 */
export function isCjkTerm(term) {
  if (typeof term !== 'string' || term === '') return false
  for (const ch of term) {
    if (!CJK_SINGLE.test(ch)) return false
  }
  return true
}