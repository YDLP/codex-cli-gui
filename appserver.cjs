// Metadata only; exec owns conversation writers. Private stdio RPC avoids fixed
// ports and connecting to another application's app-server process.
const readline = require('node:readline');
const { spawnCodex, proxyEnv, killTree } = require('./codex-process.cjs');
const CALL_TIMEOUT_MS = 20000;
let connection = null;
let connecting = null;
let nextId = 1;

function dispose(conn, error = new Error('app-server stopped')) {
  if (!conn || conn.closed) return;
  conn.closed = true;
  for (const p of conn.pending.values()) { clearTimeout(p.timer); p.reject(error); }
  conn.pending.clear();
  conn.lines.close();
  conn.child.stdin.destroy();
  killTree(conn.child.pid);
  if (connection === conn) connection = null;
}
function killServer() { dispose(connection); }
process.on('exit', killServer);

function request(conn, method, params = {}) {
  return new Promise((resolve, reject) => {
    if (conn.closed || !conn.child.stdin.writable) return reject(new Error('app-server not connected'));
    const id = nextId++;
    const timer = setTimeout(() => {
      conn.pending.delete(id);
      reject(new Error('timeout calling ' + method));
      dispose(conn);
    }, CALL_TIMEOUT_MS);
    conn.pending.set(id, { resolve, reject, timer });
    conn.child.stdin.write(JSON.stringify({ method, id, params }) + '\n');
  });
}

async function connect(proxy) {
  if (connecting) await connecting;
  if (connection && !connection.closed && (proxy === undefined || connection.proxy === proxy)) return connection;
  dispose(connection);
  connecting = (async () => {
    const child = spawnCodex(['app-server', '--listen', 'stdio://'], { env: proxyEnv(proxy) });
    const conn = { child, proxy, pending: new Map(), closed: false };
    conn.lines = readline.createInterface({ input: child.stdout });
    connection = conn;
    child.stderr.resume();
    child.on('error', (e) => dispose(conn, e));
    child.on('close', () => dispose(conn, new Error('app-server disconnected')));
    child.stdin.on('error', (e) => dispose(conn, e));
    conn.lines.on('line', (line) => {
      let msg; try { msg = JSON.parse(line); } catch { return; }
      if (msg.method && msg.id !== undefined) {
        if (child.stdin.writable) child.stdin.write(JSON.stringify({ id: msg.id,
          error: { code: -32601, message: 'This client supports metadata operations only' } }) + '\n');
        return;
      }
      const pending = conn.pending.get(msg.id);
      if (!pending) return;
      conn.pending.delete(msg.id); clearTimeout(pending.timer);
      msg.error ? pending.reject(new Error(msg.error.message || JSON.stringify(msg.error))) : pending.resolve(msg.result);
    });
    try {
      await request(conn, 'initialize', { clientInfo: { name: 'codex_gui', title: 'Codex GUI', version: '1.1.0' } });
      child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
      return conn;
    } catch (e) { dispose(conn, e); throw e; }
  })();
  try { return await connecting; } finally { connecting = null; }
}

async function withClient(fn, { proxy } = {}) {
  const conn = await connect(proxy);
  return fn((method, params) => request(conn, method, params));
}

const SOURCE_KINDS = ['exec', 'cli', 'vscode', 'appServer'];
async function listSessions({ limit = 60, cwd = '', proxy } = {}) {
  return withClient(async (rpc) => {
    const res = await rpc('thread/list', { sourceKinds: SOURCE_KINDS,
      sortKey: 'updated_at', sortDirection: 'desc', limit,
      ...(cwd ? { cwd } : {}) });
    return (res?.data || []).map((t) => {
      let preview = (t.preview || '').trim();
      const cut = preview.indexOf('\n\n---\n');
      if (cut >= 0) preview = preview.slice(0, cut).trim();
      if (preview.length > 160) preview = preview.slice(0, 160) + '…';
      return { id: t.id, title: (t.name || '').trim(), preview,
        createdAt: t.createdAt ?? null, updatedAt: t.updatedAt ?? null,
        cwd: t.cwd || '', model: t.model || '', source: t.source || '' };
    });
  }, { proxy });
}
async function deleteSession(threadId, options) {
  return withClient((rpc) => rpc('thread/delete', { threadId }), options);
}
async function renameSession(threadId, name, options) {
  return withClient((rpc) => rpc('thread/name/set', { threadId, name }), options);
}
module.exports = { listSessions, deleteSession, renameSession, withClient, killServer, SOURCE_KINDS };
