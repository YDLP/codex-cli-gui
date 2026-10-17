# 审查与修复记录

原项目的主要执行方式适合继续保留，但原有测试大多检查源码中是否存在某段文字，不能证明操作成功。本次补充了实际 HTTP、子进程、Codex 协议和浏览器行为验证。

## 已修复

| 严重程度 | 问题与影响 | 修复 |
|---|---|---|
| 高 | HTTP 接口未检查来源；其他网站可以用普通文本 POST 请求触发本机任务或改设置 | 校验 Host、Origin、Fetch Metadata，并要求 JSON Content-Type |
| 高 | 提示直接放入 Windows argv，长消息超过命令行限制；以选项开头的消息可能被 CLI 当成参数 | 提示经 stdin 发送，Codex 入口不经过 shell |
| 高 | 停止按钮会终止所有页面的任务；同一会话可被并发执行并争抢写锁 | 按 runId 停止，服务端拒绝重复执行同一会话 |
| 高 | 运行时仍可切换或新建会话，后续事件会写入错误的页面状态 | 发送前同步锁定运行状态；任务结束后解除 |
| 高 | 权限下拉可能与续接会话实际保存的配置不同，尤其从完全访问切到只读时，界面造成错误的权限预期 | 恢复历史模式，服务端拒绝不同模式的续接请求，明确提示新建会话 |
| 高 | 历史请求返回顺序与点击顺序不一致时，旧内容覆盖新会话；历史回答被合并到先前的气泡 | 以请求序号丢弃过期响应，逐条渲染消息并恢复会话工作目录 |
| 高 | 上下文条使用整轮累计值，并重复加上推理 token | 分开显示整轮消耗和末次模型调用的上下文估计 |
| 中 | 宣称附件支持 25 MB，实际 JSON 请求限制只有 2 MB | 单文件 25 MB、总量 50 MB、最多 20 个，前后端一致校验 |
| 中 | 同名附件会覆盖已被旧会话引用的内容；空文件被跳过；保存失败被静默忽略 | 每批使用独立目录和唯一文件名，接受空文件并报告保存失败 |
| 中 | 发送前的目录检查没有异常处理，且未锁定状态；快速 Enter 可能触发重复请求 | 检查前即进入运行状态，异常恢复界面并保留输入和附件 |
| 中 | 文件仍在读取时即可发送，造成漏附件 | 读取完成前禁用发送；丢弃已切换会话的过期文件读取结果 |
| 中 | stdio 每个 Buffer 独立解码会破坏跨块中文或 emoji | 使用有状态 UTF-8 解码 |
| 中 | RPC 在固定 WebSocket 端口连接，可能撞到别的进程；初始化竞态、缺少 initialized 通知、断连后请求等超时 | 改为私有 stdio，等待完整初始化；断连立即拒绝并支持重连 |
| 中 | 未预期的 RPC 服务端请求被自动回复成功 | 明确拒绝，避免意外批准工具或命令 |
| 中 | 设置保存失败仍响应成功；并发保存的旧结果可覆盖新界面设置；空代理被默认值覆盖 | 原子替换设置文件，验证输入并报告失败；前端串行保存，显式保留空代理 |
| 中 | 工具开始和完成各新增一张卡片；失败回合可能显示「完成」 | 按工具 ID 更新卡片，区分回合失败、停止和正常结束 |
| 中 | 侧栏固定宽度挤压小窗口，输入框变成逐字竖排 | 添加可折叠侧栏与窄屏布局，验证 390px 宽度 |
| 中 | 启动器以端口被占用直接判断「GUI 已运行」，且忽略自定义端口 | 新启动器检查健康接口，支持自定义端口与 Codex 路径 |
| 低 | 文档包含互相矛盾的权限描述、重复 token 公式和不可靠的推理文本承诺 | 重写 README，区分实际返回内容、累计消耗和估计值 |

## 验证范围

- `npm.cmd test`：26 项通过；`node check-ui.cjs`：12 项真实浏览器检查通过。
- 使用本机 Codex CLI 检查三种权限模式的参数解析，并连接本地拒绝推理的模拟服务，读取新建和续接回合的权限及审批记录。
- 使用真实 HTTP、真实子进程和本地模拟 CLI，验证大附件、长消息、中文分块、停止隔离、断连清理、RPC 初始化及重连。
- 使用 Edge 实际点击和输入，验证会话历史、乱序返回、重复发送、失败恢复、工具更新、停止及手机宽度布局。
- 使用本机 Codex app-server 成功读取会话列表与 7 个模型的目录。
- 测试均与真实用户会话、设置隔离；模型推理服务使用本地模拟接口。

## 后续改动（Codex 审查之后）

| 日期 | 改动 | 原因 |
|---|---|---|
| 2026-10-16 | **回复气泡锚定底部，工具卡插入其上方** | 原先工具卡与回复都往后追加，每条命令都把对话往下顶，用户要等整轮跑完才看得到回复。现在本轮回复气泡在回合开始时即创建并固定在底部，工具卡（`toolRow()`）与「正在处理」指示器都插到它**上方**。 |
| 2026-10-16 | `addAgent(text, separate)` 新增 `separate` 参数 | 同一回合内多条 assistant 消息累积进同一气泡；**历史回放必须每条独立成泡**，否则会静默改写用户原本的对话记录（曾把两条历史回复合并，被 `check-ui.cjs` 的历史测试抓到）。 |
| 2026-10-16 | `check-ui.cjs` 新增锚定回归测试 | 断言 `details.cmd`（工具卡）渲染在回复气泡**之前**，且回复之后除 `btnNew` 的标记外不得有任何本轮内容。 |
| 2026-10-16 | **回合结束时自动折叠工具卡** | 原先要手动点击才收起。现在运行中展开（看得到实时输出），回合结束自动折叠。**只折正文，摘要行（命令 + exit 码）始终保留**——那才是"跑了什么、成不成功"。用户手动展开过的卡片用 `data-user-opened` 标记，不再被自动折叠。折叠在 `exit` 事件与 `finally` 两处调用，失败/中止路径也会收起。 |
| 2026-10-16 | **新增 Markdown 渲染**（回复气泡） | 此前回复走 `textContent`，代码块/列表全是纯文本。支持围栏代码块（带语言标签）、行内代码、粗体、斜体、标题、引用、有序/无序列表、链接、分隔线。 |
| 2026-10-16 | **代码块复制按钮** | 每个围栏代码块带一个「复制」，复制**原始文本**（`pre.textContent`，不是渲染后的节点）。优先用 `navigator.clipboard`，不可用时回退到 `textarea + execCommand`（无头浏览器/非安全源）。 |
| 2026-10-16 | **回合分界线**（带轮次编号） | 每轮交流后插入 `.turn-sep`，形如 `—— 第 N 轮 ——`。**插在用户消息之后**（归属新一轮，不是收尾上一轮）。轮次编号在切换会话/新建会话时重置——它是**按会话**计数，不是按页面累计。 |
| 2026-10-16 | **每轮 Codex 输出收进一张卡片**（`.row.turn`） | 原先工具卡、推理、回复各自是散的行。现在每轮一个带 `Codex` 标题的边框容器，内部顺序固定为 **工具卡 → 推理摘要 → 回复**。 |
| 2026-10-16 | **粘贴图片/文件到输入框** | 支持 Ctrl+V 直接贴截图（Win+Shift+S）。剪贴板里的图片**没有文件名**，会按 MIME 生成 `pasted-<时间戳>.png`，否则附件栏无法区分多个截图。 |
| 2026-10-16 | **修复空卡片残留** | 见下「空卡片」小节。 |
| 2026-10-16 | **重放的历史附件改为缩略图预览** | 见下「附件回放」小节。 |
| 2026-10-16 | **输入框的附件也显示缩略图** | 粘贴后只显示文件名，看不出贴的是不是想要的那张图。现在直接显示图片本身，点击放大；发送后信息流里同样是缩略图（发送时用本地字节，回放时从磁盘取）。 |
| 2026-10-16 | **修复竞态后会话列表变空** | `switchSession` 因竞态提前返回时，侧栏可能显示「还没有会话」。现在**每条退出路径都重新 `renderSessions()`**。这是真实缺陷：快速连点两个会话即可触发（`check-ui.cjs` 曾间歇性抓到）。 |

### ⚠️ 附件回放（为什么历史里会看到 XML）

用户消息在 rollout 里存的是 **Codex 实际收到的完整 prompt**，里面有两段
**用户从未写过**的管线文本：

1. **Codex 自己加的** `<image name=... path="...">…</image>`
2. **`bridge.cjs` 拼上的清单**（`---` + `Attached files (paths are relative…)` …）

刷新会话时若原样渲染，就会看到一整块 XML 和文件清单。`rollout.cjs` 的
`splitAttachments()` 负责剥离它们，并把附件作为**结构化数据**返回：

```js
messages: [{ role:'user', text:'附件图片测试',
             attachments:[{ path, name, isImage, size }] }]
```

前端渲染成缩略图，点击放大（`/api/attach/raw?path=…` 提供字节流——
浏览器无法加载本地路径，也不能把 base64 塞进历史 JSON，那会让每次切换都变慢）。

#### 实测踩到的两个格式坑

| 坑 | 实际情况 |
|---|---|
| `<image>` 的 `name` **不一定带引号** | 真实 rollout 是 `name=[Image #1]`，我最初只匹配 `name="…"`，**完全没匹配上**，XML 原样漏到界面上 |
| `name` 往往是**占位名** | 形如 `Image #1`，对用户没意义。优先用清单里的真实文件名，否则**回退到路径的 basename** |

`/api/attach/raw` 只放行图片扩展名、要求绝对路径、上限 25 MB。
`check-ui.cjs` 断言非图片（如 `win.ini`）返回 400。

#### 图片来源有两条路，都要保留

| 场景 | 图片地址 | 原因 |
|---|---|---|
| 输入框里的附件 | `data:` URL（字节就在内存里） | 立刻显示，且发送前文件还没落盘 |
| 刚发送的消息 | `data:` URL 优先，`path` 兜底 | `meta` 只给相对路径，绝对路径由 `joinPath(cwd, rel)` 拼出 |
| 刷新后重放的消息 | `/api/attach/raw?path=…` | base64 塞进历史 JSON 会让**每次切换会话都变慢** |

⚠️ **两者都要设**：只给 `path` 时若路径拼错，界面会退化成"破损"；
只给 `dataUrl` 则历史回放无法显示（那时代码里没有字节）。
`buildAttachmentRow()` 优先 `dataUrl`，失败才回退到 `path`——这样任一条路坏掉都还有另一条。

| 2026-10-16 | **命令卡折叠后摘要只留「命令 + exit 码」** | 见下「命令卡」小节。 |
| 2026-10-16 | **空的会话列表响应不再清空侧栏** | 会话读取可能瞬时返回空（app-server 重启中）。此时把侧栏替换成「还没有会话」，用户会以为**会话全丢了**。现在保留上次结果并提示。 |

### ⚠️ 命令卡：长命令会把折叠的卡片重新撑开

只折叠**输出**是不够的。原先命令全文放在 `<summary>` 里，
一条 PowerShell 长命令即使 `details` 已折叠**依然完整显示**，把框撑得很宽——
正是折叠要避免的事。

现在分三层：

| 位置 | 内容 | 折叠时 |
|---|---|---|
| `<summary>` | `命令` 标签 + `exit N` + **截断到 64 字符的单行预览** | 可见 |
| `.cmd-line` | **完整命令**（自动换行） | 隐藏 |
| `<pre>` | 命令输出 | 隐藏 |

并加了 `▸ / ▾` 展开指示。`check-ui.cjs` 的夹具改用**一条 149 字符的真实长命令**，
断言折叠后 `summary` 文本 < 90 字符、且 `peek < full`——短命令测不出这个问题。

| 2026-10-16 | **命令按轮分组为一张卡片** | 见下「命令分组」小节。 |
| 2026-10-16 | **刷新会话不再丢失命令** | `rollout.cjs` 此前**只提取 `message`**，命令和推理根本没有回放——刷新后命令卡整片消失。现在从 `event_msg/item_completed` 提取（字段与实时事件流**完全一致**），并走同一套渲染。 |

| 2026-10-16 | **右侧会话快速跳转条** | 每个提问一个圆点，悬停显示预览，点击跳转。见下「跳转条」小节。 |
| 2026-10-16 | **思维强度徽标显示实际发出的参数** | 见下「思维强度看不出来」小节。 |
| 2026-10-16 | **联网搜索并入工具组** | 联网项原来渲染在**独立的 `Codex · 工具` 行**上，是全轮唯一不随组折叠的工具活动，所以刷新后看着像"丢了"。现在和命令一样进 `cmd-group`，可回放（`WebSearch` 记录）。 |
| 2026-10-16 | **压缩检测补上测试** | 实现早就在，但**零测试覆盖**。见下「压缩检测」。 |

### ⚠️ 联网记录的真实形状（我猜错过一次）

**不要按 app-server 的类型名去解析 rollout。** 实测的真实形状是 **`Extension`**：

```json
{ "type":"Extension", "kind":"web.search", "id":"exec-…",
  "query":"Codex model_reasoning_effort configuration",
  "action":{ "type":"search", "query":"…", "queries":null },
  "results":[ { "type":"text_result", "title":"…", "url":"…", "snippet":"…" } ] }
```

`action.type` 有三种：**`search` / `openPage` / `findInPage`**。

我第一版按 `type:"WebSearch"`（app-server 的 `WebSearchItem` 名）写提取，
**对你的真实数据一条都匹配不到**——刷新后联网记录消失，就是这么来的。
现在两种都接受，但**真实路径是 `Extension` + `kind` 以 `web.` 开头**。

> ⚠️ 教训：**用合成数据验证 ≠ 验证**。我当时用自造的 `WebSearch` 记录测通了，
> 就以为修好了；直到用**真实 rollout** 才发现在真实数据上完全不工作。
> 定形状的改动，**必须拿真实样本核对**（`probe` 脚本跑一遍真实会话）。

其他 `kind` 也存在，例如 `clock.sleep`（→ `Extension` + `durationMs`），
目前**不渲染**，因为它对用户没有信息量。

### ⚠️ 跳转条（一个提问一个标记）

长会话里翻找某个提问很痛苦，所以右侧加了一条导航：
**每个 `.row.user` 一个胶囊标记**，悬停出预览（`第 N 条 · 你的输入`），
点击跳转，滚动时当前所在的提问会高亮。

**交互模仿 DSH 的侧边导航**：

| 行为 | 说明 |
|---|---|
| 鼠标悬停在条上滚轮 | **滚动这条导航**（不是会话） |
| 滚到任一端继续滚 | 事件**放行**给会话，不会把滚轮困住 |
| 滚动条 | **完全没有**。靠上下两端渐隐提示还有内容 |
| 标记尺寸 | 16×22px，悬停变宽到 24px（`9×9` 的小圆点太难瞄准） |
| 可见上限 | `JUMP_VISIBLE_DOTS = 10`（用户指定），约 270px 高 |

**实现要点**：

- 预览文本存在行的 `dataset.prompt` 上（`addUser` 里写入），不在 DOM 里反复抓文本。
- 预览是**定位的浮层**而不是 `title`：`title` 在无头测试里不可见，也无法控制排版。
- 每个标记用 `dataset.index` 记录**自己的提问序号**，点击时**按索引重新取行**
  （不是闭包捕获行引用）——这样"rail 比 feed 先建好"也不会跳错。
- **切换会话 / 新建 / 清屏 / 发送后都要 `rebuildJumpRail()`**，整条重建，不会累积重复标记。
- 窄屏（≤820px）隐藏：手机上这条会挡住内容。
- 滚轮监听器**只注册一次**（在初始化里），不放在 `rebuildJumpRail()` 内，否则每次重建都叠加一个。

#### ⚠️ 三个必须记住的坑

**① 跳转不能用 `scrollIntoView`，要显式计算位置。**
`scrollIntoView` 的落点受内边距、`scroll-margin`、"浏览器选哪个祖先当滚动容器"影响。
改成 `row.offsetTop - log.offsetTop - 8` 并 clamp 到可滚范围，落点稳定得多。

**② 高亮必须取"离视口顶部最近的那条"，不能用阈值。**
早期写成"`offsetTop <= scrollTop + 24` 的最后一条"。**最后几条提问永远顶不到视口顶部**
（它们下面的内容不够填满视口，浏览器滚不下去），于是高亮**卡在前面好几条**，
用户看到的就是"我点第 10 条，它高亮第 8 条"。
改成比距离、平局取靠后者，高亮与视觉一致。

**③ 尾部落不到最顶部是物理限制，不是 bug。**
到最后一条时已无内容可滚。实测最后一条落在距顶 82px 处，它仍是"离顶部最近的那条"，
高亮也是它。测试对 `idx > N-3` 放宽到 `nearest` 一致，中间提问要求 `delta < 80`。

> ⚠️ **"无滚动条"要用 `offsetWidth - clientWidth === 0` 验证，不能只看 `scrollbar-width`**：
> 后者是 Firefox 属性，在 Chromium 里读不到就让断言变成永远通过。
> 实测 `gutterPx: 0` 且真实滚轮只动导航（`rail 21→48`、会话 `3242→3242`）。

> ⚠️ **可见上限是用户明确指定的 10，不要"顺手调大"。**
> 我一度改成 12（理由是"点变大了，多显示几个也无妨"），被用户指出。
> 这类明确给定的数值，改动前先问。

### ⚠️ 思维强度：模型看不到，所以问不出来

用户问 Codex「你现在是 max 思维强度吗」，它答**「我看不到本次请求的思维强度参数」**。

**它答得没错** —— 思维强度是**请求参数**，不属于对话内容，模型看不到自己用了哪一档。
**所以"模型说看不到"不能用来判断 GUI 有没有设置。**

实测 GUI 是传了的（`check-effort` 验证过，新会话与续接都带）：

```
exec --json --skip-git-repo-check -m gpt-6.1-sol -c model_reasoning_effort="max" -c web_search="live" ...
exec ... resume <id> --json --skip-git-repo-check -m gpt-6.1-sol -c model_reasoning_effort="max" ...
```

为了让这件事**可自证**，`effortBadge` 现在悬停会显示实际参数：

```
实际发送：-c model_reasoning_effort="max"
该模型可选：low, medium, high, xhigh, max, ultra
（思维强度是请求参数，模型看不到自己用了哪一档，问它是问不出来的）
```

**不确定时不要问模型**——看这个提示，或看 bridge 的 `meta.args`。

### ⛔ 双击「完全没反应」——继承的 SW_HIDE，加上前台锁

用户报告桌面快捷方式双击没反应。**这个 bug 查了三轮，前两轮的结论都是错的**，记下来是因为错法本身很有代表性。

#### 第一轮：以为机制坏了 —— 全好

| 检查 | 结果 |
|---|---|
| 服务 | 健康，`/api/health` 正常 |
| 页面 | HTTP 200，完整 HTML |
| VBS | `cscript` 跑无错误 |
| `cmd /c start` | **实测浏览器确实收到了请求**（起临时 HTTP 服务端点，看得到命中） |
| 默认浏览器 / node | 都正常 |

#### 第二轮：以为是前台锁 —— 结论对了一半，但验证被污染

实测到后台进程开的窗口拿不到焦点，于是加了「`--new-window` + `AppActivate`」。
当时验证**通过了** —— 但那是因为**之前测试留下的一个 Codex GUI 窗口还在**，
`AppActivate` 只是把旧窗口调到前台。**典型的假阳性。**

用户随后给出关键信息：**只有 stop 之后才能打开**。也就是说**复用已有服务**这条路径才是坏的。

#### 第三轮：按真实场景复现

关掉 GUI 窗口、保持服务运行、再双击 —— 稳定复现：

```
already running pid=25260 -> opening browser
opening browser (new window): msedge.exe
WARN  no Codex GUI window to focus after 15000 ms
```

**窗口根本没出现**，不是"出现了但不在前台"。

**真正原因**：`sh.Run cmd, 0, False` 里的 **`0` 是 `SW_HIDE`**。这个显示状态
**会被子进程继承** —— node 是隐藏的，node 再 spawn 的 msedge 也带着隐藏标志，
于是浏览器窗口**创建了、也加载了页面，但它是隐藏的**。
`IsWindowVisible` 返回假，`AppActivate` 自然找不到。

冷启动之所以"看起来能用"：那时 Edge 常常没在运行，走的是另一条路径。

#### 修法：谁有窗口样式，谁就负责开浏览器

```vbs
' VBS 用样式 0 跑 node，并告诉它别开浏览器
sh.Run """" & nodeExe & """ """ & here & "\launch.cjs"" --detach --no-browser", 0, False
' 轮询 /api/health，等服务起来
' 然后自己用样式 1（正常窗口）打开页面
sh.Run "http://127.0.0.1:8790/", 1, False
' 最后 AppActivate 把它调到前台
```

`launch.cjs` 新增 `--no-browser`，把开浏览器的责任交回调用方。
两种场景实测：

| 场景 | 结果 |
|---|---|
| 服务在跑 + 窗口已关（**用户报的那条**） | `service healthy after 0 ms -> opening the page` / `focused after 500 ms` ✓ |
| 服务已停（冷启动） | 服务启动 → 开页面 → `focused after 500 ms` ✓ |

窗口列表确认：`可见的 Codex GUI 窗口: 1`，前台就是它。

#### 顺带补上的诊断能力（这是最大的收获）

`wscript` 没有控制台，`launch.cjs` 里所有 `console.log` / 异常**全部消失** —— 这才是
"双击没反应"查不动的根本原因。现在两处都写 `.codex-gui/launch.log`：

```
16:18:01  start  node=D:\nodejs\node.exe
launcher  08:18:01.855  no service on :8790 -> starting a detached bridge
launcher  08:18:01.998  service is up
16:18:01  service healthy after 0 ms -> opening the page
16:18:01  focused the Codex GUI window after 500 ms
```

VBS 还补了 node 的 4 级查找（`CODEX_GUI_NODE` → PATH → 常见安装目录 → 注册表），
原来只扫 PATH。

> ⚠️ **教训一：验证被污染是最危险的假阳性。** 我"验证通过"时，目标窗口其实早就存在。
> 复现脚本必须先清理前置状态（这次是：先关掉所有 GUI 窗口）。
>
> ⚠️ **教训二：'能创建' 不等于 '可见'。** 我只检查了窗口是否存在/是否在前台，
> 没想到第三种状态 —— **存在但隐藏**。`IsWindowVisible` 才是该查的。

#### 第四个问题：冷启动会开两个窗口

修好之后用户立刻反馈：**stop 之后首次打开会开两个**。

原因很简单 —— **两个地方各自开了一次浏览器**：

| 位置 | 为什么存在 |
|---|---|
| `bridge.cjs:849` | 前台模式（`node launch.cjs`）靠它打开浏览器 |
| `start-hidden.vbs` | 新加的「用样式 1 打开页面」 |

detach 模式下两者都执行 → 两个窗口。这个**重复在改动之前就有**（那时是 bridge +
`launch.cjs`，两个都开），只是都变成同一窗口里的标签，所以没被注意到。

修法：`startDetached()` 给子进程注入 `CODEX_GUI_NO_BROWSER=1`，
**detach 模式下由调用方统一负责开浏览器**。

实测两条路径都是 `count=1`。

### ✅ 文件改动现在会显示 diff 了

用户最初把它列为「最大的洞」：Codex 改了文件，界面什么都不显示。实现时才发现真正麻烦的地方。

#### 事件有两种形状，而且只有一种带 diff

```jsonc
// 实时（codex exec --json）：数组，蛇形，**没有 diff**
"changes":[{"path":"...","kind":"update"}]

// rollout（~/.codex/sessions）：对象，按路径键，**有 diff**
"changes":{"...":{"type":"update","unified_diff":"@@ -1,3 +1,3 @@..."}}
```

**实测确认**：跑一个真实回合强制用 `apply_patch` 改文件，实时流里只有路径和
`kind`，`unified_diff` 只写在 rollout 里。

所以行为是：**回合进行中看到「改了哪些文件」，刷新/重开会话才看到 diff。**

#### 另一个实测发现：Windows 上多数改动根本不发 FileChange

第一次探测时我让它「用 shell 命令改 note.txt」—— 文件确实改了，但事件里**只有一条
`command_execution`**，没有 `file_change`。只有走 `apply_patch` 才会有。
这解释了真实会话里 `FileChange` 只占 4 条、而命令有 96 条。

#### 修掉两个连带 bug

| 问题 | 原因 | 修法 |
|---|---|---|
| 组头显示「工具 5 条 · **1 条失败**」 | 组头按 `dataset.exit` 统计；文件改动没设这个属性，`undefined === ''` 为假 → 算失败 | `addFileChange` 里按状态设 `'0'` / `''` / `'1'` |
| **第二轮的命令覆盖第一轮卡片** | 实时 item id 是每进程计数器（`item_1`…），每轮重置；`commandCards` 只在线程切换时清空 | 每次新交换清空（`clearTurnCards()`） |

第二个是**先前就存在的**，只是这次加文件改动时才注意到。

#### 渲染

`diffNode()` 把 `unified_diff` 拆成 `<div class="dl">` 行，`+`/`-`/`@@`/元信息各自着色，
**全部 `textContent`**。夹具里放了一个路径含 `<script>alert(1)</script>`，
断言注入元素为 0、`window.__xss` 未设置。

路径按工作目录相对化显示（`note.txt` 而不是完整绝对路径），`title` 里保留全路径。

### ⛔ 「显示推理摘要」永远是空的 —— 已移除该开关

用户判断：「没有流式输出的话推理显示没有意义」。**这个判断是对的**，而且有个更根本的原因。

#### 证据：条目存在，但内容是空的

真实 rollout 里的 Reasoning 条目：

```json
{"type":"Reasoning","id":"rs_...","summary_text":[],"raw_content":[]}
```

一个会话里 **102 个 Reasoning 条目，全部为空数组**。不是渲染坏了，是发过来就没内容。

#### 根因：模型目录的默认值就是 `none`

```
gpt-6.1-sol : default_reasoning_summary = "none"
gpt-6-astra : default_reasoning_summary = "none"
… 目录里 9 个模型，全部是 "none"
```

而 `bridge.cjs` 只传了推理强度，**从没传过摘要**：

```js
common.push('-c', `model_reasoning_effort="${reasoningEffort}"`);
```

#### 合法值（用非法值触发校验白拿，没花额度）

```
Error: unknown variant `BOGUS_VALUE`, expected one of `auto`, `concise`, `detailed`, `none`
```

#### 已做的改动

| 位置 | 改动 |
|---|---|
| `index.html` | 删除 `显示推理摘要` 勾选框及其全部绑定 |
| `index.html` | 删除「本轮包含 N 个推理 token；CLI 未提供可显示的推理摘要」提示（每轮都是噪音） |
| `index.html` | 删除只写不读的 `gotReasoningThisTurn` |
| `bridge.cjs` | `DEFAULTS.showReasoning` → `false` |
| `settings.json` | `showReasoning` → `false` |

`addReasoning()` **保留**并加了说明，将来只需两处改动即可恢复：

1. `bridge.cjs` 加 `-c model_reasoning_summary="concise"`
2. settings 里 `showReasoning` 设为 `true`

> ⚠️ 恢复会**增加输出 token 成本**（每次推理都要多生成一段摘要）。用户就是为省钱离开
> DeepSeek 的，所以默认关闭、且不擅自打开。

> **教训：一个开关如果它的前提条件永远不成立，那不是"没生效"，是"骗人"。**
> 要么修前提，要么删掉开关。这次选了删掉。

### ⚠️ 跳转栏只能往下滚、不能往上滚

报告：「缩略点显示第 4-13，但我不能往上滚到第 1；第 1-10 的时候可以往下滚到 13」。

**不对称的滚动 = 有人在往回拽。** 根因：

```js
// onRailWheel 里
rail.scrollTop += e.deltaY;
updateJumpActive();          // ← 这一行
```

`updateJumpActive()` 的职责是「让**高亮**的那个标记保持可见」，
而高亮由**对话位置**决定，不是由 rail 的位置决定。于是：

1. 对话在底部 → 高亮 = 第 13 条
2. 你往上滚 → rail 移到第 3-12 条 → **第 13 条看不见了**
3. `updateJumpActive()` 发现高亮不在视野 → **把 rail 拉回去显示第 13 条**
4. 结果：往上滚立刻被撤销；往下滚因为本来就在底部，看起来"正常"

**修法：把两件事分开。**

| 动作 | 该做什么 |
|---|---|
| 滚轮滚 rail | 只滚 rail + 更新上下渐隐，**不碰高亮** |
| 对话滚动 | 更新高亮 + **在用户没在浏览 rail 时**自动跟随 |

```js
let railTouchedAt = 0;   // 用户上次手动滚 rail 的时刻

// 滚轮里
railTouchedAt = Date.now();
rail.scrollTop += e.deltaY;
updateRailFades(rail);    // 不再调用 updateJumpActive

// 高亮里
if (dot && Date.now() - railTouchedAt > 2500){ /* 才自动跟随 */ }
```

- 2.5 秒的宽限：手动滚过之后短时间内不抢方向盘
- **点击标记会清掉守卫**（`railTouchedAt = 0`）——点击就是明确的"我要过去"

> **教训：一个函数同时负责「保持视图」和「反映状态」，就会互相打架。**
> 拆开之后，测试才能分别断言这两件事。

`check-ui.cjs` 复现了原始场景：把对话滚到底 → 连续 4 次滚轮往上 → 断言
rail 确实上移、**400ms 后没有被拉回**、顶部渐隐与中部双向渐隐都正确。

### ⚠️ 状态栏显示服务启动时刻与运行时长

用户要求加这个，起因是前面那个结论：**后端改动必须重启才生效**。看不到运行时长，
就分不清"页面显示的是新代码还是旧代码"。

- 数据来自 `/api/health` 的 `startedAt`（bridge 进程启动时刻），
  **不是页面加载时间** —— 刷新页面不会重置，这正是它的价值
- 每秒刷新一次（`setInterval(renderServerInfo, 1000)`）
- 悬停显示精确启动时间、pid、版本，并提示"刷新不会重置、改后端要重启"
- **< 60 秒时高亮成蓝色**：刚重启 = 新代码生效的那一刻，值得看见

时长格式只取两级单位，且不拖尾零：

| 时长 | 显示 |
|---|---|
| 5s / 59s | `5秒` / `59秒` |
| 60s / 90s | `1分` / `1分30秒` |
| 1h / 1.5h | `1小时` / `1小时30分` |
| 1d / 3d5h | `1天` / `3天5小时` |

> 第一版会输出 `1分0秒`、`1天0小时` 这种拖尾零，已修。

### ⛔ 忘了 stop 本身无害，但「残留 pid 文件」会误杀无关进程

用户问「如果我忘了 stop 会怎么样」。实测结论：

| 项目 | 实测 |
|---|---|
| 内存 | bridge **~42 MB**；app-server **~38 MB**（**懒启动**，只在读会话列表时出现） |
| CPU | 空闲时 **0.08 秒**（累计），不烧 CPU |
| 端口 | 一直占着 8790 |
| **再次启动** | 启动器认出 `/api/health`，**直接复用**并打开浏览器 → 正常工作 |
| 日志 | 每次启动追加约 200 字节的 banner，不会疯长 |

**所以忘了 stop 基本无害**——不占 CPU、下次能复用。

#### ⚠️ 但有一个真实危险：重启后残留的 pid 文件

Windows **会复用 PID**。机器重启后 `.codex-gui/bridge.pid` 里那个号很可能已经属于
**别的程序**。旧的停止脚本逻辑是「pid 文件存在就 kill」——实测把一个无关的
node 进程杀掉了。

**修法：端口归属才是真正的身份，不是 pid 文件。**

```
1. 找出谁真的持有 8790（netstat）
2. 用 PowerShell 读它的命令行，确认含 bridge.cjs
3. 只有两者都满足才 kill
4. 否则明确拒绝并说明原因
```

现在三种场景都实测过：

| 场景 | 结果 |
|---|---|
| pid 文件残留 + 无监听 | `recorded pid X is stale - ignoring it`，**不杀** |
| 别的程序占了 8790 | `[WARN] pid X is NOT the Codex GUI bridge` + `refusing to kill it` |
| 真的是我们的 bridge | `confirmed: bridge.cjs` → `[OK] stopped pid X` |

> ⚠️ **`echo [!!]` 在 `enabledelayedexpansion` 下会破坏后续 `!VAR!` 的展开**：
> 输出变成了 `[PORTPID is NOT ...`。改成 `[WARN]` 才对。这类字符与延迟展开的
> 交互很容易踩，`.cmd` 里别用 `!!` 做装饰。

> ⚠️ `wmic` 在本机**不可用**（Win11 已移除），读命令行只能用 PowerShell 或 CIM。

### ⛔ 关掉窗口服务就没了 —— 打包成 exe 也救不了

用户报告：「不小心关掉 cmd 会导致服务失效」，并问能不能封成 exe。

**根因不是缺 exe，是进程挂在控制台上**：

```js
// 旧版 launch.cjs
spawn(bridge.cjs, { stdio: 'inherit' });   // 与控制台同生共死
```

⚠️ **打包成 exe 同样不解决**：双击 exe 会开一个控制台窗口，关掉一样杀进程
（除非另写 GUI 子系统或做脱钩）。**要解决的是"脱离控制台"，不是"换个文件格式"。**

现在的做法（`launch.cjs --detach`）：

```js
spawn(process.execPath, [bridge.cjs], {
  detached: true,                        // 不随父进程/job 退出
  windowsHide: true,
  stdio: ['ignore', logFd, logFd],       // 自己有日志，不再依附控制台
});
child.unref();
```

三个条件**缺一不可**：`detached` + `stdio` 不继承 + `unref()`。

配套：

| 文件 | 作用 |
|---|---|
| `start-hidden.vbs` | 用 `wscript` 跑 `launch.cjs --detach`，**窗口样式 0**：连控制台都不出现 |
| `stop-codex-gui.cmd` | 按 `.codex-gui/bridge.pid` 停；PID 失效时回退到按端口查找。**窗口会停留显示结果** |
| `start-codex-gui.cmd` | **保留**：带控制台的前台模式，排查时看日志用 |
| `setup-shortcut.ps1` | 建两个快捷方式：启动（指向 vbs）和停止 |

日志追加到 `.codex-gui/bridge.log`，否则后台进程出错就完全看不见。

> ⚠️ **别用 `timeout /t` 在重定向环境下做"按任意键"**：会报
> `ERROR: Input redirection is not supported`。已移除。
>
> ⚠️ **PowerShell 的 `Start-Process -Wait` 等待 detached 子进程会挂住**（实测 120 秒不返回）。
> 这是 `-Wait` 的已知行为，**不是程序问题**——测试时不要加 `-Wait`。

### ⚠️ 上下文仪表：一分子，一分母

显示格式就是 `已用 / 预算 （百分比）`：

```
上下文估计：37,523 / 828,400 （4.5%） · 缓存命中 99%
```

> ⚠️ 曾经显示成 `37,523 / 828,400可用 / 500,000窗口 （4.5%）`——**三个数字**，
> 用户直接问"不是一个分子一个分母吗"。**那个 `500,000窗口` 是我加的多余信息**，
> 它确实会被读成"第二个分母"。已移除；标称窗口移进**设置里的提示**（`ctxCatalogInfo`），
> 那里才适合放细节。`ctxWindowRaw` 变量随之删除（删前已是只写不读）。
>
> **教训：仪表上每多一个数字，就多一次"哪个是分母"的疑问。**

### ⚠️ 上下文仪表的分母：用会话报告的真实值

实测三个数字（`gpt-6.1-sol`）：

| 来源 | 值 |
|---|---|
| `codex debug models` → `context_window` | 500,000 |
| 同上 → `max_context_window` | 872,000 |
| 目录推出的可用窗口 `500000 × 95%` | 475,000 |
| **Codex 运行时自己报的 `model_context_window`** | **828,400**（= `872000 × 95%`，21 条记录一致） |

**分母用会话报告值（828,400）**，这是 Codex 亲口报的**真实预算**：

```js
if (serverContextWindow > 0) ctxMax = serverContextWindow;
```

> ⚠️ 我曾改成 `Math.min(serverContextWindow, catalogUsable)`（理由是"红区警告要早于压缩才有用"），
> **被用户否决**：「肯定用真实的当警告阈值啊」。**用户是对的**——仪表回答的是
> "我还有多少余量"，那就该用真实预算；用保守值会让百分比虚高、误导。
> 目录的 `475,000` 仍作为 `ctxWindowRaw` 展示供参考。
>
> **教训：这类"该用哪个数"的选择，先问，不要替用户定。**

### ⚠️ 压缩后进度条会变绿 —— 但痕迹必须留着

进度条显示的是**当前**上下文，所以压缩后回落到 41,000（20.5%）时
**确实会变回绿色**（`class` 里没有 `warn`/`hot`）。这是对的：占用真的降下来了。

但**光变绿会让用户以为什么都没发生**，所以三处痕迹**必须保留**：

| 位置 | 值（实测） |
|---|---|
| 进度条旁常驻徽标 | `# 1 可能压缩于 402,000 → 41,000` |
| 对话流内标记 | `可能已压缩 上下文从 402,000 回落到 41,000（释放 361,000 tokens）` |
| 进度条下方提示 | `疑似压缩 1 次 · 本会话峰值 402,000` ← **峰值**，仪表已回绿但它不会 |

`check-ui.cjs` 断言这一整组：`pct < 65`、`class` 不含 warn/hot、**徽标 1 个、标记 1 条、提示里有次数和峰值**。

### ⚠️ 上下文数值有多可信（分层结论）

| 部分 | 可信度 | 依据 |
|---|---|---|
| **分子**（已用 token） | **精确** | 直接用 Codex 的 `token_usage_record`：`input + output`。`cached` 是 `input` 的子集不能相加（加过，读数翻倍） |
| **分母**（可用窗口） | **可信但保守** | 目录 `500000 × 95%`；Codex 运行时报 828,400，两者不一致时取小 |
| **压缩判定** | **可用** | 见下 |

**压缩判定为什么不受分母误差影响**：触发条件是**比例**——
"本轮 < 上一轮 × 60%"，且上一轮要超过 `max(6000, ctxMax × 0.12)`。
分母只影响 `MIN_PREV` 这个下限，**分母要错到约 7 倍才会在正常轮次里误报**。

> ⚠️ **压缩是推断，不是事件。** `codex exec` 完全不产生压缩事件
> （`--json` 三个回合、强制 `model_auto_compact_token_limit=2000` 都没有）。
> 模型切换、上下文裁剪也会造成回落，所以界面**明说是推断**。

### ⚠️ 压缩提示出现在三处（实测验证）

| 位置 | 内容 |
|---|---|
| 对话流 | `可能已压缩 上下文从 402,000 回落到 41,000（释放 361,000 tokens）` |
| 进度条旁常驻徽标 | `# 1 可能压缩于 402,000 → 41,000` |
| 一次性提示 | `检测到可能的上下文压缩：这是本会话第 1 次推断…` |

**按会话隔离**：`resetThreadTracking()` → `resetCompactionTracking()` 在切换会话、
新建会话、切换模型时清空 `ctxLastUsed` / `ctxPeakUsed` / `compactionCount`。

#### ⚠️ 夹具的 `turn.completed` 用量必须和 rollout 里的 `token_usage_record` 一致

bridge 为了让仪表不落后一轮，**优先读 rollout 的数值**，不一致时事件流的值会被覆盖。
（踩过：只改一处，仪表显示旧值，排查很久。）夹具用 `BIG` 前缀区分大小回合，
两处都要跟着变。

### ⚠️ Markdown 表格：解析顺序会踩到水平线

用户报告"回复的文本格式好像有点问题"——截图里表格是**原始管道符文本**。
渲染器当时**没有表格支持**，整块被当成普通段落。

加表格时有一条**必须记住的顺序陷阱**：

```
| 问题 | 相关寄存器 |
|---|---|
```

那个分隔行 `|---|---|` **同时匹配水平线规则** `/^\s*([-*_])\1{2,}\s*$/`。
**表格判定必须排在水平线之前**，否则分隔行被吃掉，表格只剩半个。

现在的判断（在 `renderMarkdownInto` 里，先于 heading 和 hr）：

```js
if (line.includes('|') && i + 1 < lines.length &&
    /^[\s|:-]*-[\s|:-]*$/.test(lines[i + 1]) && lines[i + 1].includes('-')){
```

其它细节：

- **单元格内容仍走 `renderInline`**，所以行内代码、粗体、链接照常生效。
- 支持 `:---` / `---:` / `:---:` 三种对齐。
- 行首行尾的 `|` 可省略；行列数不齐时**按表头补齐**，不会破坏布局。
- 表格**横向滚动**而非撑宽气泡（`.md-table` 容器滚动）。

`check-ui.cjs` 的夹具里放了一个表格，紧跟着一条**真正的** `---` 分隔线，
一次断言两件事：表格渲染成 `<table>`（表头、2 行、单元格内容），
且**之后的 `---` 仍然渲染成 `<hr>`**（证明顺序修复没有牺牲水平线）。

### ⛔ `codex exec --json` 是回合制的：中途没有任何事件

**这是传输层的硬限制，不是 UI 的 bug。** 实测一次真实回合（104 秒）：

```
 90204ms  thread.started
 90252ms  turn.started
 96488ms  item.completed:agent_message
101282ms  item.completed:agent_message
101321ms  turn.completed  usage:input_tokens+cached_input_tokens+...
```

- **没有任何** `item/updated` / `outputDelta` / `agentMessage/delta`——那套增量事件
  **只存在于 app-server 协议**（`codex_app_server_protocol.schemas.json` 里 37 处），
  `codex exec` 连开关都没有，`--help` 只承诺 "Print events to stdout as JSONL"。
- **`usage` 只在 `turn.completed`（回合结束）出现一次**，中途不报。

所以下面两件事**做不到**，不要再去"修"：

| 现象 | 原因 |
|---|---|
| 命令输出/状态不是实时刷新 | 回合中途没有事件；`aggregated_output` 只在 `item.completed` 里 |
| 上下文估计要等回合结束 | `usage` 只在 `turn.completed` 里 |

**能做的只是诚实标注**：回合进行中仪表显示 `上一轮` 标签并变暗
（`markCtxStale()`），否则一个不变的数字看起来就是"坏了"。

> ⚠️ **想真正实时，只有换传输层**（app-server 的 `command/exec/outputDelta`）。
> 但 app-server 路径在本项目里**已被否决**——它会占用线程写锁导致会话报废，
> 见「为什么不用 app-server」。

### ⚠️ 用户折叠过的组，不能被后续命令重新打开

报告的第三条：「工具卡片折叠之后，如果来了新的命令会强制自动打开，导致折叠失效」。

原因：实时回合里每条新命令都 `programmaticOpen(toolGroup, true)`，
**每来一条就把用户的折叠撤销一次**。

修法：把「用户主动关闭」单独记在 `toolGroup.dataset.userClosed`，自动展开前先看它：

```js
if (toolGroup.dataset.userClosed !== '1') programmaticOpen(toolGroup, true);
```

- `userClosed` 与 `userOpened` **是两件事**：前者表示"别再自动展开"，后者表示"别自动折叠"。
- `stopToolGroup()` 在新回合丢弃该状态——下一轮默认仍是展开的。

`check-ui.cjs` 用**真实点击 `summary`**（不是脚本开合）验证：关闭后再等 4 条命令
陆续到达，组仍然关着，且 4 条都记录在里面。

> 夹具为此在命令之间加了 120ms 间隔，否则测试没有机会在回合中途操作。

### ⚠️ 工具分组：一张卡 = 一轮

原来每**条**命令一张卡：6 条命令就是 6 个边框卡片，把回复顶出视野。
现在**一轮的所有工具活动（命令 + 联网搜索）收进一张 `details.cmd-group`**，
组头显示条数与结果：

```
▸ 工具  3 条  全部成功
▸ 工具  2 条  1 条失败
```

折叠时整轮只剩这一行；展开后**每一条仍是独立的折叠行**（摘要只留
exit 码 + 截断预览，完整内容在展开区）。

> ⚠️ **联网搜索必须进这个组。** 它原来渲染在独立的 `Codex · 工具` 行上，
> 是全轮**唯一不随组折叠**的工具活动——刷新后看着就像"联网记录丢了"。
> 任何新的工具类型都要走 `ensureToolGroup()` + `toolGroupBox`，
> `check-ui.cjs` 有一条断言守着：`#log .tool-line` 数量必须为 0。

| 场景 | 组的状态 |
|---|---|
| 实时回合进行中 | **展开**（看得到输出） |
| 回合结束 | **折叠** |
| 从磁盘回放（刷新会话） | **折叠** —— 与刚跑完的回合一致 |

#### ⚠️ 程序化开关绝不能被当成用户操作

`toggle` 事件对**脚本触发的变更也会触发**。没有防护时，我们自己 `open = true`
会被记成"用户手动展开"，于是 `collapseToolCards()` 跳过它，**组永远收不起来**。

**关键：不能用定时器做守卫。** 第一版用 `setTimeout(..., 0)` 清标志，
实测无效——`toggle` 是**异步派发**的，比定时器更晚触发，标志早已被清空。
现在改为**由事件自己消费的标记**（`data-scripted`），与时机无关：

```js
function programmaticOpen(d, open){ d.dataset.scripted = '1'; d.open = open; }
function consumeScripted(d){ if (d.dataset.scripted !== '1') return false; delete d.dataset.scripted; return true; }
// toggle: if (consumeScripted(d)) return;   // 这次是我们自己改的
```

### ⚠️ 命令回放的记录格式（实测）

命令**不在** `response_item` 里（那只有 `message` / `reasoning` / `custom_tool_call`），
而在 `event_msg` → `item_completed` → `item`：

```
{ type:"CommandExecution", id, command:[argv...], status:"completed",
  exit_code:0, aggregated_output:"...", duration }
```

**字段名与 `codex exec --json` 的实时事件完全一致**，所以回放能直接复用同一个渲染函数。
`command` 是 **argv 数组**，需 `join(' ')` 成命令行。

> ⚠️ `response_item/custom_tool_call` 里也有命令，但埋在
> `input: "const r = await tools.exec_command({cmd:\"...\"})"` 这样的 JavaScript 源码里，
> 要解析代码才能拿到——**不要用那个**，用 `CommandExecution`。

### ⚠️ 空卡片（Empty turn card）

回复卡片在回合**开始**时就创建（这是"回复钉在底部"的前提），因此任何**没有产出内容**的
结束路径都会留下一个空框。这个问题**连续踩坑四次**，前三次都是猜错方向，最终靠
**DOM 转储 + 创建点调用栈探针**才查清。

**真正的根因**：一轮里卡片被创建了**两次**。

```
1. ensureAgentRow ← send()        回合开始，建卡片（含空回复气泡，作为锚点）
2. ensureAgentRow ← toolRow()     工具到达时，又建了一个
```

中间 `addUser()` 调了 `resetAgentRow()`——它把 `agentRow` **置空但没有删 DOM 元素**，
于是留下一个**孤儿空卡片**。`finally` 只清掉第二个，孤儿永远留在信息流里。
**用户每次发送都会看到它**（夹在上一轮回复和自己的消息之间）。

#### 规则一：`resetAgentRow()` 必须删掉空卡片，不能只是"忘记"它

```js
if (pending && pending.isConnected && !turnCardHasContent(pending)) pending.remove();
```

⚠️ **但不能无条件删**：历史回放会在消息之间调用 `resetAgentRow()`，
无条件删会把**已渲染好的回复删掉**（实测 `answer1`/`answer2` 消失，被历史测试抓到）。
所以判据是 `turnCardHasContent()`。

#### 规则二：判"空"必须用「已落定的内容」，绝不用「当前 DOM 里恰好有什么」

```js
if (row.querySelector('details.cmd')) return true;   // 跑过工具
if (row.querySelector('.think')) return true;        // 有推理
const bubble = row.querySelector('.bubble');
return !!(bubble && bubble.textContent.trim());      // 有回复
```

- **不能用 `agentMarkdown`**：`addAgent` 末尾会清空它，回合结束后恒为空，会误删有内容的卡片。
- **不能用 DOM 即时状态**：临时的「正在处理」行会让空卡片看起来非空，
  而 `showThinking(false)` 又会把它删掉——**判断时机会决定结果**。

配套：`resetTurnView()`（= 清理空卡片 + 复位回合状态）在所有中转点调用：
页面启动、`btnClear`、`btnNew`、`switchSession`、`send()` 的 `finally`。

### ⚠️ 分界线必须在提示之前

`addUser()` 里的顺序是 **先 `addTurnDivider(n)`，再 `row('user', …)`**。
反过来（先消息后分界线）会让「第 N 轮」标签**归属上一轮**，用户反馈过这个问题。

> ⚠️ 顺序陷阱：`send()` 的 `finally` 里 **`dropAgentRowIfEmpty()` 必须排在 `showThinking(false)` 之前**，
> 否则「正在处理」行先被删掉、卡片又没被清理，就永久留下空框。

### ⚠️ 一张卡片 = 一个用户提问，不是一条回复

**`addAgent(text, separate)` 的 `separate` 只在「这条 assistant 消息开启新一轮」时为 true**，
即**紧跟用户消息**的那一条。一个提问可以产生**多条** assistant 消息，它们必须共用一张卡片。

历史回放里这样判定（`switchSession`）：

```js
let previousRole = '';
for (const m of msgs){
  if (m.role === 'user'){ addUser(m.text); previousRole = 'user'; }
  else { addAgent(m.text, previousRole === 'user'); previousRole = 'assistant'; }
}
```

**踩过的坑**：早期版本对每条 assistant 消息都传 `separate=true`，结果一个提问配 3 条回复
就渲染成 **3 张 CODEX 卡片**（用户截图反馈）。`check-ui.cjs` 的 Session B 夹具
故意让第二个提问有两条回复，专门守这一点。

### ⚠️ 回合卡片的锚定与收尾（改动前必读）

回复气泡必须在卡片内**最后**，工具卡/推理插到它**前面**（`agentRow.insertBefore(x, agentBubble)`）。
这带来一个必须配对的收尾动作：

**`addUser()` 里必须调用 `resetAgentRow()`。** 否则上一轮的卡片（含回复）已经固定在底部，
新一轮的用户消息会被追加到它**下面**——顺序就反了。`check-ui.cjs` 的锚定测试会抓到这一点。

**空卡片**：回复卡片在回合**开始**时就创建（这是锚定的前提），所以失败/被停止的回合
必须由 `dropAgentRowIfEmpty()` 收掉，否则留下一个空框。

卡片结构：

```
.row.agent.turn          ← 一轮一张
  .turn-head             "Codex"
  .tool-line             ← 工具卡（可有多个）
  .reason-line           ← 推理摘要
  .bubble.md             ← 回复，必须在最后
```

### ⚠️ Markdown 渲染器的安全约束（改动前必读）

**模型输出绝不能经 `innerHTML`。** 渲染器全程用 `textContent` 构造文本节点与元素，
因此 Markdown 无法注入标记——这也是**没有引入 marked 之类库**的原因（那些库返回 HTML 字符串）。

`check-ui.cjs` 有一条测试专门守这个边界：夹具回复里带
`<img src=x onerror="window.__xss=1">`，断言

- `#log .md img` / `script` 元素数 **必须为 0**
- `window.__xss` **必须为 0**
- 该载荷**以字面文本可见**（不是被吞掉）

**不要为了"支持更多语法"改成 `innerHTML` 方案**，那会直接把这条防护拆掉。

> ⚠️ 区分**两个不同的顺序**，它们不矛盾，别混为一谈：
> - `check-ui.cjs` 里"回复在工具调用之后"说的是 **DOM 出现顺序**（历史逐条渲染）；
> - 本条锚定说的是**渲染位置**——工具卡插到回复**上方**。

> ⚠️ 另一个实测验到的行为：续接会话时若**无法核实该会话原有的权限**，后端会返回
> `409 无法核实此会话的原有权限，请新建会话或重新选择历史会话。`
> 这是有意的防护。写测试时需要新会话（清空模块级 `threadId`）——只清输入框
> `$('threadId').value` 不够，`send()` 读的是模块变量。

## 仍需了解

- Codex 的权限、审批结果和可用模型仍由当前 CLI、本机策略及账户决定；模型目录不是权限凭证。
- 历史从本地 rollout 读取，保留最近 400 条消息，每条最多 20,000 字符。不会重放工具输出或推理摘要。
- 上下文压缩只能根据用量变化推断，界面标明「可能已压缩」。
- 本次没有执行真实付费模型的完整问答；已验证本机元数据接口，并通过本地模拟覆盖执行协议和页面流程。
- 新后端需重启进程才会加载。原服务若有任务运行，应等该任务结束再重启。
