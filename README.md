**English** | [简体中文](README.zh-CN.md)

# pi-next-prompt

A pi extension: after a turn ends, it guesses the sentence you are about to type and fills it into the editor.

## What you get

The model writes one extra line at the end of its final reply:

```text
…the answer…

NEXT_PROMPT: add a test for this
```

That line is stripped before it reaches agent state, disk, or the UI, so it never shows up in the transcript. The guess goes to the editor instead:

```text
> add a test for this
```

If the model does not comply, the result is simply "no suggestion this turn" — no error.

## Install

`package.json` already declares the `pi` manifest (`extensions: ["./src"]`), so installing from the git repository loads it globally for good:

```bash
pi install git:github.com/poenl/pi-next-prompt
```

Try it for a single invocation (current process only, nothing written to settings):

```bash
pi -e git:github.com/poenl/pi-next-prompt
```

## How it works

The guess is produced as a side effect of the same reply: no extra model call, no extra round trip. Four points do the work:

| Point                | Action                                                                                                |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| `before_agent_start` | Appends the convention to the system prompt, telling the model to put the guess on its own line       |
| while streaming      | Masks the sentinel and everything after it in the display layer (rendering only)                      |
| `message_end`        | Extracts the guess and truly deletes the line (agent state / disk / UI at once)                       |
| `agent_settled`      | Once the turn has actually finished and the editor is empty, writes the stashed guess into the editor |

## When it stays silent

- no sentinel line at the end — no suggestion this turn, no error
- the turn was interrupted (`aborted`) — nothing is filled
- not in `tui` mode — there is no editor to fill
- the editor already has content — it is never overwritten
- a new session starts — the previous stash is cleared, so nothing leaks across sessions

## Commands

```bash
pnpm check    # tsc --noEmit && eslint
pnpm test     # vitest run
pnpm format   # prettier --write
```

## Layout

```text
src/index.ts               entry: stripGuess / hideGuess + the four hooks + the system-prompt convention
tests/next-prompt.test.ts  cases for stripGuess and hideGuess
```
