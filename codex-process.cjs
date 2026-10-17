// Shared, shell-free Codex invocation. Prompts and paths never pass via cmd.exe.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

function codexInvocation(args) {
  const explicit = process.env.CODEX_GUI_CODEX_PATH;
  const candidates = explicit ? [explicit] : [
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
    ...String(process.env.PATH || '').split(path.delimiter).flatMap((dir) => [
      path.join(dir, process.platform === 'win32' ? 'codex.exe' : 'codex'),
      path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
    ]),
  ];
  for (const file of candidates) {
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
    return /\.[cm]?js$/i.test(file)
      ? { file: process.execPath, args: [file, ...args] }
      : { file, args };
  }
  throw new Error('找不到 Codex CLI。请安装 @openai/codex，或设置 CODEX_GUI_CODEX_PATH。');
}

function proxyEnv(proxy) {
  const env = { ...process.env };
  if (proxy === '') {
    for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'all_proxy']) delete env[key];
  } else if (proxy) {
    env.HTTPS_PROXY = env.HTTP_PROXY = env.https_proxy = env.http_proxy = proxy;
    env.NO_PROXY = env.no_proxy = 'localhost,127.0.0.1,::1';
  }
  return env;
}

function spawnCodex(args, options = {}) {
  const invocation = codexInvocation(args);
  return spawn(invocation.file, invocation.args, {
    windowsHide: true, detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'], ...options,
  });
}

function killTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => {});
      killer.unref();
    } else {
      try { process.kill(-pid, 'SIGKILL'); } catch { process.kill(pid, 'SIGKILL'); }
    }
  } catch { /* already exited */ }
}

module.exports = { codexInvocation, spawnCodex, proxyEnv, killTree };
