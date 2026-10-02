/**
 * dsh-search · 会话日志的多帧 zstd 读取
 *
 * DSH 的 JSONL 后端把日志写成**首尾相接的独立 zstd 帧**（每帧可单独解压），
 * 这样追加写入不需要重压整个文件。node:zlib 的流式解压只认单帧（多帧会报
 * Unknown frame descriptor），所以这里自己扫描帧边界后逐帧解压。
 *
 * 帧边界扫描算法与 DSH 的 `packages/session/session-persistence-jsonl/src/zstd.ts`
 * 的 scanZstdFrames 保持一致（帧头、块头、可选校验和），保证读到的是权威边界。
 */

import { constants, zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = 0xfd2fb528

/**
 * 扫描缓冲区内所有完整 zstd 帧。
 * @param buffer 文件当前全部字节
 * @returns { frames: Array<[start, end]>, tornStart?: number }
 *   frames 是完整帧的字节区间；tornStart 是末尾被 EOF 截断的半帧起点（活会话追加中）。
 */
export function scanFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt zstd log: invalid frame magic at byte ${offset}`)
    }
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) throw new Error(`corrupt zstd log: reserved frame-header bit at byte ${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) throw new Error(`corrupt zstd log: reserved block type at byte ${offset - 3}`)
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push([start, offset])
  }
  return { frames }
}

/**
 * 解压一个完整帧。
 * @param buffer 整个文件缓冲
 * @param range [start, end)
 * @returns 解压后的 UTF-8 文本
 */
export function decodeFrame(buffer, [start, end]) {
  return zstdDecompressSync(buffer.subarray(start, end)).toString('utf8')
}

/**
 * 解压被截断的末帧（活会话正在写入时可能读到半帧）。
 * `ZSTD_e_flush` 会放弃帧尾与校验和完成，因此只能在已确认的截断边界上使用；
 * 解出来的内容可能缺最后几个字节，逐行解析时会自然丢掉不完整的最后一行。
 */
export function decodeTornFrame(buffer, start) {
  try {
    return zstdDecompressSync(buffer.subarray(start), { finishFlush: constants.ZSTD_e_flush }).toString('utf8')
  } catch {
    return ''
  }
}