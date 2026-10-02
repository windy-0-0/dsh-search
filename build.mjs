/**
 * dsh-search 打包：两个半区各出一个 bundle。
 *   lib/index.js    —— host 半区（ESM / node），含 worker 与各扫描器
 *   lib/worker.js   —— 索引构建线程（worker_threads 按路径加载，必须单独产出）
 *   lib/client.js   —— 浏览器半区（按 DSH 的 __ModuleLoader__ 协议包装）
 *
 * 客户端把平台模块标成 external，由加载器注入；host 侧除 node 内置模块外全部内联，
 * 保证插件目录自包含（不依赖 profile 的 node_modules 解析）。
 */
import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const CLIENT_ID = 'dsh-search'

const CLIENT_EXTERNAL = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  'cordis',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-runtime',
  '@deepseek-ai/dsh-client-ui-sidebar',
  '@deepseek-ai/dsh-client-ui-renderer',
]

mkdirSync(join(root, 'lib'), { recursive: true })

const common = {
  bundle: true,
  legalComments: 'none',
  logLevel: 'info',
  // node:sqlite 是内置模块，worker_threads 同理；只有第三方包才需要内联。
  external: ['node:*'],
}

await build({
  ...common,
  entryPoints: [join(root, 'src/index.js')],
  outfile: join(root, 'lib/index.js'),
  format: 'esm',
  platform: 'node',
  target: 'node22.19',
})

// worker 单独打包：它由 fileURLToPath(new URL('./worker.js', import.meta.url)) 定位，
// 因此必须和 index.js 平级落在 lib/ 下。
await build({
  ...common,
  entryPoints: [join(root, 'src/host/worker.js')],
  outfile: join(root, 'lib/worker.js'),
  format: 'esm',
  platform: 'node',
  target: 'node22.19',
})

await build({
  ...common,
  entryPoints: [join(root, 'src/client.js')],
  outfile: join(root, 'lib/client.js'),
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  external: CLIENT_EXTERNAL,
  banner: {
    js: [
      `window.__ModuleLoader__.load({ id: ${JSON.stringify(CLIENT_ID)}, factory: (require) => {`,
      'var module = { exports: {} };',
      'var exports = module.exports;',
    ].join('\n'),
  },
  footer: { js: 'return module.exports; } });' },
})