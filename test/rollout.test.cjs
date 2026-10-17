const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'codex-rollout-test-'));
process.env.CODEX_HOME=temp;
const {readConversation}=require('../rollout.cjs');
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
