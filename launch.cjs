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
const STATE_DIR = path.join(__dirname, '.codex-gui');
const LOG_FILE = path.join(STATE_DIR, 'bridge.log');
const PID_FILE = path.join(STATE_DIR, 'bridge.pid');

function openBrowser(url) {
  let child;
  if (process.platform === 'win32') child = spawn('cmd', ['/c','start','',url], {windowsHide:true,stdio:'ignore'});
  else child = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], {stdio:'ignore'});
  child.on('error', error => console.warn('Open this URL in your browser: '+url+' ('+error.message+')'));
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
    if (process.env.CODEX_GUI_NO_BROWSER !== '1') openBrowser(url);
    return;
  }
  codexInvocation([]); // fail with actionable installation guidance before spawning

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
      throw new Error('背景服务没有启动成功。请看日志：' + LOG_FILE);
    }
    if (process.env.CODEX_GUI_NO_BROWSER !== '1') openBrowser(url);
    return;
  }

  const child = spawn(process.execPath,[path.join(__dirname,'bridge.cjs')],{stdio:'inherit',windowsHide:true});
  child.on('error',error=>{console.error(error.message);process.exitCode=1;});
  child.on('close',code=>{process.exitCode=code??1;});
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
