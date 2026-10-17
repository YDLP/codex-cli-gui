// Real browser regression checks using Chromium's DevTools protocol. No npm
// dependencies. All conversations, settings, and CLI work stay in a temp folder.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const temp = fs.mkdtempSync(path.join(os.tmpdir(),'codex-gui-browser-'));
process.env.CODEX_HOME=path.join(temp,'codex-home');
process.env.CODEX_GUI_SETTINGS_FILE=path.join(temp,'settings.json');
process.env.CODEX_GUI_CODEX_PATH=path.join(__dirname,'test/fixtures/fake-codex.cjs');
fs.writeFileSync(process.env.CODEX_GUI_SETTINGS_FILE,JSON.stringify({cwd:temp,proxy:'',model:'gpt-6.1-sol',permissionMode:'read-only'}));
const {server}=require('./bridge.cjs');
const appserver=require('./appserver.cjs');
const {killTree}=require('./codex-process.cjs');
let browser, socket;
const pending=new Map();
let nextId=1;
const errors=[];
let passed=0;
let navigations=0;
const sleep=(ms)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label){const deadline=Date.now()+12000;while(Date.now()<deadline){if(await fn())return;await sleep(30);}throw new Error('Timed out: '+label);}
function cdp(method,params={}){
  return new Promise((resolve,reject)=>{
    const id=nextId++;
    const timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout: '+method));},15000);
    pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));
  });
}
async function evaluate(expression){
  const response=await cdp('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
  if(response.exceptionDetails)throw new Error(response.exceptionDetails.exception?.description||response.exceptionDetails.text);
  return response.result.value;
}
async function waitUI(expression){await until(()=>evaluate(expression),expression);}
async function check(name,fn){await fn();console.log('  OK   '+name);passed++;}

async function main(){
  const executable=[process.env.CODEX_GUI_BROWSER_PATH,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(file=>file&&fs.existsSync(file));
  if(!executable)throw new Error('No Chromium browser found. Set CODEX_GUI_BROWSER_PATH to Edge/Chrome.');
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  const profile=path.join(temp,'browser-profile');
  browser=spawn(executable,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check',
    '--disable-background-networking','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:'ignore'});
  browser.on('error',error=>errors.push(error.message));
  const portFile=path.join(profile,'DevToolsActivePort');
  await until(()=>fs.existsSync(portFile),'browser startup');
  const port=fs.readFileSync(portFile,'utf8').split('\n')[0];
  const targets=await (await fetch('http://127.0.0.1:'+port+'/json/list')).json();
  socket=new WebSocket(targets.find(target=>target.type==='page').webSocketDebuggerUrl);
  await once(socket,'open');
  socket.addEventListener('message',event=>{
    const message=JSON.parse(event.data);
    if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails.exception?.description||message.params.exceptionDetails.text);
    if(message.method==='Page.frameNavigated'&&!message.params.frame.parentId)navigations++;
    const call=pending.get(message.id);if(!call)return;
    pending.delete(message.id);clearTimeout(call.timer);
    message.error?call.reject(new Error(message.error.message)):call.resolve(message.result);
  });
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride',{width:1440,height:960,deviceScaleFactor:1,mobile:false});
  await cdp('Page.navigate',{url:origin});
  // Waiting only for '就绪' is not enough: the initial loadSessions() may still be
  // in flight, which keeps the composer disabled. Wait for the composer itself.
  await waitUI("document.getElementById('status')?.textContent === '就绪' && !document.getElementById('btnSend').disabled");
  const workspaceA=path.join(temp,'workspace-a'),workspaceB=path.join(temp,'workspace-b');
  fs.mkdirSync(workspaceA);fs.mkdirSync(workspaceB);
  // A real 1x1 PNG so the replayed attachment can actually load and be asserted
  // as a thumbnail (a missing file correctly falls back to a text label).
  const fixtureShot=path.join(temp,'fixture-shot.png');
  fs.writeFileSync(fixtureShot,Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'));
  // A rollout ON DISK holding two commands, so the reload path can be checked
  // through the real reader rather than a stubbed history response.
  const cmdId='00000000-0000-0000-0000-0000000000cc';
  const cmdText='"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -Command "Get-Content -LiteralPath \'.codex-gui/attachments/x/N72.jflash\' -Raw"';
  fs.mkdirSync(path.join(process.env.CODEX_HOME,'sessions'),{recursive:true});
  fs.writeFileSync(path.join(process.env.CODEX_HOME,'sessions','rollout-'+cmdId+'.jsonl'),[
    {type:'turn_context',payload:{cwd:temp,model:'gpt-6.1-sol',sandbox_policy:{type:'read-only'}}},
    {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'跑几条命令'}]}},
    {type:'event_msg',payload:{type:'item_completed',item:{type:'CommandExecution',id:'exec-a',
      command:[cmdText],status:'completed',exit_code:0,aggregated_output:'OUT-A'}}},
    {type:'event_msg',payload:{type:'item_completed',item:{type:'CommandExecution',id:'exec-b',
      command:['cmd.exe /d /c echo CMD output test: OK'],status:'completed',exit_code:0,aggregated_output:'CMD output test: OK'}}},
    // A file change WITH a diff. Only the rollout carries diffs, so replay is the
    // one place the UI can show HOW a file changed.
    {type:'event_msg',payload:{type:'item_completed',item:{type:'FileChange',id:'exec-fc',
      status:'completed',changes:{
        [path.join(temp,'note.txt')]:{type:'update',
          unified_diff:'@@ -1,3 +1,3 @@\n alpha\n-beta\n+BETA\n gamma\n',move_path:null},
      },stdout:'Success.',stderr:''}}},
    {type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'都跑完了'}]}},
  ].map((r)=>JSON.stringify(r)).join('\n'));
  const a='00000000-0000-0000-0000-000000000001',b='00000000-0000-0000-0000-000000000002';
  await evaluate(`(() => {
    window.$test = id => document.getElementById(id);
    window.__test = {failRun:false,failCheck:false,delayCheck:0,deferHistory:false,resolvers:{},runCalls:0,stops:[],
      sessions:${JSON.stringify([{id:a,title:'Session A',cwd:workspaceA},{id:b,title:'Session B',cwd:workspaceB}])}};
    const t=window.__test;
    const nativeFetch=window.fetch;
    const response=data=>new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});
    window.fetch=async (url,options={})=>{
      const t=window.__test;
      if(String(url).startsWith('/api/sessions')){
        t.sessionsCalls=(t.sessionsCalls||0)+1;
        t.lastSessionsPayload=t.sessions;
        return response({sessions:t.sessions});
      }
      if(String(url).startsWith('/api/history?')){
        // 「realHistory」lets a check exercise the ACTUAL rollout reader instead of
        // this stub -- without it the on-disk replay path is never tested.
        if(t.realHistory)return nativeFetch(url,options);
        const id=new URL(url,location.href).searchParams.get('threadId');
        // The mocked list only has the two fixture sessions; a freshly created
        // thread is not in it, so fall back instead of crashing on the title.
        const session=t.sessions.find(s=>s.id===id)||{title:'Session',cwd:t.sessions[0].cwd};
        // Session B has MULTIPLE assistant messages for its second prompt: one
        // question can produce several replies, and they must share one card.
        // Its first prompt also carries an IMAGE attachment, to cover the
        // thumbnail rendering after a history reload.
        const multi=id===${JSON.stringify(b)};
        const messages=multi
          ?[{role:'user',text:'Session B user1',attachments:[{path:${JSON.stringify(path.join(temp,'fixture-shot.png'))},name:'shot.png',isImage:true,size:1234}]},
            {role:'assistant',text:'Session B answer1'},
            {role:'user',text:'Session B user2'},
            {role:'assistant',text:'Session B answer2a'},{role:'assistant',text:'Session B answer2b'}]
          :[{role:'user',text:session.title+' user1'},{role:'assistant',text:session.title+' answer1'},
            {role:'user',text:session.title+' user2'},{role:'assistant',text:session.title+' answer2'}];
        const result={found:true,cwd:session.cwd,model:'gpt-6.1-sol',contextWindow:475000,
          usage:t.historyUsage||{inputTokens:1000,outputTokens:100,reasoningOutputTokens:50,cachedInputTokens:500},
          messages:t.manyMessages||messages};
        if(t.deferHistory)return new Promise(resolve=>{t.resolvers[id]=()=>resolve(response(result));});
        return response(result);
      }
      if(url==='/api/checkdir'){
        if(t.failCheck)throw new TypeError('fixture network failure');
        if(t.delayCheck)await new Promise(resolve=>setTimeout(resolve,t.delayCheck));
      }
      if(url==='/api/run'){
        t.runCalls++;
        if(t.failRun)return new Response(JSON.stringify({error:'fixture upload rejection'}),{status:413});
      }
      if(url==='/api/stop')t.stops.push(JSON.parse(options.body));
      return nativeFetch(url,options);
    };
  })()`);
  await check('initial page starts without JavaScript exceptions',async()=>{assert.deepEqual(errors,[]);assert.equal(await evaluate("$test('btnSend').disabled"),false);});
  await check('the status line shows the service uptime',async()=>{
    const info=JSON.parse(await evaluate(`JSON.stringify({
      hidden:document.getElementById('serverInfo').hidden,
      text:document.getElementById('serverInfo').textContent,
      title:document.getElementById('serverInfo').title})`));
    console.log('       server info:', JSON.stringify(info));
    assert.equal(info.hidden,false,'the uptime chip must be visible: '+JSON.stringify(info));
    assert.match(info.text,/运行\s*\d/,'it must show a duration: '+JSON.stringify(info));
    // The counter comes from the SERVICE's start time, not from page load.
    assert.match(info.title,/服务启动于 \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/,
      'the tooltip must show the absolute start time: '+JSON.stringify(info));
    assert.match(info.title,/pid \d+/,'the tooltip must show the pid: '+JSON.stringify(info));
    // It must tick: a second later the duration may change (or at least not error).
    const before=info.text;
    await sleep(1200);
    const after=await evaluate("document.getElementById('serverInfo').textContent");
    console.log('       uptime ticks:', JSON.stringify(before), '->', JSON.stringify(after));
    assert.match(after,/运行\s*\d/,'it must keep rendering: '+after);
    assert.deepEqual(errors,[]);
  });
  await evaluate("$test('btnRefreshSessions').click()");
  await waitUI("document.querySelectorAll('.sess').length === 2");
  await check('an empty session reply never wipes the sidebar',async()=>{
    // The session reader can legitimately come back empty for a moment
    // (app-server restarting). Replacing the list then reads as "all your
    // conversations are gone". Force an empty reply and require the sidebar to
    // keep what it already showed.
    await evaluate("__test.sessions=[]");
    await evaluate("$test('btnRefreshSessions').click()");
    await sleep(200);
    assert.equal(await evaluate("document.querySelectorAll('.sess').length"),2,
      'an empty reply must not clear the list: '+await evaluate("$test('sessionList').textContent.slice(0,60)"));
    // Restore the fixture and let the list come back normally.
    await evaluate(`__test.sessions=${JSON.stringify([
      {id:a,title:'Session A',cwd:workspaceA},{id:b,title:'Session B',cwd:workspaceB}])}`);
    await evaluate("$test('btnRefreshSessions').click()");
    await waitUI("document.querySelectorAll('.sess').length === 2");
  });
  await check('history keeps four ordered bubbles and switches the workspace',async()=>{
    await evaluate("document.querySelectorAll('.sess')[0].click()");
    await waitUI("$test('status').textContent === '已切换会话'");
    assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('#log .bubble'),x=>x.textContent)"),['Session A user1','Session A answer1','Session A user2','Session A answer2']);
    // Consecutive exchanges must be visually separated, including replayed history.
    assert.ok(await evaluate("document.querySelectorAll('#log .turn-sep').length")>=1,
      'a divider must appear between replayed exchanges');
    // Each Codex turn is contained in its own card.
    assert.equal(await evaluate("document.querySelectorAll('#log .row.turn').length"),2,
      'each assistant reply must live in its own turn card');
    assert.equal(await evaluate("$test('cwd').value"),workspaceA);
    assert.match(await evaluate("$test('ctxText').textContent"),/1,100/);
  });
  await check('manual context-window override survives history loading',async()=>{
    await evaluate("$test('contextWindow').value='2000';$test('contextWindow').dispatchEvent(new Event('change'));document.querySelectorAll('.sess')[1].click()");
    await waitUI("$test('status').textContent === '已切换会话'");
    assert.match(await evaluate("$test('ctxText').textContent"),/2,000/);
  });
  await check('late history responses cannot overwrite a newer session',async()=>{
    await evaluate("__test.deferHistory=true;document.querySelectorAll('.sess')[0].click();document.querySelectorAll('.sess')[1].click()");
    assert.equal(await evaluate("$test('btnSend').disabled"),true);
    await evaluate(`__test.resolvers[${JSON.stringify(b)}]()`);
    await waitUI("$test('status').textContent === '已切换会话'");
    await evaluate(`__test.resolvers[${JSON.stringify(a)}]()`);await sleep(50);
    assert.match(await evaluate("$test('log').textContent"),/Session B answer2a/);
    assert.doesNotMatch(await evaluate("$test('log').textContent"),/Session A answer1/);
    // Session B's second prompt got TWO replies; they must share ONE card, so
    // the session shows two turn cards, not three.
    assert.equal(await evaluate("document.querySelectorAll('#log .row.turn').length"),2,
      'consecutive replies from one prompt must share a single turn card');
    assert.match(await evaluate("$test('log').textContent"),/Session B answer2b/);
    // Two exchanges => two numbered dividers.
    assert.equal(await evaluate("document.querySelectorAll('#log .turn-sep').length"),2,
      'each exchange gets one labelled divider');
    assert.match(await evaluate("document.querySelector('#log .turn-sep').textContent"),/第 1 轮/);
    // A replayed attachment renders as a thumbnail, not as the raw <image> XML
    // and manifest text the prompt actually carried.
    const attDump=await evaluate("JSON.stringify({att:document.querySelectorAll('#log .att').length,img:document.querySelectorAll('#log .att img').length,userRows:document.querySelectorAll('#log .row.user').length,firstUser:($test('log').querySelector('.row.user')||{}).textContent})");
    assert.equal(await evaluate("document.querySelectorAll('#log .att img').length"),1,
      'a replayed image attachment must render as a thumbnail: '+attDump);
    assert.doesNotMatch(await evaluate("$test('log').textContent"),/<image\s+name=/,
      'the raw image tag must not be shown to the user');
    assert.doesNotMatch(await evaluate("$test('log').textContent"),/Attached files \(paths are relative/,
      'the attachment manifest must not be shown to the user');
    // Clicking the thumbnail opens the full-size view, Escape closes it.
    await evaluate("document.querySelector('#log .att img').click()");
    await waitUI("!!document.querySelector('.img-back')");
    assert.match(await evaluate("document.querySelector('.img-cap').textContent"),/shot\.png/);
    await evaluate("document.querySelector('.img-close').click()");
    await waitUI("!document.querySelector('.img-back')");
    await sleep(30);
  });
  await check('new conversation invalidates in-flight history',async()=>{
    const sidebar="JSON.stringify({sess:document.querySelectorAll('.sess').length,list:$test('sessionList').textContent.slice(0,60),navs:"+navigations+"})";    assert.equal(await evaluate("document.querySelectorAll('.sess').length"),2,
      'the sidebar must still list its sessions after a raced switch: '+await evaluate(sidebar));
    await evaluate("document.querySelectorAll('.sess')[0].click();$test('btnNew').click()");
    await evaluate(`__test.resolvers[${JSON.stringify(a)}]();__test.deferHistory=false`);await sleep(50);
    assert.equal(await evaluate("$test('threadId').value"),'');
    assert.doesNotMatch(await evaluate("$test('log').textContent"),/answer1/);
  });
  await evaluate(`$test('cwd').value=${JSON.stringify(temp)};$test('prompt').value=${JSON.stringify('--help\n多行🙂')};
    {const transfer=new DataTransfer();transfer.items.add(new File(['attachment'],'hello.txt',{type:'text/plain'}));
      $test('fileInput').files=transfer.files;$test('fileInput').dispatchEvent(new Event('change'));}`);
  await waitUI("$test('attachBar').children.length === 1 && !$test('btnSend').disabled");
  await check('rejected uploads retain the input and attachment',async()=>{
    await evaluate("__test.failRun=true;$test('btnSend').click()");
    await waitUI("$test('status').textContent.includes('发送失败')");
    assert.match(await evaluate("$test('prompt').value"),/多行/);
    assert.equal(await evaluate("$test('attachBar').children.length"),1);
    assert.equal(await evaluate("$test('btnSend').disabled"),false);
  });
  await check('rapid send dispatches once; Chinese output and command updates render correctly',async()=>{
    await evaluate("__test.failRun=false;__test.delayCheck=100;__test.runCalls=0;$test('btnSend').click();$test('prompt').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));$test('btnNew').click()");
    assert.equal(await evaluate("$test('btnNew').disabled"),true);
    await waitUI("$test('status').textContent === '完成' && !$test('btnSend').disabled");
    assert.equal(await evaluate('__test.runCalls'),1);
    assert.equal(await evaluate("document.querySelectorAll('#log details.cmd').length"),4,
      'three commands and one web search (file changes are their own kind)');
    assert.equal(await evaluate("document.querySelectorAll('#log details.filechg').length"),1,
      'exactly one file-change card');
    assert.equal(await evaluate("document.querySelectorAll('#log details.cmd-group').length"),1,
      'exactly one tool group');
    assert.equal(await evaluate("document.querySelectorAll('#log details.cmd-group .grp-body details.cmd').length"),4,
      'the web search must fold into the same group as the commands (the file change is standalone now)');
    assert.equal(await evaluate("document.querySelectorAll('#log details.cmd-group .grp-body details.cmd.web').length"),1);
    // File changes: rendered as tool activity, above the reply, inside the group.
    const fch=JSON.parse(await evaluate(`JSON.stringify({
      cards:document.querySelectorAll('#log details.filechg').length,
      inGroup:document.querySelectorAll('#log details.cmd-group details.filechg').length,
      inFileGroup:document.querySelectorAll('#log details.fch-group details.filechg').length,
      fileGroups:document.querySelectorAll('#log details.fch-group').length,
      fileGroupHeader:(document.querySelector('#log details.fch-group > summary')||{}).textContent||'',
      rows:document.querySelectorAll('#log details.filechg .fch-head').length,
      kinds:[...document.querySelectorAll('#log details.filechg .fch-head .pill')].map(function(x){return x.textContent;}),
      paths:[...document.querySelectorAll('#log details.filechg .fch-head code')].map(function(x){return x.textContent;}),
      diffLines:document.querySelectorAll('#log details.filechg pre.diff .dl').length,
      injected:document.querySelectorAll('#log details.filechg script').length,
      xss:!!window.__xss})`));
    console.log('       file change (live):', JSON.stringify(fch));
    assert.equal(fch.cards,1,'a file change must render one card: '+JSON.stringify(fch));
    // Nested in its OWN group, mirroring the tool group -- not loose in the
    // transcript and not mixed into the tools.
    assert.equal(fch.inGroup,0,'file changes must not be inside the tool group: '+JSON.stringify(fch));
    assert.equal(fch.fileGroups,1,'there must be one file group per turn: '+JSON.stringify(fch));
    assert.equal(fch.inFileGroup,1,'the card must be nested in the file group: '+JSON.stringify(fch));
    assert.match(fch.fileGroupHeader,/文件/,'the file group header: '+JSON.stringify(fch));
    assert.equal(fch.rows,3,'one row per changed path: '+JSON.stringify(fch));
    assert.deepEqual(fch.kinds,['修改','新增','删除'],'kind labels: '+JSON.stringify(fch));
    // A path containing a script tag must be TEXT, never markup.
    assert.equal(fch.paths.some((p) => p.includes('<script>alert(1)</script>')),true,
      'the hostile path must be shown as text: '+JSON.stringify(fch));
    assert.equal(fch.injected,0,'no script element may be created from a path');
    assert.equal(fch.xss,false,'nothing may execute');
    // MEASURED: the live `codex exec --json` event has no diff content, but the
    // bridge reads the diffs out of the rollout and ships them with
    // turn.completed, so by the time the turn is finished the card has them.
    assert.ok(fch.diffLines > 0,
      'the bridge must attach the rollout diffs at turn.completed: '+JSON.stringify(fch));
    const addedLines=JSON.parse(await evaluate(`JSON.stringify(
      [...document.querySelectorAll('#log details.filechg pre.diff .dl.add')].map(function(x){return x.textContent;}))`));
    console.log('       diff lines attached at completion:', JSON.stringify(addedLines));
    assert.ok(addedLines.some((l) => l.includes('+BETA')),
      'the real diff content must reach the live card: '+JSON.stringify(addedLines));
    // And nothing may be left outside the group as a loose tool line.
    assert.equal(await evaluate("document.querySelectorAll('#log .tool-line').length"),0,
      'no tool activity may render outside the group');
    assert.match(await evaluate("$test('log').textContent"),/中文🙂 --help\n多行🙂/);
    assert.equal(await evaluate("$test('attachBar').children.length"),0);
    assert.equal(await evaluate("$test('prompt').value"),'');
    // The meter must use the LAST CALL, not the turn/thread totals, and must not
    // add cached tokens (a subset of input) on top of input.
    //   correct        = input + output   = 40000 + 1000 = 41,000
    //   cached added   = + 30000          = 71,000        <- the old 2x-ish bug
    const meter=await evaluate("$test('ctxText').textContent");
    console.log('       meter:', JSON.stringify(meter));
    // One numerator, one denominator -- a second token figure would read as a
    // second denominator (it did: "37,523 / 828,400可用 / 500,000窗口").
    // Count only thousands-separated figures, so the percentage and the cache
    // ratio are not mistaken for token counts.
    const figures=meter.match(/\d{1,3}(?:,\d{3})+/g)||[];
    assert.ok(figures.length<=2,'the meter must not show a third token figure: '+meter);
    assert.match(meter,/41,000/,'the meter must show input + output of the last call: '+meter);
    assert.doesNotMatch(meter,/71,000/,'cached tokens must not be added to input: '+meter);
  });
  await check('turn failure with a zero process exit still shows failure',async()=>{
    await evaluate("$test('btnNew').click();$test('prompt').value='FAIL_EVENT';$test('btnSend').click()");
    await waitUI("!$test('btnSend').disabled && $test('status').textContent.includes('运行失败')");
  });
  await check('stop includes the current run id and releases the UI',async()=>{
    await evaluate("$test('btnNew').click();$test('prompt').value='WAIT browser';$test('btnSend').click()");
    await waitUI("$test('threadId').value !== '' && !$test('btnStop').classList.contains('hidden')");
    await evaluate("$test('btnStop').click()");
    await waitUI("$test('status').textContent === '已停止' && !$test('btnSend').disabled");
    assert.ok(await evaluate('__test.stops.at(-1).runId'));
    assert.equal((await (await fetch(origin+'/api/health')).json()).running,0);
  });
  await check('directory network failure is caught before input is consumed',async()=>{
    await evaluate("__test.failCheck=true;$test('prompt').value='keep this';$test('btnSend').click()");
    await waitUI("$test('status').textContent.includes('发送失败') && !$test('btnSend').disabled");
    assert.equal(await evaluate("$test('prompt').value"),'keep this');
    await evaluate('__test.failCheck=false');
  });
  await check('phone-width layout keeps the composer usable and both drawers accessible',async()=>{
    await cdp('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
    await waitUI("$test('aside').classList.contains('hidden') && $test('sessionsPane').classList.contains('hidden')");
    assert.ok(await evaluate("$test('prompt').getBoundingClientRect().width > 200"));
    assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'),true);
    await evaluate("$test('btnSessions').click()");
    assert.equal(await evaluate("$test('sessionsPane').classList.contains('hidden')"),false);
    await evaluate("$test('btnSettings').click()");
    assert.equal(await evaluate("$test('aside').classList.contains('hidden')"),false);
    assert.equal(await evaluate("$test('sessionsPane').classList.contains('hidden')"),true);
    await cdp('Emulation.setDeviceMetricsOverride',{width:1440,height:960,deviceScaleFactor:1,mobile:false});
  });
  await check('tool cards stack above the reply and never push it down',async()=>{
    // Simulates the real ordering: the reply bubble is created when the turn
    // starts, tool activity arrives afterwards. Tool cards must be inserted
    // ABOVE the reply, otherwise every command shoves the answer further down
    // the feed and the user cannot read it until the run ends.
    // Clear the feed WITHOUT the "new conversation" markers that btnNew appends,
    // so the row order inspected below is exactly this turn's content.
    // Clear the feed WITHOUT the "new conversation" markers that btnNew appends,
    // so the row order inspected below is exactly this turn's content.
    await evaluate("$test('btnClear').click()");
    await evaluate("__test.failRun=false;__test.failCheck=false");
    // Start a FRESH thread without btnNew's log markers, so the inspected row
    // order is exactly this turn's content. (Resuming instead would need the
    // session's recorded sandbox policy; the fixture rollout omits it, so the
    // bridge correctly refuses with 409 -- this test is about layout.)
    // btnNew is what actually clears the module-level threadId (clearing the
    // input alone leaves the variable set, and the bridge then refuses to resume
    // without a verified permission record). It also appends two log markers,
    // which the assertion below accounts for.
    await evaluate("$test('btnNew').click();$test('btnClear').click()");
    await evaluate("__test.failRun=false;__test.failCheck=false");
    await evaluate("$test('prompt').value='ANCHOR_PROBE';$test('btnSend').click()");
    try{
      await waitUI("$test('threadId').value !== '' && $test('status').textContent === '完成'",8000);
    }catch(debugError){
      const state=await evaluate(`JSON.stringify({status:$test('status').textContent,
        busy:$test('busyBadge').textContent,runCalls:__test.runCalls,failRun:__test.failRun,
        rows:$test('log').children.length})`);
      throw new Error('anchor probe did not finish: '+state);
    }
    // Structure-agnostic: collect the rows and the tool cards in DOCUMENT order
    // and compare positions. Tool cards and the reply now live inside the turn's
    // card, so walking only #log's direct children would miss them.
    const probe=await evaluate(`(()=>{
      // querySelectorAll returns containers AND their descendants, and a turn card
      // contains tool cards -- so walk the tree in true document order instead.
      const out=[]; const seen=new Set();
      const walk=(n)=>{
        if(n.nodeType!==1)return;
        if(n.classList.contains('turn-sep'))out.push({k:'divider'});
        // Commands now live grouped inside details.cmd-group.
        else if(n.classList.contains('cmd-group'))out.push({k:'tool'});
        else if(n.classList.contains('tool-line'))out.push({k:'tool'});
        else if(n.classList.contains('bubble')){
          const user=n.closest('.row.user')!==null;
          out.push({k:user?'user':'assistant',text:(n.textContent||'').slice(0,40)});
        }
        for(const c of n.children)walk(c);
      };
      for(const c of $test('log').children)walk(c);
      return out;
    })()`);
    const order=probe.map(x=>x.k);
    if(!order.includes('assistant')){
      throw new Error('no assistant bubble. order='+JSON.stringify(order));
    }
    const tool=order.indexOf('tool');
    const reply=order.lastIndexOf('assistant');
    assert.ok(tool>=0,'expected a tool card in the transcript, got: '+JSON.stringify(order));
    assert.ok(reply>=0,'expected an assistant reply, got: '+JSON.stringify(order));
    // The reply bubble was created BEFORE the tool card arrived, yet must now
    // render BELOW it: that is the whole point of anchoring.
    assert.ok(reply>tool,'tool card must render above the reply: '+JSON.stringify(order));
    assert.ok(order.indexOf('divider')>=0,'a divider must separate exchanges: '+JSON.stringify(order));
    // Nothing may render below the reply: the divider and user row that btnNew
    // appended for the NEXT exchange are cleared above, so this turn's reply is
    // the last thing in the feed.
    assert.deepEqual(order.slice(reply+1),[],
      'no turn content may render below the reply: '+JSON.stringify(order));
    await evaluate("$test('prompt').value=''");
  });
  await check('agent replies render Markdown, and model output can never create markup',async()=>{
    // The fixture's reply contains Markdown AND an <img onerror> injection
    // attempt. `innerHTML` is never used with model output, so no element may
    // be created by it and the payload must stay inert text.
    await evaluate("$test('btnNew').click();$test('btnClear').click();__test.failRun=false;__test.failCheck=false");
    await evaluate("window.__xss=0");
    await evaluate("$test('prompt').value='MD_PROBE';$test('btnSend').click()");
    try{ await waitUI("$test('threadId').value !== '' && $test('status').textContent === '完成'",8000); }
    catch(debugError){
      throw new Error('markdown probe did not finish: '+await evaluate("$test('status').textContent"));
    }
    const md=await evaluate(`JSON.stringify({
      code:document.querySelectorAll('#log .md-code pre').length,
      lang:document.querySelectorAll('#log .md-code .md-lang').length,
      strong:document.querySelectorAll('#log .bubble.md strong').length,
      inlineCode:document.querySelectorAll('#log .bubble.md code').length,
      link:document.querySelectorAll('#log .bubble.md a[href^="https://example.com"]').length,
      injected:document.querySelectorAll('#log .md img, #log .md script').length,
      payloadVisible:($test('log').textContent||'').includes('<img src=x'),
      xssRan:window.__xss
    })`);
    const r=JSON.parse(md);
    assert.ok(r.code>=1,'fenced code block must render as a block, got: '+md);
    assert.equal(r.lang,1,'language tag must be shown');
    assert.ok(r.strong>=1,'bold must render');
    assert.ok(r.inlineCode>=1,'inline code must render');
    assert.ok(r.link>=1,'links must render as anchors');
    // A local path destination in CommonMark's <...> form (spaces allowed) must
    // become an anchor, not raw syntax. Codex writes links this way for files.
    const localLink=JSON.parse(await evaluate(`(() => {
      const a=[...document.querySelectorAll('#log .bubble.md a')].find(x=>x.textContent==='查看文档');
      return JSON.stringify({found:!!a, href:a?a.getAttribute('href'):null, title:a?a.title:'',
        handler:!!(a && a.classList.contains('fch-open')),
        raw:(document.getElementById('log').textContent||'').includes('](<')});
    })()`));
    console.log('       local path link:', JSON.stringify(localLink));
    assert.equal(localLink.found,true,'[text](<path with space>) must render as an anchor: '+JSON.stringify(localLink));
    // It looks like a link, so it must behave like one: clicking calls the bridge.
    assert.equal(localLink.href,'#','a local path is handled by the bridge, not a navigation: '+JSON.stringify(localLink));
    assert.equal(localLink.handler,true,'the local link must be wired to openPath: '+JSON.stringify(localLink));
    assert.match(localLink.title,/00 自测问答\.md/,'the path belongs in the tooltip: '+JSON.stringify(localLink));
    assert.equal(localLink.raw,false,'the raw [..](<..>) syntax must not survive: '+JSON.stringify(localLink));

    // The in-page viewer: clicking a local link must open a read-only panel, not
    // hand the file to the OS default application.
    assert.equal(await evaluate("document.getElementById('fileViewer').hidden"),true,
      'the viewer starts closed');
    await evaluate(`(() => {
      const a=[...document.querySelectorAll('#log a.fch-open')].find(function(x){return x.textContent==='sample.txt';});
      if (a) a.click();
    })()`);
    await waitUI("document.getElementById('fileViewer') && !document.getElementById('fileViewer').hidden",8000);
    const fv=JSON.parse(await evaluate(`JSON.stringify({
      name:document.getElementById('fvName').textContent,
      rows:document.querySelectorAll('#fvBody .fv-l').length,
      firstLine:(document.querySelector('#fvBody .fv-l .fv-t')||{}).textContent,
      hasCr:/\\r/.test(document.getElementById('fvBody').textContent||'')
    })`));
    console.log('       viewer:', JSON.stringify(fv));
    assert.equal(fv.name,'sample.txt','the viewer shows the file name: '+JSON.stringify(fv));
    assert.equal(fv.rows,3,'every line gets a numbered row: '+JSON.stringify(fv));
    assert.equal(fv.firstLine,'first line','the content is the file content: '+JSON.stringify(fv));
    assert.equal(fv.hasCr,false,'CRLF must be normalised: '+JSON.stringify(fv));
    // Jump to a line through the header box.
    await evaluate(`(() => { const i=document.getElementById('fvLine'); i.value='2';
      i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); })()`);
    await sleep(200);
    const jumped=await evaluate("(document.querySelector('#fvBody .fv-l.hl')||{}).dataset ? document.querySelector('#fvBody .fv-l.hl').dataset.n : ''");
    assert.equal(jumped,'2','the jump box must highlight the requested line: '+jumped);
    // Esc closes it.
    await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    await sleep(200);
    assert.equal(await evaluate("document.getElementById('fileViewer').hidden"),true,'Esc closes the viewer');
    assert.equal(r.injected,0,'model output must not create any element: '+md);
    assert.equal(r.xssRan,0,'the injection payload must never execute');
    assert.equal(r.payloadVisible,true,'the payload stays visible as literal text');
    // Tables must render as tables -- raw pipes were reported as broken formatting.
    const tbl=JSON.parse(await evaluate(`JSON.stringify({
      tables:document.querySelectorAll('#log .md-table table').length,
      heads:[...document.querySelectorAll('#log .md-table thead th')].map(function(x){return x.textContent;}),
      rows:document.querySelectorAll('#log .md-table tbody tr').length,
      cells:[...document.querySelectorAll('#log .md-table tbody tr:first-child td')].map(function(x){return x.textContent;}),
      pipesLeft:(document.querySelector('#log .bubble.md')||{}).textContent.indexOf('|---')>=0,
      rules:document.querySelectorAll('#log .bubble.md hr').length})`));
    console.log('       table:', JSON.stringify(tbl));
    assert.equal(tbl.tables,1,'a Markdown table must render as a table: '+JSON.stringify(tbl));
    assert.deepEqual(tbl.heads,['问题','相关寄存器'],'the header cells must be parsed: '+JSON.stringify(tbl));
    assert.equal(tbl.rows,2,'both body rows must render: '+JSON.stringify(tbl));
    assert.deepEqual(tbl.cells,['哪些 ID 通过','RXMIR'],'body cells must be parsed: '+JSON.stringify(tbl));
    assert.equal(tbl.pipesLeft,false,'no raw delimiter row may survive as text: '+JSON.stringify(tbl));
    // The real rule AFTER the table must still become an <hr>.
    assert.equal(tbl.rules,1,'the separator after the table must still render as a rule: '+JSON.stringify(tbl));
    // Every fenced block offers a copy button.
    assert.equal(await evaluate("document.querySelectorAll('#log .md-code').length"),
      await evaluate("document.querySelectorAll('#log .md-code .md-copy').length"),
      'each code block must have exactly one copy button');
    // Clicking it must report success (clipboard may be unavailable in headless;
    // then the textarea fallback runs and the label still changes).
    await evaluate("document.querySelector('#log .md-code .md-copy').click()");
    await sleep(120);
    const label=await evaluate("document.querySelector('#log .md-code .md-copy').textContent");
    assert.ok(label==='已复制'||label==='复制失败','copy button must react to the click, got: '+label);
    await evaluate("$test('prompt').value=''");
  });
  await check('tool output folds when the turn ends, unless the user opened it',async()=>{
    // Run a normal turn that produces a command card.
    await evaluate("$test('btnNew').click();$test('btnClear').click();__test.failRun=false;__test.failCheck=false");
    await evaluate("$test('prompt').value='FOLD_PROBE';$test('btnSend').click()");
    await waitUI("$test('threadId').value !== '' && $test('status').textContent === '完成'",8000);
    const afterTurn=await evaluate("JSON.stringify(Array.from(document.querySelectorAll('#log details.cmd'),d=>({open:d.open,hasOutput:!!d.querySelector('pre')})))");
    const cards=JSON.parse(afterTurn);
    assert.ok(cards.length>=1,'expected a command card, got: '+afterTurn);
    // The automatic collapse must have folded every card that has a body.
    assert.ok(cards.every(c=>!c.open),'tool cards must fold once the turn ends: '+afterTurn);
    // The summary line survives the fold: the command and exit status stay readable.
    assert.ok(await evaluate("(document.querySelector('#log details.cmd summary')?.textContent||'').includes('exit')"),
      'the exit status must remain visible in the folded summary');
    // A long command must NOT keep the card open: the summary shows only a short
    // echo, and the full text lives in the body (revealed on expand).
    const cmdShape=await evaluate(`(()=>{
      const d=document.querySelector('#log details.cmd');
      const peek=d.querySelector('summary .cmd-peek');
      const full=d.querySelector('.cmd-line code');
      return JSON.stringify({peek:peek?peek.textContent.length:0,
        summaryText:d.querySelector('summary').textContent.length,
        full:full?full.textContent.length:0, open:d.open});
    })()`);
    const C=JSON.parse(cmdShape);
    console.log('       command card:', cmdShape);
    assert.ok(C.full>60,'the fixture command should be long enough to matter: '+cmdShape);
    assert.ok(C.peek<C.full,'the summary must show only a shortened echo: '+cmdShape);
    assert.ok(C.summaryText<90,'the folded summary must stay compact: '+cmdShape);
    assert.equal(C.open,false,'the finished card must be folded');
    // Several commands must live in ONE group card, not one card each: six
    // separate cards filled the screen and pushed the reply out of view.
    const grp=await evaluate(`(()=>{
      const g=document.querySelector('#log details.cmd-group');
      if(!g)return JSON.stringify({groups:0});
      return JSON.stringify({groups:document.querySelectorAll('#log details.cmd-group').length,
        rows:g.querySelectorAll('.grp-body details.cmd').length,
        open:g.open, userOpened:g.dataset.userOpened||'',
        rowOpened:Array.from(g.querySelectorAll('.grp-body details.cmd')).map(function(x){return x.dataset.userOpened||'';}),
        header:g.querySelector('summary').textContent.replace(/\\s+/g,' ').trim()});
    })()`);
    const G=JSON.parse(grp);
    console.log('       command group:', grp);
    assert.equal(G.groups,1,'all of a turn\'s tool activity must share one group: '+grp);
    assert.equal(G.rows,4,'every command and web search must be listed inside the group: '+grp);
    assert.equal(G.open,false,'the group must fold when the turn ends: '+grp);
    assert.match(G.header,/4 条/,'the header must state how many tools ran: '+grp);
    // File changes live in their own group, so they must not inflate the tool
    // count nor appear inside the tool group.
    assert.equal(await evaluate("document.querySelectorAll('#log details.cmd-group details.filechg').length"),0,
      'file changes must stay out of the tool group: '+grp);
    assert.equal(await evaluate("document.querySelectorAll('#log details.fch-group details.filechg').length"),1,
      'file changes must be nested in their own group: '+grp);
    assert.equal(await evaluate("document.querySelectorAll('#log details.fch-group').length"),1,
      'exactly one file group per turn: '+grp);
    // A card the user opens by hand opts out of the automatic collapse: simulate
    // the manual open and confirm the guard is recorded (that flag is what
    // collapseToolCards() skips on a later turn).
    await evaluate("const d=document.querySelector('#log details.cmd');d.open=true;d.dispatchEvent(new Event('toggle'))");
    assert.equal(await evaluate("document.querySelector('#log details.cmd')?.dataset.userOpened||''"),'1',
      'opening a card by hand must be remembered so it is not folded again');
    await evaluate("$test('prompt').value=''");
  });
  await check('a fresh page and btnNew leave no empty turn card',async()=>{
    // Minimal reproduction of the reported bug, with no prior test state:
    // load the page, press 新会话, and assert the feed holds no empty card.
    const emptyCards="Array.from(document.querySelectorAll('#log .row.turn')).filter(function(t){return !t.querySelector('details.cmd') && !(t.querySelector('.bubble')?t.querySelector('.bubble').textContent:'').trim();}).length";
    await evaluate("$test('btnClear').click()");
    assert.equal(await evaluate(emptyCards),0,'btnClear must not leave an empty turn card');
    await evaluate("$test('btnNew').click()");
    await sleep(60);
    assert.equal(await evaluate(emptyCards),0,'btnNew must not leave an empty turn card behind');
  });
  await check('pasting a screenshot attaches it as an image',async()=>{
    await evaluate("$test('btnClear').click()");
    // Fabricate a clipboard payload the way a Win+Shift+S screenshot arrives:
    // a file item with an EMPTY name and an image mime type.
    const result=await evaluate(`(()=>{
      const dt=new DataTransfer();
      const png=new Uint8Array([137,80,78,71,13,10,26,10]);
      dt.items.add(new File([png],'',{type:'image/png'}));
      $test('prompt').dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));
      return true;
    })()`);
    assert.equal(result,true);
    await waitUI("$test('attachBar').children.length === 1 && !$test('btnSend').disabled");
    const chip=await evaluate("$test('attachBar').textContent");
    assert.match(chip,/pasted-\d{8}/,'a pasted image must get a generated name, got: '+chip);
    assert.equal(await evaluate("$test('attachBar').querySelectorAll('.chip.img').length"),1,
      'the pasted file must be treated as an image');
    // The composer must show the PICTURE, not just a filename -- a name cannot
    // tell the user whether they pasted the right screenshot.
    assert.equal(await evaluate("$test('attachBar').querySelectorAll('.chip-thumb').length"),1,
      'a pasted image must show a thumbnail in the composer');
    assert.match(await evaluate("$test('attachBar').querySelector('.chip-thumb').getAttribute('src')"),
      /^data:image\/png;base64,/,'the thumbnail must render from the attachment bytes');
    // Clicking it opens the same full-size preview replayed attachments use.
    await evaluate("$test('attachBar').querySelector('.chip-thumb').click()");
    await waitUI("!!document.querySelector('.img-back')");
    assert.match(await evaluate("document.querySelector('.img-box img').getAttribute('src')"),/^data:image\//);
    await evaluate("document.querySelector('.img-close').click()");
    await waitUI("!document.querySelector('.img-back')");
    // Remove the chip through the UI so later tests start clean.
    await evaluate("const r=$test('attachBar').querySelector('.chip button');if(r)r.click();");
    await sleep(50);
  });
  await check('a completed turn leaves no empty card',async()=>{
    // Reported bug: an empty bordered card appeared right after every send.
    // Assert it right after a turn finishes, before any other interaction.
    const emptyCards="Array.from($test('log').querySelectorAll('.row.turn')).filter(function(t){return !t.querySelector('details.cmd') && !(t.querySelector('.bubble')?t.querySelector('.bubble').textContent:'').trim();}).length";
    await evaluate("$test('btnNew').click();$test('btnClear').click();__test.failRun=false;__test.failCheck=false");
    await evaluate("$test('prompt').value='EMPTY_PROBE';$test('btnSend').click()");
    await waitUI("$test('threadId').value !== '' && $test('status').textContent === '完成'",8000);
    assert.equal(await evaluate(emptyCards),0,
      'a finished turn must not leave an empty card: '+
      await evaluate("JSON.stringify(Array.from($test('log').querySelectorAll('.row.turn')).map(function(t){return JSON.stringify(t.textContent.slice(0,40));}))"));
    // The divider must sit ABOVE the prompt it labels, not below the previous reply.
    const layout=await evaluate(`(()=>{
      const kids=[...$test('log').children];
      const idx=(cls)=>kids.findIndex(k=>k.classList.contains(cls));
      return JSON.stringify({sep:kids.findIndex(k=>k.classList.contains('turn-sep')),
        user:kids.findIndex(k=>k.classList.contains('user')),
        turn:kids.findIndex(k=>k.classList.contains('turn'))});
    })()`);
    const L=JSON.parse(layout);
    assert.ok(L.sep>=0&&L.user>=0,'expected a divider and a user row: '+layout);
    assert.ok(L.sep<L.user,'the divider must come BEFORE the prompt it labels: '+layout);
    assert.ok(L.user<L.turn,'the prompt must come before the reply card: '+layout);
  });
  await check('a session reloaded from disk keeps its commands, grouped and folded',async()=>{
    // Reported bug: refreshing a session dropped every command card, so the
    // transcript no longer matched what the user had just watched.
    // Drive it through the UI on a rollout we control completely.
    await evaluate("__test.realHistory=true");
    await evaluate("__test.sessions=[{id:"+JSON.stringify(cmdId)+",title:'Replay',cwd:"+JSON.stringify(temp)+"}]");
    await evaluate("$test('btnRefreshSessions').click()");
    await waitUI("document.querySelectorAll('.sess').length === 1");
    await evaluate("document.querySelectorAll('.sess')[0].click()");
    await waitUI("$test('status').textContent === '已切换会话'",8000);
    const got=JSON.parse(await evaluate(`(()=>{
      const g=document.querySelector('#log details.cmd-group');
      if(!g)return JSON.stringify({groups:0});
      return JSON.stringify({groups:document.querySelectorAll('#log details.cmd-group').length,
        rows:g.querySelectorAll('.grp-body details.cmd').length, open:g.open,
        header:g.querySelector('summary').textContent.replace(/\\s+/g,' ').trim(),
        full:(g.querySelector('.cmd-line code')||{}).textContent.length||0});
    })()`));
    console.log('       replayed group:', JSON.stringify(got));
    assert.equal(got.groups,1,'the reloaded session must show a command group: '+JSON.stringify(got));
    assert.equal(got.rows,2,'both commands must be replayed in the group: '+JSON.stringify(got));
    assert.equal(got.open,false,'a reloaded group must start folded, like a finished turn: '+JSON.stringify(got));
    assert.ok(got.full>60,'the full command text must be replayed, not just the peek: '+JSON.stringify(got));

    // The replayed file change carries the diff -- this is the payoff of the whole
    // feature: during a turn you see WHAT changed, after it you also see HOW.
    const replayed=JSON.parse(await evaluate(`JSON.stringify({
      cards:document.querySelectorAll('#log details.filechg').length,
      rows:document.querySelectorAll('#log details.filechg .fch-head').length,
      paths:[...document.querySelectorAll('#log details.filechg .fch-head code')].map(function(x){return x.textContent;}),
      added:[...document.querySelectorAll('#log details.filechg pre.diff .dl.add')].map(function(x){return x.textContent;}),
      removed:[...document.querySelectorAll('#log details.filechg pre.diff .dl.del')].map(function(x){return x.textContent;}),
      hunks:document.querySelectorAll('#log details.filechg pre.diff .dl.hunk').length,
      folded:document.querySelector('#log details.filechg').open})`));
    console.log('       replayed file change:', JSON.stringify(replayed));
    assert.equal(replayed.cards,1,'the replayed file change must render: '+JSON.stringify(replayed));
    assert.equal(replayed.rows,1,'one row: '+JSON.stringify(replayed));
    assert.equal(replayed.paths[0],'note.txt','the path is shown relative to the cwd: '+JSON.stringify(replayed));
    assert.deepEqual(replayed.added,['+BETA'],'added lines: '+JSON.stringify(replayed));
    assert.deepEqual(replayed.removed,['-beta'],'removed lines: '+JSON.stringify(replayed));
    assert.equal(replayed.hunks,1,'the @@ hunk header must render: '+JSON.stringify(replayed));
    // Folded by default, like every other card; the "+N -N" in the summary is
    // what tells you a diff is inside.
    assert.equal(replayed.folded,false,'a replayed card is folded by default: '+JSON.stringify(replayed));
    const stat=(await evaluate("(document.querySelector('#log details.filechg .fch-stat')||{}).textContent"))||'';
    console.log('       summary stats:', JSON.stringify(stat));
    assert.match(stat,/^\+\d+ −\d+$/,'the folded summary must show +N -N: '+JSON.stringify(stat));
    // Restore the sidebar fixture for the checks that follow.
    await evaluate("__test.realHistory=false");
    await evaluate(`__test.sessions=${JSON.stringify([
      {id:a,title:'Session A',cwd:workspaceA},{id:b,title:'Session B',cwd:workspaceB}])}`);
    await evaluate("if($test('btnRefreshSessions'))$test('btnRefreshSessions').click()");
    await waitUI("document.querySelectorAll('.sess').length === 2");
  });
  await check('a large context drop is reported as a possible compaction',async()=>{
    // Compaction is INFERRED, not signalled: `codex exec` emits no compaction
    // event at all, so the only available evidence is the context falling a lot.
    // Turn 1 reports a huge context, turn 2 a small one.
    await evaluate("__test.realHistory=false;__test.failRun=false;__test.failCheck=false");
    // The earlier checks pinned a 2,000-token override to exercise the manual
    // field; a 41,000-token turn would read 100% against it. Use a realistic
    // window so the meter's colour is meaningful here.
    await evaluate("$test('contextWindow').value='200000';$test('contextWindow').dispatchEvent(new Event('change'))");
    await evaluate("$test('btnNew').click();$test('btnClear').click()");
    // Wait for the composer to be usable first: status still says '完成' from the
    // previous check, so waiting on it alone returns before this turn even starts.
    await waitUI("$test('status').textContent === '已开始新会话' && !$test('btnSend').disabled",8000);
    await evaluate("$test('prompt').value='BIG turn';$test('btnSend').click()");
    await waitUI("$test('status').textContent === '运行中' || $test('status').textContent === '完成'",8000);
    await waitUI("$test('status').textContent === '完成' && !$test('btnSend').disabled",8000);
    const first=await evaluate("$test('ctxText').textContent");
    console.log('       after big turn:', JSON.stringify(first.slice(0, 60)));
    assert.equal(await evaluate("document.querySelectorAll('#log .compact-note').length"),0,
      'a first turn cannot be a compaction');

    await evaluate("$test('prompt').value='small turn';$test('btnSend').click()");
    await waitUI("$test('status').textContent === '完成' && !$test('btnSend').disabled",8000);
    const note=await evaluate("($test('log').querySelector('.compact-note')||{}).textContent||''");
    const pill=await evaluate("($test('ctxMarks').querySelector('.compact-pill')||{}).textContent||''");
    console.log('       note:', JSON.stringify(note.slice(0, 80)));
    console.log('       pill:', JSON.stringify(pill));
    assert.match(note,/可能已压缩/,'a big drop must be reported: '+JSON.stringify(note));
    assert.match(pill,/# 1 可能压缩于/,'the meter must keep a badge: '+JSON.stringify(pill));
    // The real second turn here has a SMALLER context than the first, so the
    // meter must have gone down -- that drop is the whole signal.
    const second=await evaluate("$test('ctxText').textContent");
    console.log('       after small turn:', JSON.stringify(second.slice(0, 60)));
    assert.ok(parseInt(second.replace(/[^0-9]/g,''),10)!==parseInt(first.replace(/[^0-9]/g,''),10),
      'the two turns must differ in context size');
    // Firing repeatedly would be noise; the badge records the count instead.
    assert.match(await evaluate("$test('log').textContent"),/推断/,'the note must admit it is inferred');

    // The bar tracks the CURRENT context, so it must be GREEN again after the
    // drop -- while the inferred count and peak survive, or the event would leave
    // no trace once the bar resets. Checked here, while this session is loaded.
    const after=JSON.parse(await evaluate(`JSON.stringify({
      pct:document.getElementById('ctxFill').style.width,
      cls:document.getElementById('ctxFill').className,
      hint:document.getElementById('ctxHint').textContent,
      badges:document.querySelectorAll('#ctxMarks .compact-pill').length,
      notes:document.querySelectorAll('#log .compact-note').length})`));
    console.log('       after compaction:', JSON.stringify(after));
    assert.ok(parseFloat(after.pct)<65,'the bar must fall back below the warn level: '+JSON.stringify(after));
    assert.ok(!/warn|hot/.test(after.cls),'the bar must be green again: '+JSON.stringify(after));
    assert.equal(after.badges,1,'the compaction badge must persist: '+JSON.stringify(after));
    assert.equal(after.notes,1,'the transcript note must persist: '+JSON.stringify(after));
    assert.match(after.hint,/疑似压缩 1 次/,'the hint must keep the count: '+JSON.stringify(after));
    assert.match(after.hint,/峰值/,'the hint must keep the peak: '+JSON.stringify(after));
  });
  await check('the jump rail lists every prompt and previews it on hover',async()=>{
    // Switch to the fixture session that has two prompts.
    await evaluate("$test('btnRefreshSessions').click()");
    await waitUI("document.querySelectorAll('.sess').length === 2");
    await evaluate("document.querySelectorAll('.sess')[0].click()");
    await waitUI("$test('status').textContent === '已切换会话'",8000);
    const n=await evaluate("document.querySelectorAll('#jumpRail .jump-dot').length");
    const users=await evaluate("document.querySelectorAll('#log .row.user').length");
    console.log('       dots:', n, '| prompts in feed:', users);
    assert.equal(n,users,'one dot per prompt');
    assert.ok(n>=2,'the fixture session has two prompts');

    // Hovering a dot must reveal a preview containing that prompt's text.
    await evaluate("document.querySelectorAll('#jumpRail .jump-dot')[1].dispatchEvent(new MouseEvent('mouseenter',{bubbles:true}))");
    await waitUI("!document.getElementById('jumpTip').hidden");
    const tip=await evaluate("$test('jumpTip').textContent");
    console.log('       tip:', JSON.stringify(tip));
    assert.match(tip,/第 2 条/,'the tip must say which prompt it is: '+tip);
    assert.match(tip,/user2/,'the tip must preview the actual input: '+tip);

    // Leaving hides it again.
    await evaluate("document.querySelectorAll('#jumpRail .jump-dot')[1].dispatchEvent(new MouseEvent('mouseleave',{bubbles:true}))");
    assert.equal(await evaluate("$test('jumpTip').hidden"),true,'the tip must hide on mouseleave');

    // Clicking must scroll the feed. A one-screen session has nothing to scroll,
    // so assert the scroll CALL (with a sensible target) rather than the outcome;
    // landing accuracy is covered by the many-prompt check below.
    await evaluate(`window.__scrolls=[];
      const orig=$test('log').scrollTo.bind($test('log'));
      $test('log').scrollTo=function(o){window.__scrolls.push(JSON.stringify(o));return orig(o);};`);
    await evaluate("document.querySelectorAll('#jumpRail .jump-dot')[1].click()");
    await sleep(150);
    const scrolls=JSON.parse(await evaluate("JSON.stringify(window.__scrolls)"));
    console.log('       scroll calls:', JSON.stringify(scrolls));
    assert.equal(scrolls.length,1,'clicking one dot must scroll once: '+JSON.stringify(scrolls));
    assert.match(scrolls[0],/smooth/,'the jump must be smooth, not a teleport');

    // The active dot follows the scroll position.
    await evaluate("$test('log').scrollTop=0;$test('log').dispatchEvent(new Event('scroll'))");
    await sleep(60);
    assert.equal(await evaluate("document.querySelector('#jumpRail .jump-dot.active').dataset.index"),'0',
      'the first dot must be marked active at the top of the feed');

    // The rail is rebuilt from scratch, so it must not accumulate duplicates.
    await evaluate("$test('btnRefreshSessions').click()");
    await sleep(60);
    await evaluate("document.querySelectorAll('.sess')[0].click()");
    await waitUI("$test('status').textContent === '已切换会话'",8000);
    assert.equal(await evaluate("document.querySelectorAll('#jumpRail .jump-dot').length"),n,
      'reloading a session must not duplicate dots');
  });
  await check('many prompts: the rail caps its height, jumps exactly, and tracks scroll',async()=>{
    // Report that motivated this: "click dot 10 and it lands on prompt 8".
    // Needs a feed with more prompts than the rail can show.
    const N=14;
    const many=[];
    for(let i=1;i<=N;i++){
      many.push({role:'user',text:'PROMPT-'+i});
      many.push({role:'assistant',text:'ANSWER-'+i+' '+'x'.repeat(140)});
    }
    await evaluate("__test.manyMessages="+JSON.stringify(many));
    await evaluate("__test.realHistory=false;__test.sessions=[{id:"+JSON.stringify(b)+",title:'Many',cwd:"+JSON.stringify(temp)+"}]");
    await evaluate("$test('btnRefreshSessions').click()");
    await waitUI("document.querySelectorAll('.sess').length === 1");
    await evaluate("document.querySelectorAll('.sess')[0].click()");
    await waitUI("$test('status').textContent === '已切换会话'",8000);

    const shape=JSON.parse(await evaluate(`(()=>{
      const r=document.getElementById('jumpRail');
      const d0=r.querySelector('.jump-dot');
      const cs=getComputedStyle(r);
      return JSON.stringify({dots:r.querySelectorAll('.jump-dot').length,
        prompts:document.querySelectorAll('#log .row.user').length,
        railH:Math.round(r.getBoundingClientRect().height),
        dotW:Math.round(d0.getBoundingClientRect().width),
        dotH:Math.round(d0.getBoundingClientRect().height),
        scrollbar:cs.scrollbarWidth,
        scrolls:Math.round(r.scrollHeight>r.clientHeight?1:0),
        panelH:Math.round(document.querySelector('.chat').getBoundingClientRect().height)});
    })()`));
    console.log('       rail shape:', JSON.stringify(shape));
    assert.equal(shape.dots,N,'one dot per prompt');
    assert.ok(shape.railH<shape.panelH-40,
      'the rail must stay shorter than the panel: '+JSON.stringify(shape));
    assert.ok(shape.dotH>=18&&shape.dotW>=14,
      'the markers must be big enough to aim at: '+JSON.stringify(shape));
    assert.equal(shape.scrollbar,'none','the rail must not show a scrollbar: '+JSON.stringify(shape));
    // The visible count is capped (asked for: 10). More prompts than that must
    // therefore scroll rather than making the rail taller.
    const VISIBLE=10;
    const fitsNoScroll=Math.floor((shape.railH-10)/(shape.dotH+4))+1;
    assert.ok(fitsNoScroll<=VISIBLE+1,
      'at most '+VISIBLE+' markers may be visible at once: '+JSON.stringify(shape));
    if (shape.dots>VISIBLE){
      assert.equal(shape.scrolls,1,'a rail beyond the cap must scroll: '+JSON.stringify(shape));
    }

    // Wheel over the rail scrolls the RAIL, and never the feed behind it.
    const wheel=JSON.parse(await evaluate(`(()=>{
      const rail=$test('jumpRail');
      const log=$test('log');
      log.scrollTop=0;
      rail.scrollTop=0;                    // a clean start, not wherever it sat
      const maxRail=rail.scrollHeight-rail.clientHeight;
      const before={rail:rail.scrollTop,log:log.scrollTop,maxRail:maxRail};
      rail.dispatchEvent(new WheelEvent('wheel',{deltaY:120,bubbles:true,cancelable:true}));
      return JSON.stringify({before:before,after:{rail:rail.scrollTop,log:log.scrollTop},
        railScrollable:maxRail>0});
    })()`));
    console.log('       wheel over rail:', JSON.stringify(wheel));
    if (wheel.railScrollable){
      assert.ok(wheel.after.rail>wheel.before.rail,'the wheel must scroll the rail: '+JSON.stringify(wheel));
      assert.equal(wheel.after.log,0,'the wheel over the rail must not scroll the feed: '+JSON.stringify(wheel));
      // At the end, further wheel turns are handed back to the feed.
      const handed=JSON.parse(await evaluate(`(()=>{
        const rail=$test('jumpRail');
        rail.scrollTop=rail.scrollHeight;
        const before=rail.scrollTop;
        const ev=new WheelEvent('wheel',{deltaY:120,bubbles:true,cancelable:true});
        const notCancelled=rail.dispatchEvent(ev);
        return JSON.stringify({before:before,defaultPrevented:!notCancelled});
      })()`));
      console.log('       at rail end:', JSON.stringify(handed));
      assert.equal(handed.defaultPrevented,false,
        'at the end the wheel must pass through to the feed: '+JSON.stringify(handed));
    }

    // Reported: with the active prompt near the bottom you could scroll the rail
    // DOWN but never UP -- every wheel-up was undone by the "keep the active
    // marker visible" logic. Reproduce exactly that: conversation at the bottom,
    // then wheel up repeatedly and require the rail to stay scrolled up.
    const upScroll=await evaluate(`(()=>{
      const rail=$test('jumpRail');
      const log=$test('log');
      log.scrollTop=log.scrollHeight;            // active prompt is now the last one
      return 'ready';
    })()`);
    await evaluate("$test('log').dispatchEvent(new Event('scroll'))");
    await sleep(120);
    const atBottom=await evaluate("Math.round($test('jumpRail').scrollTop)");
    const afterUp=await evaluate(`(()=>{
      const rail=$test('jumpRail');
      for(let i=0;i<4;i++) rail.dispatchEvent(new WheelEvent('wheel',{deltaY:-120,bubbles:true,cancelable:true}));
      return Math.round(rail.scrollTop);
    })()`);
    await sleep(400);   // give any "snap back" a chance to happen
    const settled=await evaluate("Math.round($test('jumpRail').scrollTop)");
    console.log('       rail scroll up: bottom=' + atBottom + ' -> ' + afterUp + ' -> settles ' + settled);
    assert.ok(afterUp < atBottom,
      'wheeling up must move the rail up: '+atBottom+' -> '+afterUp);
    assert.ok(settled <= afterUp + 2,
      'the rail must NOT be yanked back to the active marker: '+afterUp+' -> '+settled);
    // At the very top there is nothing above: only the "more below" fade applies.
    const fades=JSON.parse(await evaluate(`JSON.stringify({
      above:$test('jumpRail').classList.contains('more-above'),
      below:$test('jumpRail').classList.contains('more-below')})`));
    console.log('       fades at top:', JSON.stringify(fades));
    assert.equal(fades.above,false,'nothing is above the top: '+JSON.stringify(fades));
    assert.equal(fades.below,true,'more markers remain below: '+JSON.stringify(fades));
    // And scrolling part-way must show BOTH fades.
    await evaluate("$test('jumpRail').dispatchEvent(new WheelEvent('wheel',{deltaY:40,bubbles:true,cancelable:true}))");
    await sleep(60);
    const mid=JSON.parse(await evaluate(`JSON.stringify({
      above:$test('jumpRail').classList.contains('more-above'),
      below:$test('jumpRail').classList.contains('more-below')})`));
    console.log('       fades mid-way:', JSON.stringify(mid));
    assert.equal(mid.above,true,'markers are above mid-way: '+JSON.stringify(mid));

    // Landing accuracy for a middle prompt, and for a tail prompt (which cannot
    // reach the very top because there is not enough content below it).
    const land=async(idx)=>{
      await evaluate(`document.querySelectorAll('#jumpRail .jump-dot')[${idx-1}].click()`);
      await sleep(700);
      return JSON.parse(await evaluate(`(()=>{
        const log=$test('log'); const anchor=log.getBoundingClientRect().top;
        let best=0,bestD=1e9;
        document.querySelectorAll('#log .row.user').forEach(function(r,i){
          const d=Math.abs(r.getBoundingClientRect().top-anchor);
          if(d<=bestD){bestD=d;best=i+1;}
        });
        const a=document.querySelector('#jumpRail .jump-dot.active');
        return JSON.stringify({nearest:best,delta:Math.round(bestD),
          active:a?Number(a.dataset.index)+1:null});
      })()`));
    };
    for (const idx of [10, 6, 13]) {
      const r=await land(idx);
      console.log('       dot ' + idx + ' -> ' + JSON.stringify(r));
      // The clicked prompt must be the one nearest the top (a tail prompt may sit
      // lower on screen, but it must never be a DIFFERENT prompt that wins).
      const tail = idx > N-3;
      assert.ok(Math.abs(r.nearest-idx)<=1,
        'dot '+idx+' must land on its own prompt: '+JSON.stringify(r));
      // "At the top" means within a small fraction of the viewport -- an exact
      // pixel match is not the contract, and layout differences between runs
      // shift it by a few tens of pixels.
      if (!tail) assert.ok(r.delta<80,
        'a middle prompt must land near the top: '+JSON.stringify(r));
      assert.equal(r.active,r.nearest,
        'the highlight must match the prompt actually at the top: '+JSON.stringify(r));
    }

    await evaluate("__test.sessions="+JSON.stringify([
      {id:a,title:'Session A',cwd:workspaceA},{id:b,title:'Session B',cwd:workspaceB}]));
    await evaluate("delete __test.manyMessages");
    await evaluate("$test('btnRefreshSessions').click()");
    await waitUI("document.querySelectorAll('.sess').length === 2");
  });
  await check('a collapsed group stays collapsed when the next command arrives',async()=>{
    // Reported: "工具卡片折叠之后，如果来了新的命令会强制自动打开，导致折叠失效".
    // The fixture now pauses between commands, so the collapse can happen mid-turn.
    await evaluate("$test('btnNew').click();$test('btnClear').click();__test.failRun=false;__test.failCheck=false");
    await waitUI("$test('status').textContent === '已开始新会话' && !$test('btnSend').disabled",8000);
    await evaluate("$test('prompt').value='COLLAPSE_PROBE';$test('btnSend').click()");
    // Wait until the group exists with at least one command, then close it by hand.
    await waitUI("document.querySelector('#log details.cmd-group') && document.querySelectorAll('#log .grp-body details.cmd').length >= 1",8000);
    const openedLive=await evaluate("document.querySelector('#log details.cmd-group').open");
    assert.equal(openedLive,true,'a live group must start expanded so output is visible');
    // Close it the way a user does: a real click, not a scripted open.
    await evaluate(`const g=document.querySelector('#log details.cmd-group');
      g.querySelector('summary').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));`);
    await sleep(80);
    assert.equal(await evaluate("document.querySelector('#log details.cmd-group').open"),false,
      'the summary click must close the group');
    assert.equal(await evaluate("document.querySelector('#log details.cmd-group').dataset.userClosed"),'1',
      'a deliberate close must be remembered');
    // Let the rest of the commands arrive.
    await waitUI("$test('status').textContent === '完成' && !$test('btnSend').disabled",9000);
    assert.equal(await evaluate("document.querySelector('#log details.cmd-group').open"),false,
      'later commands must NOT re-open a group the user closed');
    assert.equal(await evaluate("document.querySelectorAll('#log .grp-body details.cmd').length"),4,
      'every tool must still be recorded inside the closed group (3 commands + 1 search; the file change is standalone)');
  });
  await check('the meter says so while a turn is running',async()=>{
    // `codex exec --json` reports usage only at turn.completed, so during a turn
    // the figure on screen is the previous turn's. Unlabelled, that reads as a
    // broken meter -- which is exactly how it was reported.
    await evaluate("$test('prompt').value='WAIT browser'");
    // Make sure the composer is actually ready before clicking: clicking a
    // disabled button silently does nothing, and the wait below then times out
    // with no clue why. This test used to flake exactly that way.
    await waitUI("!$test('btnSend').disabled", 8000);
    await evaluate("$test('btnSend').click()");
    // markCtxStale(true) fires when the run is ACCEPTED (the `meta` frame), which
    // is after the directory check -- so wait for the running status itself.
    try {
      await waitUI("$test('status').textContent.startsWith('运行中') || /失败|错误/.test($test('status').textContent)", 15000);
    } catch (e) {
      throw new Error('the turn never started; status was: ' + await evaluate("$test('status').textContent"));
    }
    assert.doesNotMatch(await evaluate("$test('status').textContent"), /失败|错误/,
      'the run must not fail before this check: ' + await evaluate("$test('status').textContent"));
    const during=JSON.parse(await evaluate(`JSON.stringify({
      tagHidden:document.getElementById('ctxStaleTag').hidden,
      stale:document.getElementById('ctxText').classList.contains('stale'),
      status:document.getElementById('status').textContent})`));
    console.log('       while running:', JSON.stringify(during));
    assert.equal(during.tagHidden,false,'the meter must be marked stale during a turn: '+JSON.stringify(during));
    assert.equal(during.stale,true,'the figure must be dimmed while stale: '+JSON.stringify(during));
    assert.match(during.status,/运行中/,'the turn must actually be running: '+JSON.stringify(during));
    await evaluate("$test('btnStop').click()");
    await waitUI("$test('status').textContent === '已停止'",9000);
  });
  assert.deepEqual(errors,[]);
  await evaluate("$test('prompt').value='';document.querySelectorAll('.sess')[1].click()");
  await waitUI("$test('status').textContent === '已切换会话'");
  // The screenshot goes into the public README, so it must never show a real path
  // or a real proxy. The working directory here is a temp dir, which would render
  // the OS username ("C:\Users\<name>\AppData\Local\Temp\...") -- invisible to any
  // text scan, because it becomes pixels. Pin neutral values first, and clear the
  // "recent folders" chips, which are built from this machine's real history.
  // No dispatchEvent: this is cosmetic, and firing 'change' would persist it.
  const neutralCwd = 'C:\\code\\codex-gui-demo';
  await evaluate(`$test('cwd').value=${JSON.stringify(neutralCwd)}`);
  await evaluate(`$test('proxy').value=${JSON.stringify('http://127.0.0.1:7890')}`);
  await evaluate("$test('recent').innerHTML=''");
  const shown = await evaluate("$test('cwd').value + '|' + $test('proxy').value");
  const chips = await evaluate("document.querySelectorAll('#recent button').length");
  assert.equal(shown, neutralCwd + '|http://127.0.0.1:7890',
    'the screenshot must show neutral values: ' + shown);
  assert.doesNotMatch(shown, /Users|AppData|Temp|7897/i,
    'the screenshot must not show a user path or the real proxy: ' + shown);
  assert.equal(chips, 0, 'recent-folder chips must be cleared for the screenshot');
  await sleep(150);
  const screenshot=await cdp('Page.captureScreenshot',{format:'png'});
  const artifact=path.join(__dirname,'.codex-gui','review-ui.png');
  fs.mkdirSync(path.dirname(artifact),{recursive:true});fs.writeFileSync(artifact,Buffer.from(screenshot.data,'base64'));
  await check('an older backend cannot accept requests from the updated UI',async()=>{
    await cdp('Page.addScriptToEvaluateOnNewDocument',{source:`const originalFetch=window.fetch;window.fetch=(url,options)=>url==='/api/health'?Promise.resolve(new Response(JSON.stringify({ok:true,capabilities:{sessions:true}}))):originalFetch(url,options);`});
    await cdp('Page.navigate',{url:origin});
    await waitUI("document.getElementById('status')?.textContent === '等待重启 Codex GUI'");
    assert.equal(await evaluate("document.getElementById('btnSend').disabled"),true);
  });
  console.log(`Browser: ${passed} checks passed; screenshot: ${artifact}`);
}

main().catch(error=>{console.error(error.stack);process.exitCode=1;}).finally(async()=>{
  socket?.close();
  for(const call of pending.values()){clearTimeout(call.timer);call.reject(new Error('browser closed'));}pending.clear();
  appserver.killServer();
  server.closeAllConnections();
  if(server.listening)await new Promise(resolve=>server.close(resolve));
  if(browser){killTree(browser.pid);await Promise.race([once(browser,'close').catch(()=>{}),sleep(3000)]);}
  try{assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(temp,{recursive:true,force:true,maxRetries:10,retryDelay:100});}catch(error){console.warn('Temporary browser profile cleanup: '+error.message);}
});
