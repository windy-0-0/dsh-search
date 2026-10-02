/**
 * 端到端：用桩 ctx 挂载插件 → 触发 /build → 等 worker 完成 → 跑检索 → 校验标题与记忆。
 * DSH_HOME 可覆盖（默认用真实家目录，建的是真索引）。
 */
import { EventEmitter } from 'node:events'
import { statSync } from 'node:fs'

const plugin = await import('../lib/index.js')

const effects = []
const tools = new Map()
const routes = new Map()

const ctx = {
  effect(fn) { const d = fn(); effects.push(d); return d },
  on() { return () => {} },
  inject(_names, fn) { fn(ctx); return () => {} },
  get() { return undefined },
  provide() { return () => {} },
  tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
  timer: { timeout() { return () => {} }, interval() { return () => {} } },
  webServer: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } },
}

plugin.apply(ctx, { autoIndexDelayMs: 0 })

async function call(path, { method = 'GET', body } = {}) {
  const route = routes.get(path.split('?')[0])
  const req = new EventEmitter()
  req.url = path
  req.method = method
  const chunks = []
  const res = {
    writeHead() {},
    end(payload) { chunks.push(payload) },
  }
  const promise = route.handler(req, res)
  if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)))
  req.emit('end')
  await promise
  return JSON.parse(chunks.join('') || 'null')
}

const t0 = Date.now()
const started = await call('/plugins/dsh-search/build', { method: 'POST', body: { full: process.argv.includes('--full') } })
console.log('BUILD_START', JSON.stringify(started.ok), started.reason ?? '')

// 等 worker 结束：轮询 status，直到 building 变 false 且 lastResult 出现。
let status
for (;;) {
  await new Promise(resolve => setTimeout(resolve, 1500))
  status = await call('/plugins/dsh-search/status')
  if (status.building === false && status.lastResult !== null) break
  if (Date.now() - t0 > 20 * 60_000) { console.log('TIMEOUT'); break }
}
console.log('BUILD_MS', Date.now() - t0)
console.log('LAST_RESULT', JSON.stringify(status.lastResult))
console.log('INDEX', JSON.stringify(status.index))
console.log('DB_MB', status.dbExists ? (statSync(status.dbPath).size / 1e6).toFixed(1) : 'n/a')

const samples = ['任务看板', '长期记忆', '回收站', '安全加固', 'dsh-safety', '会话标题']
for (const query of samples) {
  const out = await call(`/plugins/dsh-search/search?query=${encodeURIComponent(query)}&limit=5`)
  const kinds = (out.hits ?? []).map(hit => `${hit.kind}${hit.sessionTitle === null ? '' : `@${String(hit.sessionTitle).slice(0, 12)}`}`)
  console.log(`SEARCH "${query}" total=${out.total} shown=${out.hits?.length} ms=${out.ms} relaxed=${out.relaxed} kinds=[${kinds.join(', ')}]`)
}

const titled = await call('/plugins/dsh-search/search?query=' + encodeURIComponent('中文补丁') + '&scope=sessions')
console.log('TITLE_SCOPE total', titled.total)
const first = titled.hits?.[0]
if (first !== undefined) {
  console.log('SAMPLE_HIT', JSON.stringify({ id: first.id, kind: first.kind, title: first.sessionTitle, seg: first.snippet?.segments?.slice(0, 4) }))
}

const doc = await call(`/plugins/dsh-search/doc?id=${first?.id ?? 1}`)
console.log('DOC_OK', doc.ok, 'chars', doc.doc?.text?.length)

const sessions = await call('/plugins/dsh-search/sessions')
console.log('SESSIONS', sessions.sessions?.length, 'first', JSON.stringify(sessions.sessions?.[0]))

for (const dispose of effects.reverse()) { if (typeof dispose === 'function') await dispose() }
console.log('TEARDOWN_OK routes=', routes.size)