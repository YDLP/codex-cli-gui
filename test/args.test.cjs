const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildArgs, PERMISSION_MODES, WEB_SEARCH_MODES } = require('../bridge.cjs');
const { codexInvocation, proxyEnv } = require('../codex-process.cjs');
const base = { cwd:__dirname, model:'gpt-6.1-sol', reasoningEffort:'high', webSearch:'live',sandbox:'workspace-write',prompt:'--help\n中文🙂' };
for (const [mode, spec] of Object.entries(PERMISSION_MODES)) {
  for (const resume of [false,true]) {
    test(`${mode}, ${resume?'resume':'new'}: parent options parse with installed CLI`, (t) => {
      const args = buildArgs({...base,sandbox:mode,resumeThreadId:resume?'00000000-0000-0000-0000-000000000001':''});
      assert.equal(args[0],'exec');
      assert.ok(args.includes('-'));
      assert.ok(!args.includes(base.prompt));
      assert.ok(!args.includes('--search'));
      for(const flag of spec.freshFlags) assert.ok(args.includes(flag));
      if(resume) for(const flag of spec.freshFlags) assert.ok(args.indexOf(flag)<args.indexOf('resume'));
      let inv; try { inv=codexInvocation([...args,'--help']); } catch { t.skip('Codex CLI not installed'); return; }
      const parsed=spawnSync(inv.file,inv.args,{encoding:'utf8',windowsHide:true,timeout:10000});
      assert.equal(parsed.status,0,parsed.stderr);
    });
  }
}
test('images and long option-looking prompts remain separate from argv', () => {
  const image=path.join(__dirname,'../.codex-gui/attachments/attach-test.png');
  const args=buildArgs({...base,prompt:'--config x=y\n'.repeat(10000),images:[image,image]});
  assert.equal(args.filter((arg)=>arg==='-i').length,2);
  assert.ok(args.indexOf('-i')>args.indexOf('-'));
  assert.ok(args.join(' ').length<2000);
});
test('untrusted override values are never interpolated', () => {
  const args=buildArgs({...base,reasoningEffort:'bad"\nevil',webSearch:'bad"\nevil'});
  assert.ok(!args.join(' ').includes('evil'));
  for(const mode of WEB_SEARCH_MODES) assert.ok(buildArgs({...base,webSearch:mode}).includes(`web_search="${mode}"`));
});
test('empty proxy explicitly clears inherited proxies', () => {
  const env=proxyEnv('');
  for(const key of ['HTTP_PROXY','HTTPS_PROXY','http_proxy','https_proxy','ALL_PROXY','all_proxy']) assert.equal(env[key],undefined);
});
