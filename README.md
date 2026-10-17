# Codex GUI

**English** · [简体中文](README.zh-CN.md)

A local, browser-based GUI for the [Codex CLI](https://github.com/openai/codex) — no desktop app required.

![screenshot](docs/screenshot.png)

## Why this exists

The official Codex desktop app does not run on every machine. In my case the work
laptop runs Windows 10 build 18363, which the installer does not support, and using
the raw CLI for a long conversation is painful: you lose scrollback, you cannot
easily re-open an old session, and attachments are awkward.

So this is a thin local web UI on top of the CLI you already have. It does not
re-implement the model, does not proxy your traffic, and does not phone home. It
spawns `codex exec --json`, reads the JSONL, and renders it.

If your system is supported by the official app, use the official app — it is
better. This exists for the machines that fall through the cracks.

## Features

- **Chat with the Codex CLI** — Enter sends, Shift+Enter newlines, IME-safe
- **Session list** — continue, rename, delete past sessions, history replayed from disk
- **Model + reasoning-effort pickers** — read from the CLI's own catalog
- **Permission modes** — read-only / workspace-write / full-access, switchable per session
- **Attachments** — images go in as images, everything else is handed over by path
- **Tool activity as collapsible cards** — commands, exit codes, web searches and **file changes with diffs**, grouped per turn
- **Context meter** — how full the window is, plus an inferred "possible compaction" marker
- **Native folder picker**, three themes, windowless detached launcher
- **Zero runtime dependencies** — Node built-ins only; no `npm install` needed

## Requirements

- Node.js **22+**
- Codex CLI installed and logged in (`codex` on `PATH`, or set `CODEX_GUI_CODEX_PATH`)
- Windows is the primary target. macOS and Linux should work; the launcher scripts
  (`.cmd` / `.vbs` / shortcut setup) are Windows-only.

## Quick start

```powershell
node launch.cjs
```

That starts the bridge on <http://127.0.0.1:8790> and opens your browser. It only
ever listens on `127.0.0.1`.

### Run it in the background (Windows)

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File setup-shortcut.ps1
```

Double-click **Codex GUI**. It launches with **no console window at all** and
detaches, so closing any window will not stop the service. Stop it with the
**Codex GUI (stop)** shortcut, or:

```powershell
cmd /c "stop-codex-gui.cmd --no-pause"
```

That reports what it stopped and which port was released. It refuses to kill a
process that merely happens to own the port — the holder must actually be
`bridge.cjs`.

### Run it in the foreground

`start-codex-gui.cmd` (or `node launch.cjs`) keeps the service attached to its
console: closing the window stops it, and the log prints right there. Use this mode
when something is wrong.

## Configuration

Settings live in `settings.json` next to the code (created on first save). Copy
`settings.example.json` to get started. It is git-ignored, because it holds your
working directory and proxy.

| Environment variable | Purpose |
|---|---|
| `CODEX_GUI_PORT` | HTTP port, default `8790` |
| `CODEX_GUI_NO_BROWSER=1` | Do not open a browser on start |
| `CODEX_GUI_CODEX_PATH` | Path to the Codex executable or `codex.js` |
| `CODEX_GUI_SETTINGS_FILE` | Use a different settings file (tests do this) |
| `CODEX_GUI_DETACH=1` | Same as `launch.cjs --detach` |
| `CODEX_HOME` | Use Codex's own config/auth/session directory |

### Permission modes

| Option | Behaviour |
|---|---|
| Read-only | `-s read-only` |
| Workspace write | `--approve-for-me` — writes inside the workspace, reviewed automatically |
| Full access | `-s danger-full-access` — no sandbox |

A resumed session keeps the sandbox it was created with; the CLI will not let a
later invocation widen it. The GUI restores the original mode and the bridge rejects
a mismatched resume, so pick the mode when you create the session.

### Proxy

The proxy field is injected as `HTTPS_PROXY` / `HTTP_PROXY` into the Codex child
process only. **It is never written to the Windows system proxy settings.** Leave it
empty to pass the environment through untouched.

## How it works

```
browser  ──HTTP/SSE──▶  bridge.cjs  ──spawn──▶  codex exec --json
                            │                        │
                            │◀─── JSONL events ──────┘
                            │
                            └──▶ app-server (stdio) ──▶ session list / rename / delete
```

- One `codex exec --json` process per turn; events are forwarded over SSE as they arrive.
- Session metadata comes from a **private stdio app-server** connection, because the
  rollout files alone cannot rename or delete a thread.
- History is replayed from `~/.codex/sessions/**/*.jsonl`, including command
  executions, reasoning items and web searches.

## Known limitations

Properties of the CLI, not bugs. Documented so nobody hunts for a setting that does
not exist:

- **No token-level streaming.** `codex exec --json` is turn-based: it emits
  `item.completed` for a whole message, never deltas. Real streaming exists only in
  the app-server protocol, which this project deliberately avoids (see below). A
  reply therefore appears all at once at the end of a turn.
- **Reasoning summaries are empty.** Every model in the catalog reports
  `default_reasoning_summary = "none"`, so Reasoning items arrive with empty
  `summary_text` and `raw_content` (verified against real rollouts: 102 items, all
  empty). The UI has no reasoning toggle on purpose.
- **Context usage only updates at the end of a turn**, for the same reason: `usage`
  arrives once, in `turn.completed`. While a turn runs the meter is marked "上一轮"
  (previous turn) rather than pretending to be live.
- **No app-server turn execution.** Calling `thread/resume` or `thread/read` takes a
  writer lock on the thread and never releases it, which bricks later
  `codex exec resume` with `thread-store conflict`. Only read-only metadata calls are
  used.
- **Compaction is inferred, not reported.** `codex exec --json` has no compaction
  event, so the GUI flags a large drop in context usage as "possibly compacted".
- **A live file change carries no diff.** The live event gives only
  `changes: [{ path, kind }]`; the `unified_diff` is written to the rollout file
  separately. So during a turn you see *which* files changed, and the diff itself
  appears when the session is replayed (a page refresh, or reopening it). Verified
  against a real turn — this is a property of the event, not a shortcut here.

## Known gaps — good first contributions

This was built in a few days for one person's workflow. There are real holes. If you
want to use this as a baseline, these are honest starting points, roughly by value:

| Gap | Where | Why it matters |
|---|---|---|
| **No session search or filter** | `index.html` session list | Once you have 50 sessions you scroll. |
| **No export** | — | Copying a whole conversation out as Markdown is not possible. |
| **No side-by-side diff view** | `index.html` (`diffNode`) | Diffs render as unified text; there is no split view or syntax highlighting. |
| **Multi-tab coordination** | `bridge.cjs` | Two tabs on the same session race; there is a 409 guard but no shared state. |
| **Few keyboard shortcuts** | `index.html` | Enter / Shift+Enter / Escape only. |
| **Model catalog is static** | `models.json`, `extract-models.cjs` | Needs `node extract-models.cjs` when the CLI ships new models. |
| **No mac/Linux launchers** | — | `launch.cjs` works; the `.cmd` / `.vbs` / shortcut scripts do not. |
| **No cost aggregation** | — | Per-turn tokens are shown; nothing sums across sessions. |

Calling `thread/resume` or `thread/read` to get streaming is the one thing that will
**break sessions** — read the limitation above before trying.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the code map, the testing bar, and the
traps that already cost time.

## Testing

```powershell
npm.cmd test        # 26 unit tests: args, HTTP, attachments, processes, RPC, replay
node check-ui.cjs   # 26 checks driving a real headless browser over CDP
node check-live.cjs # 23 assertions against the served page
```

The browser test starts its own bridge with a temporary settings file and a fake
Codex CLI, so it never calls a paid model and never touches your real sessions.
Screenshots land in `.codex-gui/review-ui.png`.

Set `CODEX_GUI_BROWSER_PATH` to choose which Chromium-based browser to drive.

## Layout

| File | Purpose |
|---|---|
| `index.html` | The whole UI. Single file, no external resources. |
| `bridge.cjs` | HTTP server, attachments, Codex execution, SSE |
| `codex-process.cjs` | Shell-free spawning, proxy env, process-tree kill |
| `appserver.cjs` | Private stdio RPC for session metadata |
| `rollout.cjs` | History replay, last-call usage, attachments |
| `launch.cjs` | Health check, detach mode, browser opening |
| `start-hidden.vbs` / `stop-codex-gui.cmd` | Windowless start / stop |
| `setup-shortcut.ps1` | Desktop shortcuts |
| `REVIEW.md` | Engineering notes: what broke, why, and how it was verified |

## Security notes

- Binds `127.0.0.1` only; `Host` and `Origin` are validated on every request.
- The UI never writes model output as HTML — the Markdown renderer builds DOM nodes
  and uses `textContent`, with a test asserting an XSS payload injects nothing.
- Attachment filenames are sanitised and written into
  `<cwd>/.codex-gui/attachments/<batch>/`.

## Credits

Built by **YDLP** together with an AI coding agent (DeepSeek Harness, running
`deepseek-flash`).

The agent wrote the implementation, the tests, and most of this documentation. The
human set the direction, used it for real work, and found the bugs no test would
have: commands vanishing after a refresh, a jump rail that could only scroll one
way, a permission dropdown that was silently ignored, and a stale PID file that
could kill an unrelated process. `REVIEW.md` records those failures — including the
wrong turns — because a baseline is more useful when it says what already hurt.

## License

MIT — see [LICENSE](LICENSE).
