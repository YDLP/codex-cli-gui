# Contributing

**English** · [简体中文](CONTRIBUTING.zh-CN.md)

Thanks for looking. This project was built in a few days for one person's workflow,
so it is deliberately small and there is plenty of room. This file is the shortest
path to changing it without breaking the things that were hard to get right.

## Ground rules

1. **Every fix needs a test that would have failed before it.** The test suite exists
   because several bugs were "fixed" two or three times while still broken. If you
   cannot write a failing test first, describe the manual reproduction in the PR.
2. **Keep the runtime dependency count at zero.** Node built-ins only. This is what
   makes `node launch.cjs` work with no install step.
3. **Do not trust a green test suite over a real run.** The nastiest bugs here were
   invisible to unit tests and obvious in five seconds of real use.
4. `REVIEW.md` is the engineering log. When you fix something subtle, add an entry —
   including the wrong turns.

## Code map

| File | What lives there |
|---|---|
| `index.html` | Everything the browser runs. Markdown rendering, tool cards, jump rail, session list, settings drawer. No build step, no external assets. |
| `bridge.cjs` | HTTP routes, request validation, attachment staging, spawning turns, SSE framing, settings persistence. |
| `codex-process.cjs` | `codexInvocation()` (finding the binary), `proxyEnv()` (proxy injection), `spawnCodex()`, `killTree()`. |
| `appserver.cjs` | Private stdio JSON-RPC to `codex app-server` for session list/rename/delete. |
| `rollout.cjs` | Parses `~/.codex/sessions/**/*.jsonl`: messages, command executions, reasoning, web searches, usage, attachments. |
| `launch.cjs` | Health check, reuse detection, `--detach` background mode. |
| `check-ui.cjs` | Real browser (CDP) driven checks. The most valuable file in the repo. |
| `test/fixtures/fake-codex.cjs` | A fake Codex CLI that emits real-shaped JSONL **and** writes a matching rollout. |

### Hot spots

- `index.html` → `renderMarkdownInto()` — the DOM-building Markdown renderer.
- `index.html` → `addCmd()` / `addWebSearch()` / `addReasoning()` — tool items.
- `index.html` → `toolRow()` / `ensureToolGroup()` / `collapseToolCards()` — the per-turn tool card.
- `index.html` → `updateJumpActive()` / `onRailWheel()` — the jump rail.
- `bridge.cjs` → `handleLine()` — where Codex JSONL becomes SSE frames.

## The traps

Each of these cost real time. Please do not undo them.

### Never call `thread/resume` or `thread/read`

They take a **writer lock on the thread and never release it**. After that, any
`codex exec resume <id>` fails with `thread-store conflict: ... already has an active
writer`, and the session is unusable. `appserver.cjs` is restricted to read-only
metadata calls (`thread/list`, `thread/name/set`, `thread/delete`) for this reason.

If you want streaming, the app-server protocol does have `item/agentMessage/delta` —
but proving it is safe means running a turn through app-server and then verifying
`codex exec resume` still works. Do that experiment before writing code.

### Never render model output with `innerHTML`

`renderMarkdownInto()` builds DOM nodes and sets `textContent`. A test feeds an
`<img src=x onerror=...>` payload and asserts zero injected elements and zero
execution. Keep it that way.

### `codex exec` argument quirks

- There is **no `-a` / `--ask-for-approval` flag** on `codex exec`.
- `--approve-for-me` implies `workspace-write` and **conflicts with `-s`**.
- `-s workspace-write` alone cannot write in non-interactive mode (no approver).
  That is why `PERMISSION_MODES` in `bridge.cjs` maps to whole *flag sets*.
- A resumed turn rejects `-s` and `--approve-for-me`, but accepts
  `-c sandbox_mode="..."`.
- There is no `--search`; web search is `-c web_search="live"`.
- Reasoning summaries need `-c model_reasoning_summary="auto|concise|detailed|none"`.
  Default for every catalog model is `none`, so items are empty.

### Never pass a prompt through `cmd /c`

`cmd` mangles argv (newlines, quotes, trailing flags). `codex-process.cjs` spawns the
executable directly with `shell: false`, and **prompts go in on stdin** (`-`), not in
argv. Attachments rely on this too.

### Never kill a process by PID file alone

Windows reuses PIDs. A stale `.codex-gui/bridge.pid` after a reboot can point at an
unrelated program — verified: it killed an innocent `node` process. `stop-codex-gui.cmd`
now resolves the **port holder**, verifies its command line contains `bridge.cjs`, and
only then kills.

### `.cmd` and `.vbs` must stay ASCII

Windows PowerShell 5.1 and `cmd.exe` read BOM-less scripts in the system ANSI codepage.
Non-ASCII breaks parsing on some machines. Also: `echo [!!]` inside
`enabledelayedexpansion` **destroys later `!VAR!` expansion** — use `[WARN]`.

### Restart rules

`index.html` is read from disk **on every request** → edit and refresh.
`bridge.cjs`, `appserver.cjs`, `rollout.cjs`, `codex-process.cjs` are loaded once →
**must restart the service**. The status line shows how long the service has been up
so you can tell which code you are looking at.

### Test fixtures must agree with themselves

`test/fixtures/fake-codex.cjs` emits `turn.completed` **and** writes a rollout with a
matching `token_usage_record`. The bridge prefers rollout numbers, so if the two
disagree the test measures the wrong thing.

## How file changes are implemented (and how to extend it)

Codex emits file changes in **two different shapes**, and both reach the UI. This is
the single most confusing part of the codebase, so it is written down here.

```jsonc
// LIVE: `codex exec --json`, item.type is snake_case. NO diff content.
{"type":"item.completed","item":{
  "id":"item_2","type":"file_change","status":"completed",
  "changes":[{"path":"C:\\path\\to\\file.md","kind":"update"}]
}}

// ROLLOUT: ~/.codex/sessions/**.jsonl, item.type is CamelCase. HAS the diff.
{"type":"event_msg","payload":{"type":"item_completed","item":{
  "type":"FileChange","id":"exec-...","status":"completed",
  "changes":{
    "C:\\path\\to\\file.md":{"type":"update","unified_diff":"@@ -3,8 +3,7 @@\n ...","move_path":null}
  },
  "stdout":"Success. Updated the following files:\nM ...","stderr":""
}}}
```

So: **during a turn you can only show *which* files changed. The diff exists only
after the turn, in the rollout.** That is a property of the event, verified by
running a real turn — not a shortcut.

The pipeline:

| Stage | What it does |
|---|---|
| `rollout.cjs` → `replayItem()` | Reads the CamelCase shape, normalises `changes` into an array of `{ path, type, unified_diff }`, caps the total diff length with `maxChars`. |
| `index.html` → `normalizeFileChanges()` | Accepts **both** shapes: array entries use `kind`/`type` interchangeably, and `diff`/`unified_diff`. |
| `index.html` → `fileChangeBody()` | One `<details class="cmd filechg">` per event, one row per path, plus a diff block when there is one. |
| `index.html` → `diffNode()` | Splits the diff into `<div class="dl">` rows, coloured via `.add` / `.del` / `.hunk` / `.meta`. **`textContent` only.** |
| `index.html` → `addFileChange()` | Drops it into the turn's `.cmd-group`, above the reply, same folding rules as commands. |

Gotchas that will bite you:

- **`dataset.exit` must be set.** The group header counts cards by it (`''` running,
  `'0'` ok, anything else failed). Leaving it unset made every file change show up as
  a *failed* tool: `工具 5 条 · 1 条失败`.
- **Live item ids repeat every turn** (`item_1`, `item_2`, ...) because each turn is a
  new process. `commandCards` is therefore cleared per exchange in `addTurnDivider`'s
  path (`clearTurnCards()`); without that, turn 2 replaced turn 1's card.
- **Paths must be rendered as text.** The fixture includes a path containing
  `<script>alert(1)</script>` and the test asserts zero injected elements.

Extending it: a side-by-side view would replace `diffNode()` only — the normaliser and
the card already carry everything needed.

## Workflow

```powershell
node --check bridge.cjs           # syntax before anything else
npm.cmd test                      # 26 unit tests
node check-ui.cjs                 # real browser, 26 checks
node check-live.cjs               # served-page assertions
node check-rollout-replay.cjs
node check-rollout-attach.cjs
```

Browser checks start their own bridge on a random port with a temporary settings file
and the fake CLI, so they are safe to run repeatedly. Run `check-ui.cjs` two or three
times — flakiness here has historically meant a real race, not a bad test.

## Style

- Plain CommonJS, no transpiler, no bundler.
- Comments explain **why**, especially for the non-obvious workarounds.
- Chinese UI strings, English code and comments.
- Keep `index.html` single-file; it is what makes "no install" true.

## Reporting a bug

Include: your Node and Codex versions, the mode (permission), whether the service was
restarted, and what the status line said. If a command or file change is involved,
paste the relevant JSONL line from `~/.codex/sessions/` — the events are the ground
truth.
