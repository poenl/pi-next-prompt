import { describe, expect, test } from 'vitest'

import type { ExtensionAPI, MessageEndEvent } from '@earendil-works/pi-coding-agent'

import nextPrompt, { hideGuess, parseConfig, rule, stripGuess } from '../src/index'

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

  test('哨兵之后的工具调用块保留，否则后续工具结果失去配对的调用', () => {
    const base = assistant('正文\nNEXT_PROMPT: 猜测')
    const toolCall = { type: 'toolCall', id: 'call-1', name: 'bash', arguments: {} }
    const withTool = {
      ...base,
      content: [...base.content, toolCall]
    } as unknown as AssistantMessage
    const { message, guess } = stripGuess(withTool)
    expect(guess).toBe('猜测')
    expect(message.content).toEqual([{ type: 'text', text: '正文' }, toolCall])
  })

  test('哨兵独占整条消息时正文为空，不留下空文本块', () => {
    const { message, guess } = stripGuess(assistant('NEXT_PROMPT: 只有猜测'))
    expect(guess).toBe('只有猜测')
    expect(message.content).toEqual([])
  })
})

describe('parseConfig', () => {
  test('取出约定强度、自动填充开关与快捷键', () => {
    expect(parseConfig('{ "guessIntent": "always", "autoFill": false, "shortcut": "f2" }')).toEqual(
      { guessIntent: 'always', autoFill: false, shortcut: 'f2' }
    )
  })

  test('字段缺失或取值非法时只回退该字段', () => {
    expect(parseConfig('{ "guessIntent": "always" }')).toEqual({
      guessIntent: 'always',
      autoFill: true,
      shortcut: 'shift+right'
    })
    expect(parseConfig('{ "guessIntent": "high", "autoFill": "yes", "shortcut": "F2 " }')).toEqual({
      guessIntent: 'optional',
      autoFill: true,
      shortcut: 'shift+right'
    })
  })

  test('快捷键只做宽松校验，合法键名原样保留', () => {
    expect(parseConfig('{ "shortcut": "ctrl+g" }').shortcut).toBe('ctrl+g')
    expect(parseConfig('{ "shortcut": "alt+pageUp" }').shortcut).toBe('alt+pageUp')
  })

  test('快捷键为空串或含空白时退回默认键', () => {
    expect(parseConfig('{ "shortcut": "" }').shortcut).toBe('shift+right')
    expect(parseConfig('{ "shortcut": "F2 " }').shortcut).toBe('shift+right')
  })

  test('shortcut 为 false 表示不注册快捷键', () => {
    expect(parseConfig('{ "shortcut": false }').shortcut).toBeUndefined()
    expect(parseConfig('{ "shortcut": 0 }').shortcut).toBe('shift+right')
  })

  test('JSON 坏时整体退回默认值', () => {
    expect(parseConfig('不是 JSON')).toEqual({
      guessIntent: 'optional',
      autoFill: true,
      shortcut: 'shift+right'
    })
  })
})

describe('rule', () => {
  test('两档都含哨兵行，且互不相同', () => {
    const texts = [rule('optional'), rule('always')]
    for (const text of texts) expect(text).toContain('NEXT_PROMPT:')
    expect(new Set(texts).size).toBe(2)
  })

  test('只有 optional 保留「没把握就别写」', () => {
    expect(rule('optional')).toContain('or are not confident')
    expect(rule('always')).toContain('even if you are not confident')
  })
})

describe('hideGuess', () => {
  test('完整哨兵及其后的猜测一并截掉', () => {
    expect(hideGuess('正文\nNEXT_PROMPT: 猜测内容')).toBe('正文\n')
  })

  test('哨兵只出了半截时按行首锚定吞掉，不闪现', () => {
    expect(hideGuess('正文\nNEXT')).toBe('正文\n')
  })

  test('哨兵写在正文同一行时，半截前缀也一并吞掉', () => {
    expect(hideGuess('正文 NEXT')).toBe('正文 ')
  })

  test('前缀不成立即恢复，正文原样保留', () => {
    expect(hideGuess('正文 NEXTX')).toBe('正文 NEXTX')
  })

  test('已知代价：正文末尾恰好构成哨兵前缀时被吞，前缀一破即恢复', () => {
    expect(hideGuess('正文 N')).toBe('正文 ')
    expect(hideGuess('正文 NX')).toBe('正文 NX')
  })

  test('没有哨兵时原样返回', () => {
    expect(hideGuess('只有正文')).toBe('只有正文')
  })

  test('多次出现时取最后一次', () => {
    expect(hideGuess('NEXT_PROMPT: 假的\n正文')).toBe('')
  })
})

describe('接线', () => {
  /** 只实现本扩展用到的四个方法的假 ExtensionAPI，用来跑一遍事件接线 */
  function fakePi() {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>()
    const emitted: Array<{ channel: string; data: unknown }> = []
    const api = {
      on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
        handlers.set(name, handler)
        return () => {}
      },
      registerShortcut: () => {},
      registerMarkdownTransformer: () => {},
      events: {
        emit: (channel: string, data: unknown) => emitted.push({ channel, data }),
        on: () => () => {}
      }
    }
    return { api: api as unknown as ExtensionAPI, handlers, emitted }
  }

  const ctx = {
    hasUI: true,
    mode: 'tui',
    ui: { getEditorText: () => '', setEditorText: () => {} }
  }

  test('本轮产出猜测时发事件，中断时不发', () => {
    const { api, handlers, emitted } = fakePi()
    nextPrompt(api)

    const end = handlers.get('message_end')!
    const settled = handlers.get('agent_settled')!

    end({ message: assistant('正文\nNEXT_PROMPT: 猜测内容') }, ctx)
    settled({ aborted: false }, ctx)
    expect(emitted).toEqual([{ channel: 'pi-next-prompt:guess', data: { guess: '猜测内容' } }])

    emitted.length = 0
    end({ message: assistant('正文\nNEXT_PROMPT: 第二轮') }, ctx)
    settled({ aborted: true }, ctx)
    expect(emitted).toEqual([])
  })
})
