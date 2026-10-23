const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'codex-gui-test-'));
process.env.CODEX_GUI_SETTINGS_FILE=path.join(temp,'settings.json');
process.env.CODEX_HOME=path.join(temp,'codex-home');
process.env.CODEX_GUI_DATA_DIR=path.join(temp,'data');
process.env.CODEX_GUI_CODEX_PATH=path.join(__dirname,'fixtures/fake-codex.cjs');
const {server,stageAttachments,validateAttachments}=require('../bridge.cjs');
const appserver=require('../appserver.cjs');
let base;
const runIds=new Set();
before(async()=>{await new Promise((resolve)=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;});
after(async()=>{
  for(const runId of runIds) await post('/api/stop',{runId}).catch(()=>{});
  appserver.killServer();
  server.closeAllConnections();
  await new Promise((resolve)=>server.close(resolve));
  // Only remove the unique directory this suite created in the OS temp folder.
  assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir())+path.sep));
  fs.rmSync(temp,{recursive:true,force:true});
});
function post(route,body,options={}){return fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),...options});}
async function until(check){const deadline=Date.now()+5000;while(Date.now()<deadline){if(await check())return;await new Promise(r=>setTimeout(r,30));}throw new Error('condition timed out');}
async function openRun(prompt,more={}){
  const response=await post('/api/run',{prompt,cwd:temp,sandbox:'read-only',proxy:'',...more});
  assert.equal(response.status,200);
  const reader=response.body.getReader();let text='';
  const decoder=new TextDecoder();
  while(!text.includes('event: meta')||!text.includes('thread.started')){const chunk=await reader.read();assert.equal(chunk.done,false);text+=decoder.decode(chunk.value,{stream:true});}
  const meta=JSON.parse(text.split('\n').find(x=>x.startsWith('data: ')).slice(6));
  runIds.add(meta.runId);
  const done=(async()=>{for(;;){const chunk=await reader.read();if(chunk.done)return text; text+=decoder.decode(chunk.value,{stream:true});}})();
  return {meta,done};
}
test('malformed JSON and invalid options fail before spawning a process',async()=>{
  assert.equal((await post('/api/run',{}, {body:'{broken'})).status,400);
  assert.equal((await post('/api/run',{prompt:'hello',cwd:'missing'})).status,400);
  assert.equal((await post('/api/run',{prompt:'hello',cwd:temp,sandbox:'__proto__'})).status,400);
  assert.equal((await post('/api/run',{prompt:'hello',cwd:temp,resumeThreadId:'--last'})).status,400);
  assert.equal((await (await fetch(base+'/api/health')).json()).running,0);
});
test('opening a local path is limited to the working directory',async()=>{
  // The path comes from model output; the endpoint must not be a way to launch
  // arbitrary things on disk.
  const settings=await (await fetch(base+'/api/settings')).json();
  assert.equal((await post('/api/open-path',{path:'relative.txt'})).status,400,'relative paths are refused');
  assert.equal((await post('/api/open-path',{path:path.join(settings.cwd,'nope-xyz.txt')})).status,404,'missing files are refused');
  const outside=path.join(os.tmpdir(),'codex-gui-outside-'+Date.now()+'.txt');
  fs.writeFileSync(outside,'x');
  try{
    assert.equal((await post('/api/open-path',{path:outside})).status,403,'paths outside the working directory are refused');
  }finally{try{fs.unlinkSync(outside);}catch{}}
});
test('the viewer reads files, but only inside the working directory',async()=>{
  const settings=await (await fetch(base+'/api/settings')).json();
  assert.equal((await post('/api/file',{path:'relative.txt'})).status,400,'relative paths are refused');
  assert.equal((await post('/api/file',{path:path.join(settings.cwd,'nope-xyz.txt')})).status,404,'missing files are refused');
  const outside=path.join(os.tmpdir(),'codex-gui-view-'+Date.now()+'.txt');
  fs.writeFileSync(outside,'secret');
  try{
    assert.equal((await post('/api/file',{path:outside})).status,403,'paths outside the working directory are refused');
  }finally{try{fs.unlinkSync(outside);}catch{}}

  const inside=path.join(settings.cwd,'view-probe.txt');
  fs.writeFileSync(inside,'line one\r\nline two\r\n','utf8');
  try{
    const r=await post('/api/file',{path:inside});
    assert.equal(r.status,200);
    const body=await r.json();
    assert.equal(body.ok,true);
    assert.equal(body.name,'view-probe.txt','the original file name casing is kept');
    assert.equal(body.binary,false);
    assert.match(body.text,/line one/);
  }finally{try{fs.unlinkSync(inside);}catch{}}

  // A bare `file.c:236` reference has no directory, so the page asks for a lookup.
  const named=path.join(settings.cwd,'find-probe.c');
  fs.writeFileSync(named,'int main(void){return 0;}\n','utf8');
  try{
    const found=await (await post('/api/find-file',{name:'find-probe.c'})).json();
    assert.equal(found.path,named,'the lookup resolves a bare file name under the cwd');
    const missing=await (await post('/api/find-file',{name:'definitely-not-here.c'})).json();
    assert.equal(missing.path,'','an unknown name resolves to nothing');
    assert.equal((await post('/api/find-file',{name:'../escape'})).status,400,'a name with separators is refused');
  }finally{try{fs.unlinkSync(named);}catch{}}
});
test('cross-origin, non-JSON, and forged Host requests are denied',async()=>{
  assert.equal((await post('/api/settings',{}, {headers:{Origin:'https://example.com','Content-Type':'application/json'}})).status,403);
  assert.equal((await post('/api/settings',{}, {headers:{'Content-Type':'text/plain'}})).status,415);
  const status=await new Promise((resolve,reject)=>{const req=http.get(base+'/api/health',{headers:{Host:'attacker.example'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);});
  assert.equal(status,403);
});
test('oversize settings body returns an HTTP error, not a connection reset',async()=>{
  assert.equal((await post('/api/settings',{padding:'x'.repeat(2*1024*1024)})).status,413);
});
test('a spurious capacity error is retried without bothering the user',async()=>{
  // Codex sometimes reports "Selected model is at capacity" when nothing is
  // limited. One silent retry is cheaper than making the user press send again.
  const run=await openRun('FLAKY_CAPACITY');
  const text=await run.done;
  assert.match(text,/event: retry/,'the page must be told a retry is happening');
  assert.match(text,/CAPACITY_OK/,'the second attempt must carry the answer');
  const exits=text.split('event: exit').length-1;
  assert.equal(exits,1,'the failed attempt must not emit its own exit');
});
test('the last turn stderr is kept so a replay can show it',async()=>{
  // stderr never reaches the rollout, so a refreshed session used to lose the CLI
  // log entirely -- and the post-turn refresh wiped the card that had just appeared.
  const run=await openRun('STDERR_NOISE');
  const text=await run.done;
  const m=text.match(/"thread_id"\s*:\s*"([0-9a-f-]{8,})"/);
  assert.ok(m,'the stream carries the thread id');
  const h=await (await fetch(base+'/api/history?threadId='+m[1])).json();
  assert.match(h.cliLog||'',/Transport channel closed/,'the log must come back with the history');
  assert.match(h.cliLog||'',/rmcp/,'and it is the cleaned text');
});
test('the stream announces the finished answer before the process exits',async()=>{
  // `turn.completed` is withheld until the process exits so it can carry final
  // usage and file diffs. The UI still has to learn the ANSWER is done earlier:
  // the CLI spends seconds afterwards flushing the rollout. Reported as "回复吐完
  // 了转圈还转了10s".
  const run=await openRun('hello');
  const text=await run.done;
  const doneAt=text.indexOf('event: answer_done');
  const exitAt=text.indexOf('event: exit');
  const completedAt=text.indexOf('turn.completed');
  assert.ok(doneAt>0,'the stream must carry an answer_done event');
  assert.ok(exitAt>doneAt,'answer_done must arrive BEFORE the exit event');
  // The enriched turn.completed still arrives (with usage and file diffs), after
  // the early signal and before exit -- that order is what keeps the meter working.
  assert.ok(completedAt>doneAt,'the enriched completed turn comes after answer_done');
  assert.ok(completedAt<exitAt,'and before the process exit');
});
test('attachments accept empty files and preserve same-name files across turns',()=>{
  const input=validateAttachments([{name:'same.txt',dataBase64:Buffer.from('one').toString('base64')},{name:'same.txt',dataBase64:Buffer.from('two').toString('base64')},{name:'empty',dataBase64:''}]);
  const first=stageAttachments(temp,input),second=stageAttachments(temp,input);
  assert.equal(first.length,3);assert.notEqual(first[0].abs,first[1].abs);assert.notEqual(first[0].abs,second[0].abs);
  assert.equal(fs.readFileSync(first[0].abs,'utf8'),'one');assert.equal(fs.readFileSync(first[1].abs,'utf8'),'two');
  assert.equal(fs.statSync(first[2].abs).size,0);
  assert.throws(()=>validateAttachments([{name:'x',path:__filename}]),/格式无效/);
  assert.throws(()=>validateAttachments([{name:'x',dataBase64:'!!!!'}]),/格式无效/);
});
test('a >2 MB attachment and a >32 KB Unicode prompt survive real pipes and HTTP',async()=>{
  const prompt='--help\n中文🙂'.repeat(5000);
  const response=await post('/api/run',{prompt,cwd:temp,sandbox:'read-only',proxy:'',attachments:[{name:'large.bin',dataBase64:Buffer.alloc(3*1024*1024,42).toString('base64')}]});
  assert.equal(response.status,200);
  const text=await response.text();
  const frames=text.split('\n\n').map(x=>x.split('\n').find(l=>l.startsWith('data: '))).filter(Boolean).map(l=>JSON.parse(l.slice(6)));
  const message=frames.find(x=>x.type==='item.completed'&&x.item.type==='agent_message').item.text;
  assert.ok(message.includes(prompt));assert.ok(!message.includes('\ufffd'));
  const meta=frames.find(x=>x.runId);assert.equal(meta.proxy,null);assert.equal(meta.attachments[0].size,3*1024*1024);
  const end=frames.at(-1);assert.equal(end.code,0);
  const completed=frames.find(x=>x.type==='turn.completed');
  // The fixture's rollout usage must match what the event stream reported, since
  // the bridge prefers the rollout numbers so the meter does not lag a turn.
  // contextTokens = input + output (cached is a SUBSET of input, never added).
  assert.equal(completed.contextUsage.contextTokens,41000);
  assert.equal(completed.usage.input_tokens,40000);
});
test('stopping one run leaves another run alive; same-thread concurrency is rejected',async()=>{
  const id='00000000-0000-0000-0000-000000000001';
  const dir=path.join(process.env.CODEX_HOME,'sessions');fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,`rollout-${id}.jsonl`),JSON.stringify({type:'turn_context',payload:{sandbox_policy:{type:'read-only'}}}));
  assert.equal((await post('/api/run',{prompt:'hello',cwd:temp,resumeThreadId:id,sandbox:'full-access'})).status,409);
  const first=await openRun('WAIT first',{resumeThreadId:id});
  const second=await openRun('WAIT second');
  assert.equal((await post('/api/run',{prompt:'hello',cwd:temp,resumeThreadId:id})).status,409);
  assert.equal((await post('/api/stop',{})).status,400);
  await post('/api/stop',{runId:first.meta.runId});
  assert.match(await first.done,/"stopped":true/);
  assert.equal((await (await fetch(base+'/api/health')).json()).running,1);
  await post('/api/stop',{runId:second.meta.runId});
  assert.match(await second.done,/"stopped":true/);
});
test('a disconnected browser terminates its Codex process',async()=>{
  const controller=new AbortController();
  const response=await post('/api/run',{prompt:'WAIT disconnect',cwd:temp,sandbox:'read-only',proxy:''},{signal:controller.signal});
  const reader=response.body.getReader();await reader.read();controller.abort();
  await reader.cancel().catch(()=>{});
  await until(async()=>(await (await fetch(base+'/api/health')).json()).running===0);
});
test('settings only acknowledge successful validated writes',async()=>{
  const before=await (await fetch(base+'/api/settings')).json();
  assert.equal((await post('/api/settings',{recentDirs:'bad'})).status,400);
  const saved=await (await post('/api/settings',{proxy:'',theme:'light'})).json();
  assert.equal(saved.proxy,'');assert.equal(saved.theme,'light');
  assert.equal(JSON.parse(fs.readFileSync(process.env.CODEX_GUI_SETTINGS_FILE,'utf8')).theme,'light');
  assert.equal((await (await fetch(base+'/api/settings')).json()).cwd,before.cwd);
});
test('concurrent RPC users wait for initialization; unexpected approvals are rejected',async()=>{
  const results=await Promise.all(Array.from({length:6},()=>appserver.withClient(call=>call('model/list',{}))));
  assert.ok(results.every(x=>x.data.length===1));
  const approval=await appserver.withClient(call=>call('test/approval',{}));
  assert.equal(approval.error.code,-32601);assert.equal(approval.result,undefined);
});
test('RPC disconnect rejects immediately and a later call reconnects',async()=>{
  const start=Date.now();
  await assert.rejects(appserver.withClient(call=>call('test/disconnect',{})),/disconnected/);
  assert.ok(Date.now()-start<3000);
  assert.equal((await appserver.withClient(call=>call('model/list',{}))).data.length,1);
});
