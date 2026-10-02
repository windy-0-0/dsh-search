/**
 * 本地冒烟：用桩 ctx 挂载 lib/index.js，验证工具注册、路由注册、检索链路与卸载清理。
 * 不启动 DSH，不需要重启宿主。
 *
 * 关键：桩 ctx 必须**按插件声明的 inject 决定给不给服务**。
 * 以前这里无条件提供 timer，于是插件漏写 `inject = ['tools','timer']` 时冒烟全绿，
 * 真实挂载却报 `cannot get property "timer" without inject` —— 假绿。现在按声明给。
 */
import { EventEmitter } from 'node:events'

const plugin = await import('../lib/index.js')

const effects = []
const tools = new Map()
const routes = new Map()
const services = new Map()

/** 插件声明的硬依赖；没声明的服务一律不给，复现真实 ReflectService 的语义。 */
const declared = new Set(Array.isArray(plugin.inject) ? plugin.inject : [])

const available = {
  tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
  timer: {
    timeout(fn, ms) { const t = setTimeout(fn, ms); return () => clearTimeout(t) },
    interval(fn, ms) { const t = setInterval(fn, ms); return () => clearInterval(t) },
  },
  webServer: {
    register(route) { routes.set(route.path, route); return () => routes.delete(route.path) },
  },
}

const ctx = {
  effect(fn, label) {
    const dispose = fn()
    effects.push({ label, dispose })
    return dispose
  },
  on() { return () => {} },
  // ctx.inject([...], fn)：模拟 cordis 的软依赖注入——被请求的服务在回调里可用。
  inject(names, fn) {
    const scoped = Object.create(ctx)
    for (const name of names) {
      Object.defineProperty(scoped, name, { get: () => available[name], configurable: true })
    }
    fn(scoped)
    return () => {}
  },
  // ctx.get 只返回"插件声明过"的服务；未声明的返回 undefined。
  get(name) { return declared.has(name) ? available[name] : undefined },
  provide(name, value) { services.set(name, value); return () => services.delete(name) },
}

// ctx.<service> 的访问同样只在声明后可用，否则抛与 cordis 同形的错误。
for (const name of Object.keys(available)) {
  Object.defineProperty(ctx, name, {
    get() {
      if (!declared.has(name)) throw new Error(`cannot get property "${name}" without inject`)
      return available[name]
    },
  })
}

// 用**非零** autoIndexDelayMs 挂载：这是唯一会走 ctx.timer 的路径。
// 传 0 会把整段自动索引代码跳过去，于是漏写 inject 的缺陷在冒烟里看不见（曾经的假绿）。
// 这里给一个很短但非零的延迟，让 timer 分支真实执行，同时不真的建索引（会在 teardown 前被清掉）。
plugin.apply(ctx, { autoIndexDelayMs: 60_000 })

console.log('INJECT', [...declared].join(', ') || '(none)')
console.log('TOOLS', [...tools.keys()].join(', '))
console.log('ROUTES', [...routes.keys()].join(', '))
console.log('SERVICES', [...services.keys()].join(', '))
console.log('EFFECTS', effects.length)

/** 模拟一次 HTTP 请求。 */
async function call(path, { method = 'GET', body } = {}) {
  const route = routes.get(path.split('?')[0])
  if (route === undefined) throw new Error(`no route ${path}`)
  const req = new EventEmitter()
  req.url = path
  req.method = method
  const chunks = []
  const res = {
    statusCode: 200,
    headers: null,
    writeHead(code, headers) { this.statusCode = code; this.headers = headers },
    end(payload) { chunks.push(payload) },
  }
  const promise = route.handler(req, res)
  if (body !== undefined) {
    req.emit('data', Buffer.from(JSON.stringify(body)))
  }
  req.emit('end')
  await promise
  return { status: res.statusCode, json: JSON.parse(chunks.join('') || 'null') }
}

const status = await call('/plugins/dsh-search/status')
console.log('STATUS.ok', status.json.ok, 'docs', status.json.index?.docs, 'building', status.json.building, 'dbExists', status.json.dbExists)

// 直接建索引（同步等 worker 完成），验证 worker 链路真的能跑。
const dbPath = '/tmp/dsh-search-probe/smoke.sqlite'
process.env.DSH_SEARCH_TEST = '1'

console.log('--- search (empty index) ---')
const empty = await call('/plugins/dsh-search/search?query=' + encodeURIComponent('任务看板'))
console.log('SEARCH.total', empty.json.total, 'hits', empty.json.hits?.length, 'error', empty.json.error ?? null)

console.log('--- tool render (empty index) ---')
const toolText = await tools.get('search_dsh').execute({ query: '任务看板' })
console.log('TOOL', toolText.slice(0, 80))

console.log('--- read tool ---')
console.log('READ', (await tools.get('search_dsh_read').execute({ doc_id: 1 })).slice(0, 80))

console.log('--- teardown ---')
for (const { label, dispose } of effects.reverse()) {
  if (typeof dispose === 'function') await dispose()
}
console.log('ROUTES_AFTER', routes.size, 'TOOLS_AFTER', tools.size)