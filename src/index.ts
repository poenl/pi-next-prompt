/**
 * pi-next-prompt — 在 AI 本轮最终回复结束后，猜一句用户接下来可能会说的话，填进输入框。
 *
 * 五个时点各司其职：
 * - before_agent_start：往系统提示追加约定，让模型在最终回复末尾单独一行写出猜测
 * - 流式期间：显示层遮挡哨兵及其后内容，避免猜测在输出过程中被看到（只影响渲染）
 * - message_end：抠出该行并把它从消息里真正删掉（state / 落盘 / UI 同时生效）
 * - agent_settled：本轮确实收尾、编辑器为空时，把暂存的猜测写进编辑器（可用 autoFill 关掉）
 * - 快捷键（默认 shift+right）：编辑器为空时把最近一次猜测填进去
 *
 * 全程不额外调用模型：猜测由本轮回复顺带产出。
 *
 * 本轮真的产出猜测时，另通过 pi.events 在 pi-next-prompt:guess 通道发出事件，payload 为 { guess }
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { ExtensionAPI, MessageEndEvent } from '@earendil-works/pi-coding-agent'

/** 事件里那条带 role 判别的 assistant 消息类型；pi 未直接导出 AssistantMessage */
type AssistantMessage = Extract<MessageEndEvent['message'], { role: 'assistant' }>

/** 快捷键键名类型从 pi 的注册接口推导；pi 未导出 KeyId */
type ShortcutKey = Parameters<ExtensionAPI['registerShortcut']>[0]

/**
 * 猜测行的起始标记。保持纯 ASCII，确保模型复现不走样；
 * 正文末尾恰好构成哨兵前缀时会有瞬间误吞，靠 hideGuess 的「前缀不成立即恢复」把影响收在流式期间
 */
const SENTINEL = 'NEXT_PROMPT:'

/** 约定强度：optional 允许模型在没把握时不写，always 要求收尾必须给一句 */
const INTENTS = ['optional', 'always'] as const

type Intent = (typeof INTENTS)[number]

/**
 * shortcut 的宽松校验：只要求非空且不含空白。pi 未导出 parseKey，穷举 KeyId 的维护成本太高；
 * 代价是写法错误的键名不会被拒绝，只表现为快捷键不触发
 */
const SHORTCUT_PATTERN = /^\S+$/

/** 约定段的固定部分：标题、哨兵行格式、说明 */
const RULE_HEAD = `

## Next input prediction
When you finish this turn and will not call any more tools, output this as the very last line of your reply, on its own line:
${SENTINEL} <one sentence guessing what the user will say to you next, in the user's language>
That line is not part of the answer.`

/** 约定段的末句，按 guessIntent 变化 */
const RULE_TAIL: Record<Intent, string> = {
  optional: ' If you are still calling tools, or are not confident, do not output it.',
  always:
    ' Always output it when the turn ends, even if you are not confident: give your single best guess.'
}

/** 按 guessIntent 给出要注入的约定段 */
export function rule(intent: Intent): string {
  return RULE_HEAD + RULE_TAIL[intent]
}

/** 配置内容：约定强度、是否自动把猜测填进编辑器、触发填充的快捷键（undefined 表示不注册） */
export interface Config {
  guessIntent: Intent
  autoFill: boolean
  shortcut: ShortcutKey | undefined
}

/**
 * 配置缺失或不合法时使用的默认值。shortcut 选 shift+方向键，是因为 pi-tui 的默认键表里
 * 没有任何 shift+方向键绑定；代价是终端不区分 Shift 时这个键送不到 pi，快捷键按了没反应
 */
const DEFAULT_CONFIG: Config = {
  guessIntent: 'optional',
  autoFill: true,
  shortcut: 'shift+right'
}

/**
 * 解析配置文本。文件缺失、JSON 坏时整体取默认值；单个字段不合法时只回退该字段，
 * 保证配置写错不会影响 pi 启动。
 */
export function parseConfig(raw: string): Config {
  try {
    const parsed: { guessIntent?: unknown; autoFill?: unknown; shortcut?: unknown } =
      JSON.parse(raw)
    return {
      guessIntent: INTENTS.includes(parsed.guessIntent as Intent)
        ? (parsed.guessIntent as Intent)
        : DEFAULT_CONFIG.guessIntent,
      autoFill: typeof parsed.autoFill === 'boolean' ? parsed.autoFill : DEFAULT_CONFIG.autoFill,
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

export default function (pi: ExtensionAPI) {
  // 配置在扩展加载时读一次，三个字段统一为「改后需要重启 pi」；快捷键也必须在这时注册
  const config = loadConfigSync()

  // message_end 捕获到的猜测，等 agent_settled 落地；每条 assistant 消息都会覆盖它，
  // 所以真正收尾时留下的必然是最后一条消息的猜测
  let pendingGuess: string | undefined

  // 最近一次收尾时的猜测，供快捷键取用；与 pendingGuess 分开，收尾后仍然保留
  let lastGuess: string | undefined

  // 换会话时清掉上一条残留，避免跨会话误填
  pi.on('session_start', () => {
    pendingGuess = undefined
    lastGuess = undefined
  })

  // 1. 注入约定：告诉模型在最终回复末尾的哪一行写什么
  pi.on('before_agent_start', (event) => ({
    systemPrompt: event.systemPrompt + rule(config.guessIntent)
  }))

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

  // 4. 落地：只有本轮真正收尾时才写编辑器，带工具调用的中间轮不会触发
  pi.on('agent_settled', (event, ctx) => {
    const guess = pendingGuess
    pendingGuess = undefined
    // 先转存给快捷键：即使不自动填充，也保留这次猜测供快捷键取用
    lastGuess = guess
    if (!guess || event.aborted) return
    // 通知其他扩展：本轮确实产出了猜测，与是否自动填充无关
    pi.events.emit('pi-next-prompt:guess', { guess })
    if (!config.autoFill) return
    // 非交互模式没有可填的编辑器
    if (!ctx.hasUI || ctx.mode !== 'tui') return
    // 用户已经在打字时不覆盖
    if (ctx.ui.getEditorText() !== '') return
    ctx.ui.setEditorText(guess)
  })

  // 5. 快捷键：编辑器为空时填入最近一次猜测；shortcut 为 false 时不注册。
  // pi 的扩展快捷键是「匹配到即消费」，键名配成编辑器已用的键就会夺走该键原有功能
  if (config.shortcut)
    pi.registerShortcut(config.shortcut, {
      description: '填入上一条预测到编辑器',
      handler: (ctx) => {
        if (!lastGuess) return
        if (!ctx.hasUI || ctx.mode !== 'tui') return
        // 用户已经在打字时不覆盖
        if (ctx.ui.getEditorText() !== '') return
        ctx.ui.setEditorText(lastGuess)
      }
    })
}
