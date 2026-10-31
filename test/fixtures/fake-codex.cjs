// A local CLI/RPC fixture: exercises the real process/HTTP/browser boundaries
// without inference, credentials, quota, or edits to existing conversations.
const { randomUUID } = require('node:crypto');
const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === 'app-server') {
  let initialized = false;
  let approvalResponse = null;
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const msg = JSON.parse(line);
    const reply = (result) => process.stdout.write(JSON.stringify({ id: msg.id, result }) + '\n');
    if (!msg.method) { approvalResponse = msg; return; }
    if (msg.method === 'initialize') { setTimeout(() => reply({ userAgent: 'fixture' }), 30); return; }
    if (msg.method === 'initialized') {
      initialized = true;
      process.stdout.write(JSON.stringify({ method:'item/commandExecution/requestApproval', id:100000, params:{} }) + '\n');
      return;
    }
    if (!initialized) { process.stdout.write(JSON.stringify({id:msg.id,error:{message:'Not initialized'}})+'\n'); return; }
    if (msg.method === 'test/disconnect') { process.exit(0); return; }
    if (msg.method === 'test/approval') { reply(approvalResponse); return; }
    if (msg.method === 'thread/list') { reply({ data:[] }); return; }
    if (msg.method === 'model/list') { reply({ data:[{id:'fixture',model:'fixture',displayName:'Fixture',supportedReasoningEfforts:[]}] }); return; }
    reply({ ok:true });
  });
} else {
  let prompt = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { prompt += chunk; });
  process.stdin.on('end', async () => {
    const resume = args.indexOf('resume');
    const id = resume >= 0 ? args[resume + 1] : randomUUID();
    const emit = (event) => process.stdout.write(JSON.stringify(event) + '\n');
    emit({ type:'thread.started', thread_id:id });
    emit({ type:'turn.started' });
    if (prompt.startsWith('WAIT')) { setInterval(() => {}, 1000); return; }
    if (prompt.startsWith('FAIL_EVENT')) {
      // Codex writes the session file when the session starts, BEFORE the turn can
      // fail -- so even a failed turn can be resumed. Without this the bridge
      // rightly refuses to continue it ("无法核实此会话的原有权限").
      const dir=path.join(process.env.CODEX_HOME,'sessions');fs.mkdirSync(dir,{recursive:true});
      fs.writeFileSync(path.join(dir,`rollout-${id}.jsonl`),[
        {type:'turn_context',payload:{cwd:process.cwd(),model:'gpt-6.1-sol',sandbox_policy:{type:'read-only'}}},
        {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:prompt}]}},
      ].map(row=>JSON.stringify(row)).join('\n'));
      emit({type:'turn.failed',error:{message:'fixture failure'}});
      return;
    }
    // A transport hiccup reported through the `error` event: this is a retry
    // notice, not a failure, and must not render as a red error box.
    if (prompt.startsWith('RECONNECT')) {
      emit({ type:'error', message:'Reconnecting... 2/5 (stream disconnected before completion: tls handshake eof)' });
      await new Promise((resolve) => setTimeout(resolve, 40));
      emit({ type:'item.completed', item:{ type:'agent_message', text:'重连后继续：DONE' } });
      emit({ type:'turn.completed', usage:{input_tokens:1000,output_tokens:50,reasoning_output_tokens:0,cached_input_tokens:0} });
      return;
    }
    // The answer is complete, but the process lingers -- exactly what real
    // `codex exec` does (rollout flush, plugin-catalog requests). Measured by the
    // user as ~10s of spinner after the reply had visibly finished.
    if (prompt.startsWith('SLOW_EXIT')) {
      emit({ type:'item.completed', item:{ type:'agent_message', text:'答案已经写完了。' } });
      emit({ type:'turn.completed', usage:{input_tokens:900,output_tokens:20,reasoning_output_tokens:0,cached_input_tokens:0} });
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return;
    }
    // A command whose completion carries an exit code but NO `status` field --
    // exactly the shape that made a finished row still read 执行中 while the group
    // header counted it as failed.
    if (prompt.startsWith('EXIT_NO_STATUS')) {
      emit({ type:'item.started', item:{ id:'cmd-x', type:'command_execution',
        command:'"C:\\\\Windows\\\\System32\\\\cmd.exe" /d /c exit 1', status:'in_progress' } });
      await new Promise((resolve) => setTimeout(resolve, 80));
      emit({ type:'item.completed', item:{ id:'cmd-x', type:'command_execution',
        command:'"C:\\\\Windows\\\\System32\\\\cmd.exe" /d /c exit 1', exit_code:1,
        aggregated_output:'boom' } });
      emit({ type:'item.completed', item:{ type:'agent_message', text:'done' } });
      emit({ type:'turn.completed', usage:{input_tokens:800,output_tokens:20,reasoning_output_tokens:0,cached_input_tokens:0} });
      return;
    }
    // A command that never finishes, so stopping the turn leaves a card in flight.
    if (prompt.startsWith('CMD_HANG')) {
      emit({ type:'item.started', item:{ id:'cmd-w', type:'command_execution',
        command:'"C:\\\\Windows\\\\System32\\\\cmd.exe" /d /c ping -n 60 127.0.0.1', status:'in_progress' } });
      setInterval(() => {}, 1000);
      return;
    }
    // A burst of stderr, like the rmcp transport retries. It used to be painted
    // as a wall of plain meta text at the end of the turn.
    if (prompt.startsWith('STDERR_NOISE')) {
      for (let i = 0; i < 8; i++) {
        process.stderr.write('2026-10-21T07:49:0' + i + 'Z ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed\n');
      }
      emit({ type:'item.completed', item:{ type:'agent_message', text:'日志已产生。' } });
      emit({ type:'turn.completed', usage:{input_tokens:700,output_tokens:10,reasoning_output_tokens:0,cached_input_tokens:0} });
      return;
    }
    // A SPURIOUS upstream error: it reports "capacity" even though nothing is
    // limited, exactly as Codex does now and then. Fails once, succeeds after.
    if (prompt.startsWith('FLAKY_CAPACITY')) {
      const mark = path.join(process.cwd(), '.flaky-capacity-once');
      if (!fs.existsSync(mark)) {
        try { fs.writeFileSync(mark, '1'); } catch {}
        emit({ type:'turn.failed', error:{ message:'Selected model is at capacity. Please try a different model.' } });
        return;
      }
      emit({ type:'item.completed', item:{ type:'agent_message', text:'重试后成功：CAPACITY_OK' } });
      emit({ type:'turn.completed', usage:{input_tokens:600,output_tokens:12,reasoning_output_tokens:0,cached_input_tokens:0} });
      return;
    }
    // A turn that says nothing for a while: exactly what a stalled request looks
    // like, and what the stall warning is for.
    if (prompt.startsWith('SILENT_GAP')) {
      await new Promise((resolve) => setTimeout(resolve, 1600));
      emit({ type:'item.completed', item:{ type:'agent_message', text:'静默结束：SILENT_OK' } });
      emit({ type:'turn.completed', usage:{input_tokens:500,output_tokens:8,reasoning_output_tokens:0,cached_input_tokens:0} });
      return;
    }
    const big = prompt.startsWith('BIG');
    // THREE deliberately LONG commands, so two things can be checked for real:
    //   1. a long command left in <summary> kept the card wide open when folded;
    //   2. several commands must collapse into ONE group, not one card each.
    const commands = [
      '"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -Command "Get-Content -LiteralPath \'.codex-gui/attachments/fixture/N72.jflash\' -Raw"',
      '"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -NoProfile -Command "cmd.exe /d /c dir /b \'.codex-gui/attachments/fixture\'"',
      '"C:\\\\Windows\\\\System32\\\\cmd.exe" /d /c echo CMD output test: OK',
    ];
    for (let i = 0; i < commands.length; i++) {
      const item = {id:'cmd-' + (i + 1), type:'command_execution', command:commands[i], status:'in_progress'};
      emit({ type:'item.started', item });
      // A gap between commands, so a test can act WHILE the turn is still running
      // (e.g. collapse the group and check the next command does not re-open it).
      await new Promise((resolve) => setTimeout(resolve, 120));
      emit({ type:'item.completed', item:{ ...item, status:'completed', exit_code:0,
        aggregated_output: i === 2 ? 'CMD output test: OK' : 'ok' } });
    }
    // A web search is tool activity too: it must fold into the same group.
    emit({ type:'item.completed', item:{ id:'ws-1', type:'web_search',
      query:'codex cli 0.162.1 release notes',
      action:{ type:'search', query:'codex cli 0.162.1 release notes', queries:null } } });

    // A file change. MEASURED live shape: `changes` is an ARRAY of { path, kind }
    // and carries NO diff. One of the paths contains a script tag on purpose: the
    // renderer must show it as text.
    // Also materialise a small text file so the viewer has something real to open.
    try {
      require('node:fs').writeFileSync(path.join(process.cwd(), 'sample.txt'),
        'first line\nsecond line\nthird line\n', 'utf8');
    } catch { /* cwd may be read-only in some fixture runs */ }
    const changedFiles = [
      { path: path.join(process.cwd(), 'note.txt'), kind: 'update' },
      { path: path.join(process.cwd(), 'added.md'), kind: 'add' },
      { path: path.join(process.cwd(), '<script>alert(1)</script>.txt'), kind: 'delete' },
    ];
    emit({ type:'item.started', item:{ id:'fc-1', type:'file_change',
      changes: changedFiles, status:'in_progress' } });
    await new Promise((resolve) => setTimeout(resolve, 60));
    emit({ type:'item.completed', item:{ id:'fc-1', type:'file_change',
      changes: changedFiles, status:'completed' } });
    // Deliberately split a UTF-8 code point across OS pipe chunks.
    // The reply carries Markdown AND an HTML injection attempt: the UI must
    // render the Markdown without ever letting model output create markup.
    const replyText = [
      '中文🙂 ' + prompt,
      '',
      '[link](https://example.com/a?b=1&c=2) and **bold** and `inline`',
      '',
      // A local path wrapped in <...> (CommonMark) with a space in it -- exactly
      // what Codex writes for file links. It used to render as raw syntax.
      '[查看文档](<E:/dir/00 自测问答.md>)',
      // A file that really exists in the working directory, so the in-page viewer
      // can be driven end to end (open + jump to a line).
      '[sample.txt](<' + path.join(process.cwd(), 'sample.txt') + '>)',
      '',
      '```js',
      'const a = 1 < 2;',
      '```',
      '',
      // A table directly followed by a rule: the delimiter row `|---|---|` also
      // looks like a horizontal rule, so this pins the parse order.
      '| 问题 | 相关寄存器 |',
      '|---|---|',
      '| 哪些 ID 通过 | RXMIR |',
      '| 收到后通知 CPU | IFLAG |',
      '',
      '---',
      '',
      // A LOOSE ordered list with indented continuation, a fenced block inside an
      // item, and blank lines between items. MEASURED against a real reply: the
      // renderer used to close the list at the first non-marker line, so every item
      // became its own <ol> and the page showed "1. 1. 1.".
      '1. **外层成立，进入。**  ',
      '   内层判断不成立，跳过 `#30～#40`。',
      '',
      '2. **继续执行后面的 `#50～#60`。**  ',
      '   设置时钟源，然后执行：',
      '',
      '   ```c',
      '   CAN_WRITE_PROTECTED_REG_RESET(pFlexCANLocal->canmcr, kFlexCAN_MDIS);',
      '   ```',
      '',
      '   清掉 `MDIS`，重新启用模块。',
      '',
      '3. **接下来执行软复位。**  ',
      '   `CanLL_ExecuteSoftReset()` 发起软复位并等待完成。',
      '',
      '<img src=x onerror="window.__xss=1">',
    ].join('\n');
    const line = Buffer.from(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:replyText}})+'\n');
    const split = line.indexOf(Buffer.from('中')) + 1;
    process.stdout.write(line.subarray(0,split));
    await new Promise((resolve) => setTimeout(resolve,20));
    process.stdout.write(line.subarray(split));
    emit({type:'turn.completed', usage: big
      ? {input_tokens:400000,output_tokens:2000,reasoning_output_tokens:0,cached_input_tokens:390000}
      : {input_tokens:40000,output_tokens:1000,reasoning_output_tokens:0,cached_input_tokens:30000}});
    // Mimic a rollout flush that follows the JSON completion event.
    await new Promise((resolve) => setTimeout(resolve,20));
    const dir=path.join(process.env.CODEX_HOME,'sessions');fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,`rollout-${id}.jsonl`),[
      {type:'turn_context',payload:{cwd:process.cwd(),model:'gpt-6.1-sol',sandbox_policy:{type:'read-only'}}},
      // Must match the usage reported above: the bridge prefers the rollout's
      // numbers (so the meter does not lag a turn), so a mismatch here would
      // silently override what the event stream said.
      {type:'token_usage_record',payload:{usage: big
        ? {input_tokens:400000,output_tokens:2000,reasoning_output_tokens:0,cached_input_tokens:390000}
        : {input_tokens:40000,output_tokens:1000,reasoning_output_tokens:0,cached_input_tokens:30000}}},
      {type:'event_msg',payload:{type:'token_count',info:{model_context_window:475000}}},
      // The user turn and the command executions, exactly as Codex records them.
      // Replaying these is what keeps a refreshed session from losing the
      // commands the user just watched run.
      {type:'response_item',payload:{type:'message',role:'user',
        content:[{type:'input_text',text:prompt}]}},
      ...commands.map((cmd,i)=>({type:'event_msg',payload:{type:'item_completed',
        turn_id:'fixture-turn',item:{type:'CommandExecution',id:'exec-fixture-'+i,
          command:[cmd],status:'completed',exit_code:0,
          aggregated_output:i===2?'CMD output test: OK':'ok'}}})),
      // The rollout's FileChange shape DIFFERS from the live one: `changes` is an
      // OBJECT keyed by path and it DOES carry a unified diff. Both must render.
      {type:'event_msg',payload:{type:'item_completed',turn_id:'fixture-turn',
        item:{type:'FileChange',id:'exec-fixture-file',status:'completed',changes:{
          [changedFiles[0].path]:{type:'update',unified_diff:'@@ -1,3 +1,3 @@\n alpha\n-beta\n+BETA\n gamma\n',move_path:null},
          [changedFiles[1].path]:{type:'add',unified_diff:'@@ -0,0 +1,2 @@\n+first line\n+second line\n',move_path:null},
          [changedFiles[2].path]:{type:'delete',unified_diff:'@@ -1,1 +0,0 @@\n-gone\n',move_path:null},
        },stdout:'Success. Updated the following files:',stderr:''}}},
      {type:'response_item',payload:{type:'message',role:'assistant',
        content:[{type:'output_text',text:replyText}]}},
    ].map(row=>JSON.stringify(row)).join('\n'));
  });
}
