/**
 * pi-next-prompt — 在 AI 本轮最终回复结束后，猜一句用户接下来可能会说的话，填进输入框。
 *
 * 六个时点各司其职：
 * - before_agent_start：清掉上一条预测，并往系统提示追加约定，让模型在最终回复末尾单独一行写出猜测
 * - 流式期间：显示层遮挡哨兵及其后内容，避免猜测在输出过程中被看到（只影响渲染）
 * - message_end：抠出该行并把它从消息里真正删掉（state / 落盘 / UI 同时生效）
 * - agent_before_settle：本轮漏写时补一次极短请求，让模型只补那一行
 * - agent_settled：本轮确实收尾、编辑器为空时，把暂存的猜测写进编辑器（可用 autoFill 关掉）
 * - 快捷键（默认 shift+right）：编辑器为空、或内容正好是猜测开头时，用猜测补全剩余部分
 *
 * 猜测默认由本轮回复顺带产出；漏写时才额外请求一次，且每轮最多补一次。
 *
 * 本轮真的产出猜测时，另通过 pi.events 在 pi-next-prompt:guess 通道发出事件，payload 为 { guess }
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { truncateToVisualLines } from '@earendil-works/pi-coding-agent'
import type {
  ExtensionAPI,
  ExtensionContext,
  MessageEndEvent,
  SessionEntry
} from '@earendil-works/pi-coding-agent'

/** 事件里那条带 role 判别的 assistant 消息类型；pi 未直接导出 AssistantMessage */
type AssistantMessage = Extract<MessageEndEvent['message'], { role: 'assistant' }>

/** 快捷键键名类型从 pi 的注册接口推导；pi 未导出 KeyId */
type ShortcutKey = Parameters<ExtensionAPI['registerShortcut']>[0]

/**
 * 猜测行的起始标记。保持纯 ASCII，确保模型复现不走样；
 * 正文末尾恰好构成哨兵前缀时会有瞬间误吞，靠 hideGuess 的「前缀不成立即恢复」把影响收在流式期间
 */
const SENTINEL = 'NEXT_PROMPT:'

/** 会话记录的类型名：用来在重载、换分支时认出本扩展写入的记录 */
export const ENTRY_TYPE = 'pi-next-prompt:guess'

/** 输入框上方提示行的 key；同一个 key 再设置一次就是替换那一行 */
const SUGGESTION_WIDGET = 'pi-next-prompt'

/** 补写请求在会话里的类型名：用来认出这条系统提示，不与应用写入的预测记录混淆 */
const RETRY_TYPE = 'pi-next-prompt:retry'

/**
 * 漏写时追加的提示。只让它输出哨兵行、不要重复正文，避免补写变成第二条长回复；
 * 语言跟随上一轮，防止模型突然改成英文
 */
const RETRY_MESSAGE = `Your reply must end with the NEXT_PROMPT line. Output only that line, same language, no repetition:\n${SENTINEL} <one sentence>`

/**
 * shortcut 的宽松校验：只要求非空且不含空白。pi 未导出 parseKey，穷举 KeyId 的维护成本太高；
 * 代价是写法错误的键名不会被拒绝，只表现为快捷键不触发
 */
const SHORTCUT_PATTERN = /^\S+$/

/**
 * 注入系统提示的约定段。要求每轮收尾都必须给一句，不允许以「没把握」为由省略：
 * 无把握时的最优猜测仍有参考价值，省略只会让这轮停在空白编辑器上
 */
export const RULE = `

## Next input prediction
When you finish this turn and will not call any more tools, output this as the very last line of your reply, on its own line:
${SENTINEL} <one sentence in the user's language that the user would type to you next — not something you would say>
That line is not part of the answer. Always output it when the turn ends, even if you are not confident: give your single best guess.`

/** 配置内容：是否自动把猜测填进编辑器、触发填充的快捷键（undefined 表示不注册） */
export interface Config {
  autoFill: boolean
  showSuggestion: boolean
  shortcut: ShortcutKey | undefined
}

/**
 * 配置缺失或不合法时使用的默认值。shortcut 选 shift+方向键，是因为 pi-tui 的默认键表里
 * 没有任何 shift+方向键绑定；代价是终端不区分 Shift 时这个键送不到 pi，快捷键按了没反应
 */
const DEFAULT_CONFIG: Config = {
  autoFill: true,
  showSuggestion: true,
  shortcut: 'shift+right'
}

/**
 * 解析配置文本。文件缺失、JSON 坏时整体取默认值；单个字段不合法时只回退该字段，
 * 保证配置写错不会影响 pi 启动。
 */
export function parseConfig(raw: string): Config {
  try {
    const parsed: { autoFill?: unknown; showSuggestion?: unknown; shortcut?: unknown } =
      JSON.parse(raw)
    return {
      autoFill: typeof parsed.autoFill === 'boolean' ? parsed.autoFill : DEFAULT_CONFIG.autoFill,
      // 未自动填入时是否用输入框上方的一行提示展示预测
      showSuggestion:
        typeof parsed.showSuggestion === 'boolean'
          ? parsed.showSuggestion
          : DEFAULT_CONFIG.showSuggestion,
      shortcut:
        parsed.shortcut === false
          ? undefined
          : typeof parsed.shortcut === 'string' && SHORTCUT_PATTERN.test(parsed.shortcut)
            ? (parsed.shortcut as ShortcutKey)
            : DEFAULT_CONFIG.shortcut
    }
  } catch {
    return DEFAULT_CONFIG
  }
}

/**
 * 配置文件位置：<agent 目录>/extensions/pi-next-prompt/config.json。
 * 目录顺序与 pi 一致（docs/environment-variables.md）：
 * PI_CODING_AGENT_DIR → $XDG_CONFIG_HOME/pi/agent → ~/.pi/agent
 */
function configPath(): string {
  const agentDir =
    process.env.PI_CODING_AGENT_DIR ??
    (process.env.XDG_CONFIG_HOME
      ? join(process.env.XDG_CONFIG_HOME, 'pi', 'agent')
      : join(homedir(), '.pi', 'agent'))
  return join(agentDir, 'extensions', 'pi-next-prompt/config.json')
}

/**
 * 同步读配置，供扩展加载阶段使用：配置只在扩展加载时读一次，注册快捷键也必须在这一刻。
 * 读不到就整体退回默认值。
 */
function loadConfigSync(): Config {
  try {
    return parseConfig(readFileSync(configPath(), 'utf8'))
  } catch {
    return DEFAULT_CONFIG
  }
}

/** 摘掉 assistant 消息末尾的哨兵行，返回改写后的消息与其中的猜测 */
export function stripGuess(message: AssistantMessage): {
  message: AssistantMessage
  guess?: string
} {
  const blocks = message.content
  // 倒序找最后一段含哨兵的文本；哨兵之后的内容一律丢弃
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]
    if (!block || block.type !== 'text') continue
    const at = block.text.lastIndexOf(SENTINEL)
    if (at === -1) continue
    const guess = block.text
      .slice(at + SENTINEL.length)
      .split('\n')[0]
      ?.trim()
    // 保留哨兵之前的正文，并去掉由此产生的尾部空白
    const text = block.text.slice(0, at).replace(/\s+$/, '')
    const content = blocks.slice(0, i)
    if (text) content.push({ ...block, text })
    // 哨兵之后的文本一律丢弃，但工具调用这类非文本块必须留下：模型若先写哨兵再调工具，
    // 删掉调用块会让紧随其后的工具结果失去配对的调用
    content.push(...blocks.slice(i + 1).filter((b) => b.type !== 'text'))
    return { message: { ...message, content }, guess: guess || undefined }
  }
  return { message }
}

/**
 * 流式期间的显示层遮挡：截掉哨兵及其后内容，让猜测在输出过程中不可见。
 * 每次流式增量都会带着当前全文重跑，判定为「不是哨兵」时上一帧的隐藏自动消失。
 */
export function hideGuess(text: string): string {
  const sentinelStart = text.lastIndexOf(SENTINEL)
  if (sentinelStart !== -1) return text.slice(0, sentinelStart)
  // 哨兵只出了半截（如「NEXT」）时也一并吞掉，否则流式期间会闪现。
  // 锚点取最后一个哨兵首字符，不要求行首：模型可能把哨兵写在正文同一行。
  // 代价是正文末尾恰好构成哨兵前缀时会被吞（如正文停在单个大写 N，或单词 NEXT），
  // 前缀不成立或本轮结束即恢复
  const partialStart = text.lastIndexOf(SENTINEL.at(0)!)
  if (partialStart === -1) return text
  const partial = text.slice(partialStart)
  if (partial.length < SENTINEL.length && SENTINEL.startsWith(partial)) {
    return text.slice(0, partialStart)
  }
  return text
}

/**
 * 取当前分支上最后一条预测。记录挂在写入时的节点之后，所以按「挂载点是否在当前分支路径上」
 * 判断归属：/tree 只能停在消息节点，记录作为它的子节点不在路径里，按记录自身判断会漏掉它。
 */
export function latestGuess(
  entries: readonly SessionEntry[],
  pathIds: ReadonlySet<string>
): string | undefined {
  // lib 为 es2022，没有 findLast，只能倒序循环
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]
    if (entry?.type !== 'custom' || entry.customType !== ENTRY_TYPE) continue
    if (!entry.parentId || !pathIds.has(entry.parentId)) continue
    // 最后一条本扩展记录就是权威状态：null 表示这轮明确没有猜测，不再往前找
    return typeof entry.data === 'string' ? entry.data : undefined
  }
  return undefined
}

export default function (pi: ExtensionAPI) {
  // 配置在扩展加载时读一次，三个字段统一为「改后需要重启 pi」；快捷键也必须在这时注册
  const config = loadConfigSync()

  // message_end 捕获到的猜测，等 agent_settled 落地；每条 assistant 消息都会覆盖它，
  // 所以真正收尾时留下的必然是最后一条消息的猜测
  let pendingGuess: string | undefined

  // 最近一次收尾时的猜测，供快捷键取用；与 pendingGuess 分开，收尾后仍然保留
  let lastGuess: string | undefined

  // 本轮是否已经补写过一次。补写后仍然没写就不再继续，避免无限续写
  let retried = false

  /**
   * 把预测挂到输入框上方。是否看得见不在挂的时候定，而是每帧渲染时拿编辑器当前内容比较：
   * 内容与预测相同（已经采用）就不画，不同（包括正在手打或删空）就画。
   * 这样不需要编辑器变更事件，输入过程中也能立即跟随
   */
  function syncSuggestion(ctx: ExtensionContext): void {
    if (!ctx.hasUI || ctx.mode !== 'tui') return
    const suggestion = lastGuess
    if (!config.showSuggestion || suggestion === undefined) {
      ctx.ui.setWidget(SUGGESTION_WIDGET, undefined)
      return
    }
    // 用组件而不是字符串数组：主题色只能在渲染时取，换主题后颜色才不会过时
    ctx.ui.setWidget(SUGGESTION_WIDGET, (_tui, theme) => ({
      render: (width: number) => {
        // 与编辑器内容相同说明已经采用，不重复画；用户删掉后下一帧自动回来
        if (ctx.ui.getEditorText() === suggestion) return []
        return truncateToVisualLines(theme.fg('muted', `› ${suggestion}`), 2, width, 1, 'start')
          .visualLines
      },
      // 每次渲染重新取主题色与编辑器内容，不缓存，无需失效处理
      invalidate: () => {}
    }))
  }

  /**
   * 会话启动或换分支后：清掉本轮暂存，从会话里读回当前分支最近一次猜测，
   * 再把结果广播出去。无论读没读到都发一次：订阅方（editor-bg 的幽灵文本）靠事件更新，
   * 不发会把旧分支的预测留在编辑器里
   */
  function restore(ctx: ExtensionContext): void {
    pendingGuess = undefined
    lastGuess = latestGuess(
      ctx.sessionManager.getEntries(),
      new Set(ctx.sessionManager.getBranch().map((entry) => entry.id))
    )
    pi.events.emit('pi-next-prompt:guess', { guess: lastGuess })
    syncSuggestion(ctx)
  }

  // 换会话、重载时清掉上一条残留，避免跨会话误填
  pi.on('session_start', (_event, ctx) => restore(ctx))

  // 换分支不会触发 session_start，所以单独再读一次，否则拿到的还是原分支的猜测
  pi.on('session_tree', (_event, ctx) => restore(ctx))

  // 1. 注入约定：告诉模型在最终回复末尾的哪一行写什么，且每轮都必须写
  pi.on('before_agent_start', (event, ctx) => {
    // 新的用户轮次开始：上一条预测已经过期，先清掉再允许补写一次。
    // 用户已经自己发了话，旧预测再留着只会误导快捷键与提示行
    retried = false
    lastGuess = undefined
    syncSuggestion(ctx)
    return { systemPrompt: event.systemPrompt + RULE }
  })

  // 2. 显示层遮挡：只在流式期间生效。transformer 是会话级常驻，
  // 非流式时套用会把正文里提到的哨兵永久隐藏，因此必须靠 isStreaming 收口
  pi.registerMarkdownTransformer((markdown, context) => {
    if (context.messageType !== 'assistant' || !context.isStreaming) return markdown
    return hideGuess(markdown)
  })

  // 3. 捕获 + 真删：改写这条消息，agent state、落盘记录、UI 都用不含哨兵行的版本
  pi.on('message_end', (event) => {
    if (event.message.role !== 'assistant') return
    const { message, guess } = stripGuess(event.message)
    pendingGuess = guess
    if (message !== event.message) return { message }
  })

  // 4. 漏写兜底：收尾前还没有预测时，追加一条不可见的提示让模型补写一次。
  // 只在本轮正常完成时补；中断、出错不补。补写后仍漏就放弃，不再继续
  pi.on('agent_before_settle', (event) => {
    if (retried || event.outcome !== 'completed' || pendingGuess) return
    retried = true
    return {
      entries: [
        {
          type: 'custom_message' as const,
          customType: RETRY_TYPE,
          content: RETRY_MESSAGE,
          display: false
        }
      ],
      continue: true
    }
  })

  // 5. 落地：只有本轮真正收尾时才写编辑器，带工具调用的中间轮不会触发
  pi.on('agent_settled', (event, ctx) => {
    const guess = pendingGuess
    pendingGuess = undefined
    // 本轮有预测才替换提示行用的那一条；没有就保留上一条，不让提示无缘无故消失
    if (guess) lastGuess = guess
    // 写进会话：没有猜测也写 null，保证重载或换分支后读回的状态与当时一致
    pi.appendEntry(ENTRY_TYPE, guess ?? null)
    if (guess && !event.aborted) {
      // 通知其他扩展：本轮确实产出了猜测，与是否自动填充无关
      pi.events.emit('pi-next-prompt:guess', { guess })
      // 自动填入的前提：开关开着、有可填的编辑器、用户还没开始打字
      if (config.autoFill && ctx.hasUI && ctx.mode === 'tui' && ctx.ui.getEditorText() === '') {
        ctx.ui.setEditorText(guess)
      }
    }
    // 统一在这一处定提示行：自动填入后编辑器里已经有这句，相等即不显示
    syncSuggestion(ctx)
  })

  // 6. 快捷键：用最近一次猜测补全编辑器；shortcut 为 false 时不注册。
  // pi 的扩展快捷键是「匹配到即消费」，键名配成编辑器已用的键就会夺走该键原有功能
  if (config.shortcut)
    pi.registerShortcut(config.shortcut, {
      description: '补全上一条预测',
      handler: (ctx) => {
        if (!lastGuess) return
        if (!ctx.hasUI || ctx.mode !== 'tui') return
        const current = ctx.ui.getEditorText()
        // 只在编辑器内容正好是预测开头时补全：空编辑器也属于这种情况，
        // 已经打了一半的同一句可以接着补；无关内容、或已经打完整句都不动
        if (!lastGuess.startsWith(current) || current === lastGuess) return
        ctx.ui.setEditorText(lastGuess)
        // 采用后编辑器内容与预测相同，提示行随之隐藏
        syncSuggestion(ctx)
      }
    })
}
