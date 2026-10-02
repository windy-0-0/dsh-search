/**
 * dsh-search · 会话日志记录 → 可索引文档
 *
 * 纯函数：输入一条已解析的 JSONL 记录，输出 0..N 个文档与（可选）会话级元数据。
 * 不碰文件系统、不碰数据库，便于单测与全量回归对照。
 *
 * 抽取原则（完整性优先）：
 *   - 只认**装配完成后**的记录（`assistant/message` / `tool/call` / `tool/result`），
 *     不索引流式增量（`assistant/chunk` / `text-chunks` / `reasoning-chunks` /
 *     `tool-call-chunks`）——增量是同一内容的碎片，索引它们只会重复且放大体积。
 *   - 一条记录一个文档，保留 seq/turn/step，便于结果排序、引用与去重。
 *   - 超长文本不截断（检索要"全面"）；只有病态超大文档（>32MB）才截断索引，
 *     并在文档上标注 truncated。
 */

/** 单文档索引上限：超过则只索引前 32MB（原文仍完整保留）。 */
export const DOC_INDEX_LIMIT = 32 * 1024 * 1024

/** 从 LLM 消息的 content 数组里取纯文本（忽略图片等非文本块）。 */
export function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/** 从 LLM 消息的 content 数组里取指定类型块的文本。 */
function blocksOfType(content, type) {
  if (!Array.isArray(content)) return []
  const out = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type !== type) continue
    if (typeof block.text === 'string') out.push(block.text)
  }
  return out
}

/** 工具调用参数的展示文本：字符串原样，对象转 JSON。 */
function argsText(args) {
  if (typeof args === 'string') return args
  if (args === null || args === undefined) return ''
  try {
    return JSON.stringify(args)
  } catch {
    return String(args)
  }
}

function clip(text, limit = DOC_INDEX_LIMIT) {
  if (typeof text !== 'string') return { text: '', truncated: false }
  if (text.length <= limit) return { text, truncated: false }
  return { text: text.slice(0, limit), truncated: true }
}

/**
 * 抽取一条记录。
 * @param record 已解析的会话日志记录（含 type / seq / time / data）。
 * @param ctx 会话上下文 { sessionId, projectKey, cwd, title }，用于给文档打标。
 * @returns { header?, title?, docs: Array<{kind, label, text, truncated, seq, time, turn, step}> }
 */
export function extract(record, ctx) {
  if (record === null || typeof record !== 'object') return { docs: [] }
  const type = record.type
  if (typeof type !== 'string') return { docs: [] }
  const data = record.data !== null && typeof record.data === 'object' ? record.data : {}
  const seq = Number.isFinite(record.seq) ? record.seq : (Number.isFinite(record.seq0) ? record.seq0 : null)
  const time = Number.isFinite(record.time) ? record.time : (Number.isFinite(record.time0) ? record.time0 : null)
  const turn = Number.isFinite(data.turn) ? data.turn : null
  const step = Number.isFinite(data.step) ? data.step : null
  const base = { seq, time, turn, step }

  switch (type) {
    case 'session': {
      return {
        docs: [],
        header: {
          id: typeof record.id === 'string' ? record.id : ctx.sessionId,
          cwd: typeof record.cwd === 'string' ? record.cwd : null,
          createdAt: Number.isFinite(record.createdAt) ? record.createdAt : null,
          parentSession: typeof record.parentSession === 'string' ? record.parentSession : null,
          origin: typeof record.origin === 'string' ? record.origin : null,
          agentPreset: typeof record.agentPreset === 'string' ? record.agentPreset : null,
          delegationDepth: Number.isFinite(record.delegationDepth) ? record.delegationDepth : null,
        },
      }
    }

    case 'session/title': {
      const title = typeof data.title === 'string' ? data.title : ''
      if (title === '') return { docs: [] }
      return { title, docs: [{ ...base, kind: 'title', label: '会话标题', text: title }] }
    }

    case 'user/message': {
      const text = textOfContent(data.content)
      if (text === '') return { docs: [] }
      return { docs: [{ ...base, kind: 'user', label: '用户消息', text }] }
    }

    case 'agent/inbox/spliced': {
      // 插件/其它 agent 注入的消息（含人类插话），同样是"聊天记录"的一部分。
      const inserted = Array.isArray(data.inserted) ? data.inserted : []
      const docs = []
      for (const message of inserted) {
        const text = textOfContent(message?.content)
        if (text === '') continue
        const kind = message?.source?.kind === 'user' ? 'user' : 'inject'
        docs.push({ ...base, kind, label: kind === 'user' ? '用户插话' : '注入消息', text })
      }
      return { docs }
    }

    case 'assistant/message': {
      const content = data.message?.content
      const docs = []
      const reasoning = blocksOfType(content, 'reasoning').join('\n\n').trim()
      if (reasoning !== '') docs.push({ ...base, kind: 'reasoning', label: '思考过程', text: reasoning })
      const text = blocksOfType(content, 'text').join('\n\n').trim()
      if (text !== '') docs.push({ ...base, kind: 'assistant', label: '助手回复', text })
      // 工具调用不在此处索引：tool/call 记录才是权威来源（避免同一调用被索引两次）。
      return { docs }
    }

    case 'tool/call': {
      const name = typeof data.name === 'string' ? data.name : 'tool'
      const args = argsText(data.arguments)
      const text = `${name} ${args}`.trim()
      if (text === '') return { docs: [] }
      return { docs: [{ ...base, kind: 'tool_call', label: `工具调用 · ${name}`, text, tool: name }] }
    }

    case 'tool/result': {
      const message = data.message
      const content = message?.content
      const parts = []
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block === null || typeof block !== 'object') continue
          if (Array.isArray(block.content)) parts.push(textOfContent(block.content))
          else if (typeof block.text === 'string') parts.push(block.text)
        }
      }
      const text = parts.filter(Boolean).join('\n').trim()
      if (text === '') return { docs: [] }
      const toolCallId = content?.[0]?.toolCallId ?? null
      const isError = content?.[0]?.isError === true
      return { docs: [{ ...base, kind: 'tool_result', label: isError ? '工具结果（错误）' : '工具结果', text, toolCallId }] }
    }

    case 'compaction/summary': {
      const text = Array.isArray(data.summary) ? textOfContent(data.summary) : ''
      if (text === '') return { docs: [] }
      return { docs: [{ ...base, kind: 'summary', label: '上下文压缩摘要', text }] }
    }

    case 'goal/change': {
      const objective = data.goal?.objective
      if (typeof objective !== 'string' || objective === '') return { docs: [] }
      const operation = typeof data.operation === 'string' ? data.operation : 'change'
      if (operation === 'complete' || operation === 'pause') return { docs: [] }
      return { docs: [{ ...base, kind: 'goal', label: '会话目标', text: objective }] }
    }

    case 'todo/write': {
      const todos = Array.isArray(data.todos) ? data.todos : []
      const text = todos.map(item => `[${item?.status ?? '?'}] ${item?.content ?? ''}`).join('\n').trim()
      if (text === '') return { docs: [] }
      return { docs: [{ ...base, kind: 'todo', label: '任务清单', text }] }
    }

    case 'command/run': {
      const name = typeof data.name === 'string' ? data.name : ''
      const args = typeof data.args === 'string' ? data.args : ''
      const text = `${name} ${args}`.trim()
      if (text === '') return { docs: [] }
      return { docs: [{ ...base, kind: 'command', label: '用户命令', text }] }
    }

    case 'command/done': {
      const text = typeof data.text === 'string' ? data.text.trim() : ''
      if (text === '') return { docs: [] }
      return { docs: [{ ...base, kind: 'command_result', label: '命令结果', text }] }
    }

    case 'approval/asked': {
      const toolName = typeof data.toolName === 'string' ? data.toolName : ''
      const reason = typeof data.reason === 'string' ? data.reason : ''
      const text = `${toolName} ${reason}`.trim()
      if (text === '') return { docs: [] }
      return { docs: [{ ...base, kind: 'approval', label: '审批请求', text }] }
    }

    case 'defend/detection': {
      const text = `${data.category ?? ''} ${data.ruleId ?? ''} ${data.secretType ?? ''}`.trim()
      if (text === '') return { docs: [] }
      return { docs: [{ ...base, kind: 'defend', label: '安全检测', text }] }
    }

    default:
      return { docs: [] }
  }
}

/** 对一条文档做索引前裁剪，返回 { text, truncated }。 */
export function clipDocText(text) {
  return clip(text)
}
