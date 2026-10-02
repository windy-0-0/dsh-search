/**
 * 单文件扫描耗时分布：决定索引构建要不要放进 worker。
 * 主进程是 Web 服务与 agent 共用的唯一事件循环，同步扫描会整个冻住 GUI。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { scanSessionDir } from '../src/host/scan.js'

const root = '/Users/mac/.dsh/sessions'
const rows = []
const sink = { onHeader() {}, onTitle() {}, onDoc() {}, onFile() {} }

for (const projectKey of readdirSync(root)) {
  const projectDir = join(root, projectKey)
  let segments
  try {
    segments = readdirSync(projectDir)
  } catch {
    continue
  }
  for (const segment of segments) {
    const dir = join(projectDir, segment)
    let names
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    const name = names.find(n => n.endsWith('.jsonl.zstd') || n.endsWith('.jsonl'))
    if (name === undefined) continue
    let size = 0
    try {
      size = statSync(join(dir, name)).size
    } catch {
      continue
    }
    const t0 = performance.now()
    try {
      scanSessionDir(dir, projectKey, undefined, sink)
    } catch {
      continue
    }
    rows.push({ ms: performance.now() - t0, sizeMB: size / 1e6, segment })
  }
}

rows.sort((a, b) => b.ms - a.ms)
const total = rows.reduce((sum, row) => sum + row.ms, 0)
console.log(`files=${rows.length} total=${total.toFixed(0)}ms`)
console.log('slowest 12:')
for (const row of rows.slice(0, 12)) {
  console.log(`  ${row.ms.toFixed(0).padStart(6)}ms  ${row.sizeMB.toFixed(1).padStart(7)}MB  ${row.segment}`)
}
const over = [100, 300, 1000, 3000]
for (const limit of over) {
  const n = rows.filter(row => row.ms > limit).length
  console.log(`  > ${limit}ms: ${n} files`)
}