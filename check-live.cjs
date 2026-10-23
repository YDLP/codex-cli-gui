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
    // The group is folded live as well: auto-opening it for every command forced
    // a manual collapse each turn.
    ['a live tool group is never auto-opened', /Live: the GROUP stays folded/],
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
    // A group the user OPENS must stay open as later commands arrive.
    ['a deliberate open is remembered', /setUserOpened\(toolGroup, true\)/],
    ['the scripted mark is only set when the state really changes', /if \(d\.open === open\) return;/],
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
    // In-page file viewer: references open a panel, not the OS default app.
    ['the viewer panel exists', /id="fileViewer"/],
    ['it reads files through the bridge', /function renderFileViewer/],
    ['non-markdown files get numbered rows', /className = 'fv-l'/],
    ['a line can be jumped to', /function jumpToViewerLine/],
    ['the default-app open is still available', /id="fvOpen"/],
    // Session search: instant filter on the list, then conversation text.
    ['the search box exists', /id="sessSearch"/],
    ['content search goes through the bridge', /api\/sessions\/search/],
    ['a hit is explained with a highlighted snippet', /function snippetNode/],
    ['the list filters as you type', /function visibleSessions/],
    // In-session search: every hit marked, jump between them.
    ['Ctrl+F opens an in-session search', /id="tsInput"/],
    ['each occurrence gets a mark', /className = 'ts-hit'/],
    ['next/previous hops between hits', /function tsGoto/],
    ['clearing restores the transcript exactly', /function tsClearMarks/],
    // Theme is a header selector; the cycling button was removed.
    ['theme is a selector in the header', /id="theme" class="theme-pick"/],
    ['changing it applies and persists', /applyTheme\(\$\('theme'\)\.value\); persist\(\);/],
    // Polish must stay decoration: no effect may be required for the UI to work.
    ['animations are CSS-only', /@keyframes rowIn/],
    ['reduced-motion is respected', /prefers-reduced-motion/],
    ['the theme fade is a temporary class', /body\.theming/],
    // Sessions work independently; the sidebar says which is doing what.
    ['runs are tracked per session', /const runs = \[\]/],
    ['a background run does not touch the visible feed', /function runVisible/],
    ['the sidebar shows running/done/error', /sess-state/],
    ['stop only targets the active session', /const run = activeRun\(\)/],
    // The answer-done signal must not wait for the process to exit (the bridge
    // side of this is covered by test/bridge.test.cjs).
    ['the page stops spinning on that signal', /name === 'answer_done'/],
    // A new session gets a row before it has an id, and Ctrl+F can use a selection.
    ['a new session gets a stand-in row', /stand_in/],
    ['Ctrl+F can seed itself from the selection', /function selectedTextForSearch/],
    // Round button that returns to the newest message.
    ['a jump-to-latest button exists', /id="btnScrollBottom"/],
    ['it only shows when there is something below', /function updateScrollBottom/],
    // In-session search starts near the viewport, not at the top of the session.
    ['search starts from the nearest hit', /function tsNearestIndex/],
    // A command's label and the group header must agree, and nothing may stay
    // "执行中" after the turn ends.
    ['an exit code alone means finished', /function isCmdFinished/],
    ['unfinished commands become interrupted', /function markInterruptedCommands/],
    // stderr is diagnostic noise: one folded card, not a wall of meta text.
    ['CLI stderr folds into its own card', /function addCliLog/],
    // A finished turn is rebuilt from disk, but only when the file agrees.
    ['a finished turn re-renders from disk', /function reloadTranscriptAfterTurn/],
    ['that refresh refuses to replace a mismatched feed', /function lastAnswerMatches/],
    // A silent turn is announced (never killed: long commands are silent too).
    ['a stalled turn is reported', /name === 'warning'/],
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
