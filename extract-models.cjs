// Refresh the catalog without opening a public RPC port or making inference calls.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { codexInvocation, proxyEnv } = require('./codex-process.cjs');
const appserver = require('./appserver.cjs');

function fromDebug(proxy) {
  const invocation = codexInvocation(['debug', 'models']);
  const result = spawnSync(invocation.file, invocation.args, {
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 20000,
    windowsHide: true, env: proxyEnv(proxy),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || 'codex debug models failed');
  return JSON.parse(result.stdout).models.filter((m) => m.visibility === 'list').map((m) => ({
    slug: m.slug, name: m.display_name || m.slug, description: m.description || '',
    defaultEffort: m.default_reasoning_level || '',
    contextWindow: m.context_window ?? null, maxContextWindow: m.max_context_window ?? null,
    usableContextWindow: typeof m.context_window === 'number'
      ? Math.floor(m.context_window * (m.effective_context_window_percent ?? 100) / 100) : null,
    efforts: (m.supported_reasoning_levels || []).map((e) => ({ value: e.effort, description: e.description || '' })),
  }));
}

function mergeCatalog(rpc, debug) {
  const facts = new Map((debug || []).map((m) => [m.slug, m]));
  // When RPC succeeds its visible list defines the selector; debug only adds
  // context-window facts. Neither list guarantees account entitlement.
  if (!rpc?.length) return debug || [];
  return rpc.filter((m) => !m.hidden).map((m) => {
    const slug = m.model || m.id;
    const d = facts.get(slug);
    return { ...(d || {}), slug, name: m.displayName || slug,
      description: m.description || '', defaultEffort: m.defaultReasoningEffort || '',
      contextWindow: d?.contextWindow ?? null, maxContextWindow: d?.maxContextWindow ?? null,
      usableContextWindow: d?.usableContextWindow ?? null,
      efforts: (m.supportedReasoningEfforts || []).map((e) => ({ value: e.reasoningEffort, description: e.description || '' })),
    };
  });
}

async function main() {
  let proxy;
  try { proxy = JSON.parse(fs.readFileSync(path.join(__dirname, 'settings.json'), 'utf8')).proxy; } catch {}
  let rpc = null, debug = null;
  try {
    try { rpc = (await appserver.withClient((call) => call('model/list', {}), { proxy })).data; }
    catch (e) { console.warn('model/list unavailable: ' + e.message); }
    try { debug = fromDebug(proxy); }
    catch (e) { console.warn('debug catalog unavailable: ' + e.message); }
    const models = mergeCatalog(rpc, debug);
    if (!models.length) throw new Error('No model catalog available; existing models.json was preserved');
    const catalog = { generatedAt: new Date().toISOString(), source: 'Codex model catalog (not an entitlement check)', models };
    const output = path.join(__dirname, 'models.json');
    const temporary = output + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(catalog, null, 2), 'utf8');
    fs.renameSync(temporary, output);
    console.log('Updated ' + models.length + ' models in ' + output);
  } finally { appserver.killServer(); }
}
if (require.main === module) main().catch((e) => { console.error(e.message); process.exitCode = 1; });
module.exports = { mergeCatalog };
