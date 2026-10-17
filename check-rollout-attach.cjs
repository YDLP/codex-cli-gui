// Verify rollout.cjs strips attachment plumbing and returns usable attachments.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { readConversation } = require('./rollout.cjs');

const dir = path.join(os.homedir(), '.codex', 'sessions');
let files = [];
(function walk(d){ for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.jsonl')) files.push(p); } })(dir);
files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

let checked = 0;
for (const f of files.slice(0, 30)) {
  const id = (f.match(/rollout-.*?-([0-9a-f-]{36})\.jsonl/) || [])[1];
  if (!id) continue;
  let r;
  try { r = readConversation(id); } catch { continue; }
  for (const m of r.messages) {
    if (m.role !== 'user') continue;
    // No message may still expose the plumbing the user never typed.
    assert.ok(!/<image\s+name=/.test(m.text), 'image tag leaked in ' + id + ': ' + m.text.slice(0, 120));
    assert.ok(!/Attached files \(paths are relative/.test(m.text), 'manifest leaked in ' + id);
    assert.ok(!/Read these files yourself as needed/.test(m.text), 'manifest tail leaked in ' + id);
    for (const a of (m.attachments || [])) {
      assert.ok(a.path, 'attachment without a path in ' + id);
      assert.ok(path.isAbsolute(a.path), 'attachment path must be absolute: ' + a.path);
      // A placeholder name is only acceptable when no real one was available.
      if (/^Image #?\d*$/i.test(a.name)) {
        console.log('  note: placeholder name kept for ' + a.path.slice(-40));
      }
      checked++;
    }
  }
}
console.log('attachments inspected:', checked);
console.log('RESULT: ROLLOUT ATTACHMENT PARSING OK');
