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

模型没照做时表现为「这轮没有建议」，不报错。

## 安装

package.json 中已声明 `pi` 清单（`extensions: ["./src"]`），从 git 仓库安装即可长期全局生效：

```bash
pi install git:github.com/poenl/pi-next-prompt
```

临时试用（仅当前进程，不写 settings）：

```bash
pi -e git:github.com/poenl/pi-next-prompt
```

## 工作原理

猜测由本轮回复顺带产出，全程不额外调用模型、不追加往返。四个时点各司其职：

| 时点                 | 动作                                                      |
| -------------------- | --------------------------------------------------------- |
| `before_agent_start` | 往系统提示追加约定，让模型在最终回复末尾单独一行写猜测    |
| 流式期间             | 显示层遮挡哨兵及其后内容（只影响渲染）                    |
| `message_end`        | 抠出猜测并从消息里真删该行（agent 状态 / 落盘 / UI 同步） |
| `agent_settled`      | 本轮确实收尾、编辑器为空时，把暂存的猜测写进编辑器        |

## 不生效的情形

- 末尾没有哨兵行 —— 这轮没有建议，不报错
- 本轮被中断（`aborted`）—— 不填
- 非 `tui` 模式 —— 没有可填的编辑器
- 编辑器已有内容 —— 不覆盖
- 新会话开始 —— 清空上一条暂存，不跨会话误填

## 命令

```bash
pnpm check    # tsc --noEmit && eslint
pnpm test     # vitest run
pnpm format   # prettier --write
```

## 目录

```text
src/index.ts               扩展入口：stripGuess / hideGuess + 四个事件接线 + 系统提示约定段
tests/next-prompt.test.ts  stripGuess 与 hideGuess 的用例
```
