/**
 * 本地验证脚本：对已建好的索引跑一组检索样例，人工核对准确性与覆盖面。
 * 用法：node scripts/e2e-search.mjs [dbPath] [query...]
 */
import { SearchIndex } from '../src/host/index-db.js'
import { snippetFor } from '../src/core/highlight.js'
import { indexDbPath } from '../src/core/paths.js'

// 默认打真实索引库。以前默认 /tmp/dsh-search-probe/index.sqlite —— 那是个不存在的
// 路径，open() 会就地建一个空库，于是所有查询都 total=0 却毫无报错（假绿）。
const dbPath = process.argv[2] ?? indexDbPath()
const index = new SearchIndex(dbPath)
index.open()

const cases = process.argv.slice(3).length > 0
  ? process.argv.slice(3).map(q => ({ query: q, options: {} }))
  : [
      { query: '任务看板', options: {} },
      { query: '任务看板 cron', options: {} },
      { query: '长期记忆', options: {} },
      { query: 'dsh-search', options: {} },
      { query: '回收站', options: {} },
      { query: '安全加固', options: {} },
      { query: '虚拟机 锁屏 登录', options: {} },
      { query: '任务看板', options: { kinds: ['title'] } },
      { query: '任务看板', options: { kinds: ['user'] } },
      { query: '看板任务', options: {} },
      { query: '任务看板 cron', options: { match: 'any' } },
      { query: '没有出现过的词xyzzy', options: {} },
    ]

for (const item of cases) {
  const t0 = Date.now()
  const result = index.search({ query: item.query, limit: 5, ...item.options })
  const ms = Date.now() - t0
  console.log('='.repeat(78))
  console.log(`QUERY 「${item.query}」 ${JSON.stringify(item.options)} → total=${result.total} mode=${result.mode} relaxed=${result.relaxed} (${ms}ms)`)
  result.hits.slice(0, 5).forEach((hit, i) => {
    const piece = snippetFor(hit.text, item.query, 140)
    const where = hit.sessionTitle ?? hit.sessionId ?? hit.path ?? '—'
    console.log(`  ${i + 1}. [${hit.kind}] ${where} · ${hit.turn === null ? '' : '第' + hit.turn + '轮 '}score=${hit.score.toFixed(3)}`)
    console.log(`     ${(piece.prefix + piece.text.replace(/\s+/g, ' ') + piece.suffix).slice(0, 200)}`)
  })
  if (result.error !== undefined) console.log('  ERROR ' + result.error)
}
console.log('='.repeat(78))
console.log('sessions in index: ' + index.listSessions(5).length)