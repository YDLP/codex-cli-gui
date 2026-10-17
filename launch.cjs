// Launch safely or reuse a verified GUI service. Port occupancy alone does not
// establish that another listener is this application.
//
// Two modes:
//   node launch.cjs            foreground -- the bridge shares this console, so
//                              closing the console stops it (handy when debugging)
//   node launch.cjs --detach   background -- the bridge is spawned DETACHED with
//                              its own log file, so closing any window cannot
//                              kill the service. This is what the desktop
//                              shortcut uses.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { codexInvocation } = require('./codex-process.cjs');

const DETACH = process.argv.includes('--detach') || process.env.CODEX_GUI_DETACH === '1';
/**
 * Do not open a browser; the caller will.
 *
 * start-hidden.vbs passes this: it runs node with window style SW_HIDE, and that
 * show state is inherited by anything node spawns, so a browser opened from here
 * got an INVISIBLE window. The VBS opens the page itself with a normal window.
 */
const NO_BROWSER = process.argv.includes('--no-browser') || process.env.CODEX_GUI_NO_BROWSER === '1';
const STATE_DIR = path.join(__dirname, '.codex-gui');
const LOG_FILE = path.join(STATE_DIR, 'bridge.log');
const PID_FILE = path.join(STATE_DIR, 'bridge.pid');

/**
 * Find the executable registered to handle http(s) links.
 *
 * Returns `{ exe, chromium }` or null. Chromium-family browsers are worth
 * detecting separately: launching them with `--new-window` guarantees a visible
 * window, whereas re-opening an already-open URL can just reload the existing tab
 * and leave a minimised window minimised -- measured as "double-click does
 * nothing", even though a request does reach the server.
 */
function defaultBrowser() {
  if (process.platform !== 'win32') return null;
  try {
    const { execFileSync } = require('node:child_process');
    const reg = (...args) => execFileSync('reg', args, { encoding: 'utf8', windowsHide: true, timeout: 4000 });
    // A named value: `reg query <key> /v <name>`.
    const namedValue = (key, name) => {
      const out = reg('query', key, '/v', name);
      const m = out.match(new RegExp(name + '\\s+REG_SZ\\s+(.+)', 'i'));
      return m ? m[1].trim() : '';
    };
    // The DEFAULT value needs /ve; /v "(Default)" does not work.
    const defaultValue = (key) => {
      const out = reg('query', key, '/ve');
      const m = out.match(/REG_SZ\s+(.+)/i);
      return m ? m[1].trim() : '';
    };
    const progId = namedValue('HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice', 'ProgId');
    if (!progId) return null;
    const raw = defaultValue('HKCR\\' + progId + '\\shell\\open\\command');
    if (!raw) return null;
    const exeMatch = raw.match(/^"([^"]+\.exe)"/i) || raw.match(/^([^\s]+\.exe)/i);
    if (!exeMatch) return null;
    const exe = exeMatch[1];
    if (!fs.existsSync(exe)) return null;
    const chromium = /(msedge|chrome|brave|vivaldi|chromium)\.exe$/i.test(exe);
    return { exe, chromium };
  } catch {
    return null;
  }
}

function openBrowser(url) {
  let child;
  if (process.platform === 'win32') {
    const browser = defaultBrowser();
    if (browser && browser.chromium){
      // A new window is visible even when the browser is minimised or already
      // showing the same URL in a background tab.
      child = spawn(browser.exe, ['--new-window', url], { windowsHide: false, stdio: 'ignore' });
      logAttempt('opening browser (new window): ' + browser.exe);
    } else {
      child = spawn('cmd', ['/c','start','',url], {windowsHide:true,stdio:'ignore'});
      logAttempt('opening browser (start): ' + (browser ? browser.exe : 'shell default'));
    }
  } else {
    child = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], {stdio:'ignore'});
    logAttempt('opening browser: ' + (process.platform === 'darwin' ? 'open' : 'xdg-open'));
  }
  child.on('error', error => {
    logAttempt('FAIL  could not open a browser: ' + error.message);
    console.warn('Open this URL in your browser: '+url+' ('+error.message+')');
  });
  child.on('exit', (code, signal) => {
    logAttempt('browser process exited code=' + code + ' signal=' + signal);
  });
  child.unref();
}

/**
 * Start the bridge fully detached from this process and its console.
 *
 * `detached` + `unref` + ignored stdio are all needed: without them Windows keeps
 * the child in the same console/job, and closing that window kills the service --
 * which is exactly the failure this mode exists to prevent.
 */
function startDetached() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const log = fs.openSync(LOG_FILE, 'a');
  fs.writeSync(log, '\n=== ' + new Date().toISOString() + ' starting ===\n');
  const child = spawn(process.execPath, [path.join(__dirname, 'bridge.cjs')], {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', log, log],
    cwd: __dirname,
  });
  child.unref();
  fs.writeFileSync(PID_FILE, String(child.pid), 'utf8');
  console.log('Codex GUI started in the background (pid ' + child.pid + ')');
  console.log('  log : ' + LOG_FILE);
  console.log('  stop: run stop-codex-gui.cmd');
  return child.pid;
}

/**
 * Append one line to .codex-gui/launch.log.
 *
 * When the desktop shortcut runs this file through wscript there is NO console,
 * so anything printed here is discarded -- "I double-clicked and nothing
 * happened" then has no evidence at all. Every exit path records its outcome.
 */
function logAttempt(message) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace('T', ' ').replace('Z', '');
    fs.appendFileSync(path.join(STATE_DIR, 'launch.log'), `launcher  ${stamp}  ${message}\n`, 'utf8');
  } catch { /* logging must never break launching */ }
}

async function main() {
  const port = Number(process.env.CODEX_GUI_PORT || 8790);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('CODEX_GUI_PORT must be between 1 and 65535');
  const url = 'http://127.0.0.1:'+port;
  let response;
  try { response = await fetch(url+'/api/health', {signal:AbortSignal.timeout(1500)}); }
  catch { /* no listener yet */ }
  if (response) {
    const health = await response.json().catch(() => null);
    if (!response.ok || !health?.ok || !health.capabilities?.sessions) throw new Error('Port '+port+' is occupied by another application');
    if (!health.capabilities.scopedStop) console.log('An older Codex GUI is running. Finish its task, close its console, then launch again.');
    else console.log('Codex GUI '+(health.version||'')+' is already running: '+url);
    logAttempt('already running pid=' + (health.pid ?? '?') + ' -> opening browser');
    if (!NO_BROWSER) openBrowser(url);
    else logAttempt('browser opening delegated to the caller (--no-browser)');
    return;
  }
  codexInvocation([]); // fail with actionable installation guidance before spawning
  logAttempt('no service on :' + port + ' -> starting a detached bridge');

  if (DETACH) {
    startDetached();
    // Give it a moment to bind, then open the browser -- only on success, so a
    // failed start does not leave the user staring at a dead tab.
    const deadline = Date.now() + 8000;
    let ok = false;
    while (Date.now() < deadline) {
      try {
        const h = await (await fetch(url + '/api/health', { signal: AbortSignal.timeout(800) })).json();
        if (h && h.app === 'codex-local-gui') { ok = true; break; }
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 120));
    }
    if (!ok) {
      logAttempt('FAIL  the detached service never became healthy');
      throw new Error('背景服务没有启动成功。请看日志：' + LOG_FILE);
    }
    logAttempt('service is up');
    if (!NO_BROWSER) openBrowser(url);
    return;
  }

  const child = spawn(process.execPath,[path.join(__dirname,'bridge.cjs')],{stdio:'inherit',windowsHide:true});
  child.on('error',error=>{console.error(error.message);process.exitCode=1;});
  child.on('close',code=>{process.exitCode=code??1;});
}
if(require.main===module) main().catch(error => {
  logAttempt('FAIL  ' + error.message);
  console.error(error.message);
  process.exitCode = 1;
});

module.exports = { defaultBrowser, logAttempt };
