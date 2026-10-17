# 贡献指南

[English](CONTRIBUTING.md) · **简体中文**

谢谢你看这个项目。它是几天内为一个人的工作流写的，所以**刻意做得很小**，可扩展的地方很多。这份文件是「改动它但别把已经做对的部分弄坏」的最短路径。

## 基本要求

1. **每个修复都要带一个「修复前会失败」的测试。** 测试套件之所以存在，是因为有好几个 bug 被「修好」了两三次却依然是坏的。写不出失败测试，就在 PR 里描述手工复现步骤。
2. **运行时依赖保持为零。** 只用 Node 内置模块。这是「`node launch.cjs` 不用装任何东西」的前提。
3. **别拿「测试全绿」当结论。** 这个项目里最难缠的 bug 单元测试完全看不见，真实用五秒钟就暴露了。
4. `REVIEW.md` 是工程日志。修了微妙的问题就往里加一条 —— **包括走过的弯路**。

## 代码地图

| 文件 | 里面有什么 |
|---|---|
| `index.html` | 浏览器里跑的全部东西：Markdown 渲染、工具卡片、跳转栏、会话列表、设置抽屉。无构建步骤、无外部资源。 |
| `bridge.cjs` | HTTP 路由、请求校验、附件暂存、启动回合、SSE 封帧、设置持久化。 |
| `codex-process.cjs` | `codexInvocation()`（找可执行文件）、`proxyEnv()`（注入代理）、`spawnCodex()`、`killTree()`。 |
| `appserver.cjs` | 到 `codex app-server` 的私有 stdio JSON-RPC，用于会话列表/重命名/删除。 |
| `rollout.cjs` | 解析 `~/.codex/sessions/**/*.jsonl`：消息、命令执行、推理、联网搜索、用量、附件。 |
| `launch.cjs` | 健康检查、复用检测、`--detach` 后台模式。 |
| `check-ui.cjs` | 真实浏览器（CDP）驱动的检查。**这是仓库里最有价值的文件。** |
| `test/fixtures/fake-codex.cjs` | 假 Codex CLI，发出真实形状的 JSONL，**并且**写出对应的 rollout。 |

### 关键位置

- `index.html` → `renderMarkdownInto()` —— 构建 DOM 的 Markdown 渲染器
- `index.html` → `addCmd()` / `addWebSearch()` / `addReasoning()` —— 工具条目
- `index.html` → `toolRow()` / `ensureToolGroup()` / `collapseToolCards()` —— 每轮的工具卡片
- `index.html` → `updateJumpActive()` / `onRailWheel()` —— 跳转栏
- `bridge.cjs` → `handleLine()` —— Codex JSONL 变 SSE 帧的地方

## 已经踩过的坑

每一条都花了真实时间，**请不要把它们改回去**。

### 绝不要调用 `thread/resume` 或 `thread/read`

它们会**拿到线程写锁且永不释放**。之后任何 `codex exec resume <id>` 都会报
`thread-store conflict: ... already has an active writer`，**会话就废了**。
`appserver.cjs` 因此被限制为只读元数据调用（`thread/list`、`thread/name/set`、`thread/delete`）。

想要流式的话，app-server 协议里确实有 `item/agentMessage/delta` —— 但要证明它安全，需要先用 app-server 跑一轮，再验证 `codex exec resume` 是否仍然可用。**先做这个实验，再写代码。**

### 绝不要用 `innerHTML` 渲染模型输出

`renderMarkdownInto()` 全程构建 DOM 节点 + `textContent`。有一条测试喂
`<img src=x onerror=...>`，断言注入 0 个元素、执行 0 次。保持这样。

### `codex exec` 的参数怪癖

- `codex exec` **没有 `-a` / `--ask-for-approval`**
- `--approve-for-me` 隐含 `workspace-write`，且**与 `-s` 冲突**
- 非交互模式下光给 `-s workspace-write` 是**写不了**的（没有审批者）
  —— 这就是 `bridge.cjs` 里 `PERMISSION_MODES` 映射到**整组 flag** 的原因
- 续接的回合拒绝 `-s` 和 `--approve-for-me`，但接受 `-c sandbox_mode="..."`
- 没有 `--search`；联网搜索是 `-c web_search="live"`
- 推理摘要需要 `-c model_reasoning_summary="auto|concise|detailed|none"`。
  目录里所有模型默认都是 `none`，所以条目是空的。

### 绝不要通过 `cmd /c` 传提示词

`cmd` 会毁掉 argv（换行、引号、末尾参数）。`codex-process.cjs` 直接 spawn 可执行文件（`shell: false`），并且**提示词走 stdin**（`-`），不进 argv。附件也依赖这一点。

### 绝不要只凭 PID 文件就杀进程

Windows **会复用 PID**。机器重启后残留的 `.codex-gui/bridge.pid` 可能指向一个无关程序 —— 实测中它**杀了一个无辜的 node 进程**。现在 `stop-codex-gui.cmd` 会解析**端口占用者**、校验其命令行含 `bridge.cjs`、确认之后才 kill。

### `.cmd` 和 `.vbs` 必须保持纯 ASCII

Windows PowerShell 5.1 和 `cmd.exe` 用系统 ANSI 代码页读取无 BOM 脚本，非 ASCII 会让某些机器解析失败。另外：`echo [!!]` 在 `enabledelayedexpansion` 下会**破坏后续 `!VAR!` 展开** —— 用 `[WARN]`。

### 重启规则

`index.html` **每次请求都从磁盘读** → 改了刷新页面即可。
`bridge.cjs`、`appserver.cjs`、`rollout.cjs`、`codex-process.cjs` 只在启动时载入 →
**必须重启服务**。状态栏会显示服务已运行多久，就是让你分辨当前跑的是哪份代码。

### 测试夹具必须自洽

`test/fixtures/fake-codex.cjs` 会发 `turn.completed`，**并且**写出一份带匹配
`token_usage_record` 的 rollout。bridge 优先用 rollout 里的数字，两者不一致时测试就测错了东西。

## 配方：渲染文件改动（当前最大的缺口）

Codex 已经在发数据了，只是没人渲染。真实会话里验证过的结构：

```json
{"type":"event_msg","payload":{"type":"item_completed","item":{
  "type":"FileChange","id":"exec-...","status":"completed",
  "changes":{
    "C:\\path\\to\\file.md":{"type":"update","unified_diff":"@@ -3,8 +3,7 @@\n ..."}
  },
  "stdout":"Success. Updated the following files:\nM ...",
  "stderr":""
}}}
```

`type` 是 `update`、`add` 或 `delete`。步骤：

1. **`rollout.cjs`** —— 在 `replayItem()` 里按 `CommandExecution` 的方式处理
   `FileChange`，返回 `{kind:'filechange', item}`。加一条夹具，并在
   `check-rollout-replay.cjs` 里加断言。
2. **`bridge.cjs`** —— 不用改，`item.completed` 已经原样转发。
3. **`index.html`** —— 在 `addCmd()` 旁边写 `addFileChange(item)`。用
   `insertBeforeAgentRow()` 插到**回复气泡之前**，并放进现有的 `.cmd-group`
   （`ensureToolGroup()` / `setToolGroupLive()`）里，这样它和别的工具活动一起折叠。
4. **diff 渲染** —— `unified_diff` 是纯文本。解析 `@@` 分块，用 `textContent`
   输出带 `+`/`-`/` ` 前缀的 `<div class="dl">` 行。**不要用 `innerHTML`。**
5. **测试** —— 夹具里加一个 `update`、一个 `add`、一个 `delete`；断言卡片数量、
   文件名可见、`+` 行和 `-` 行都存在、以及含 `<script>` 的路径被当作文本渲染。
6. **`check-ui.cjs` 和 `check-live.cjs`** 都要覆盖。

## 工作流

```powershell
node --check bridge.cjs           # 先做语法检查
npm.cmd test                      # 26 个单元测试
node check-ui.cjs                 # 真实浏览器，26 项检查
node check-live.cjs               # 已服务页面的断言
node check-rollout-replay.cjs
node check-rollout-attach.cjs
```

浏览器检查会用临时设置文件和假 CLI 在随机端口起独立 bridge，可以反复跑。
`check-ui.cjs` 建议连跑两三次 —— 这里的偶发失败历史上都意味着**真实的竞态**，而不是测试不好。

## 风格

- 纯 CommonJS，不用转译器、不用打包器
- 注释解释**为什么**，尤其是那些不显然的绕过方案
- 界面文案中文，代码和注释英文
- `index.html` 保持单文件 —— 这是「零安装」成立的原因

## 报 bug 请附带

Node 与 Codex 版本、当时的权限模式、服务是否重启过、状态栏显示运行多久。如果涉及命令或文件改动，从 `~/.codex/sessions/` 里贴出对应的 JSONL 行 —— **事件才是事实**。
