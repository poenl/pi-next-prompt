# AGENTS.md

pi 扩展：本轮回复结束后猜一句用户接下来会说的话，填入编辑器。猜测由本轮回复顺带产出
（末尾哨兵行 `NEXT_PROMPT: ...`），无额外模型调用；该行在进入 agent 状态、磁盘、UI 之前被摘除。

## 项目结构

- src/index.ts：`stripGuess`（解析 + 摘除）+ 三个事件接线（`before_agent_start` /
  `message_end` / `agent_settled`）+ 系统提示约定段 `RULE`
- tests/next-prompt.test.ts：`stripGuess` 的解析用例

## 常用命令

- pnpm check：tsc + eslint（必须全绿）
- pnpm test：vitest（必须全绿）
- pnpm format：prettier 写格式

## 行为要点

- 哨兵标记 `NEXT_PROMPT:`，只认最后一段文本块里的最后一次出现，其后内容丢弃
- 摘除走 `message_end` 返回同 role 替换消息：agent 状态、落盘、UI 三处同时生效（真删）
- 写入编辑器只在 `agent_settled`（本轮真正收尾）、`aborted` 为假、`ctx.mode === 'tui'`、
  且编辑器为空时；编辑器有内容不覆盖
- 每条 assistant 消息结束都会覆盖暂存 `pendingGuess`，`session_start` 清空
- 模型不照做时表现为"这轮没有建议"，不报错
