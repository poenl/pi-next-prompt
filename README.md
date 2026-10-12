# pi-next-prompt

pi 扩展：AI 本轮回复结束后，猜一句用户接下来可能会说的话，填进编辑器。

猜测由**当前这轮回复顺带产出**（末尾一行 `NEXT_PROMPT: ...`），不额外调用模型、不追加
往返；该行在写进 agent 状态、落盘和 UI 之前就被摘掉，不会出现在上下文里。

## 目录

```text
src/                扩展入口
tests/              测试
eslint.config.mjs   ESLint flat config
```

## 加载

package.json 中已声明 `pi` 清单（`extensions: ["./src"]`），本地路径安装即可长期全局加载：

```bash
pi install /path/to/pi-next-prompt
```

临时试用（仅当前进程，不写 settings）：

```bash
pi -e /path/to/pi-next-prompt
```

## 命令

```bash
pnpm check    # tsc --noEmit && eslint
pnpm test     # vitest run
pnpm format   # prettier --write
```
