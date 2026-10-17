// Verify the served page carries the command-grouping and replay behaviour.
// Run after restarting the bridge: the page is read from disk per request.
const http = require('node:http');

const read = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: 8790, path: p }, (r) => {
    let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res(b));
  }).on('error', rej);
});

(async () => {
  const html = await read('/');
  const checks = [
    ['commands are grouped into one card per turn', /cmd-group/],
    ['the group header states how many ran', /grp-count/],
    ['the group header states the outcome', /全部成功/],
    ['a long command is truncated into a peek', /peek\.length > 64/],
    ['the full command lives in the body', /className = 'cmd-line'/],
    ['programmatic open/close is not read as a user action', /consumeScripted/],
    ['a live turn keeps its group open', /programmaticOpen\(toolGroup, true\)/],
    ['a replayed turn starts folded', /addCmd\(\{ \.\.\.m\.item, status: 'completed' \}, true\)/],
    // Prompt jump rail
    ['the jump rail element exists', /jumpRail/],
    ['it renders one dot per prompt', /className = 'jump-dot'/],
    ['hovering a dot previews the input', /function showJumpTip/],
    ['scrolling marks the current prompt', /function updateJumpActive/],
    ['the rail is rebuilt on every session change', /rebuildJumpRail\(\);/],
    ['it is hidden on narrow screens', /max-width:820px/],
    // A collapse the user made must survive later commands in the same turn.
    ['a deliberate close is remembered', /dataset\.userClosed/],
    ['later commands do not re-open it', /toolGroup\.dataset\.userClosed !== '1'/],
    // The meter cannot update mid-turn; it must say the figure is the last turn's.
    ['the meter carries a stale marker', /ctxStaleTag/],
    ['stale figures are dimmed', /#ctxText\.stale/],
    ['a running turn marks it', /markCtxStale\(true\)/],
    // Service uptime: shows whether the backend was restarted (backend edits
    // only take effect after a restart).
    ['the status line has an uptime chip', /id="serverInfo"/],
    ['uptime comes from the service start, not page load', /Date\.parse\(health\.startedAt/],
    ['uptime updates every second', /setInterval\(renderServerInfo, 1000\)/],
    ['a fresh restart is highlighted', /classList\.toggle\('fresh'/],
    // File changes: rendered as tool activity, with the diff when replaying.
    ['file changes render as a card', /function fileChangeBody/],
    ['both live and rollout shapes are accepted', /function normalizeFileChanges/],
    ['the diff is built from text nodes only', /function diffNode/],
    ['diff lines are coloured by kind', /pre\.diff \.dl\.add/],
    ['paths are shown relative to the working directory', /function shortPath/],
  ];
  let ok = 0;
  for (const [label, re] of checks) {
    const hit = re.test(html);
    if (hit) ok++;
    console.log('  ' + (hit ? 'OK  ' : 'MISS') + ' ' + label);
  }
  console.log('\n  ' + ok + '/' + checks.length + ' 项已上线');
  process.exit(ok === checks.length ? 0 : 1);
})().catch((e) => { console.log('ERROR:', e.message); process.exit(1); });
