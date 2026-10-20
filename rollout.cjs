/**
 * Reads a saved Codex conversation from its rollout JSONL.
 *
 * `codex exec resume` does NOT replay earlier turns (`--json` only emits the new
 * turn's events), so switching sessions in the GUI has to reconstruct history
 * from `$CODEX_HOME/sessions/**.jsonl`.
 *
 * Record shapes verified against codex-cli 0.162.1:
 *   {type:"response_item", payload:{type:"message", role:"user"|"assistant",
 *                                   content:[{type:"input_text"|"output_text", text}]}}
 *   {type:"token_usage_record", payload:{... input_tokens, cached_input_tokens,
 *                                        output_tokens, reasoning_output_tokens,
 *                                        total_tokens}}
 * Roles "developer" / "system" carry Codex's own instructions and are skipped.
 */

const fs = require('node:fs');
const path = require('node:path');

const CODEX_HOME = process.env.CODEX_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.codex');
const SESSIONS_DIR = path.join(CODEX_HOME, 'sessions');

/** Find a rollout file whose name contains the thread id. */
function findRollout(threadId) {
  if (!threadId || !/^[0-9a-f-]{20,}$/i.test(threadId)) return null;
  const stack = [SESSIONS_DIR];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name.endsWith('.jsonl') && e.name.includes(threadId)) return p;
    }
  }
  return null;
}

function textOf(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const c of content) {
    if (c && typeof c.text === 'string' && /text$/.test(c.type || '')) parts.push(c.text);
  }
  return parts.join('\n').trim();
}

/** Resolve an attached path against the session's working directory. */
function toAbsolute(p, cwd) {
  if (!p) return '';
  if (/^[a-zA-Z]:[\\/]/.test(p)) return p;            // already absolute
  if (!cwd) return p;
  return path.join(cwd, p.replace(/^[\\/]+/, ''));
}

/**
 * Pull attachments out of a replayed user message.
 *
 * The prompt that Codex actually received carries two pieces of plumbing that
 * were never written by the user and should not be shown back to them:
 *
 *   1. `<image name="[Image #1]" path="...">...</image>` — added by Codex itself
 *      for images passed with `-i`.
 *   2. The manifest appended by bridge.cjs:
 *        ---
 *        Attached files (paths are relative to the working directory):
 *        - path (name, N bytes)
 *        Images also passed to you directly: ...
 *        Read these files yourself as needed (...)
 *
 * Returns the human text plus a deduplicated attachment list.
 */
function splitAttachments(text, cwd) {
  const attachments = [];
  const seen = new Set();
  const add = (abs, name, isImage, size) => {
    const key = (abs || name || '').toLowerCase();
    if (!key) return;
    if (seen.has(key)) return;
    // Codex's own tag carries a useless placeholder ("Image #1"); prefer a real
    // filename if the same path shows up again from the bridge manifest.
    const placeholder = /^Image #?\d*$/i.test(name || '');
    if (!placeholder){
      const prior = attachments.find((a) => a.path && a.path.toLowerCase() === (abs || '').toLowerCase());
      if (prior){
        prior.name = name;
        if (size) prior.size = size;
        return;
      }
    }
    seen.add(key);
    // Never surface Codex's "Image #1" placeholder: fall back to the real file
    // name on disk, which is far more useful in the transcript.
    let label = name;
    if (!label || /^Image #?\d*$/i.test(label)) label = path.basename(abs || '') || label;
    attachments.push({ path: abs, name: label, isImage, size: size || 0 });
  };

  const cleanName = (n) => String(n || '').replace(/^["'\[]+/, '').replace(/["'\]]+$/, '').trim();

  // 1. Codex's own <image ...> tags (inline, so removing them leaves a gap).
  //    The `name` value is NOT always quoted: real rollouts contain
  //    `<image name=[Image #1] path="...">`, so accept quoted, bracketed or bare.
  const IMAGE_TAG = /<image\s+name=("[^"]*"|'[^']*'|\[[^\]]*\]|[^\s>]+)\s+path="([^"]+)"\s*\/?>(?:\s*<\/image>)?/g;
  let out = text.replace(IMAGE_TAG, (_m, name, p) => {
    add(toAbsolute(p, cwd), cleanName(name), true, 0);
    return '';
  });

  // 2. bridge.cjs manifest.
  const manifestAt = out.search(/\n?---\nAttached files \(paths are relative to the working directory\):/);
  if (manifestAt >= 0) {
    const manifest = out.slice(manifestAt);
    out = out.slice(0, manifestAt);
    for (const m of manifest.matchAll(/^- (.+?) \((.+?), (\d+) bytes\)\s*$/gm)) {
      const rel = m[1].trim(), name = m[2].trim(), size = Number(m[3]) || 0;
      add(toAbsolute(rel, cwd), name, /\.(png|jpe?g|gif|webp|bmp)$/i.test(name || rel), size);
    }
    // "Images also passed to you directly: a.png, b.png"
    const direct = manifest.match(/Images also passed to you directly:\s*(.+)$/m);
    if (direct) {
      for (const rel of direct[1].split(',').map((s) => s.trim()).filter(Boolean)) {
        add(toAbsolute(rel, cwd), path.basename(rel), true, 0);
      }
    }
  }

  out = out.replace(/\n{3,}/g, '\n\n').trim();
  return { text: out, attachments };
}

/**
 * Turn a recorded `item_completed` item into a replayable transcript row.
 *
 * Shapes verified against codex-cli 0.162.1:
 *   CommandExecution: { type, id, command:[argv], status, aggregated_output,
 *                       exit_code, duration }
 *   Reasoning:        { type, id, summary:[{type,text}] } or { text }
 */
function replayItem(it, maxChars) {
  if (it.type === 'CommandExecution') {
    // `command` is an argv array; join it the way a shell would show it.
    const cmd = Array.isArray(it.command) ? it.command.join(' ') : String(it.command || '');
    if (!cmd) return null;
    let out = String(it.aggregated_output || '');
    if (out.length > maxChars) out = out.slice(0, maxChars) + '\n…（已截断）';
    return {
      role: 'assistant', kind: 'command',
      item: {
        id: it.id, type: 'command_execution', command: cmd,
        status: it.status === 'completed' ? 'completed' : 'in_progress',
        exit_code: typeof it.exit_code === 'number' ? it.exit_code : null,
        aggregated_output: out,
      },
    };
  }
  if (it.type === 'Reasoning') {
    let text = '';
    if (typeof it.text === 'string') text = it.text;
    else if (Array.isArray(it.summary)) text = it.summary.map((s) => (s && s.text) || '').join('\n');
    else if (Array.isArray(it.content)) text = it.content.map((s) => (s && s.text) || '').join('\n');
    text = (text || '').trim();
    if (!text) return null;
    if (text.length > maxChars) text = text.slice(0, maxChars) + '\n…（已截断）';
    return { role: 'assistant', kind: 'reasoning', item: { id: it.id, type: 'reasoning', text } };
  }
  // File change. MEASURED shape in real rollouts:
  //   { type:"FileChange", id, status, changes:{ <abs path>: { type, unified_diff, move_path } },
  //     stdout, stderr }
  // NOTE the rollout keys `changes` by path and includes the diff, while the LIVE
  // `codex exec --json` event uses an array of { path, kind } with NO diff. The
  // UI normalises both (normalizeFileChanges). Replay is the only place a diff is
  // available at all.
  if (it.type === 'FileChange') {
    const changes = it.changes;
    let files = [];
    if (changes && typeof changes === 'object' && !Array.isArray(changes)) {
      files = Object.entries(changes).map(([p, v]) => ({
        path: p,
        kind: String((v && v.type) || 'update'),
        diff: String((v && v.unified_diff) || ''),
        movePath: (v && v.move_path) || null,
      }));
    } else if (Array.isArray(changes)) {
      files = changes.map((e) => ({
        path: String((e && e.path) || ''),
        kind: String((e && e.kind) || 'update'),
        diff: '',
        movePath: null,
      }));
    }
    files = files.filter((f) => f.path);
    if (!files.length) return null;
    // Keep the transcript bounded: a huge patch must not bloat the history payload.
    let used = 0;
    for (const f of files) {
      if (!f.diff) continue;
      const room = Math.max(0, maxChars - used);
      if (!room) { f.diff = '…（已截断）'; continue; }
      used += f.diff.length;
      if (f.diff.length > room) f.diff = f.diff.slice(0, room) + '\n…（已截断）';
    }
    return {
      role: 'assistant', kind: 'file_change',
      item: {
        id: it.id, type: 'file_change',
        status: it.status === 'completed' ? 'completed' : 'in_progress',
        changes: files.map((f) => ({ path: f.path, type: f.kind, unified_diff: f.diff })),
      },
    };
  }
  // Web search. MEASURED shape in real rollouts is an Extension, NOT WebSearchItem:
  //   { type:"Extension", kind:"web.search", id, query, action, results:[...] }
  // The app-server type name (`WebSearch`) is accepted too, for safety.
  if (it.type === 'WebSearch' || (it.type === 'Extension' && String(it.kind || '').startsWith('web.'))) {
    return {
      role: 'assistant', kind: 'web_search',
      item: { id: it.id, type: 'web_search', query: it.query || '',
        action: it.action ?? null,
        results: Array.isArray(it.results) ? it.results
          : (Array.isArray(it.content) ? it.content : null) },
    };
  }
  return null;
}

/**
 * @returns {{messages: Array<{role:string,text:string}>, usage: object|null, path: string|null}}
 */
function readConversation(threadId, { maxMessages = 400, maxChars = 20000 } = {}) {
  const file = findRollout(threadId);
  if (!file) return { messages: [], usage: null, path: null };

  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { messages: [], usage: null, path: file }; }

  const messages = [];
  let usage = null;
  let contextWindow = null;
  let model = '';
  let cwd = '';
  let permissionMode = '';
  const usageSeries = [];
  const pushUsage = (t) => {
    if (!t || typeof t.input_tokens !== 'number') return;
    // A zero record exists (seen at 124 points in one real session) and would read
    // as a 100% drop, i.e. a fake compaction. Only counts that actually measured
    // something are kept.
    if (!t.input_tokens && !t.output_tokens) return;
    const point = {
      input: t.input_tokens ?? 0,
      output: t.output_tokens ?? 0,
      cached: t.cached_input_tokens ?? 0,
    };
    // The same turn can be reported twice (token_count event AND usage record);
    // an identical consecutive point is not a new turn.
    const last = usageSeries[usageSeries.length - 1];
    if (last && last.input === point.input && last.output === point.output) return;
    usageSeries.push(point);
  };
  const setUsage = (t) => {
    if (!t || typeof t.input_tokens !== 'number') return;
    pushUsage(t);
    usage = {
      inputTokens: t.input_tokens ?? 0,
      cachedInputTokens: t.cached_input_tokens ?? 0,
      outputTokens: t.output_tokens ?? 0,
      reasoningOutputTokens: t.reasoning_output_tokens ?? 0,
      // Reasoning is included in output_tokens. Use the last model call:
      // turn/thread totals add many calls and are not current context size.
      contextTokens: (t.input_tokens ?? 0) + (t.output_tokens ?? 0),
    };
  };

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const p = o.payload;
    if (!p) continue;
    if (o.type === 'turn_context' || o.type === 'session_meta') {
      if (typeof p.model === 'string') model = p.model;
      if (typeof p.cwd === 'string') cwd = p.cwd;
      const sandbox = p.sandbox_policy?.type;
      if (sandbox === 'read-only' || sandbox === 'workspace-write') {
        // The automatic-review mode may retain a read-only base sandbox and
        // grant individual operations through review. Preserve the full mode,
        // rather than losing its reviewer when displaying a saved session.
        permissionMode = p.approval_policy === 'on-request' && p.approvals_reviewer === 'auto_review'
          ? 'workspace-write' : sandbox;
      }
      else if (sandbox === 'danger-full-access') permissionMode = 'full-access';
    }

    if (o.type === 'response_item' && p.type === 'message') {
      // Skip Codex's own instruction blocks; only show the real conversation.
      if (p.role !== 'user' && p.role !== 'assistant') continue;
      let text = textOf(p.content);
      if (!text) continue;
      let attachments = [];
      // User turns can carry a large <environment_context> preamble.
      if (p.role === 'user') {
        text = text.replace(/<environment_context>[\s\S]*?<\/environment_context>/g, '').trim();
        // Strip the attachment plumbing and surface the files as data instead.
        const split = splitAttachments(text, cwd);
        text = split.text;
        attachments = split.attachments;
        if (!text && !attachments.length) continue;
      }
      if (text.length > maxChars) text = text.slice(0, maxChars) + '\n…（已截断）';
      if (maxMessages > 0) {
        const msg = attachments.length ? { role: p.role, text, kind: 'message', attachments }
          : { role: p.role, text, kind: 'message' };
        messages.push(msg);
        if (messages.length > maxMessages) messages.shift();
      }
    } else if (o.type === 'event_msg' && p.type === 'item_completed' && p.item) {
      // Commands and reasoning are recorded here with the SAME shape the live
      // `codex exec --json` stream uses, so replay can rebuild the identical
      // tool cards -- without this, refreshing a session silently dropped every
      // command the user had just watched run.
      const it = p.item;
      const msg = replayItem(it, maxChars);
      if (msg){
        messages.push(msg);
        if (maxMessages > 0 && messages.length > maxMessages) messages.shift();
      }
    } else if (o.type === 'event_msg' && p.type === 'token_count' && p.info) {
      // This is the authoritative record: it carries the model's real context
      // window, which the exec event stream never reports.
      if (typeof p.info.model_context_window === 'number') {
        contextWindow = p.info.model_context_window;
      }
      setUsage(p.info.last_token_usage);
    } else if (o.type === 'token_usage_record') {
      setUsage(p.usage);
    }
  }

  // Keep the tail if the conversation is enormous.
  const trimmed = messages.length > maxMessages ? messages.slice(-maxMessages) : messages;
  // `usageSeries` is what lets the page rebuild its compaction marker after a
  // refresh or a session switch: the live view infers it from turn-to-turn drops,
  // and without the series there is only one number to look at (see the UI).
  return { messages: trimmed, usage, usageSeries, contextWindow, model, cwd, permissionMode, path: file };
}

/**
 * File changes recorded for the LAST turn, with their diffs.
 *
 * Needed because the live `codex exec --json` event only says which paths
 * changed -- the `unified_diff` is written to the rollout afterwards. The bridge
 * calls this when a turn closes so the card can show HOW, not just WHAT, without
 * waiting for a refresh.
 *
 * Deliberately cheap: no message replay, no attachment parsing, capped diff size.
 */
function readLastTurnFileChanges(threadId, { maxChars = 20000 } = {}) {
  const file = findRollout(threadId);
  if (!file) return [];
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }

  // The turn id is only known once we have seen it, so collect per turn and keep
  // the last one that actually recorded a file change.
  let lastTurnId = '';
  const byTurn = new Map();
  for (const line of raw.split('\n')) {
    if (!line.trim() || line.indexOf('FileChange') === -1) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const p = o.payload;
    if (!p || p.type !== 'item_completed' || !p.item || p.item.type !== 'FileChange') continue;
    const turn = String(p.turn_id || '');
    const files = [];
    const changes = p.item.changes;
    if (changes && typeof changes === 'object' && !Array.isArray(changes)) {
      for (const [path, v] of Object.entries(changes)) {
        files.push({
          path,
          type: String((v && v.type) || 'update'),
          unified_diff: String((v && v.unified_diff) || ''),
          move_path: (v && v.move_path) || null,
        });
      }
    } else if (Array.isArray(changes)) {
      for (const e of changes) {
        if (!e) continue;
        files.push({ path: String(e.path || ''), type: String(e.kind || 'update'), unified_diff: '' });
      }
    }
    const keep = files.filter((f) => f.path);
    if (!keep.length) continue;
    byTurn.set(turn, keep);
    lastTurnId = turn;
  }
  if (!lastTurnId) return [];

  let used = 0;
  return byTurn.get(lastTurnId).map((f) => {
    let diff = f.unified_diff;
    const room = Math.max(0, maxChars - used);
    used += diff.length;
    if (diff.length > room) diff = diff.slice(0, room) + '\n…（已截断）';
    return { path: f.path, type: f.type, unified_diff: diff };
  });
}

/**
 * Find a keyword inside one session's conversation.
 *
 * Returns `{ count, snippet, role }` or null. Two cheap filters come first: a
 * session with no occurrence anywhere cannot match, and re-parsing 3 MB of JSONL
 * just to discover that is wasted work. Only lines that already contain the
 * needle are parsed.
 */
function searchSession(threadId, needle, { maxChars = 4 * 1024 * 1024 } = {}) {
  const file = findRollout(threadId);
  if (!file) return null;
  const lower = String(needle || '').toLowerCase();
  if (!lower) return null;

  let raw;
  try {
    const stat = fs.statSync(file);
    if (stat.size > maxChars) {
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(maxChars);
        const n = fs.readSync(fd, buf, 0, maxChars, 0);
        raw = buf.subarray(0, n).toString('utf8');
      } finally { try { fs.closeSync(fd); } catch {} }
    } else {
      raw = fs.readFileSync(file, 'utf8');
    }
  } catch { return null; }
  if (!raw || raw.toLowerCase().indexOf(lower) === -1) return null;

  let count = 0;
  let snippet = '';
  let role = '';
  for (const line of raw.split('\n')) {
    if (!line || line.toLowerCase().indexOf(lower) === -1) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'response_item') continue;
    const p = o.payload;
    if (!p || p.type !== 'message') continue;
    if (p.role !== 'user' && p.role !== 'assistant') continue;
    let text = textOf(p.content);
    if (!text) continue;
    // The same preamble the transcript hides: matching inside it would report a
    // hit the user cannot see anywhere.
    text = text.replace(/<environment_context>[\s\S]*?<\/environment_context>/g, '').trim();
    if (!text) continue;

    const hay = text.toLowerCase();
    let from = 0, at, here = 0;
    while ((at = hay.indexOf(lower, from)) !== -1) { here++; from = at + lower.length; }
    if (!here) continue;
    count += here;
    if (!snippet) {
      const first = hay.indexOf(lower);
      const start = Math.max(0, first - 42);
      const end = Math.min(text.length, first + lower.length + 60);
      snippet = (start > 0 ? '…' : '') +
        text.slice(start, end).replace(/\s+/g, ' ').trim() +
        (end < text.length ? '…' : '');
      role = p.role;
    }
  }
  return count ? { count, snippet, role } : null;
}

module.exports = { searchSession, readConversation, readLastTurnFileChanges, findRollout, SESSIONS_DIR };
