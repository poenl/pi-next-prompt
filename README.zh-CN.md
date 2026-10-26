**简体中文** | [English](README.md)

# pi-next-prompt

pi 扩展：本轮回复结束后，猜一句你接下来会说的话，填进编辑器。

## 效果

模型在最终回复末尾多写一行：

```text
……正文……

NEXT_PROMPT: 帮我把这个测试补上
```

这一行在写进 agent 状态、落盘和 UI 之前就被摘掉，正文里看不到它；猜测由编辑器接收：

```text
> 帮我把这个测试补上
```

## 安装

从 git 仓库安装：

```bash
pi install git:github.com/poenl/pi-next-prompt
```

临时试用（仅当前进程，不写 settings）：

```bash
pi -e git:github.com/poenl/pi-next-prompt
```

## 工作原理

猜测由本轮回复顺带产出，全程不额外调用模型、不追加往返。七个时点各司其职：

| 时机           | 动作                                                                         |
| -------------- | ---------------------------------------------------------------------------- |
| 回复开始前     | 往系统提示追加约定，让模型在最终回复末尾单独一行写猜测                       |
| 流式期间       | 显示层遮挡哨兵及其后内容（只影响渲染）                                       |
| 每条消息定稿时 | 抠出猜测并从消息里真删该行（agent 状态 / 落盘 / UI 同步）                    |
| 本轮收尾时     | 编辑器为空时把暂存的猜测写进编辑器；同时存进当前会话（这轮没猜就存一条空值） |
| 打开会话时     | 读回当前分支上存的最后一条猜测                                               |
| 切换分支后     | 再读一次，因为 `/tree` 导航不会触发会话启动                                  |
| 快捷键         | 编辑器为空时填入最近一次猜测（默认 `shift+right`）                           |

## 配置

配置文件：`~/.pi/agent/extensions/pi-next-prompt/config.json`。

```json
{
  "guessIntent": "optional",
  "autoFill": true,
  "shortcut": "shift+right"
}
```

| `guessIntent` | 你会得到什么                             |
| ------------- | ---------------------------------------- |
| `optional`    | 模型没把握时，这轮可能没有建议（默认）   |
| `always`      | 每轮结束都给一句，可能出现不着边际的建议 |

| `autoFill` | 是否自动把猜测填进编辑器           |
| ---------- | ---------------------------------- |
| `true`     | 收尾且编辑器为空时自动填入（默认） |
| `false`    | 只保留猜测，由快捷键手动填入       |

| `shortcut`    | 把猜测填入空编辑器的按键             |
| ------------- | ------------------------------------ |
| `shift+right` | 默认值；与 pi 的所有默认按键都不冲突 |
| 其它键名      | 如 `f2`、`alt+right`                 |

把 `shortcut` 设为 `false` 即可关闭快捷键。

配置文件在扩展加载时读一次，改动后需要重启 pi。文件缺失或 JSON 坏时整体取默认值；单个字段不合法时只回退该字段。

## 事件

本轮确实产出可用的猜测时，扩展会在 pi 的事件总线上发一个事件：

```ts
pi.events.on('pi-next-prompt:guess', (data) => {
  const { guess } = data as { guess: string | undefined }
})
```

通道为 `pi-next-prompt:guess`，三处会发：本轮收尾且产出了猜测之后、打开会话读回之后、切换分支读回之后。payload 为 `{ guess: string | undefined }`：读不到猜测时发 `undefined`，订阅方可据此清掉正在显示的内容。与 `autoFill` 是否开启无关。

## 不生效的情形

- 末尾没有哨兵行 —— 这轮没有建议，不报错
- 本轮被中断（`aborted`）—— 不填编辑器，但猜测仍存进会话
- `autoFill` 为 `false` —— 只保留猜测，不动编辑器
- 非 `tui` 模式 —— 没有可填的编辑器
- 编辑器已有内容 —— 不覆盖
- 还没有任何猜测时按快捷键 —— 无动作
- 新会话开始 —— 清空上一条暂存，改为读取该会话里存的猜测
- 切到没有存过猜测的分支 —— 发 `{ guess: undefined }`，不填任何内容

## 命令

```bash
pnpm check    # tsc --noEmit && eslint
pnpm test     # vitest run
pnpm format   # prettier --write
```

## 目录

```text
src/index.ts               扩展入口：stripGuess / hideGuess / latestGuess + pi 事件接线 + rule(intent)
tests/next-prompt.test.ts  stripGuess、hideGuess、latestGuess、parseConfig、rule 的用例
```
