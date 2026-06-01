# Pi Extensions

A collection of custom extensions for [pi](https://pi.dev).

## Extensions

### `chat-history-autocomplete`

Tab-completes words from your chat history. More recent words appear first.

- Uses incremental indexing — each new message is added immediately, no full branch walk
- Two-level map: first character (lowercase) buckets the lookup, then the inner map keeps words case-sensitive
- Falls through to built-in `@` file and `/` command completions when no history match is found
- Seeds the index from existing session history on `session_start` so resumed sessions work out of the box

**Example:** if the assistant mentions `MyComponentClass` in the last message, typing `my` + Tab will suggest it first.

### `edit-confirmation`

Pops a confirmation dialog before the model runs `edit`, `write`, or `bash` tool calls.

- **`edit` / `write`:** always asks before modifying files
- **`bash`:** asks unless the command is whitelisted. Default whitelist: `grep`, `find`, `ls`, `cat`, `node --test`, `git diff`
- Silently allows all through in non-interactive modes (print, RPC) where there's no UI to confirm

## Install

```bash
# From git
pi install git:github.com/RangerMauve/pi-extensions

# Or directly from a local clone
pi install git:file:///path/to/pi-extensions
```

Then verify with:

```bash
pi list
pi config
```

## Add your own

Drop a new `.ts` file into `extensions/` — pi auto-discovers all TypeScript modules in that directory. No rebuild needed.
