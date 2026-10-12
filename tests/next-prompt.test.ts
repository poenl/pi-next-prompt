import { describe, expect, test } from 'vitest'

import type { MessageEndEvent } from '@earendil-works/pi-coding-agent'

import { stripGuess } from '../src/index'

type AssistantMessage = Extract<MessageEndEvent['message'], { role: 'assistant' }>

/** 造一条只带文本块的 assistant 消息，其余字段用不到，只保证类型合法 */
function assistant(...texts: string[]): AssistantMessage {
  return {
    role: 'assistant',
    content: texts.map((text) => ({ type: 'text' as const, text })),
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'test',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 }
  } as unknown as AssistantMessage
}

describe('stripGuess', () => {
  test('摘掉末尾哨兵行，正文与猜测各归其位', () => {
    const { message, guess } = stripGuess(assistant('正文内容\nNEXT_PROMPT: 帮我加个测试'))
    expect(guess).toBe('帮我加个测试')
    expect(message.content).toEqual([{ type: 'text', text: '正文内容' }])
  })

  test('哨兵行之后的残句一并丢弃', () => {
    const { message, guess } = stripGuess(assistant('正文\nNEXT_PROMPT: 猜测内容\n不该留下的尾巴'))
    expect(guess).toBe('猜测内容')
    expect(message.content).toEqual([{ type: 'text', text: '正文' }])
  })

  test('没有哨兵时原样返回，猜测为空', () => {
    const original = assistant('只有正文')
    const { message, guess } = stripGuess(original)
    expect(guess).toBeUndefined()
    expect(message).toBe(original)
  })

  test('哨兵后没有内容时仍摘除，但不算一次有效猜测', () => {
    const { message, guess } = stripGuess(assistant('正文\nNEXT_PROMPT:'))
    expect(guess).toBeUndefined()
    expect(message.content).toEqual([{ type: 'text', text: '正文' }])
  })

  test('取最后一段文本里的哨兵，其后文本块被丢弃', () => {
    const { message, guess } = stripGuess(
      assistant('开头', '正文\nNEXT_PROMPT: 后面这段才是', '多余块')
    )
    expect(guess).toBe('后面这段才是')
    expect(message.content).toEqual([
      { type: 'text', text: '开头' },
      { type: 'text', text: '正文' }
    ])
  })

  test('哨兵独占整条消息时正文为空，不留下空文本块', () => {
    const { message, guess } = stripGuess(assistant('NEXT_PROMPT: 只有猜测'))
    expect(guess).toBe('只有猜测')
    expect(message.content).toEqual([])
  })
})
