/**
 * pi-next-prompt — 在 AI 本轮最终回复结束后，猜一句用户接下来可能会说的话，填进输入框。
 *
 * 三个时点各司其职：
 * - before_agent_start：往系统提示追加约定，让模型在最终回复末尾单独一行写出猜测
 * - message_end：抠出该行并把它从消息里真正删掉（state / 落盘 / UI 同时生效）
 * - agent_settled：本轮确实收尾、编辑器为空时，把暂存的猜测写进编辑器
 *
 * 全程不额外调用模型：猜测由本轮回复顺带产出。
 */

import type { ExtensionAPI, MessageEndEvent } from '@earendil-works/pi-coding-agent'

/** 事件里那条带 role 判别的 assistant 消息类型；pi 未直接导出 AssistantMessage */
type AssistantMessage = Extract<MessageEndEvent['message'], { role: 'assistant' }>

/** 猜测行的起始标记，纯 ASCII，避免模型对罕见符号的复现失真 */
const SENTINEL = 'NEXT_PROMPT:'

/** 追加到系统提示尾部的约定段 */
const RULE = `

## 下一次输入预测
当你结束本轮、不再调用任何工具时，在回复的最后单独另起一行输出：
${SENTINEL} <一句你猜测用户接下来会对你说的话，用用户的语言>
该行不属于正文。仍在调用工具，或没有把握时，不要输出该行。`

/**
 * message_end 捕获到的猜测，等 agent_settled 落地。
 * 每条 assistant 消息结束都会覆盖它，因此真正收尾时留下的必然是最后一条消息的猜测。
 */
let pendingGuess: string | undefined

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
    return { message: { ...message, content }, guess: guess || undefined }
  }
  return { message }
}

export default function (pi: ExtensionAPI) {
  // 换会话时清掉上一条残留，避免跨会话误填
  pi.on('session_start', () => {
    pendingGuess = undefined
  })

  // 1. 注入约定：告诉模型在最终回复末尾的哪一行写什么
  pi.on('before_agent_start', (event) => ({ systemPrompt: event.systemPrompt + RULE }))

  // 2. 捕获 + 真删：改写这条消息，agent state、落盘记录、UI 都用不含哨兵行的版本
  pi.on('message_end', (event) => {
    if (event.message.role !== 'assistant') return
    const { message, guess } = stripGuess(event.message)
    pendingGuess = guess
    if (message !== event.message) return { message }
  })

  // 3. 落地：只有本轮真正收尾时才写编辑器，带工具调用的中间轮不会触发
  pi.on('agent_settled', (event, ctx) => {
    const guess = pendingGuess
    pendingGuess = undefined
    if (!guess || event.aborted) return
    // 非交互模式没有可填的编辑器
    if (!ctx.hasUI || ctx.mode !== 'tui') return
    // 用户已经在打字时不覆盖
    if (ctx.ui.getEditorText() !== '') return
    ctx.ui.setEditorText(guess)
  })
}
