// Build demo screenshots from an isolated bridge + the fixture CLI.
// Nothing here touches the real service or the real ~/.codex.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-demo-'));
process.env.CODEX_HOME = path.join(temp, 'codex-home');
process.env.CODEX_GUI_SETTINGS_FILE = path.join(temp, 'settings.json');
process.env.CODEX_GUI_DATA_DIR = path.join(temp, 'data');
process.env.CODEX_GUI_CODEX_PATH = path.join(__dirname, 'test/fixtures/fake-codex.cjs');
process.env.CODEX_GUI_STALL_MS = '800';
fs.writeFileSync(process.env.CODEX_GUI_SETTINGS_FILE, JSON.stringify({
  cwd: temp, proxy: '', model: 'gpt-6.1-sol', permissionMode: 'read-only', theme: 'dark',
}));

const { server } = require('./bridge.cjs');
const OUT_TOP = path.join(__dirname, '.codex-gui', 'demo-1.png');
const OUT_NOTICES = path.join(__dirname, '.codex-gui', 'demo-2.png');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let socket, nextId = 1; const pending = new Map();
function cdp(m, params = {}) {
  return new Promise((res, rej) => {
    const id = nextId++; const t = setTimeout(() => { pending.delete(id); rej(new Error('timeout ' + m)); }, 30000);
    pending.set(id, { resolve: res, reject: rej, timer: t });
    socket.send(JSON.stringify({ id, method: m, params }));
  });
}
async function ev(expression) {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
}
async function waitUI(expression, ms = 25000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if ((await ev(expression)) === true) return true; } catch {} await sleep(120); }
  throw new Error('timeout: ' + expression);
}
const send = async (prompt, waitStatus = '完成') => {
  await ev(`document.getElementById('prompt').value=${JSON.stringify(prompt)};document.getElementById('btnSend').click()`);
  await waitUI(`document.getElementById('status').textContent === ${JSON.stringify(waitStatus)} && !document.getElementById('btnSend').disabled`, 25000);
  await sleep(400);
};
async function shot(file) {
  const s = await cdp('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(s.data, 'base64'));
  console.log('  saved: ' + file);
}

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = 'http://127.0.0.1:' + server.address().port;

  const exe = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((f) => fs.existsSync(f));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-demo-prof-'));
  const browser = spawn(exe, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  const pf = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 120 && !fs.existsSync(pf); i++) await sleep(100);
  const port = fs.readFileSync(pf, 'utf8').split('\n')[0];
  const targets = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  socket = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await once(socket, 'open');
  socket.addEventListener('message', (e) => {
    const m = JSON.parse(e.data); const c = pending.get(m.id); if (!c) return;
    pending.delete(m.id); clearTimeout(c.timer);
    m.error ? c.reject(new Error(m.error.message)) : c.resolve(m.result);
  });
  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1320, height: 900, deviceScaleFactor: 2, mobile: false });
  await cdp('Page.navigate', { url: origin });
  await waitUI("document.getElementById('btnSend') && !document.getElementById('btnSend').disabled");

  // The post-turn refresh rebuilds the feed from disk, and the fixture overwrites
  // one rollout per run -- so for the demo the live transcript is kept instead.
  await ev(`(() => {
    const native = window.fetch;
    window.fetch = function (url) {
      if (String(url).startsWith('/api/history')) {
        return Promise.resolve(new Response(JSON.stringify({ error: 'demo: keep the live transcript' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return native.apply(this, arguments);
    };
    // The isolated app-server cannot list the fixture's sessions, so every turn
    // ends with a "list is empty" note. It is true, it is just not what the demo is
    // about -- presentation only, nothing functional is hidden.
    const style = document.createElement('style');
    style.textContent = '#log .meta { display: none !important; }';
    document.head.appendChild(style);
  })()`);

  // A normal turn: tools, a file-change card, markdown, a table, a code block.
  await send('演示：普通回合');
  // Let the sidebar discover the session, so no "list is empty" notice appears.
  for (let i = 0; i < 20; i++) {
    await ev("document.getElementById('btnRefreshSessions').click()");
    await sleep(700);
    if (Number(await ev("document.querySelectorAll('#sessionList .sess').length")) > 0) break;
  }
  await ev("document.getElementById('log').scrollTop = 0");
  await sleep(400);
  await shot(OUT_TOP);

  // Now the interesting states, all in the same session.
  await send('FAIL_EVENT', '运行失败（退出码 0）');   // red box + retry button
  await send('FLAKY_CAPACITY');                      // silent retry notice
  await send('STDERR_NOISE');                        // folded CLI log card
  await send('SILENT_GAP');                          // stall warning
  // Taller viewport for the states image, anchored on the failed turn so the
  // error box, the retry notice, the log card and the stall notice all fit.
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1320, height: 1550, deviceScaleFactor: 2, mobile: false });
  await sleep(300);
  await ev(`(() => {
    const turns = document.querySelectorAll('#log .row.user');
    const target = turns[1] || turns[0];
    if (target) {
      const log = document.getElementById('log');
      log.scrollTop = target.offsetTop - 12;
    }
  })()`);
  await sleep(500);
  await shot(OUT_NOTICES);

  browser.kill();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  fs.rmSync(temp, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error('  FAILED: ' + e.message); process.exit(1); });
