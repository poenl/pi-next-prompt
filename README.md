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

## Install

Install from the git repository:

```bash
pi install git:github.com/poenl/pi-next-prompt
```

Try it for a single invocation (current process only, nothing written to settings):

```bash
pi -e git:github.com/poenl/pi-next-prompt
```

## How it works

The guess is produced as a side effect of the same reply: no extra model call, no extra round trip. Seven points do the work:

| When                     | Action                                                                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| before the reply         | Appends the convention to the system prompt, telling the model to put the guess on its own line                                                         |
| while streaming          | Masks the sentinel and everything after it in the display layer (rendering only)                                                                        |
| when a message ends      | Extracts the guess and truly deletes the line (agent state / disk / UI at once)                                                                         |
| when the turn ends       | Writes the stashed guess into the editor when the editor is empty, and stores it in the current session (a null record when the turn produced no guess) |
| when a session opens     | Reads back the last guess stored on the current branch                                                                                                  |
| when you switch branches | Reads it back again: `/tree` navigation does not start a session                                                                                        |
| shortcut                 | Fills the last guess into the editor when the editor is empty (default `shift+right`)                                                                   |

## Configuration

Configuration file: `~/.pi/agent/extensions/pi-next-prompt/config.json`.

```json
{
  "guessIntent": "optional",
  "autoFill": true,
  "shortcut": "shift+right"
}
```

| `guessIntent` | What you get                                                           |
| ------------- | ---------------------------------------------------------------------- |
| `optional`    | the turn may end with no suggestion when the model is unsure (default) |
| `always`      | every finished reply ends with a guess, even an off-target one         |

| `autoFill` | Whether the guess goes into the editor automatically             |
| ---------- | ---------------------------------------------------------------- |
| `true`     | write it when the turn settles and the editor is empty (default) |
| `false`    | only stash it; press the shortcut to fill it in                  |

| `shortcut`    | Key that fills the stashed guess into an empty editor |
| ------------- | ----------------------------------------------------- |
| `shift+right` | default; steers clear of every default key in pi      |
| any key id    | e.g. `f2`, `alt+right`                                |

Setting `shortcut` to `false` turns the shortcut off.

The file is read once, when the extension loads, so a change needs a pi restart. A missing file or broken JSON falls back to the defaults above; an invalid single field falls back for that field only.

## Events

When a settled turn produced a usable guess, the extension emits one event on pi's event bus:

```ts
pi.events.on('pi-next-prompt:guess', (data) => {
  const { guess } = data as { guess: string | undefined }
})
```

The channel is `pi-next-prompt:guess`. It fires in three places: after a settled turn that produced a guess, when a session opens and a guess is restored, and after switching branches. The payload is `{ guess: string | undefined }`: a restored branch with no guess emits `undefined`, so subscribers can clear whatever they were showing. Whether `autoFill` is on does not matter.

## When it stays silent

- no sentinel line at the end — no suggestion this turn, no error
- the turn was interrupted (`aborted`) — nothing is filled, but the guess is still stored in the session
- `autoFill` is `false` — the guess is stashed but the editor is left alone
- not in `tui` mode — there is no editor to fill
- the editor already has content — it is never overwritten
- the shortcut does nothing when no guess is stashed yet
- a new session starts — the previous stash is cleared and the guess stored in that session is loaded instead
- you switch to a branch with no stored guess — `{ guess: undefined }` is emitted and nothing is filled

## Commands

```bash
pnpm check    # tsc --noEmit && eslint
pnpm test     # vitest run
pnpm format   # prettier --write
```

## Layout

```text
src/index.ts               entry: stripGuess / hideGuess / latestGuess + the pi event wiring + rule(intent)
tests/next-prompt.test.ts  cases for stripGuess, hideGuess, latestGuess, parseConfig and rule
```
