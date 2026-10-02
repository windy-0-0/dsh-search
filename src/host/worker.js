/**
 * dsh-search · 索引构建工作线程
 *
 * 为什么必须放在 worker 里：全量索引要解压 1.1GB 会话日志（实测 38 秒，单文件最慢
 * 1.5 秒）。这个循环与 Web 服务、agent 循环**共用同一个事件循环**，同步扫描会让
 * 整个 GUI 冻住——用户在索引期间连搜索框都打不开。放进 worker 后主线程只收进度消息。
 *
 * 数据面是纯 JSON（进度快照、结果汇总），主线程自己的 SearchIndex 连接负责检索，
 * 两边各持一个连接读同一个 WAL 库（已实测跨线程可见）。
 */

import { parentPort, workerData } from 'node:worker_threads'
import { SearchIndex } from './index-db.js'
import { Indexer } from './indexer.js'

const index = new SearchIndex(workerData.dbPath)
index.open()
const indexer = new Indexer(index, {
  sessionsRoot: workerData.sessionsRoot,
  memgasRoot: workerData.memgasRoot,
  home: workerData.home,
})

let lastSent = 0
const timer = setInterval(() => {
  const snapshot = indexer.snapshot()
  // 只在有实质变化时上报，避免主线程被无意义的消息刷屏。
  if (snapshot.docs !== lastSent) {
    lastSent = snapshot.docs
    parentPort.postMessage({ type: 'progress', progress: snapshot })
  }
}, 500)

parentPort.on('message', message => {
  if (message?.type === 'abort') indexer.abort()
})

/**
 * 收尾并结束线程。
 *
 * `parentPort.on('message')` 会把消息端口**引用住**，所以即使构建结束、定时器清掉，
 * worker 的事件循环也不会空转退出——主线程就永远等不到 exit，构建状态卡在"进行中"。
 * 因此这里必须显式 unref 端口，让线程在最后一条消息发出后自然结束。
 */
function finish(message) {
  clearInterval(timer)
  parentPort.postMessage(message)
  parentPort.unref()
}

try {
  const result = await indexer.build({
    full: workerData.full === true,
    includeFiles: workerData.includeFiles === true,
    roots: workerData.roots,
    exclude: workerData.exclude,
  })
  finish({ type: 'done', result })
} catch (error) {
  finish({
    type: 'failed',
    error: error instanceof Error ? error.message : String(error),
  })
} finally {
  index.close()
}