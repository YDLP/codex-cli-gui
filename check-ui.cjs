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
      if(String(url).startsWith('/api/sessions/search')){
        // The panel asks the bridge to search conversation text; the stub answers
        // from __test.searchHits so the UI path can be checked without files.
        const q=new URL(String(url),location.href).searchParams.get('q')||'';
        t.searchCalls=(t.searchCalls||0)+1;
        t.lastSearchQuery=q;
        return response({query:q,hits:t.searchHits||{},scanned:(t.sessions||[]).length});
      }
      if(String(url).startsWith('/api/sessions')){
        t.sessionsCalls=(t.sessionsCalls||0)+1;
        t.lastSessionsPayload=t.sessions;
        return response({sessions:t.sessions});
      }
      if(String(url).startsWith('/api/history?')){
        t.historyCalls=(t.historyCalls||0)+1;
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
          // The stored per-turn series, so the compaction marker can be rebuilt on
          // replay instead of only existing in live memory.
          usageSeries:t.usageSeries||[{input:900,output:100},{input:1200,output:120}],
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
  await check('a cold start already looks idle',async()=>{
    // Reported: "启动之后我不点击会话它也是灰的，点击某个具体会话之后才是绿的".
    // The badge only learned its state from setBusy(), which ran on the first
    // session switch -- so a fresh page showed grey next to the word 空闲.
    const st=JSON.parse(await evaluate(`JSON.stringify({
      state: $test('busyBadge').dataset.state,
      text: $test('busyBadge').textContent,
      color: getComputedStyle($test('busyBadge')).color,
      sessionsClicked: !!document.querySelector('#sessionList .sess.active')
    })`));
    console.log('       cold-start badge:', JSON.stringify(st));
    assert.equal(st.text,'空闲');
    assert.equal(st.state,'idle','the markup must carry the idle state before any click: '+JSON.stringify(st));
    assert.equal(st.color,'rgb(63, 185, 80)','and it must already be green: '+JSON.stringify(st));
    assert.equal(st.sessionsClicked,false,'this check must run before any session is opened');
  });
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
  await check('theme is a header selector, not a hidden cycle',async()=>{
    // Requested: move the theme control out of the settings panel and drop the 🌗
    // button -- it cycled through an order you had to remember.
    assert.equal(await evaluate("!!document.querySelector('header #theme')"),true,
      'the theme select belongs in the header');
    assert.equal(await evaluate("document.getElementById('btnTheme')"),null,
      'the cycling button must be gone');
    assert.equal(await evaluate("[...document.querySelectorAll('#aside h2')].some(function(h){return h.textContent==='界面';})"),false,
      'the settings panel no longer holds a 界面 section');
    assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('#theme option')).map(function(o){return o.value;})"),
      ['dark','light','system'],'all three choices stay explicit');

    // It sits in a row of buttons, so it has to BE one visually. A bare <select>
    // inherits the browser default (heavy black border, own padding) which is what
    // was reported as "为什么不统一".
    const look=JSON.parse(await evaluate(`(() => {
      const s=document.getElementById('theme'), b=$test('btnNew');
      const cs=getComputedStyle(s), cb=getComputedStyle(b);
      return JSON.stringify({
        hs:Math.round(s.getBoundingClientRect().height), hb:Math.round(b.getBoundingClientRect().height),
        border:[cs.borderTopColor,cb.borderTopColor],
        bg:[cs.backgroundColor,cb.backgroundColor],
        radius:[cs.borderRadius,cb.borderRadius],
        font:[cs.fontSize,cb.fontSize]
      });
    })()`));
    console.log('       header control look:', JSON.stringify(look));
    assert.equal(look.hs,look.hb,'the select must be the same height as the buttons: '+JSON.stringify(look));
    assert.equal(look.border[0],look.border[1],'same border colour: '+JSON.stringify(look));
    assert.equal(look.bg[0],look.bg[1],'same background: '+JSON.stringify(look));
    assert.equal(look.radius[0],look.radius[1],'same radius: '+JSON.stringify(look));
    assert.equal(look.font[0],look.font[1],'same font size: '+JSON.stringify(look));

    // Changing it applies immediately and is persisted, not just stored in the DOM.
    await evaluate(`(() => { const s=document.getElementById('theme'); s.value='light';
      s.dispatchEvent(new Event('change',{bubbles:true})); })()`);
    await sleep(300);
    assert.equal(await evaluate("document.documentElement.getAttribute('data-theme')"),'light',
      'the light theme must be applied to the document');
    const saved=await (await fetch(origin+'/api/settings')).json();
    assert.equal(saved.theme,'light','the choice must be saved');

    await evaluate(`(() => { const s=document.getElementById('theme'); s.value='dark';
      s.dispatchEvent(new Event('change',{bubbles:true})); })()`);
    await sleep(300);
    assert.equal(await evaluate("document.documentElement.getAttribute('data-theme')"),'dark',
      'switching back must work too');
  });
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
  await check('session search filters by title and by conversation content',async()=>{
    // The title only carries the first prompt, so searching has to reach into the
    // conversation text as well -- that is the whole point of the feature.
    await evaluate("document.querySelectorAll('.sess').length");
    // 1. A keyword that only appears in the CONTENT of session B.
    await evaluate("__test.searchHits=Object.fromEntries([[" +
      JSON.stringify(b) + ",{count:2,snippet:'…the CAN bus went down during Bus-Off recovery…',role:'assistant'}]]);");
    await evaluate(`(() => { const i=$test('sessSearch'); i.value='Bus-Off';
      i.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await waitUI("/内容匹配 1 个/.test($test('sessSearchInfo').textContent)",8000);
    const content=JSON.parse(await evaluate(`JSON.stringify({
      info:$test('sessSearchInfo').textContent,
      rows:document.querySelectorAll('#sessionList .sess').length,
      hits:document.querySelectorAll('#sessionList .sess-hit').length,
      mark:(document.querySelector('#sessionList .sess-hit mark')||{}).textContent||'',
      snippet:(document.querySelector('#sessionList .sess-hit')||{}).textContent||''
    })`));
    console.log('       content search:', JSON.stringify(content));
    assert.equal(content.rows,1,'only the matching session is listed: '+JSON.stringify(content));
    assert.equal(content.hits,1,'the reason is shown as a snippet: '+JSON.stringify(content));
    assert.equal(content.mark,'Bus-Off','the keyword is highlighted: '+JSON.stringify(content));
    assert.match(content.info,/标题匹配 0 个 · 内容匹配 1 个/,'the counters: '+JSON.stringify(content));

    // 2. A keyword that is in a TITLE is found without asking the bridge at all.
    await evaluate("__test.searchHits={}");
    await evaluate(`(() => { const i=$test('sessSearch'); i.value='Session A';
      i.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await sleep(400);
    assert.equal(await evaluate("document.querySelectorAll('#sessionList .sess').length"),1,
      'a title match filters the list immediately');

    // 3. Nothing matches: say so instead of showing an empty pane.
    await evaluate(`(() => { const i=$test('sessSearch'); i.value='zzz-not-anywhere';
      i.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await waitUI("/没有找到/.test($test('sessSearchInfo').textContent)",8000);
    assert.equal(await evaluate("document.querySelectorAll('#sessionList .sess').length"),0);

    // 4. Esc clears the search and restores the full list.
    await evaluate("$test('sessSearch').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    await sleep(300);
    assert.equal(await evaluate("document.querySelectorAll('#sessionList .sess').length"),2,
      'clearing the search restores every session');
    assert.equal(await evaluate("$test('sessSearchInfo').hidden"),true,'the info line is hidden again');
    await evaluate("delete __test.searchHits");
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
  await check('selecting text and pressing Ctrl+F searches for it',async()=>{
    // Requested: the search only worked by opening it first and then typing; the
    // natural gesture is to select a word and hit Ctrl+F.
    await evaluate(`(() => {
      const bubble = [...document.querySelectorAll('#log .bubble')]
        .find(function (b) { return (b.textContent || '').indexOf('answer1') >= 0; });
      // The word may live in a nested text node, not the bubble's first child.
      const walker = document.createTreeWalker(bubble, NodeFilter.SHOW_TEXT);
      let node = null;
      while (walker.nextNode()) {
        if ((walker.currentNode.nodeValue || '').indexOf('answer') >= 0) { node = walker.currentNode; break; }
      }
      const at = (node.nodeValue || '').indexOf('answer');
      const range = document.createRange();
      range.setStart(node, at); range.setEnd(node, at + 'answer'.length);
      const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
    })()`);
    assert.equal(await evaluate("String(window.getSelection())"),'answer','the selection is in place');
    await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'f',ctrlKey:true,bubbles:true,cancelable:true}))");
    await sleep(300);
    const st=JSON.parse(await evaluate(`JSON.stringify({
      open: !$test('tsSearch').hidden,
      value: $test('tsInput').value,
      marks: document.querySelectorAll('#log mark.ts-hit').length,
      count: $test('tsCount').textContent
    })`));
    console.log('       ctrl-f with a selection:', JSON.stringify(st));
    assert.equal(st.open,true,'Ctrl+F opens the bar');
    assert.equal(st.value,'answer','the selected text is the query: '+JSON.stringify(st));
    assert.ok(st.marks >= 2,'and it is already searched for: '+JSON.stringify(st));

    // A long selection is not a query -- the box opens empty instead.
    await evaluate("$test('tsInput').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))");
    await evaluate(`(() => {
      const r = document.createRange(); r.selectNodeContents($test('log'));
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    })()`);
    await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'f',ctrlKey:true,bubbles:true,cancelable:true}))");
    await sleep(200);
    assert.equal(await evaluate("$test('tsInput').value"),'',
      'a whole paragraph is not used as a query');
    await evaluate("$test('tsInput').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))");
    await evaluate("window.getSelection().removeAllRanges()");
  });
  await check('in-session search marks every hit and jumps between them',async()=>{
    // Requested as "会话内的关键词轮次搜索和跳转": the session-wide search answers
    // "which conversation", this one answers "where in THIS conversation".
    await evaluate("$test('btnFind').click()");
    await waitUI("!$test('tsSearch').hidden");
    assert.equal(await evaluate("document.activeElement === $test('tsInput')"),true,
      'opening the search must focus the field');

    // "answer" appears once in each of the two replies.
    await evaluate(`(() => { const i=$test('tsInput'); i.value='answer';
      i.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await sleep(300);
    const st=JSON.parse(await evaluate(`JSON.stringify({
      count:$test('tsCount').textContent,
      marks:document.querySelectorAll('#log mark.ts-hit').length,
      current:document.querySelectorAll('#log mark.ts-hit.cur').length,
      first:(document.querySelector('#log mark.ts-hit')||{}).textContent||''
    })`));
    console.log('       in-session search:', JSON.stringify(st));
    assert.equal(st.marks,2,'every occurrence gets a mark: '+JSON.stringify(st));
    assert.equal(st.current,1,'exactly one mark is the current one: '+JSON.stringify(st));
    assert.equal(st.count,'1/2','the counter starts at the first hit: '+JSON.stringify(st));
    assert.equal(st.first,'answer','the mark holds the matched text: '+JSON.stringify(st));

    // Next / previous wrap around, and Enter drives it too.
    await evaluate("$test('tsNext').click()");
    await sleep(120);
    assert.equal(await evaluate("$test('tsCount').textContent"),'2/2','next moves forward');
    await evaluate("$test('tsNext').click()");
    await sleep(120);
    assert.equal(await evaluate("$test('tsCount').textContent"),'1/2','next wraps to the start');
    await evaluate("$test('tsPrev').click()");
    await sleep(120);
    assert.equal(await evaluate("$test('tsCount').textContent"),'2/2','previous wraps backwards');
    await evaluate("$test('tsInput').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))");
    await sleep(120);
    assert.equal(await evaluate("$test('tsCount').textContent"),'1/2','Enter advances');

    // A word that is not there must not leave stale highlights behind.
    await evaluate(`(() => { const i=$test('tsInput'); i.value='zzz-not-in-transcript';
      i.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await sleep(250);
    assert.equal(await evaluate("document.querySelectorAll('#log mark.ts-hit').length"),0,
      'the previous highlights are cleared when the query changes');
    assert.equal(await evaluate("$test('tsCount').textContent"),'0/0');

    // Esc closes and removes every mark, so the transcript is untouched.
    await evaluate("$test('tsInput').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))");
    await sleep(200);
    assert.equal(await evaluate("$test('tsSearch').hidden"),true,'Esc closes the bar');
    assert.equal(await evaluate("document.querySelectorAll('#log mark.ts-hit').length"),0,'no marks remain');
    assert.equal(await evaluate("Array.from(document.querySelectorAll('#log .bubble'),x=>x.textContent).join('|')"),
      'Session A user1|Session A answer1|Session A user2|Session A answer2',
      'the transcript text must be unchanged after clearing the search');
  });
  await check('search ignores text folded away inside closed cards',async()=>{
    // Reported with a screenshot: searching "irmq" showed "41/72" while the first
    // hit was on screen -- the other 40 lived inside COLLAPSED tool cards, so the
    // counter counted text nobody could see. Measured then: 72 marks, 44 hidden,
    // first visible at index 40.
    await evaluate(`(() => {
      const d=document.createElement('details'); d.id='foldProbe'; d.className='cmd';
      const s=document.createElement('summary'); s.textContent='折叠的工具卡片';
      const body=document.createElement('div'); body.className='grp-body';
      const p=document.createElement('div'); p.textContent='xyzzy one xyzzy two';
      body.appendChild(p); d.appendChild(s); d.appendChild(body);
      document.getElementById('log').appendChild(d);
    })()`);
    await evaluate("$test('btnFind').click()");
    await waitUI("!$test('tsSearch').hidden");
    await evaluate(`(() => { const i=$test('tsInput'); i.value='xyzzy';
      i.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await sleep(300);
    const folded=JSON.parse(await evaluate(`JSON.stringify({
      marks:document.querySelectorAll('#log mark.ts-hit').length,
      count:$test('tsCount').textContent,
      title:$test('tsCount').title,
      hasHidden:$test('tsCount').classList.contains('has-hidden')
    })`));
    console.log('       folded-only search:', JSON.stringify(folded));
    assert.equal(folded.marks,0,'text inside a closed card must not be marked: '+JSON.stringify(folded));
    assert.equal(folded.count,'0/0','the counter must not include invisible hits: '+JSON.stringify(folded));
    assert.equal(folded.hasHidden,true,'the hidden count must be surfaced instead of dropped silently');
    assert.match(folded.title,/2 处/,'the tooltip says how many are folded away: '+JSON.stringify(folded));

    // Opening the card makes them real hits.
    await evaluate("document.getElementById('foldProbe').open=true");
    await sleep(150);
    await evaluate(`(() => { const i=$test('tsInput'); i.value='xyzzy';
      i.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await sleep(300);
    assert.equal(await evaluate("document.querySelectorAll('#log mark.ts-hit').length"),2,
      'once the card is open its text is searchable');

    await evaluate("$test('tsInput').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))");
    await sleep(150);
    await evaluate("document.getElementById('foldProbe').remove()");
  });
  await check('in-session search starts from the nearest hit, not the first one',async()=>{
    // Reported: "会话内搜索会默认跳到第一轮开始，而不是就近". The search used to
    // select index 0 whatever the transcript was scrolled to.
    await evaluate(`(() => {
      const log = $test('log');
      const pad = (n, text) => {
        for (let i = 0; i < n; i++) {
          const d = document.createElement('div');
          d.className = 'meta hit-probe';
          d.textContent = i === 0 ? text : 'padding';
          log.appendChild(d);
        }
      };
      pad(25, 'needle at the top');
      pad(45, 'padding');
      pad(25, 'needle at the bottom');
    })()`);
    await evaluate("$test('log').scrollTop = $test('log').scrollHeight");
    await sleep(300);

    await evaluate("$test('btnFind').click()");
    await waitUI("!$test('tsSearch').hidden");
    await evaluate(`(() => { const i=$test('tsInput'); i.value='needle';
      i.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await sleep(350);
    const bottom=await evaluate("$test('tsCount').textContent");
    console.log('       scrolled to the bottom -> ' + bottom);

    // Same query from the top: the answer must follow the viewport, not be fixed.
    await evaluate("$test('log').scrollTop = 0");
    await sleep(250);
    await evaluate(`(() => { const i=$test('tsInput'); i.value='';
      i.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await evaluate(`(() => { const i=$test('tsInput'); i.value='needle';
      i.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await sleep(350);
    const top=await evaluate("$test('tsCount').textContent");
    console.log('       scrolled to the top -> ' + top);

    assert.equal(bottom,'2/2','from the bottom it starts at the later hit: '+bottom);
    assert.equal(top,'1/2','from the top it starts at the earlier hit: '+top);

    await evaluate("$test('tsInput').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))");
    await sleep(150);
    await evaluate("document.querySelectorAll('#log .hit-probe').forEach(function(n){ n.remove(); })");
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
    // A real failure is still a red error box.
    assert.ok(await evaluate("document.querySelectorAll('#log .errbox').length") >= 1,
      'a failed turn must show an error box');
  });
  await check('a reconnect notice is not dressed up as a failure',async()=>{
    // Reported as a scary red box for "Reconnecting... 2/5 (stream disconnected
    // before completion: tls handshake eof)" -- which is Codex RETRYING, and the
    // turn continues if a later attempt connects.
    await evaluate("$test('btnNew').click();$test('prompt').value='RECONNECT';$test('btnSend').click()");
    await waitUI("$test('status').textContent === '完成' && !$test('btnSend').disabled",8000);
    const st=JSON.parse(await evaluate(`JSON.stringify({
      notes:document.querySelectorAll('#log .notebox').length,
      errors:document.querySelectorAll('#log .errbox').length,
      noteText:(document.querySelector('#log .notebox')||{}).textContent||'',
      reply:(document.querySelector('#log .bubble.md')||{}).textContent||''
    })`));
    console.log('       reconnect notice:', JSON.stringify(st));
    assert.equal(st.notes,1,'the retry notice must render as a notice: '+JSON.stringify(st));
    assert.equal(st.errors,0,'a retry notice must NOT render as an error: '+JSON.stringify(st));
    assert.match(st.noteText,/2\/5/,'the attempt count is kept: '+JSON.stringify(st));
    assert.match(st.noteText,/tls handshake eof/,'the reason is kept: '+JSON.stringify(st));
    assert.match(st.reply,/DONE/,'the turn must still finish: '+JSON.stringify(st));
  });
  await check('stop includes the current run id and releases the UI',async()=>{
    await evaluate("$test('btnNew').click();$test('prompt').value='WAIT browser';$test('btnSend').click()");
    await waitUI("$test('threadId').value !== '' && !$test('btnStop').classList.contains('hidden')");
    await evaluate("$test('btnStop').click()");
    await waitUI("$test('status').textContent === '已停止' && !$test('btnSend').disabled");
    assert.ok(await evaluate('__test.stops.at(-1).runId'));
    assert.equal((await (await fetch(origin+'/api/health')).json()).running,0);
  });
  await check('the spinner stops when the answer ends, not when the process exits',async()=>{
    // Reported: "回复的吐完了转圈起码还转了10s左右". The reply was complete; the
    // CLI process was still doing post-turn work, and the spinner waited for that.
    await evaluate("$test('btnNew').click();__test.failRun=false;__test.failCheck=false");
    await waitUI("$test('status').textContent === '已开始新会话' && !$test('btnSend').disabled",8000);
    await evaluate("$test('prompt').value='SLOW_EXIT';$test('btnSend').click()");
    // The reply text must be on screen before the process is gone.
    await waitUI("/答案已经写完了/.test($test('log').textContent)",10000);
    await sleep(250);
    const mid=JSON.parse(await evaluate(`JSON.stringify({
      spinner: document.querySelectorAll('#sessionList .sess-state.running').length,
      badge: $test('busyBadge').textContent,
      sendDisabled: $test('btnSend').disabled,
      status: $test('status').textContent
    })`));
    console.log('       while the process lingers:', JSON.stringify(mid));
    assert.equal(mid.spinner,0,'the spinner must stop once the answer is complete: '+JSON.stringify(mid));
    assert.equal(mid.badge,'收尾中…','the tail is labelled as teardown, not as running: '+JSON.stringify(mid));
    assert.equal(mid.sendDisabled,true,
      'the next turn must still wait: the session holds a writer lock until the process exits');
    // All three badge states carry a colour; colouring only "空闲" looked broken.
    const tailState=await evaluate("$test('busyBadge').dataset.state");
    const tailColor=await evaluate("getComputedStyle($test('busyBadge')).color");
    console.log('       finishing badge:', tailState, tailColor);
    assert.equal(tailState,'finishing','the badge exposes its state for styling: '+tailState);
    assert.notEqual(tailColor,'rgb(139, 148, 158)','the finishing badge must not stay the dim default: '+tailColor);

    // ...and once the process really exits, everything is released.
    await waitUI("$test('status').textContent === '完成' && !$test('btnSend').disabled",15000);
    assert.equal(await evaluate("$test('busyBadge').textContent"),'空闲');
    assert.equal(await evaluate("$test('busyBadge').dataset.state"),'idle');
    assert.equal(await evaluate("getComputedStyle($test('busyBadge')).color"),'rgb(63, 185, 80)',
      'idle keeps its green, so "ready to send" still reads at a glance');
  });
  await check('a finished command never reads as still running',async()=>{
    // Reported: the group header said "1 条失败" while the card inside said 执行中,
    // and a refresh changed that card to exit 1. The CLI had sent the exit code
    // without `status: 'completed'`; the label keyed off status, the header off the
    // exit code, so the row contradicted itself.
    await evaluate("$test('btnNew').click();__test.failRun=false;__test.failCheck=false");
    await waitUI("$test('status').textContent === '已开始新会话' && !$test('btnSend').disabled",8000);
    await evaluate("$test('prompt').value='EXIT_NO_STATUS';$test('btnSend').click()");
    await waitUI("$test('status').textContent === '完成' && !$test('btnSend').disabled",10000);
    const st=JSON.parse(await evaluate(`JSON.stringify({
      label:(document.querySelector('#log details.cmd-group details.cmd summary .pill')||{}).textContent||'',
      head:(document.querySelector('#log details.cmd-group > summary')||{}).textContent||'',
      exit:document.querySelector('#log details.cmd-group details.cmd').dataset.exit
    })`));
    console.log('       exit without status:', JSON.stringify(st));
    assert.equal(st.label,'exit 1','the label must follow the exit code: '+JSON.stringify(st));
    assert.equal(st.exit,'1','and so must the dataset: '+JSON.stringify(st));
    assert.match(st.head,/1 条失败/,'the header agrees with the card: '+JSON.stringify(st));
    assert.doesNotMatch(st.head,/执行中/,'nothing claims to be running afterwards: '+JSON.stringify(st));
  });
  await check('stopping a turn marks its unfinished command as interrupted',async()=>{
    await evaluate("$test('btnNew').click()");
    await waitUI("$test('status').textContent === '已开始新会话' && !$test('btnSend').disabled",8000);
    await evaluate("$test('prompt').value='CMD_HANG';$test('btnSend').click()");
    await waitUI("document.querySelector('#log details.cmd-group details.cmd') !== null",8000);
    assert.equal(await evaluate("(document.querySelector('#log details.cmd-group details.cmd summary .pill')||{}).textContent"),
      '执行中','it starts as running');
    await evaluate("$test('btnStop').click()");
    await waitUI("$test('status').textContent === '已停止'",10000);
    await sleep(300);
    const after=JSON.parse(await evaluate(`JSON.stringify({
      label:(document.querySelector('#log details.cmd-group details.cmd summary .pill')||{}).textContent||'',
      head:(document.querySelector('#log details.cmd-group > summary')||{}).textContent||''
    })`));
    console.log('       after stop:', JSON.stringify(after));
    assert.equal(after.label,'已中断','the card must stop claiming to run: '+JSON.stringify(after));
    assert.match(after.head,/1 条中断/,'the header counts it as interrupted: '+JSON.stringify(after));
    assert.doesNotMatch(after.head,/条失败/,'an interrupted command is not a failure: '+JSON.stringify(after));
  });
  await check('a finished turn is re-rendered from disk, silently, once',async()=>{
    // Requested as "会话结束之后是不是加个刷新好一点？不然有时候布局很奇怪".
    // Uses the REAL rollout reader: the stub history would not match what is on
    // screen, and the refresh deliberately refuses to replace a feed the file does
    // not agree with.
    await evaluate("$test('btnNew').click();__test.failRun=false;__test.failCheck=false;__test.realHistory=true");
    await waitUI("$test('status').textContent === '已开始新会话' && !$test('btnSend').disabled",8000);
    const before=Number(await evaluate("__test.historyCalls||0"));
    await evaluate("$test('prompt').value='replay me';$test('btnSend').click()");
    await waitUI("$test('status').textContent === '完成' && !$test('btnSend').disabled",15000);
    await sleep(1200);
    const after=Number(await evaluate("__test.historyCalls||0"));
    console.log('       history reloads: ' + before + ' -> ' + after);
    assert.ok(after > before,'a finished turn must reload the transcript once: '+before+' -> '+after);

    const st=JSON.parse(await evaluate(`JSON.stringify({
      footers: (document.getElementById('log').textContent.match(/以上为历史记录/g)||[]).length,
      hasAnswer: /收到后通知 CPU/.test(document.getElementById('log').textContent),
      dots: document.querySelectorAll('#jumpRail .jump-dot').length,
      bubbles: document.querySelectorAll('#log .bubble').length
    })`));
    console.log('       after the silent refresh:', JSON.stringify(st));
    assert.equal(st.footers,0,'the refresh must not add the switch banner: '+JSON.stringify(st));
    assert.equal(st.hasAnswer,true,'the answer survives the rebuild: '+JSON.stringify(st));
    assert.ok(st.dots >= 1,'the jump rail is rebuilt too: '+JSON.stringify(st));
    await evaluate("__test.realHistory=false");
  });
  await check('CLI stderr collapses into one folded log card',async()=>{
    // Reported with a screenshot of eight rmcp transport errors spilled under the
    // reply: "这个日志能折叠一下吗，怎么弹这么多".
    await evaluate("$test('btnNew').click();__test.failRun=false;__test.failCheck=false");
    await waitUI("$test('status').textContent === '已开始新会话' && !$test('btnSend').disabled",8000);
    await evaluate("$test('prompt').value='STDERR_NOISE';$test('btnSend').click()");
    await waitUI("$test('status').textContent === '完成' && !$test('btnSend').disabled",12000);
    await sleep(300);
    const st=JSON.parse(await evaluate(`JSON.stringify({
      cards: document.querySelectorAll('#log details.cli-log').length,
      open: (document.querySelector('#log details.cli-log')||{}).open,
      lines: document.querySelectorAll('#log details.cli-log .cli-log-line').length,
      count: (document.querySelector('#log details.cli-log .grp-count')||{}).textContent||'',
      peek: (document.querySelector('#log details.cli-log .cmd-peek')||{}).textContent||'',
      metaLeak: (document.getElementById('log').textContent.match(/CLI 日志：/g)||[]).length
    })`));
    console.log('       cli log card:', JSON.stringify(st));
    assert.equal(st.cards,1,'all stderr goes into ONE card: '+JSON.stringify(st));
    assert.equal(st.open,false,'the card starts folded: '+JSON.stringify(st));
    assert.equal(st.lines,8,'every line is kept inside it: '+JSON.stringify(st));
    assert.match(st.count,/8 行/,'the summary counts the lines: '+JSON.stringify(st));
    assert.match(st.peek,/Transport channel closed/,'and previews the last one: '+JSON.stringify(st));
    assert.equal(st.metaLeak,0,'stderr must not be dumped as plain meta text: '+JSON.stringify(st));

    // Opening it shows the lines.
    await evaluate("document.querySelector('#log details.cli-log').open = true");
    await sleep(200);
    assert.equal(await evaluate("document.querySelectorAll('#log details.cli-log .cli-log-line').length"),8,
      'the lines are visible once opened');
  });
  await check('a brand-new session shows up while its first turn runs',async()=>{
    // Reported: "新会话第一轮结束前，左边会话列表不显示，也不会转圈". The row only
    // appeared when the list reloaded AFTER the turn, so the first turn ran
    // invisibly.
    await evaluate("$test('btnNew').click();__test.failRun=false;__test.failCheck=false");
    await waitUI("$test('status').textContent === '已开始新会话' && !$test('btnSend').disabled",8000);
    await evaluate("$test('prompt').value='WAIT first turn';$test('btnSend').click()");

    await waitUI("document.querySelector('#sessionList .sess.pending') !== null",6000);
    const early=JSON.parse(await evaluate(`JSON.stringify({
      pending: document.querySelectorAll('#sessionList .sess.pending').length,
      spinner: document.querySelectorAll('#sessionList .sess.pending .sess-state.running').length,
      active: document.querySelectorAll('#sessionList .sess.pending.active').length,
      title: (document.querySelector('#sessionList .sess.pending .sess-title')||{}).textContent||'',
      threadId: $test('threadId').value
    })`));
    console.log('       first-turn row:', JSON.stringify(early));
    assert.equal(early.pending,1,'the new session gets a stand-in row immediately: '+JSON.stringify(early));
    assert.equal(early.spinner,1,'and it spins: '+JSON.stringify(early));
    assert.equal(early.active,1,'it is the current session: '+JSON.stringify(early));
    assert.match(early.title,/WAIT first turn/,'the row shows what was asked: '+JSON.stringify(early));

    // Once the CLI reports the id, the stand-in becomes the real row.
    await waitUI("$test('threadId').value !== ''",8000);
    await sleep(400);
    const bound=JSON.parse(await evaluate(`JSON.stringify({
      pending: document.querySelectorAll('#sessionList .sess.pending').length,
      matching: [...document.querySelectorAll('#sessionList .sess')]
        .filter(function (r) { return r.dataset.id === $test('threadId').value; }).length
    })`));
    console.log('       after the id arrives:', JSON.stringify(bound));
    assert.equal(bound.pending,0,'the stand-in is no longer a placeholder: '+JSON.stringify(bound));
    assert.equal(bound.matching,1,'it now carries the real session id: '+JSON.stringify(bound));

    await evaluate("$test('btnStop').click()");
    await waitUI("$test('status').textContent === '已停止'",10000);
    // Drop the synthetic row again so later checks see the fixture list.
    await evaluate("$test('btnRefreshSessions').click()");
    await sleep(300);
  });
  await check('a session keeps running while you work in another',async()=>{
    // Asked for as "左边会话窗口独立工作" plus a spinner / green dot / red dot.
    await evaluate("__test.failRun=false;__test.failCheck=false");
    // A REAL second session first: an id that exists only in the stub has no
    // rollout on disk, and resuming it is correctly refused ("无法核实此会话的原有权限").
    await evaluate("$test('btnNew').click()");
    await waitUI("$test('status').textContent === '已开始新会话' && !$test('btnSend').disabled",8000);
    await evaluate("$test('prompt').value='second session hello';$test('btnSend').click()");
    await waitUI("$test('status').textContent === '完成' && !$test('btnSend').disabled",15000);
    const otherId=await evaluate("$test('threadId').value");
    assert.ok(otherId,'the second session has an id');

    // Now a long turn in a THIRD session, which we leave running in the background.
    await evaluate("$test('btnNew').click()");
    await waitUI("$test('status').textContent === '已开始新会话' && !$test('btnSend').disabled",8000);
    await evaluate("$test('prompt').value='WAIT parallel';$test('btnSend').click()");
    await waitUI("$test('threadId').value !== '' && !$test('btnStop').classList.contains('hidden')",8000);
    const runId=await evaluate("$test('threadId').value");
    assert.ok(runId !== otherId,'the running session is a different one');

    // Put both in the sidebar so the indicators can be checked.
    await evaluate(`__test.sessions=[
      {id:${JSON.stringify(runId)},title:'Running one',cwd:${JSON.stringify(temp)}},
      {id:${JSON.stringify(otherId)},title:'Finished one',cwd:${JSON.stringify(temp)}},
      ...(__test.sessions||[])]`);
    await evaluate("$test('btnRefreshSessions').click()");
    await waitUI("document.querySelectorAll('#sessionList .sess-state.running').length >= 1",8000);
    console.log('       spinners in sidebar: ' + await evaluate("document.querySelectorAll('#sessionList .sess-state.running').length"));

    // Switching away must NOT be blocked any more.
    await evaluate("document.querySelectorAll('#sessionList .sess')[1].click()");
    await waitUI("$test('status').textContent === '已切换会话'",8000);
    assert.equal(await evaluate("$test('btnSend').disabled"),false,
      'the other session can be used while the first one runs');
    assert.equal((await (await fetch(origin+'/api/health')).json()).running,1,
      'the background turn must still be running');

    // A failing turn in the second session turns ITS dot red, not the first's.
    await evaluate("$test('prompt').value='FAIL_EVENT';$test('btnSend').click()");
    await waitUI("!$test('btnSend').disabled && $test('status').textContent.includes('运行失败')",10000);
    await sleep(300);
    const dots=JSON.parse(await evaluate(`JSON.stringify({
      running:document.querySelectorAll('#sessionList .sess-state.running').length,
      error:document.querySelectorAll('#sessionList .sess-state.error').length,
      done:document.querySelectorAll('#sessionList .sess-state.done').length
    })`));
    console.log('       dots after the failure:', JSON.stringify(dots));
    assert.equal(dots.error,1,'the failed session gets a red dot: '+JSON.stringify(dots));
    assert.equal(dots.running,1,'the background session is still spinning: '+JSON.stringify(dots));

    // Back to the first session: stopping it there must stop it there.
    await evaluate("document.querySelectorAll('#sessionList .sess')[0].click()");
    await waitUI("$test('status').textContent === '已切换会话'",8000);
    assert.equal(await evaluate("$test('btnStop').classList.contains('hidden')"),false,
      'the running session shows its own stop button');
    await evaluate("$test('btnStop').click()");
    await waitUI("$test('status').textContent === '已停止'",10000);
    await sleep(300);
    assert.equal((await (await fetch(origin+'/api/health')).json()).running,0,'nothing left running');
    assert.equal(await evaluate("document.querySelectorAll('#sessionList .sess-state.running').length"),0,
      'no spinner is left behind');
    await evaluate("__test.sessions=(__test.sessions||[]).filter(function(s){return s.title!=='Running one';})");
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
  await check('the compaction marker survives a refresh or a session switch',async()=>{
    // Reported: "压缩标记在切换会话窗口或者刷新之后就没了". The count only lived in
    // page memory and was inferred from turn-to-turn drops; replaying history used
    // to hand over ONE number, so the inference had nothing to compare.
    await evaluate(`__test.usageSeries=[{input:400000,output:2000},{input:18000,output:800},{input:19000,output:900}]`);
    await evaluate("$test('btnNew').click();$test('btnClear').click()");
    await waitUI("$test('status').textContent === '已开始新会话' && !$test('btnSend').disabled",8000);
    await evaluate("$test('btnRefreshSessions').click()");
    await waitUI("document.querySelectorAll('#sessionList .sess').length >= 1",8000);
    await evaluate("document.querySelectorAll('#sessionList .sess')[0].click()");
    await waitUI("$test('status').textContent === '已切换会话'",8000);
    const restored=JSON.parse(await evaluate(`JSON.stringify({
      hint:document.getElementById('ctxHint').textContent,
      badges:document.querySelectorAll('#ctxMarks .compact-pill').length,
      pill:(document.querySelector('#ctxMarks .compact-pill')||{}).textContent||''
    })`));
    console.log('       restored marker:', JSON.stringify(restored));
    assert.equal(restored.badges,1,'the badge must be rebuilt from the stored series: '+JSON.stringify(restored));
    assert.match(restored.hint,/疑似压缩 1 次/,'the hint must survive the switch: '+JSON.stringify(restored));
    assert.match(restored.pill,/402,000/, 'the badge keeps the real sizes: '+JSON.stringify(restored));
    await evaluate("delete __test.usageSeries");
  });
  await check('a jump-to-latest button appears only when you are above the bottom',async()=>{
    // Asked for with a screenshot of the round ↓ button above the composer.
    // The fixture transcript is shorter than the viewport at this point, so pad it
    // first: the button is about being scrolled up, which needs scrollable content.
    await evaluate(`(() => {
      const log = $test('log');
      for (let i = 0; i < 60; i++) {
        const d = document.createElement('div');
        d.className = 'meta scroll-probe';
        d.textContent = 'padding ' + i;
        log.appendChild(d);
      }
    })()`);
    await evaluate("$test('log').scrollTop = $test('log').scrollHeight");
    await sleep(300);

    const atBottom=async()=>{
      await evaluate("$test('log').scrollTop = $test('log').scrollHeight");
      await sleep(250);
      return evaluate("$test('btnScrollBottom').hidden");
    };
    assert.equal(await atBottom(),true,'at the bottom there is nothing to jump to');

    await evaluate("$test('log').scrollTop = 0");
    await sleep(250);
    const shown=JSON.parse(await evaluate(`JSON.stringify({
      hidden: $test('btnScrollBottom').hidden,
      text: $test('btnScrollBottom').textContent,
      inFooter: $test('btnScrollBottom').parentElement.tagName,
      round: getComputedStyle($test('btnScrollBottom')).borderRadius,
      gap: $test('log').scrollHeight - $test('log').scrollTop - $test('log').clientHeight
    })`));
    console.log('       scroll-bottom button:', JSON.stringify(shown));
    assert.ok(shown.gap > 160,'the probe must be scrolled far enough: '+JSON.stringify(shown));
    assert.equal(shown.hidden,false,'scrolled up, it must show: '+JSON.stringify(shown));
    assert.equal(shown.inFooter,'FOOTER','it is anchored to the composer: '+JSON.stringify(shown));
    assert.equal(shown.round,'50%','it is round: '+JSON.stringify(shown));

    // Clicking it returns to the newest message and hides itself again.
    // Wait for the SCROLL to settle, not for the button to hide: the hide
    // threshold is a 160px band, so it can disappear while still animating.
    await evaluate("$test('btnScrollBottom').click()");
    const gapOf = "$test('log').scrollHeight - $test('log').scrollTop - $test('log').clientHeight";
    let gap = await evaluate(gapOf);
    const endAt = Date.now() + 6000;
    while (gap >= 8 && Date.now() < endAt) {
      await sleep(120);
      gap = await evaluate(gapOf);
    }
    assert.ok(gap < 8,'it must actually reach the bottom: gap='+gap);
    assert.equal(await evaluate("$test('btnScrollBottom').hidden"),true,
      'and then hide itself');

    await evaluate("document.querySelectorAll('#log .scroll-probe').forEach(function(n){ n.remove(); })");
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
  await check('a live tool group is folded, and a group you open stays open',async()=>{
    // Two reports, in order:
    //   1. "折叠之后，如果来了新的命令会强制自动打开" -> the group must never be
    //      re-opened behind the user's back;
    //   2. "每次都还是要手动折叠一次" -> so it must not auto-open at all.
    // The fixture pauses between commands, so this can be checked mid-turn.
    await evaluate("$test('btnNew').click();$test('btnClear').click();__test.failRun=false;__test.failCheck=false");
    await waitUI("$test('status').textContent === '已开始新会话' && !$test('btnSend').disabled",8000);
    await evaluate("$test('prompt').value='COLLAPSE_PROBE';$test('btnSend').click()");
    await waitUI("document.querySelector('#log details.cmd-group') && document.querySelectorAll('#log .grp-body details.cmd').length >= 1",8000);
    assert.equal(await evaluate("document.querySelector('#log details.cmd-group').open"),false,
      'a live tool group must start folded');
    // Let the rest of the commands arrive: it must still be folded.
    await waitUI("$test('status').textContent === '完成' && !$test('btnSend').disabled",12000);
    assert.equal(await evaluate("document.querySelector('#log details.cmd-group').open"),false,
      'nothing may auto-open the group during a turn');
    assert.equal(await evaluate("document.querySelectorAll('#log .grp-body details.cmd').length"),4,
      'every tool must still be recorded inside the folded group (3 commands + 1 search)');

    // The other half: a group the user opens stays open while more arrive.
    await evaluate("$test('btnNew').click();$test('btnClear').click()");
    await waitUI("$test('status').textContent === '已开始新会话' && !$test('btnSend').disabled",8000);
    await evaluate("$test('prompt').value='COLLAPSE_PROBE';$test('btnSend').click()");
    await waitUI("document.querySelector('#log details.cmd-group') && document.querySelectorAll('#log .grp-body details.cmd').length >= 1",8000);
    await evaluate(`const g=document.querySelector('#log details.cmd-group');
      g.querySelector('summary').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));`);
    await sleep(100);
    assert.equal(await evaluate("document.querySelector('#log details.cmd-group').open"),true,
      'clicking the summary must open the group');
    assert.equal(await evaluate("document.querySelector('#log details.cmd-group').dataset.userOpened"),'1',
      'a deliberate open is remembered');
    await waitUI("$test('status').textContent === '完成' && !$test('btnSend').disabled",12000);
    assert.equal(await evaluate("document.querySelector('#log details.cmd-group').open"),true,
      'a group the user opened must stay open as later commands arrive');
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
    // ONE snapshot for all three facts. Reading the status twice raced: the turn
    // could end between the reads, so a passing first read was followed by a
    // failing second one (observed once as a lone flake).
    const during=JSON.parse(await evaluate(`JSON.stringify({
      tagHidden:document.getElementById('ctxStaleTag').hidden,
      stale:document.getElementById('ctxText').classList.contains('stale'),
      status:document.getElementById('status').textContent})`));
    console.log('       while running:', JSON.stringify(during));
    assert.doesNotMatch(during.status, /失败|错误/, 'the run must not fail before this check: '+JSON.stringify(during));
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
