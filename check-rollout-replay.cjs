// Unit test: does rollout.cjs replay commands and reasoning from a rollout file?
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

// Point CODEX_HOME at a scratch dir BEFORE requiring rollout.cjs.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-rollout-test-'));
process.env.CODEX_HOME = temp;
const dir = path.join(temp, 'sessions');
fs.mkdirSync(dir, { recursive: true });

const id = '01a10000-0000-7000-8000-0000000000aa';
const cmd = '"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -Command "Get-Content -LiteralPath \'.codex-gui/attachments/x/N72.jflash\' -Raw"';

fs.writeFileSync(path.join(dir, `rollout-${id}.jsonl`), [
  { type: 'turn_context', payload: { cwd: 'E:\\proj', model: 'gpt-6.1-sol', sandbox_policy: { type: 'read-only' } } },
  { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '看看这个 flash' }] } },
  { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', id: 'exec-1', command: [cmd], status: 'completed', exit_code: 0, aggregated_output: 'OK1' } } },
  { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', id: 'exec-2', command: ['cmd.exe /d /c dir'], status: 'completed', exit_code: 0, aggregated_output: 'OK2' } } },
  { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'Reasoning', id: 'r-1', summary: [{ type: 'summary_text', text: '先读文件' }] } } },
  // The shape MEASURED in real rollouts: an Extension with kind "web.search".
  { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'Extension', kind: 'web.search', id: 'exec-ws-1',
    query: 'codex cli 0.162.1 release notes',
    action: { type: 'search', query: 'codex cli 0.162.1 release notes', queries: null },
    results: [{ type: 'text_result', title: 'Release notes', url: 'https://example.com/x' }] } } },
  // Older/normalized spelling, which must also be accepted.
  { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'WebSearch', id: 'ws-2',
    query: 'second query', action: { type: 'openPage', url: 'https://example.com/y' }, results: null } } },
  // File change. MEASURED rollout shape: `changes` keyed by path, WITH the diff.
  // The live `codex exec --json` event has an array and no diff, so both shapes
  // have to reach the UI (see normalizeFileChanges in index.html).
  { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'FileChange', id: 'exec-fc-1', status: 'completed',
    changes: {
      'E:\\proj\\note.txt': { type: 'update', unified_diff: '@@ -1,2 +1,2 @@\n alpha\n-beta\n+BETA\n', move_path: null },
      'E:\\proj\\new.md': { type: 'add', unified_diff: '@@ -0,0 +1 @@\n+hello\n', move_path: null },
    },
    stdout: 'Success. Updated the following files:', stderr: '' } } },
  { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '读到了' }] } },
].map((r) => JSON.stringify(r)).join('\n'));

const { readConversation } = require('./rollout.cjs');
const r = readConversation(id);

console.log('messages:', r.messages.length);
for (const m of r.messages) {
  console.log('  ' + (m.kind || 'message').padEnd(10) + (m.role || '-').padEnd(10) +
    JSON.stringify((m.text || m.item?.command || m.item?.text || '').slice(0, 55)));
}

const kinds = r.messages.map((m) => m.kind || 'message');
assert.deepEqual(kinds, ['message', 'command', 'command', 'reasoning', 'web_search', 'web_search', 'file_change', 'message'],
  'commands, reasoning, web searches and file changes must be replayed in order');

// File changes: the rollout keys `changes` by path and DOES include the diff, so
// replay must carry it through -- that is the only place a diff exists at all.
const fc = r.messages.find((m) => m.kind === 'file_change');
assert.ok(fc, 'a FileChange item must replay');
assert.equal(fc.item.type, 'file_change', 'the replayed item uses the live event name');
assert.equal(fc.item.status, 'completed');
assert.equal(fc.item.changes.length, 2, 'both changed paths must survive');
const byPath = Object.fromEntries(fc.item.changes.map((c) => [c.path, c]));
assert.equal(byPath['E:\\proj\\note.txt'].type, 'update');
assert.equal(byPath['E:\\proj\\note.txt'].unified_diff.includes('+BETA'), true,
  'the unified diff must be replayed: ' + JSON.stringify(byPath['E:\\proj\\note.txt']));
assert.equal(byPath['E:\\proj\\new.md'].type, 'add');

const searches = r.messages.filter((m) => m.kind === 'web_search');
assert.equal(searches.length, 2, 'both spellings must be recognised');
const ws = searches[0];
assert.equal(ws.item.query, 'codex cli 0.162.1 release notes');
assert.equal(ws.item.action.type, 'search');
assert.equal(ws.item.type, 'web_search', 'the replayed item uses the live event name');
assert.equal(ws.item.results.length, 1, 'search results must be carried through');
assert.equal(searches[1].item.action.type, 'openPage');

const c1 = r.messages.find((m) => m.item?.id === 'exec-1');
assert.equal(c1.item.command, cmd, 'the argv array must be joined into a command line');
assert.equal(c1.item.exit_code, 0);
assert.equal(c1.item.aggregated_output, 'OK1');
assert.equal(c1.item.status, 'completed');

assert.equal(r.messages.find((m) => m.kind === 'reasoning').item.text, '先读文件');
assert.equal(r.messages.at(-1).text, '读到了');
assert.equal(r.cwd, 'E:\\proj');

console.log('\nRESULT: ROLLOUT REPLAYS COMMANDS AND REASONING');
fs.rmSync(temp, { recursive: true, force: true });
