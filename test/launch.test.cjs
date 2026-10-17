const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const http=require('node:http');
const {spawn}=require('node:child_process');
const {killTree}=require('../codex-process.cjs');
const launcher=path.join(__dirname,'../launch.cjs');
function launch(env){
  const child=spawn(process.execPath,[launcher],{windowsHide:true,env:{...process.env,CODEX_GUI_NO_BROWSER:'1',...env}});
  let output='';child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>output+=data);
  const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>resolve({code,output}));});
  return {child,done};
}
test('launcher rejects invalid ports without invoking a shell',async()=>{
  const result=await launch({CODEX_GUI_PORT:'bad-port'}).done;
  assert.equal(result.code,1);assert.match(result.output,/between 1 and 65535/);
});
test('launcher does not reuse a listener that is not a GUI',async()=>{
  const listener=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end('{"ok":true}');});
  await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));
  try{
    const result=await launch({CODEX_GUI_PORT:String(listener.address().port)}).done;
    assert.equal(result.code,1);assert.match(result.output,/another application/);
  }finally{listener.closeAllConnections();await new Promise(resolve=>listener.close(resolve));}
});
test('launcher starts a custom-port GUI and reuses it on a second launch', {timeout:15000},async()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'codex-gui-launch-test-'));
  const reservation=http.createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
  const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  const env={CODEX_GUI_PORT:String(port),CODEX_GUI_SETTINGS_FILE:path.join(temp,'settings.json'),CODEX_HOME:path.join(temp,'home'),CODEX_GUI_CODEX_PATH:path.join(__dirname,'fixtures/fake-codex.cjs')};
  const running=launch(env);
  try{
    let health;
    const deadline=Date.now()+7000;
    while(Date.now()<deadline){
      try{health=await(await fetch(`http://127.0.0.1:${port}/api/health`)).json();break;}catch{}
      await new Promise(resolve=>setTimeout(resolve,40));
    }
    assert.equal(health?.app,'codex-local-gui');assert.equal(health.version,'1.1.0');
    const duplicate=await launch(env).done;
    assert.equal(duplicate.code,0);assert.match(duplicate.output,/already running/);
    const again=await(await fetch(`http://127.0.0.1:${port}/api/health`)).json();assert.equal(again.pid,health.pid);
  }finally{
    killTree(running.child.pid);await running.done;
    assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(temp,{recursive:true,force:true});
  }
});
