const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'codex-rollout-test-'));
process.env.CODEX_HOME=temp;
const {readConversation,searchSession}=require('../rollout.cjs');
const {mergeCatalog}=require('../extract-models.cjs');
after(()=>{assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(temp,{recursive:true,force:true});});
const id='00000000-0000-0000-0000-000000000001';
function fixture(rows){fs.mkdirSync(path.join(temp,'sessions'),{recursive:true});fs.writeFileSync(path.join(temp,'sessions',`rollout-${id}.jsonl`),rows.map(x=>JSON.stringify(x)).join('\n'));}
test('context uses last call, excludes reasoning double count and turn totals',()=>{
  fixture([
    {type:'token_usage_record',payload:{usage:{input_tokens:100,output_tokens:50,reasoning_output_tokens:20},turn_token_usage:{input_tokens:999999,output_tokens:999999}}},
    {type:'event_msg',payload:{type:'token_count',info:{model_context_window:475000,last_token_usage:{input_tokens:200,output_tokens:80,reasoning_output_tokens:40,cached_input_tokens:100}}}},
  ]);
  const saved=readConversation(id);assert.equal(saved.usage.contextTokens,280);assert.equal(saved.contextWindow,475000);assert.equal(saved.usage.cachedInputTokens,100);
});
test('the usage series is ordered, deduplicated, and ignores empty readings',()=>{
  // The page rebuilds its "possible compaction" marker from this series after a
  // refresh or a session switch, so the shape matters: one point per turn.
  fixture([
    {type:'token_usage_record',payload:{usage:{input_tokens:100,output_tokens:50}}},
    {type:'event_msg',payload:{type:'token_count',info:{model_context_window:475000,last_token_usage:{input_tokens:100,output_tokens:50}}}},
    // A zero record was seen in a real session (124 points): without filtering it
    // reads as a 100% drop, i.e. a compaction that never happened.
    {type:'token_usage_record',payload:{usage:{input_tokens:0,output_tokens:0}}},
    {type:'token_usage_record',payload:{usage:{input_tokens:900,output_tokens:40}}},
  ]);
  const saved=readConversation(id);
  assert.deepEqual(saved.usageSeries.map((p)=>[p.input,p.output]),[[100,50],[900,40]],
    'consecutive duplicates collapse and all-zero points are dropped');
  assert.equal(saved.usage.contextTokens,940,'the last reading still drives the meter');
});
test('history preserves message order and restores the workspace/model',()=>{
  const msg=(role,text)=>({type:'response_item',payload:{type:'message',role,content:[{type:role==='assistant'?'output_text':'input_text',text}]}});
  fixture([{type:'turn_context',payload:{cwd:temp,model:'fixture'}},msg('developer','private'),msg('user','<environment_context>env</environment_context>first'),msg('assistant','answer1'),msg('user','second'),msg('assistant','answer2')]);
  const saved=readConversation(id);assert.deepEqual(saved.messages.map(x=>x.text),['first','answer1','second','answer2']);assert.equal(saved.cwd,temp);assert.equal(saved.model,'fixture');
  assert.equal(readConversation(id,{maxMessages:0}).messages.length,0);
});
test('runtime visible models define the selector; debug adds only facts',()=>{
  const models=mergeCatalog([{id:'rpc-id',model:'actual-slug',displayName:'Visible',supportedReasoningEfforts:[{reasoningEffort:'high'}]}],[{slug:'actual-slug',contextWindow:1000,usableContextWindow:950},{slug:'debug-only'}]);
  assert.equal(models.length,1);assert.equal(models[0].slug,'actual-slug');assert.equal(models[0].usableContextWindow,950);assert.equal(models[0].efforts[0].value,'high');
});
test('session search counts matches, ignores plumbing, and reports a snippet',()=>{
  const msg=(role,text)=>({type:'response_item',payload:{type:'message',role,content:[{type:role==='assistant'?'output_text':'input_text',text}]}});
  fixture([
    msg('user','<environment_context>Bus-Off mentioned only in the preamble</environment_context>real question'),
    msg('user','tell me about the Bus-Off recovery counter'),
    msg('assistant','The Bus-Off recovery counter uses 10 ms but runs every 5 ms.'),
    {type:'response_item',payload:{type:'function_call_output',output:'Bus-Off Bus-Off tool noise'}},
  ]);

  const hit=searchSession(id,'bus-off');                       // case-insensitive
  assert.ok(hit,'a keyword present in a message must be found');
  assert.equal(hit.count,2,'only the two real messages count; the environment preamble and tool output do not');
  assert.equal(hit.role,'user','the snippet names the role of the first match');
  assert.match(hit.snippet,/Bus-Off recovery counter/,'the snippet surrounds the keyword');
  assert.ok(!/environment_context/.test(hit.snippet),'plumbing never leaks into the snippet');

  assert.equal(searchSession(id,'zzz-not-there'),null,'no match means null');
  assert.equal(searchSession(id,''),null,'an empty query is not a search');
  assert.equal(searchSession('00000000-0000-0000-0000-0000000000ff','Bus-Off'),null,'an unknown session is null');
});
