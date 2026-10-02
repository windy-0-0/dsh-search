/** 本地验证脚本：对真实语料做一次全量索引，并跑若干检索样例。 */
import { statSync } from 'node:fs'
import { SearchIndex } from '../src/host/index-db.js'
import { Indexer } from '../src/host/indexer.js'

const dbPath = process.argv[2] ?? '/tmp/dsh-search-probe/index.sqlite'
const t0 = Date.now()
const index = new SearchIndex(dbPath)
index.open()
const indexer = new Indexer(index, {
  sessionsRoot: '/Users/mac/.dsh/sessions',
  memgasRoot: '/Users/mac/.dsh/memgas',
})
const result = await indexer.build({ full: true })
console.log('BUILD ' + JSON.stringify(result.progress.lastResult))
console.log('MS ' + (Date.now() - t0))
console.log('STATS ' + JSON.stringify(index.stats()))
console.log('DB_MB ' + (statSync(dbPath).size / 1e6).toFixed(1))
