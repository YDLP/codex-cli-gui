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

## Recipe: render file changes (the top gap)

Codex already emits the data; nothing renders it. Verified payload shape from a real
rollout:

```json
{"type":"event_msg","payload":{"type":"item_completed","item":{
  "type":"FileChange","id":"exec-...","status":"completed",
  "changes":{
    "C:\\path\\to\\file.md":{"type":"update","unified_diff":"@@ -3,8 +3,7 @@\n ..."}
  },
  "stdout":"Success. Updated the following files:\nM ...",
  "stderr":""
}}}
```

`type` is `update`, `add` or `delete`. Steps:

1. **`rollout.cjs`** — in `replayItem()`, handle `FileChange` the way `CommandExecution`
   is handled, returning `{kind:'filechange', item}`. Add a fixture line and a
   `check-rollout-replay.cjs` assertion.
2. **`bridge.cjs`** — nothing to do; `item.completed` is already forwarded verbatim.
3. **`index.html`** — write `addFileChange(item)` next to `addCmd()`. Insert it with
   `insertBeforeAgentRow()` so it lands **above** the reply bubble, and give it
   `details`/`summary` inside the existing `.cmd-group` so it folds with the other
   tool activity (`ensureToolGroup()` / `setToolGroupLive()`).
4. **Diff rendering** — `unified_diff` is plain text. Parse `@@` hunks and emit
   `<div class="dl">` lines with `+`/`-`/` ` prefixes via `textContent`. **Do not use
   `innerHTML`.**
5. **Tests** — extend the fixture with one `update`, one `add`, one `delete`; assert the
   card count, that the file name is shown, that a `+` line and a `-` line both exist,
   and that a path containing `<script>` renders as text.
6. **Both `check-ui.cjs` and `check-live.cjs`** should learn about it.

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
