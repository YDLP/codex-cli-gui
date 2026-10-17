#!/usr/bin/env node
/**
 * Codex GUI bridge
 * -----------------
 * A local web GUI in front of the Codex CLI. It exists because the official
 * Codex desktop app cannot be installed here, and because the Codex CLI does
 * not read the Windows system proxy -- this bridge injects a proxy for it.
 *
 * Design notes (all verified against codex-cli 0.162.1 on this machine):
 *   - Drives `codex exec --json`, NOT `app-server`. The app-server streaming
 *     transport times out on this network; `codex exec` is stable.
 *   - Emits Server-Sent Events to the browser, one line per Codex JSON event.
 *   - Conversation continuity uses `codex exec resume <thread_id>`.
 *
 * No third-party dependencies: Node's built-in http/child_process only.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { spawnCodex, proxyEnv, killTree } = require('./codex-process.cjs');
const appserver = require('./appserver.cjs');
const rollout = require('./rollout.cjs');

const PORT = Number(process.env.CODEX_GUI_PORT || 8790);
const HOST = '127.0.0.1';
const HERE = __dirname;
const SETTINGS_FILE = process.env.CODEX_GUI_SETTINGS_FILE || path.join(HERE, 'settings.json');
const START_TIME = new Date().toISOString();
const VERSION = '1.1.0';

// Settings
// ---------------------------------------------------------------------------
const DEFAULTS = {
  cwd: HERE,
  model: '',                        // '' -> Codex default model
  reasoningEffort: '',              // '' -> model default
  sandbox: 'workspace-write',
  // Permission mode key into PERMISSION_MODES. Replaces the old
  // `sandbox` + `approveForMe` pair, which could not both be honoured.
  permissionMode: 'workspace-write',
  // Empty means "do not inject a proxy": the child process simply inherits
  // whatever the environment says. Keep this empty in the repository -- a
  // hardcoded local port only makes sense on the machine it was written for.
  proxy: '',
  // Web search is ON by default inside `codex exec`; this mirrors that and lets
  // the UI turn it off. There is no --search flag on `codex exec` (it exists
  // only on the top-level `codex` command), so it travels as a config override.
  webSearch: 'live',                // disabled | cached | indexed | live
  // OFF: every catalog model defaults to `default_reasoning_summary = "none"`, so
  // Reasoning items arrive with empty summary_text/raw_content -- verified against
  // real rollouts (102 items, all empty). Without streaming a summary could only
  // appear at the end of a turn anyway. Re-enable together with
  // `-c model_reasoning_summary="concise"`; it costs extra output tokens.
  showReasoning: false,
  theme: 'dark',                    // dark | light | system
  /**
   * Manual override for the context meter, in tokens. `0` (the default) means
   * "use the catalog value from models.json", which is built from
   * `codex debug models` -> context_window * effective_context_window_percent.
   * gpt-6.1-sol reports 500000 x 95% = 475000 usable.
   */
  contextWindow: 0,
  recentDirs: [],
};

/** Values accepted for `-c web_search=...` (mirrors WebSearchMode in the schema). */
const WEB_SEARCH_MODES = ['disabled', 'cached', 'indexed', 'live'];

// Parent permission options are shared by fresh and resumed turns.
const PERMISSION_MODES = {
  'read-only': {
    freshFlags: ['-s', 'read-only'],
    resumeConfig: ['sandbox_mode="read-only"'],
    writable: false,
    label: '只读',
    note: '不能改文件',
  },
  'workspace-write': {
    freshFlags: ['--approve-for-me'],
    resumeConfig: ['sandbox_mode="workspace-write"'],
    writable: true,
    resumeWritable: true,
    label: '工作区可写（自动审查）',
    note: '推荐：只有工作目录可改，越界会被沙箱拦住',
    resumeNote: '',
  },
  'full-access': {
    freshFlags: ['-s', 'danger-full-access'],
    resumeConfig: ['sandbox_mode="danger-full-access"'],
    writable: true,
    label: '完全放开（无沙箱）',
    note: '任意路径可改、可联网；只在信任的目录用',
  },
};

/**
 * Model catalog, produced by `node extract-models.cjs` from `codex debug models`.
 * Used to populate the model / reasoning-effort dropdowns and to validate values
 * before they are interpolated into a `-c` argument.
 */
let CATALOG = { models: [] };
try {
  CATALOG = JSON.parse(fs.readFileSync(path.join(HERE, 'models.json'), 'utf8'));
} catch {
  console.warn('[bridge] models.json missing - run: node extract-models.cjs');
}

function modelEntry(slug) {
  return CATALOG.models.find((m) => m.slug === slug) || null;
}

/** Reasoning levels offered for a model; falls back to the union of all models. */
function effortsFor(slug) {
  const m = modelEntry(slug);
  if (m && m.efforts.length) return m.efforts;
  const seen = new Map();
  for (const mm of CATALOG.models) for (const e of mm.efforts) seen.set(e.value, e);
  return [...seen.values()];
}

function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}
function saveSettings(s) {
  const temporary = SETTINGS_FILE + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temporary, JSON.stringify(s, null, 2), 'utf8');
    fs.renameSync(temporary, SETTINGS_FILE);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* renamed or never created */ }
  }
}
let settings = loadSettings();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function httpError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    if (Number(req.headers['content-length']) > limit) {
      req.resume();
      reject(httpError('request body too large', 413));
      return;
    }
    req.on('data', (c) => {
      if (failed) return;
      size += c.length;
      if (size > limit) {
        failed = true;
        chunks.length = 0;
        reject(httpError('request body too large', 413));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (failed) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        const body = JSON.parse(raw);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
        resolve(body);
      } catch { reject(httpError('invalid JSON object')); }
    });
    req.on('error', reject);
  });
}

// Attachments
// ---------------------------------------------------------------------------
/**
 * Attachments are staged INSIDE the working directory (`.codex-gui/attachments`)
 * because the sandbox only grants write access there, and because the model can
 * then read non-image files with its own tools.
 *
 * Images are additionally handed to Codex with `-i` so the model sees them
 * directly. Every other format is referenced by relative path in the prompt
 * (the model can only ingest text and images natively).
 */
const ATTACH_DIRNAME = '.codex-gui';
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_ATTACHMENTS = 20;
const MAX_RUN_BODY_BYTES = 72 * 1024 * 1024;

function validateAttachments(files) {
  if (!Array.isArray(files) || files.length > MAX_ATTACHMENTS) throw httpError('最多可附加 20 个文件');
  let total = 0;
  return files.map((f) => {
    if (!f || typeof f.name !== 'string' || typeof f.dataBase64 !== 'string' ||
        f.dataBase64.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(f.dataBase64) ||
        Buffer.from(f.dataBase64, 'base64').toString('base64') !== f.dataBase64) {
      throw httpError('附件格式无效');
    }
    const size = Buffer.byteLength(f.dataBase64, 'base64');
    if (size > MAX_FILE_BYTES) throw httpError('单个附件不能超过 25 MB', 413);
    total += size;
    if (total > MAX_TOTAL_BYTES) throw httpError('附件总大小不能超过 50 MB', 413);
    return { name: f.name, dataBase64: f.dataBase64 };
  });
}

function safeName(name) {
  // Strip any directory component and characters Windows rejects.
  const base = path.basename(String(name || 'file'));
  return base.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 120) || 'file';
}

/**
 * Write base64 attachments into <cwd>/.codex-gui/attachments and return facts
 * about them. `rel` is what the prompt quotes; `abs` is what `-i` receives.
 */
function stageAttachments(cwd, files) {
  const staged = [];
  if (!Array.isArray(files) || !files.length) return staged;

  const dir = path.join(cwd, ATTACH_DIRNAME, 'attachments', randomUUID());
  fs.mkdirSync(dir, { recursive: true });

  for (const f of files) {
    try {
      const name = safeName(f.name);
      const ext = path.extname(name).toLowerCase();
      const storedName = String(staged.length + 1) + '-' + name;
      const target = path.join(dir, storedName);

      // Defence in depth: never write outside the staging directory even if
      // `name` somehow contained traversal.
      const resolved = path.resolve(target);
      if (!resolved.startsWith(path.resolve(dir) + path.sep)) continue;

      fs.writeFileSync(resolved, Buffer.from(f.dataBase64, 'base64'), { flag: 'wx' });

      staged.push({
        name,
        abs: resolved,
        rel: path.relative(cwd, resolved).split(path.sep).join('/'),
        size: fs.statSync(resolved).size,
        isImage: IMAGE_EXT.has(ext),
      });
    } catch (e) { throw new Error('无法保存附件 ' + f.name + ': ' + e.message); }
  }
  return staged;
}

/** Build the prompt text, appending an attachment manifest when there is one. */
function withAttachmentManifest(prompt, staged) {
  if (!staged.length) return prompt;
  const lines = staged.map((s) => `- ${s.rel} (${s.name}, ${s.size} bytes)`);
  const images = staged.filter((s) => s.isImage).map((s) => s.rel);
  const parts = [
    prompt,
    '',
    '---',
    'Attached files (paths are relative to the working directory):',
    ...lines,
  ];
  if (images.length) {
    parts.push('', `Images also passed to you directly: ${images.join(', ')}`);
  }
  parts.push('', 'Read these files yourself as needed (they are inside the working directory).');
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// One running Codex turn
// ---------------------------------------------------------------------------
const running = new Map(); // runId -> child

/**
 * Build the `codex exec` argv.
 *
 * Argument order matters: `resume` is a subcommand, so everything that belongs
 * to the *subcommand* must follow it. Flags placed after `resume` but before
 * the id are parsed by `codex exec resume`, and `--approve-for-me` is not a
 * valid flag there (it lives on the parent), which fails the whole run.
 */
function buildArgs({ prompt, cwd, sandbox, model, webSearch, reasoningEffort, resumeThreadId, images }) {
  // Flags accepted by BOTH `codex exec` and its `resume` subcommand.
  // Anything else must go only in the branch that supports it.
  const common = [];
  if (model) common.push('-m', model);
  // There is no --reasoning-effort flag; the value travels as a config override.
  // Only values from the catalog are accepted, so nothing user-typed can break
  // out of the `-c key=value` argument.
  if (reasoningEffort && effortsFor(model).some((e) => e.value === reasoningEffort)) {
    common.push('-c', `model_reasoning_effort="${reasoningEffort}"`);
  }
  // `codex exec` has NO --search flag (it belongs to the top-level `codex`
  // command). Passing it here fails the whole run with
  // "unexpected argument '--search' found". web_search is already on by
  // default; this override exists so the UI can also turn it off.
  if (webSearch && WEB_SEARCH_MODES.includes(webSearch)) {
    common.push('-c', `web_search="${webSearch}"`);
  }

  // Permission flags belong to exec, before the optional resume subcommand.
  const perm = Object.hasOwn(PERMISSION_MODES, sandbox) ? PERMISSION_MODES[sandbox] : PERMISSION_MODES['workspace-write'];

  // Image options follow the stdin prompt marker.
  const imageFlags = [];
  for (const p of (images || [])) {
    if (typeof p === 'string' && p && fs.existsSync(p)) imageFlags.push('-i', p);
  }

  if (resumeThreadId) {
    // Parent flags preserve the approval reviewer. Saved thread permissions
    // still take precedence; the route validates those before resuming.
    const args = ['exec', ...perm.freshFlags];
    if (cwd) args.push('-C', cwd);
    args.push('resume', resumeThreadId, '--json', '--skip-git-repo-check', ...common);
    for (const config of perm.resumeConfig) args.push('-c', config);
    args.push('-');
    args.push(...imageFlags);
    return args;
  }

  const args = ['exec', '--json', '--skip-git-repo-check', ...common, ...perm.freshFlags];
  for (const config of perm.resumeConfig) args.push('-c', config);
  if (cwd) args.push('-C', cwd);
  args.push('-'); // stdin avoids Windows command-line limits and option injection
  args.push(...imageFlags);
  return args;
}

function startRun(opts, res) {
  const runId = 'run_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const sse = (event, data) => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Stage attachments inside the working directory, then fold them into the
  // prompt (manifest) and the argv (`-i` for images only).
  let staged = [];
  try {
    staged = stageAttachments(opts.cwd, opts.attachments);
  } catch (e) {
    sse('fatal', { message: 'could not stage attachments: ' + e.message });
    res.end();
    return runId;
  }
  const finalPrompt = withAttachmentManifest(opts.prompt, staged);
  const args = buildArgs({
    ...opts,
    prompt: finalPrompt,
    images: staged.filter((s) => s.isImage).map((s) => s.abs),
  });

  const env = proxyEnv(opts.proxy);

  sse('meta', {
    runId,
    // Prompts go through stdin; metadata only contains execution options.
    args: args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' '),
    cwd: opts.cwd,
    proxy: opts.proxy || null,
    attachments: staged.map((s) => ({ name: s.name, rel: s.rel, size: s.size, isImage: s.isImage })),
    transport: 'shell-free-stdin',
  });

  let child;
  try {
    // No `cmd /c` here: it rewrites arguments containing newlines and silently
    // drops a trailing `-i <image>`. See resolveCodexExe().
    child = spawnCodex(args, {
      cwd: opts.cwd,
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    sse('fatal', { message: 'failed to start codex: ' + e.message });
    res.end();
    return runId;
  }

  const run = { child, threadId: opts.resumeThreadId, stopped: false };
  running.set(runId, run);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdin.on('error', () => {}); // EPIPE is reported by the child exit/stderr
  child.stdin.end(finalPrompt);
  const heartbeat = setInterval(() => { if (!res.destroyed && !res.writableEnded) res.write(': heartbeat\n\n'); }, 15000);
  heartbeat.unref();

  let buf = '';
  let completedTurn = null;
  const handleLine = (line) => {
    const t = line.trim();
    if (!t) return;
    if (t.startsWith('{')) {
      try {
        const event = JSON.parse(t);
        if (event.type === 'thread.started') run.threadId = event.thread_id;
        if (event.type === 'turn.completed') { completedTurn = event; return; }
        sse('codex', event);
        return;
      } catch { /* fall through to text */ }
    }
    sse('text', { line: t });
  };

  child.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    const parts = buf.split(/\r?\n/);
    buf = parts.pop() ?? '';
    for (const p of parts) handleLine(p);
  });

  let errBuf = '';
  child.stderr.on('data', (d) => {
    errBuf += d.toString('utf8');
    if (errBuf.length > 20000) errBuf = errBuf.slice(-20000);
  });

  /**
   * `codex exec` writes this banner to stderr even when the prompt was passed
   * as an argument. It is not an error, so it must not reach the UI as one.
   *
   * The models-manager refresh failures are also dropped: they only mean the
   * background catalog refresh timed out, which does not affect the turn.
   */
  const stderrNoise = [
    /^Reading additional input from stdin\.{0,3}$/,
    /failed to refresh available models/i,
    /^WARN\s+codex_models_manager/i,
  ];
  const cleanStderr = (text) =>
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !stderrNoise.some((re) => re.test(l)))
      .join('\n')
      .trim();

  let finished = false;
  const finish = (code, signal) => {
    if (finished) return;
    finished = true;
    clearInterval(heartbeat);
    if (buf.trim()) handleLine(buf);
    if (completedTurn) {
      // The writer can flush its final usage after emitting turn.completed.
      // Read after process close so the meter does not lag by one turn.
      try {
        const saved = rollout.readConversation(run.threadId, { maxMessages: 0 });
        completedTurn.contextUsage = saved.usage;
        completedTurn.contextWindow = saved.contextWindow;
        completedTurn.model = saved.model;
      } catch { /* retain billed usage; current context remains unknown */ }
      // The live file_change event carries only paths; the diffs are written to
      // the rollout afterwards. Ship them with the completion so the open card
      // can show HOW as soon as the turn ends, without a refresh.
      try {
        completedTurn.fileChanges = rollout.readLastTurnFileChanges(run.threadId);
      } catch { /* the card keeps showing just the paths */ }
      sse('codex', completedTurn);
    }
    running.delete(runId);
    const err = cleanStderr(errBuf);
    if (err) sse('stderr', { text: err.slice(-4000) });
    sse('exit', { code, signal, stopped: run.stopped });
    try { res.end(); } catch {}
  };

  child.on('close', finish);
  child.on('error', (e) => {
    sse('fatal', { message: e.message });
    finish(null);
  });

  // Client went away -> stop the run so it does not keep burning quota.
  res.on('close', () => {
    clearInterval(heartbeat);
    if (running.has(runId)) {
      killTree(child.pid);
    }
  });

  return runId;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  try {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    const port = server.address()?.port || PORT;
    const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    if (!allowed.has(req.headers.host)) throw httpError('invalid Host', 403);
    if (req.headers.origin && ![...allowed].some((host) => req.headers.origin === 'http://' + host)) throw httpError('cross-origin request denied', 403);
    if (req.headers['sec-fetch-site'] === 'cross-site') throw httpError('cross-site request denied', 403);
    if (req.method === 'POST' && !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw httpError('application/json required', 415);
    const url = new URL(req.url, `http://${HOST}:${port}`);
    const p = url.pathname;
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      const file = path.join(HERE, 'index.html');
      const body = fs.readFileSync(file);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(body);
      return;
    }

    if (req.method === 'GET' && p === '/api/settings') {
      json(res, 200, settings);
      return;
    }

    if (req.method === 'POST' && p === '/api/settings') {
      const body = await readBody(req);
      const next = { ...settings };
      for (const key of Object.keys(DEFAULTS)) if (Object.hasOwn(body, key)) next[key] = body[key];
      if (typeof next.cwd !== 'string' || typeof next.proxy !== 'string' || typeof next.model !== 'string' ||
          typeof next.reasoningEffort !== 'string' || !Array.isArray(next.recentDirs) ||
          !Object.hasOwn(PERMISSION_MODES, next.permissionMode) || !WEB_SEARCH_MODES.includes(next.webSearch) ||
          !['dark','light','system'].includes(next.theme) || !Number.isFinite(next.contextWindow) || next.contextWindow < 0) throw httpError('invalid settings');
      if (body.cwd) {
        next.recentDirs = [body.cwd, ...next.recentDirs.filter((d) => typeof d === 'string' && d !== body.cwd)].slice(0, 8);
      }
      saveSettings(next);
      settings = next;
      json(res, 200, settings);
      return;
    }

    // Verify the working directory exists before a run starts.
    if (req.method === 'POST' && p === '/api/checkdir') {
      const { cwd } = await readBody(req);
      let ok = false, note = '';
      try {
        ok = fs.statSync(cwd).isDirectory();
      } catch (e) {
        note = e.code === 'ENOENT' ? '目录不存在' : e.message;
      }
      json(res, 200, { ok, note });
      return;
    }

    // ------------------------------------------------------------------
    // Sessions (list / rename / delete) — served by the app-server RPC
    // ------------------------------------------------------------------
    // Saved transcript for one thread. `codex exec resume` does NOT replay
    // earlier turns, so the GUI rebuilds history from the rollout file.
    if (req.method === 'GET' && p === '/api/history') {
      const threadId = url.searchParams.get('threadId') || '';
      if (!threadId) { json(res, 400, { error: 'threadId required' }); return; }
      try {
        const r = rollout.readConversation(threadId);
        json(res, 200, {
          threadId,
          messages: r.messages,
          usage: r.usage,
          contextWindow: r.contextWindow,
          model: r.model,
          cwd: r.cwd,
          permissionMode: r.permissionMode,
          found: !!r.path,
          path: r.path,
        });
      } catch (e) {
        json(res, 200, { threadId, messages: [], error: e.message, found: false });
      }
      return;
    }

    if (req.method === 'GET' && p === '/api/sessions') {
      try {
        const sessions = await appserver.listSessions({
          limit: Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 60)),
          proxy: settings.proxy,
        });
        json(res, 200, { sessions });
      } catch (e) {
        // The app-server transport can be unavailable; report it without
        // breaking the rest of the UI.
        json(res, 200, { sessions: [], error: e.message });
      }
      return;
    }

    if (req.method === 'POST' && p === '/api/sessions/delete') {
      const { threadId } = await readBody(req);
      if (!threadId) { json(res, 400, { error: 'threadId required' }); return; }
      try {
        if ([...running.values()].some((run) => run.threadId === threadId)) throw httpError('会话正在运行，无法删除', 409);
        await appserver.deleteSession(String(threadId), { proxy: settings.proxy });
        json(res, 200, { ok: true });
      } catch (e) {
        json(res, 200, { ok: false, error: e.message });
      }
      return;
    }

    if (req.method === 'POST' && p === '/api/sessions/rename') {
      const { threadId, name } = await readBody(req);
      if (!threadId) { json(res, 400, { error: 'threadId required' }); return; }
      const clean = String(name || '').trim().slice(0, 120);
      try {
        if (!clean) throw httpError('标题不能为空');
        await appserver.renameSession(String(threadId), clean, { proxy: settings.proxy });
        json(res, 200, { ok: true, name: clean });
      } catch (e) {
        json(res, 200, { ok: false, error: e.message });
      }
      return;
    }

    // Report where attachments would land, and what is already staged.
    if (req.method === 'POST' && p === '/api/attach/info') {
      const { cwd } = await readBody(req);
      const dir = path.join(String(cwd || ''), ATTACH_DIRNAME, 'attachments');
      let files = [];
      try {
        files = fs.readdirSync(dir).map((n) => {
          const st = fs.statSync(path.join(dir, n));
          return { name: n, size: st.size, isImage: IMAGE_EXT.has(path.extname(n).toLowerCase()) };
        });
      } catch { /* no staged files yet */ }
      json(res, 200, { dir, files });
      return;
    }

    // Serve one attached image so replayed history can show a real preview.
    // A browser cannot load a local path, and echoing base64 into the history
    // JSON would bloat every session switch.
    if (req.method === 'GET' && p === '/api/attach/raw') {
      const target = url.searchParams.get('path') || '';
      if (!target || !IMAGE_EXT.has(path.extname(target).toLowerCase())) {
        json(res, 400, { error: 'only image attachments can be previewed' });
        return;
      }
      if (!path.isAbsolute(target)) {
        json(res, 400, { error: 'an absolute path is required' });
        return;
      }
      try {
        const st = fs.statSync(target);
        if (!st.isFile()) throw new Error('not a file');
        if (st.size > 25 * 1024 * 1024) {
          json(res, 413, { error: 'image is too large to preview' });
          return;
        }
        const body = fs.readFileSync(target);
        const ext = path.extname(target).toLowerCase();
        const type = { '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg',
          '.gif':'image/gif', '.webp':'image/webp', '.bmp':'image/bmp' }[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': 'no-store' });
        res.end(body);
      } catch (e) {
        json(res, 404, { error: 'cannot read that image: ' + e.message });
      }
      return;
    }

    if (req.method === 'GET' && p === '/api/models') {
      json(res, 200, {
        models: CATALOG.models,
        generatedAt: CATALOG.generatedAt || null,
        // Union of every model's levels, for when no model is pinned.
        fallbackEfforts: effortsFor(''),
        // Where the context-window numbers came from, for the settings hint.
        contextSource: 'codex debug models: context_window x effective_context_window_percent',
        // The UI renders its permission dropdown and hint from this, so the
        // flag mapping lives in exactly one place.
        permissionModes: Object.entries(PERMISSION_MODES).map(([key, v]) => ({
          key,
          label: v.label,
          note: v.note,
          writable: v.writable,
          // Fresh-turn flags (what the UI shows as "实际参数").
          flags: v.freshFlags.join(' '),
          // Parent options also apply when resuming an existing thread.
          resumeFlags: v.freshFlags.join(' ') + '（放在 resume 之前） ' + v.resumeConfig.map((config) => '-c ' + config).join(' '),
          resumeWritable: v.resumeWritable !== undefined ? v.resumeWritable : v.writable,
          resumeNote: v.resumeNote || '',
        })),
      });
      return;
    }

    // Native Windows folder picker. Runs in its own PowerShell process, so it
    // is independent of the browser sandbox. The script prints exactly one line:
    //   PICKED=<path> | CANCELED | ERROR=<message>
    if (req.method === 'POST' && p === '/api/pick-folder') {
      const { startIn } = await readBody(req).catch(() => ({}));
      const script = path.join(HERE, 'pick-folder.ps1');
      const child = spawn(
        'powershell',
        ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script, startIn || ''],
        { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
      );
      let out = '', err = '';
      child.stdout.on('data', (d) => { out += d.toString('utf8'); });
      child.stderr.on('data', (d) => { err += d.toString('utf8'); });
      let replied = false;
      const reply = (body) => { if (!replied && !res.destroyed) { replied = true; json(res, 200, body); } };
      child.on('error', (e) => reply({ path: '', error: e.message }));
      child.on('close', () => {
        const line = out.trim().split(/\r?\n/).pop().trim();
        if (line.startsWith('PICKED=')) return reply({ path: line.slice(7).trim() });
        if (line === 'CANCELED') return reply({ path: '', canceled: true });
        if (line.startsWith('ERROR=')) return reply({ path: '', error: line.slice(6).trim() });
        return reply({
          path: '',
          error: (err.trim() || 'the picker produced no usable output').slice(0, 500),
        });
      });
      return;
    }

    if (req.method === 'POST' && p === '/api/run') {
      const body = await readBody(req, MAX_RUN_BODY_BYTES);
      const value = (key, fallback = '') => Object.hasOwn(body, key) ? body[key] : fallback;
      const opts = {
        prompt: String(body.prompt || '').trim(),
        cwd: String(body.cwd || settings.cwd),
        sandbox: String(body.sandbox || body.permissionMode || settings.permissionMode || 'workspace-write'),
        model: String(body.model || ''),
        webSearch: String(body.webSearch || settings.webSearch || 'live'),
        reasoningEffort: String(body.reasoningEffort || ''),
        attachments: validateAttachments(value('attachments', [])),
        proxy: value('proxy', settings.proxy || ''),
        resumeThreadId: body.resumeThreadId ? String(body.resumeThreadId) : '',
      };
      if (!path.isAbsolute(opts.cwd) || !fs.existsSync(opts.cwd) || !fs.statSync(opts.cwd).isDirectory()) throw httpError('工作目录无效');
      if (!Object.hasOwn(PERMISSION_MODES, opts.sandbox)) throw httpError('权限模式无效');
      if (opts.model && !modelEntry(opts.model)) throw httpError('未知模型，请刷新模型目录');
      if (opts.reasoningEffort && !effortsFor(opts.model).some((e) => e.value === opts.reasoningEffort)) throw httpError('推理强度无效');
      if (!WEB_SEARCH_MODES.includes(opts.webSearch)) throw httpError('搜索模式无效');
      if (typeof opts.proxy !== 'string' || (opts.proxy && !/^https?:\/\//i.test(opts.proxy))) throw httpError('代理地址无效');
      if (opts.resumeThreadId && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(opts.resumeThreadId)) throw httpError('会话 ID 无效');
      if (opts.resumeThreadId && [...running.values()].some((run) => run.threadId === opts.resumeThreadId)) throw httpError('此会话已在运行', 409);
      if (opts.resumeThreadId) {
        const saved = rollout.readConversation(opts.resumeThreadId, { maxMessages: 0 });
        if (!saved.permissionMode) throw httpError('无法核实此会话的原有权限，请新建会话或重新选择历史会话。', 409);
        if (saved.permissionMode !== opts.sandbox) throw httpError('当前 Codex CLI 续接时保留会话原有权限。此会话为「' + PERMISSION_MODES[saved.permissionMode].label + '」，请切回该模式，或新建会话使用其他权限。', 409);
        const normalizeDir = (dir) => process.platform === 'win32' ? path.resolve(dir).toLowerCase() : path.resolve(dir);
        if (saved.cwd && normalizeDir(saved.cwd) !== normalizeDir(opts.cwd)) throw httpError('此会话的工作目录为「' + saved.cwd + '」，请恢复该目录，或新建会话使用其他目录。', 409);
      }
      if (!opts.prompt && !opts.attachments.length) {
        json(res, 400, { error: 'prompt is empty' });
        return;
      }
      startRun(opts, res);
      return;
    }

    if (req.method === 'POST' && p === '/api/stop') {
      const { runId } = await readBody(req);
      if (typeof runId !== 'string' || !runId) throw httpError('runId required');
      let stopped = 0;
      const run = running.get(runId);
      if (run) { run.stopped = true; killTree(run.child.pid); stopped = 1; }
      json(res, 200, { stopped });
      return;
    }

    if (req.method === 'GET' && p === '/api/health') {
      json(res, 200, {
        ok: true,
        app: 'codex-local-gui',
        version: VERSION,
        running: running.size,
        pid: process.pid,
        startedAt: START_TIME,
        // Feature fingerprint: lets a client prove it is not talking to a stale
        // process that predates a code change.
        capabilities: {
          attachments: true,
          sessions: true,
          imageFlagOrder: 'stdin-then-i',
          webSearchConfig: true,
          transport: 'shell-free-stdin',
          scopedStop: true,
        },
      });
      return;
    }

    json(res, 404, { error: 'not found' });
  } catch (e) {
    if (!res.headersSent) json(res, e.statusCode || 500, { error: e.message });
    else try { res.end(); } catch {}
  }
});

/** Open the default browser. spawn() is used so the URL is quoted correctly. */
function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch (e) {
    console.log('(could not open a browser automatically: ' + e.message + ')');
  }
}

// Only bind the port when run directly; requiring this file (argv unit test)
// must not start a server.
const RUN_AS_MAIN = require.main === module;

if (RUN_AS_MAIN) server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${server.address().port}`;
  console.log('========================================');
  console.log('  Codex GUI is running');
  console.log('========================================');
  console.log('  url   : ' + url);
  console.log('  cwd   : ' + settings.cwd);
  console.log('  proxy : ' + (settings.proxy || '(none)'));
  console.log('');
  console.log('Close this window to stop the server.');
  console.log('');

  if (process.env.CODEX_GUI_NO_BROWSER !== '1') openBrowser(url);
});

function shutdown() {
  if (!RUN_AS_MAIN) return;
  for (const run of running.values()) killTree(run.child.pid);
  appserver.killServer();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
}
if (RUN_AS_MAIN) {
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('exit', () => { for (const run of running.values()) killTree(run.child.pid); });
  server.on('error', (error) => { console.error('无法启动服务：' + error.message); process.exitCode = 1; });
}

// Exported for the argv unit test (test-args.cjs). Requiring this file as a
// module must not start the server.
module.exports = { buildArgs, WEB_SEARCH_MODES, PERMISSION_MODES, DEFAULTS, server, stageAttachments, validateAttachments };
