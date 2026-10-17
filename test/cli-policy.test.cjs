// Check effective saved policies using the installed CLI and a LOCAL provider.
// The local provider deliberately rejects inference, then we inspect the saved
// execution policy. No real inference or user sessions are used.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const http=require('node:http');
const {buildArgs}=require('../bridge.cjs');
const {codexInvocation,spawnCodex,killTree}=require('../codex-process.cjs');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('installed CLI records restricted/full sandboxes and automatic workspace review on resume', {timeout:25000}, async(t)=>{
  try{codexInvocation([]);}catch{t.skip('Codex CLI not installed');return;}
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'codex-gui-policy-test-'));
  const home=path.join(temp,'home');fs.mkdirSync(home);
  const provider=http.createServer((req,res)=>{
    req.resume();res.writeHead(400,{'Content-Type':'application/json'});
    res.end(JSON.stringify({error:{message:'Local policy fixture rejects inference',type:'invalid_request_error',code:'fixture_rejection'}}));
  });
  let child,completion;
  function contexts(threadId=''){
    const found=[];
    function walk(dir){
      if(!fs.existsSync(dir))return;
      for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
        const file=path.join(dir,entry.name);
        if(entry.isDirectory())walk(file);
        else if(file.endsWith('.jsonl')&&(!threadId||file.includes(threadId)))found.push(...fs.readFileSync(file,'utf8').split('\n').flatMap(line=>{
          try{const row=JSON.parse(line);return row.type==='turn_context'?[row.payload]:[];}catch{return [];}
        }));
      }
    }
    walk(path.join(home,'sessions'));return found;
  }
  try{
    await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
    const config=['--ignore-user-config','-c',`projects.${JSON.stringify(temp)}.trust_level="trusted"`,'-c','model_provider="gui_test"',
      '-c','model_providers.gui_test.name="Local protocol test"',
      '-c',`model_providers.gui_test.base_url="http://127.0.0.1:${provider.address().port}/v1"`,
      '-c','model_providers.gui_test.wire_api="responses"',
      '-c','model_providers.gui_test.requires_openai_auth=false',
      '-c','model_providers.gui_test.supports_websockets=false'];
    for(const mode of ['read-only','workspace-write','full-access']){
      let thread='';
      for(const resumed of [false,true]){
      const previousCount=resumed?contexts(thread).length:0;
      const args=buildArgs({cwd:temp,sandbox:mode,webSearch:'disabled',resumeThreadId:thread});
      args.splice(1,0,...config);
      if(thread) args.splice(args.indexOf('-'),0,...config.slice(1));
      child=spawnCodex(args,{cwd:temp,env:{...process.env,CODEX_HOME:home,
        HTTP_PROXY:'',HTTPS_PROXY:'',ALL_PROXY:'',http_proxy:'',https_proxy:'',all_proxy:'',NO_PROXY:'127.0.0.1',no_proxy:'127.0.0.1'}});
      let out='',err='';child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
      child.stdout.on('data',data=>out+=data);child.stderr.on('data',data=>err+=data);
      completion=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
      child.stdin.on('error',()=>{});child.stdin.end('Local policy metadata test.');
      const timer=setTimeout(()=>killTree(child.pid),4000);
      const status=await completion;clearTimeout(timer);
      thread=out.split('\n').flatMap(line=>{try{return [JSON.parse(line)]}catch{return []}}).find(event=>event.type==='thread.started')?.thread_id||thread;
      assert.ok(thread);
      const flushDeadline=Date.now()+1500;
      while(contexts(thread).length<=previousCount&&Date.now()<flushDeadline)await sleep(30);
      assert.notEqual(status,0,'local fixture must reject inference');
      const saved=contexts(thread);
      assert.ok(saved.length>previousCount,'new turn context missing: '+err+'\n'+out);
      thread=out.split('\n').flatMap(line=>{try{return [JSON.parse(line)]}catch{return []}}).find(event=>event.type==='thread.started')?.thread_id||thread;
      assert.ok(thread);
      const context=saved.at(-1);
      if(mode==='workspace-write') assert.ok(['read-only','workspace-write'].includes(context.sandbox_policy.type));
      else assert.equal(context.sandbox_policy.type,mode==='full-access'?'danger-full-access':mode,JSON.stringify({mode,resumed,context}));
      if(mode==='workspace-write'){
        assert.equal(context.approval_policy,'on-request');
        assert.equal(context.approvals_reviewer,'auto_review');
      }
      }
    }
  }finally{
    if(child?.exitCode===null){killTree(child.pid);await completion.catch(()=>{});}
    provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));
    assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir())+path.sep));
    fs.rmSync(temp,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
});
