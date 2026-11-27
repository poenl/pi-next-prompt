# AGENTS.md

pi 扩展：本轮回复结束后猜一句用户接下来会说的话，填入编辑器。猜测由本轮回复顺带产出
（末尾哨兵行 `NEXT_PROMPT: ...`），无额外模型调用；该行在进入 agent 状态、磁盘、UI 之前被摘除。

## 项目结构

- src/index.ts：`stripGuess`（解析 + 摘除）+ 四个事件接线（`before_agent_start` /
  `message_end` / `agent_settled` / `session_start`、`session_tree`）+ 系统提示约定段 `RULE`
  - 输入框上方提示行（`showSuggestion`）
- tests/next-prompt.test.ts：`stripGuess` 与配置解析的用例、事件接线用例

## 常用命令

- pnpm check：tsc + eslint（必须全绿）
- pnpm test：vitest（必须全绿）
- pnpm format：prettier 写格式

## 行为要点

- 哨兵标记 `NEXT_PROMPT:`，只认最后一段文本块里的最后一次出现，其后内容丢弃
- 摘除走 `message_end` 返回同 role 替换消息：agent 状态、落盘、UI 三处同时生效（真删）
- 写入编辑器只在 `agent_settled`（本轮真正收尾）、`aborted` 为假、`ctx.mode === 'tui'`、
  且编辑器为空时；编辑器有内容不覆盖
- 提示行是否显示只看三件事：`showSuggestion` 开着、有预测、编辑器内容不等于该预测；
  相等就渲染为空。比较放在组件渲染里，每帧读一次编辑器内容，没有变更事件也能跟随输入
- 本轮没有新预测时保留上一条（不清空），会话恢复或切分支读回的状态覆盖它
- 提示行用自定义组件渲染：淡灰（muted 主题色）+ `›`；主题色在渲染时取，换主题不会留旧色
- 每条 assistant 消息结束都会覆盖暂存 `pendingGuess`，`session_start` 清空
- 模型不照做时表现为"这轮没有建议"，不报错
