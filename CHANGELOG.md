# Changelog

## 0.5.1 (2026-10-12)

**五项迭代（基于首轮实测反馈）**：

- **fork 内部过程进入工作过程视图（transcriptView）**：`delegate()` 每次派生未来会话时，向父会话落一条与原生 subagent 同形的 `subagent/catalog` 事件（`{version:0, childId, childCreatedAt, mode:'continuable', label}`，childId 用 agent id）。客户端据此把该未来会话当作可展开的内联子代理，其内部过程直接显示在现实会话的工作过程视图里；折叠框继续作为补充视图。
- **只显示增量**：折叠框的 `/transcript` 早已按 `session/end-seed` 切割（只显示 fork 之后新增部分）；工作过程视图侧由核心按 `inheritedEventCount` 同规则处理——seed 继承的父会话前缀不会重复显示。
- **新「原文并入」模式（reality-raw）**：与摘要模式的区别只在收口——fork 照常，但**不走摘要**：未来会话这段时间里的全部工具调用与返回值（`mergeDigest`，单条 20k/总量 200k）原样塞进主会话作为本次工具结果。此模式下 `future_promote` 在子会话被禁用（并入由宿主自动完成，无需转正工具），委派提示词改为「执行完调用后一句简短 future_return 收口即可」。入口：`/future raw`（或 `原文`）、PUT /mode `reality-raw`、客户端开关三态循环 普通→摘要→原文。
- **回滚 childReasoningEffort**：按用户要求移除——未来会话 agentOptions 与主会话完全同步，不做独立推理档。
- **建 git 仓库**：此前 8 个插件中唯一无版本控制的目录，已 `git init` 并提交全部历史（CHANGELOG 即完整变更记录）。

## 0.5.0 (2026-10-12)

**基于双会话对照实测的四项架构修复 + fork 性能剖析**（对照实验：同一审计任务，未开启 vs 开启未来会话；39 个 fork 逐相位拆解）：

- **fork 性能核心问题定位**（新增 `scripts/perf-fork-analysis.mjs`，可对任意会话导出复跑）：39 个 fork 累计 1525s 中，**收口轮 LLM（末次真结果 → future_return 落账）占 49.1%（avg 19.2s）**——每条命令的原始输出都被父会话档位（high）推理的 LLM 通读+重写；fork 创建+首轮 LLM 占 22.9%（avg 8.9s）；真工具执行仅 20.7%（p50 0.9s，命令本身是毫秒级）；host 纯 JS（balancedPrefix/turnProgressDigest 跑全量事件）0.00ms/次，可忽略。**结论：慢的不是 fork 机制，是「摘要写作」这一步的推理档位与串行结构。** 缓解见 0.5.1 的原文并入模式（跳过摘要环节）。
- **future_return 支持 raw 附件 + 新工具 future_fetch**（消灭「回去取」）：summary 之外可附 `raw`（原始输出/结构化清单），持久化到 store（单条 200k 字符、至多 200 条、按 at 淘汰）。现实会话需要被摘要压掉的细节时用 `future_fetch(sessionId, offset?, limit?)` **读缓存**——不重执行、不产生新会话；无附件时兜底从落盘转录抽取工具结果。return 结论自动附带取回提示。实测动机：对照实验中端口→PID 映射被摘要压掉，现实会话被迫重新委派两次 netstat；`.npmrc` 明文令牌 P0 漏报。
- **future_promote 从「换主角」改为「并入」（promote=merge）**：不再封存现实会话、不需要用户切换。promote 触发时把未来会话自身过程（end-seed 之后的叙述+调用+结果，`mergeDigest`，单条 6k/总量 60k 截断）作为本次工具结果并入现实会话上下文，并在现实会话事件流落一条 system/message 通告。协议段给出明确触发条件（≥3 次工具调用 / 结构化细节装不进摘要 / 需要用户交互）。动机：对照实验 39/39 全选 return、0 次 promote——旧语义（封存+手动切换）对模型是敌对操作，理性回避。
- **交互中继取代禁用**：子会话不再 restrict deny `ask_user_question/choice`，改为 child 作用域注册同名中继工具（`createAskRelays`）：问题登记到 `runtime.pendingAsks`，经 `GET /transcript` 的 `pendingQuestion` 字段带给客户端；折叠框自动展开渲染提问卡（`AskRelayCard`，支持 header/description/multi_select），用户点选后 `POST /answer` 回传，`resolveAsk` 唤醒挂起在工具执行内的 Promise，未来会话**原地拿到答案继续干**。取消（signal）/收口/新提问均作废挂起项，防僵尸卡片。
- **协议污染修复**：原生 subagent（由 subagent/subagent_fork 派生、拿完整任务书的）此前按「工具返回原始数据 → 我是未来会话」自检**误判身份**，实录中以 future_return 收口、留不下 closing message。协议段新增豁免条款：此类子代理不受本协议约束。

## 0.4.13 (2026-10-11)

**修复同轮未来会话「从零重启」：本轮进度摘要随委派提示词传递**（会话 fad64828 实录复盘）：

- 🐛 **同轮 fork 对兄弟结论完全失明**：核心 seed 只能重放已闭合轮次（`balancedPrefix` 截到最后一个 `turn/end`），现实会话第一轮内 fork 时 seed 为空；且委派提示词只带 `pendingUserText`（用户消息）。结果实录中 4 个未来会话各自从零开始——call_01 的会话重新撞一遍 WMI 沙箱墙，而这墙 call_00 的会话十分钟前早踩过；call_00 的结论 `[future-session]` 标记在后续任何 fork 的转录里 0 次出现（唯一命中是系统提示词协议段）。**即使非首轮也一样**：同一轮内第 N 次调用的结论永远传不到第 N+1 次 fork（seed 冻结在上一轮末尾）。
- 修复：新增 `turnProgressDigest(events)`——从开放轮次提取①现实会话的叙述文本（仅 text 块）②已有结果的工具调用及其结论（剥 `[future-session]` 标记，按 callId 或事件序配对；每条截 4k、总量截 24k 保尾）。`delegate()` 把摘要传入 `buildDelegationPrompt`，以「本轮此前进度（直接复用，不要重做）」段附在委派指令之前。悬空的 tool/call（正在停摆等待的本次委派自身）不入摘要。位于分叉点后、逐 fork 唯一，不额外破坏前缀缓存。

## 0.4.12 (2026-10-11)

**修复未来会话越界代做整个用户任务 + 回退路径泄漏思维链**（会话 fad64828 实录复盘）：

- 🐛 **未来会话越界失控**：0.4.10 把委派提示词最小化时连同**范围声明**一并删除，叠加全局协议段「请接力完成工作」的措辞，未来会话可能把整个用户任务自行做完——实录中一次 `pwsh` 委派（收集主机/OS/CPU/GPU 信息）跑了 **58 步 / 约 10 分钟 / 1.5MB 转录**，把整个四阶段审计任务做完且从未调用 future_return。修复（双管齐下，均不破坏前缀缓存：协议段两边同形；范围行位于分叉点后、本就逐 fork 唯一）：
  - `buildDelegationPrompt` 追加一行范围约束：只执行委派的那一个工具调用，拿到结果立即 `future_return`，不要越界代做用户任务的其余部分；
  - `PROTOCOL_SECTION` 措辞收紧：「接力完成工作」→「接手现实会话当前停摆等待的那次工具调用（以委派消息给出的工具与参数为准），执行完毕即收口，不要越界代做用户任务中未被委派的部分」。
- 🐛 **回退路径泄漏思维链**：未来会话未调用 future_return 而结束时，回退结论 `lastAssistantText` → `blocksToText` 会把 assistant 消息里的 `reasoning` 块原样拼进现实会话的工具结果（实录：现实会话收到的"结论"开头是未来会话的一整段 CoT）。修复：`lastAssistantText` 只取 `type === 'text'` 的正文块（tool-call 块同样排除）。
- 🐛 **回退路径伪装成正常结论**：回退结果此前也标榜「未来会话代执行 X 的结论」，而失控会话交回的可能是整份任务报告。修复：回退结果显式标注 `[fallback]` 并说明"未必是本次委派的结果"；同时给 return/promote/fallback 三条路径的 payload 接上此前定义但从未使用的 `truncate()`（60k 字符防御）。

## 0.4.11 (2026-10-11)

**修复交互工具卡死 + 折叠框去重 + 原生风格渲染**：

- 🐛 **ask_user_question / ask_user_choice 被委派进未来会话 → 用户点不到 → 现实会话永久停摆**（用户实测）。修复：新增 `LOCAL_TOOLS` 名单，交互类（ask_user_*）、展示类（show_images / present）、会话状态类（todo_write / create·get·update_goal / exit_plan_mode / save_received_images）工具**不遮蔽、不委派**，在现实会话本地执行；未来会话内则 restrict 禁用 ask 类（防它自己长出无人能点的卡片卡死 whenIdle），协议段补充指引：需要用户决策时 `future_return` 说明并交还。
- 🐛 **折叠框显示重复内容**：seed 继承的前缀（用户已看过的全部历史）被原样转录。修复：`/transcript` 在 `session/end-seed` 继承切割标记处截断，只摘要 fork 之后新增的事件。
- 🎨 **转录步骤改为原生风格**：每步一行可折叠（▸ 图标 + 角色图标 + 等宽工具名 + 调用/完成/错误标签 + 描述摘要），展开后正文分样式（工具参数/结果等宽、用户/助手 prose、思考暗色斜体）。

## 0.4.10 (2026-10-11)

**委派最小忠实化：移除一切插件自造 token（用户指出分叉点后的额外内容破坏缓存命中）**：

- 🐛 用户实测指出两处"添油加醋"：① 委派提示词是 13 行布道文（身份说明、收口规则复述、"顺势完成相关的工作、可自由多次调用"的扩权授权——导致未来会话一口气连跑 4 个工具）；② 0.4.6 照抄原生的「委派范围声明」`systemPrompt.context` 注入——**它改写子会话系统提示词，与父会话产生分叉，直接破坏前缀缓存**。
- 修复：
  - `buildDelegationPrompt` 重写为**最小忠实中继**：开放轮次的原始用户请求（逐字，`pendingUserText` 提取）+ 停摆中的工具调用（名 + 参数），仅此而已。身份判定与收口规则本来就在两边同形的全局协议段里，不重复。
  - 移除 `future-session:delegation` 系统提示词注入。权限受限由核心策略层保证（approval 钉 never 的 delegation 事件），不需要写进提示词。
  - 保留 preset join（加入父的**同一代际** → 提示词段与父完全一致，缓存友好）与策略继承（session 事件，不产生 token）。
- 说明：核心 seed 机制不允许重放未平衡的飞行轮（原生 continuable fork 同样截到 `turn/end`），"逐 token 完整 fork"在 dsh 中不可表示；共享可缓存前缀 = [系统提示词 + 已完成轮次]，委派提示词是分叉点后的第一段新 token，因此必须最小化。

## 0.4.9 (2026-10-11)

**修复转录摘要拿不到事件 payload（`?`/空结果的最终根因）**：

- 🐛 0.4.8 的字段映射修复无效——`?debug=1` 实测 `ctx.sessionQuery.listEvents` 背后是 **FTS 搜索索引**，事件投影只有 `{sessionId, seq, type, time, surface}` 元数据，**根本没有 data 载荷**，任何字段映射都无济于事。
- 修复：新增 `readPersistedSessionEvents`（util.js）直接读落盘会话文件——扫描 `$DSH_HOME/sessions/*/<id>/session.v4.jsonl.zstd`、按 zstd magic `28 B5 2F FD` 切帧逐帧解压、逐行 parse 出带 payload 的完整事件。已用真实未来会话文件验证（36 事件，tool/call 的 name/arguments 与 tool/result 的 message.content 全部可读）。
- `/transcript` 读取顺序改为：① 活 agent 内存快照（最实时）→ ② 落盘文件（带 payload）→ ③ sessionQuery（元数据兜底并注明）。
- 顺带修复 `future.js` settle 的回退结论提取（`lastAssistantText` 之前也在读空投影，一直返回空文本，全靠 decisions 映射兜底）——同样改为活快照 → 落盘文件。

## 0.4.8 (2026-10-11)

**修复折叠框转录里工具步骤显示「调用 · ? / {} / 空结果」**：

- 🐛 `summarizeEvents` 的字段映射与实际事件形状不匹配：`tool/call` 的 `arguments` 是 **JSON 字符串**（旧代码 `JSON.stringify(字符串)` 后又被投影形状吞掉）；`tool/result` 的内容在 `data.message.content` 下（旧代码只读 `data.content` → 恒空）。
- 修复：tool/call 双形态兜底（`data.name ?? data.call?.name …`，字符串 args 原样截断）；tool/result 读 `data.message.content ?? data.content`，错误标记同查双层（`data.isError ?? data.message.isError ?? data.error`）。

## 0.4.7 (2026-10-11)

**修复未来会话落盘损坏（折叠框转录读不出：`lacks an identified message`）**：

- 🐛 **症状**：客户端折叠框「未来会话暂无步骤」，`/transcript` 报 `stored session ... is corrupt: session event at seq N lacks an identified message`。用多帧 zstd 切帧解包落盘文件实锤：接力提示词落成的 `user/message` 事件（seq 685）只有裸 `content`，缺 `id`/`role`/`source`——v4 会话校验（dsh-session:1191-1201）要求 user/message 带 `data.id`（字符串）+ `role:"user"` + 合法 source。
- 根因：`agent.followup({ content })` 裸投 content 块；原生路径用 `dsh-llm` 的 `createUserMessage`（= `{id: randomUUID(), role:'user', content, source}` + 深冻结）构造完整标识消息。
- 修复：followup 改传完整标识消息（`id: randomUUID()` + `role: 'user'` + `source: {kind:'user'}`，与原生同形）。此前创建的全部未来会话文件已永久损坏（无法修复，只能忽略/删除）。
- 附：落盘文件为**多帧 zstd** jsonl，`zstdDecompressSync` 只解第一帧——诊断脚本须按 magic `28 B5 2F FD` 切帧逐段解压。

## 0.4.6 (2026-10-11)

**修复未来会话空工具注册表（补齐原生 fork 的 setup 三件套）**：

- 🐛 **0.4.5 的 header.agentPreset 透传被实测证伪**：落盘 header 确实有了 `agentPreset:"standard"`，但未来会话依旧没有核心工具——preset 装配根本不（只）看 header，而是要子 agent 在创建窗口里调用 `agentPresets.composeFrom(childCtx, parentCtx)` 加入父的 preset **代际**。对照原生 fork 提供方（`dsh-subagent-in-process-driver` 的 `startInProcessRun`）逐行核对，发现我们直接 `agents.create` 时漏传了整个 **`setup(childCtx, child)`**。
- 修复（复刻原生三件套，全部防御式降级）：
  1. **preset join**：`agentPresets.composeFrom` —— 工具面与提示词段的真正来源；
  2. **委派范围声明**：systemPrompt.context 注入（原生 SUBAGENT_DELEGATION_CONTEXT 同文改写为 future session 语境）；
  3. **策略继承**：父会话 sandbox/permission 覆盖 + approval 钉死 `never`，以 `source:'delegation'` 事件落到子会话日志。
- meta 补 `origin: 'subagent'`（与原生 fork 同形）；selfcheck [3b] 新增 setup/origin 断言 + setup 空服务安全执行。

## 0.4.5 (2026-10-11)

**修复未来会话看不到核心工具（agentPreset 未透传）**：

- 🐛 **实弹测试发现**（由未来会话自查报告确诊）：fork→继承→收口链路已通，但未来会话的工具面板里没有 pwsh/glob/read 等核心工具，只剩 `future_*`、`load_workspace_dependencies` 等全局注册的插件工具——它根本无法"代劳执行"。
- 根因：preset registry 经 session projection 读 `header.agentPreset`（dsh-session:1708 写入、dsh-agent-preset-registry/lib/index.js:51 init 读出）来决定 agent 的工具面与提示词段；fork 的 `meta` 没带这个字段 → 未来会话无 preset → 核心工具全缺。
- 修复：`parentHeader.agentPreset` 非空时透传进 fork meta；selfcheck [3b] 增加 agentPreset 断言。

## 0.4.4 (2026-10-11)

**修复 `session "session-N" already exists`（自增铸造撞车）**：

- 🐛 **实弹测试发现**：热切换开启 reality 模式后，影子拦截与停摆等待全部正常工作，但每次 fork 都死在核心 SessionStore 的自增 id 铸造上（`session-1` → `session-2` → `session-3` 逐次递增、逐次撞车）。根因：核心自增铸造不感知 UUID 命名的既有会话，且失败的 fork 会把铸出的 `session-N` 留在存储里毒化后续铸造。0.4.0 的「不传 sessionId、交给核心原子铸」决定是错的——核心铸造器本身就是 bug 源。
- 修复：插件自铸会话身份 `session-<randomUUID()>`，彻底绕开核心自增计数器。
- selfcheck [3b] 断言同步更新：sessionId 必须匹配 `session-<uuid>` 格式。

## 0.4.3 (2026-10-11)

**修复重启后影子层丢失（恢复会话静默退化）**：

- 🐛 **宿主重启后，已标记 `mode=reality` 的会话不再被影子遮蔽，工具调用静默退化为本地直跑**：桌面端启动时恢复上个会话的 agent，`agent/created`（source=resume）可能在插件 apply 注册监听器**之前**就已发出，事件被永久错过，且没有任何日志线索（本插件对未收到的事件无感知）。
- 修复：启动收尾微任务新增**活 agent 补捞**——对 `ctx.agents.list()` 返回的全部活 agent 重放 `applyToAgent('startup-catchup')`：mode=reality 的重装影子层，其余清旧代际（幂等，与 agent/created 路径同构）。

## 0.4.2 (2026-10-11)

**修复「seeded session requires an explicit constructor seed」（第一轮必炸）**：

- 🐛 **现实会话第一轮的任何工具调用都会导致 fork 失败**：此时会话还没有任何 `turn/end`，`balancedPrefix` 截出 0 条事件，旧逻辑在 `seed.length === 0` 时整个省略 `seed` 字段，而 `meta.isSeeded: true` 照传——核心 Session 构造器在 `header.isSeeded && seed === void 0` 时直接抛错。0.4.0 的「空 seed 时不下发 seed」规避写法规避错了对象（真正要规避的是 `inheritedEventCount` 缺失，而它只要与 seed 成对下发即可）。
- 修复：`seed`（含空数组）与 `inheritedEventCount`（=seed.length）**始终成对显式下发**。已对照核心源码（dsh-session/lib/index.js:1323-1352）核验：空数组合法（校验只拒绝 `undefined`），`0 === log.length` 满足快照模式约束。
- selfcheck [3b] 断言同步反转：空 seed 必须下发空数组 + `inheritedEventCount: 0`。

## 0.4.1 (2026-10-11)

**修复启动白屏（客户端 keyed slot 冲突）**：

- 🐛 **修复 `web boot: 1 entry did not activate — @deepseek-ai/dsh-client-ui-deliverables: failed`**：0.4.0 的折叠框把 45 个标准 preset 工具名全量注册进核心 keyed slot `tool.call.toolview`（默认 priority 0），与官方 client-ui entry 的注册**大面积相撞**（`dsh-client-ui-tool` 48 个 key、`dsh-client-ui-deliverables` 的 `present`、`dsh-client-ui-skill` 的 `skill`）。slots 系统对同 key 同 priority 的重复注册直接 throw（`dsh-client-ui-slots`：`keyed slot ... already has an entry for key ...`），future-session 先注册抢占后，deliverables 激活时抛错 → fiber FAILED → web boot 审计失败 → **客户端白屏、启动爆掉**。
- 修复：`STATIC_TOOL_NAMES` 裁剪为官方未占用的 10 个 key（pwsh / subagent_fork / run_code / str_replace_editor 等），新增 `CORE_TOOLVIEW_KEYS` 名单直接跳过官方已注册的 key；`registerKey` 内加 try/catch 兜底——残余冲突一律保留官方内置视图（折叠框在这些工具上退化为不显示），**任何启动顺序下都不再抛错**。
- 功能取舍：有官方 toolview 的工具（read/grep/present/skill 等全部核心工具）不再挂折叠框；未来会话的执行过程仍可通过 `/transcript` 路由与 `future_peek` 查看。

## 0.4.0 (2026-10-11)

**修复致命委派故障 + 折叠框落地**：

- 🐛 **修复 `session "session-N" already exists` / `agent id "undefined" does not match session id`**：核心 `CreateAgentOptions` 的会话身份字段名是 **`sessionId`**（源码 `dsh-agent-loop/lib/index.js:1852` 读 `options.sessionId`），旧代码传的是 `id`——被静默忽略后由 SessionStore 自增铸成 `session-<n>`，必然撞上已有会话。现在**不再自己拼 id**，交给核心原子铸造（顺手删掉「去掉 id 重试一次」这条掩盖真错的回退）。
- `FutureSessionRuntime` 改用 `ctx.agents.create({ parentAgent, meta, seed, inheritedEventCount, agentOptions, signal })`（`ctx.agentLoop.createAgent` 保留为回退路径）；seed 优先取活会话内存快照 `session.snapshotEvents()`（与原生 fork 提供方同源），拿不到再退回 `sessionQuery`。
- 空 seed 时不下发 `seed` / `inheritedEventCount`（避免 "seeded session requires an inherited event count"）。
- **Phase 2 折叠框（客户端）**：
  - 影子工具通过 `output.presentationMeta` 把 `{ futureSession: { childSessionId, mode, toolName } }` 作为可回放展示元数据随工具结果持久化；
  - 客户端按工具名把同一个 ToolRow 注册进 ui-tool 的 keyed slot `tool.call.toolview`（静态清单 + `GET /tools` 运行时补齐，注册幂等）；
  - 工具行里出现「未来会话」折叠框：运行中每秒轮询 `GET /transcript` 显示按步转录（自动展开），收口后自动收起成一行 + 状态标签（运行中 / 已回结论 / 已转正），用户可随时手动展开、复制子会话 id；promote 时提示到左侧会话列表打开该会话接力。
- 新增宿主路由：`GET /tools[?sessionId=]`、`GET /calls?sessionId=`、`GET /transcript?sessionId=`（全部 loopback-only；transcript 只允许读本插件登记过的未来会话）。
- 新增 `ModeStore` 的 `calls`（callId → 未来会话）与 `catalogs`（会话 → 可见工具名）两张表 + 对应查询；`/calls` 是结果块元数据缺失时的兜底路径。
- selfcheck 扩到 7 项：新增「[3b] fork 请求字段契约（session id 撞车回归）」与「[6] 折叠框数据面」。

## 0.3.0

（内部迭代，未单独记录。）

## 0.2.0 (2026-10-11)

重写委派核心——**脱离 dsh 原生 subagent 体系**：

- 新增 `lib/future.js` 的 `FutureSessionRuntime`：工具调用被拦截后，插件直接经核心 Agent 工厂 `ctx.agentLoop.createAgent` 在暗处 fork 一个**插件自持的镜像会话**（meta 携带 `parentSession` / `isSeeded` / `inheritedEventCount` / `delegationDepth:1`，seed 为现实会话的平衡已完成轮次前缀），`followup` 投递接力提示词、`whenIdle` 等待收口。
- 不再使用 `ctx.subagents` / subagentCatalog / subagent/descriptor：未来会话不属于任何原生 subagent 格式，仅由插件登记与追踪。
- seed 前缀截取：`balancedPrefix`（到最后一个 turn/end）；开放轮次中的用户请求由 `pendingUserText` 提取并入接力提示词（fork 不能携带未平衡轮次）。
- 回退结论改从未来会话事件日志提取最后一条非空 assistant 文本（`lastAssistantText`）。
- 诊断日志落盘 `$DSH_HOME/dsh-plugin-future-session.log`（Desktop 宿主 console 不可见）。

## 0.1.0 (2026-10-11)

首发：

- 现实/未来会话模型：`/future on|off|status` 按会话切换；现实会话的全部工具被同名同形影子工具遮蔽，任何调用触发 fork 委派，现实会话就地停摆等待结论。
- 未来会话自主收口：`future_return`（只回结论、封存）与 `future_promote`（转正、封存原现实会话）；未显式决策时回退使用子会话最终输出。
- 同形原则：现实与未来共享同一份系统提示词协议段与工具面，身份由工具返回内容（`[future-session]` 标记 vs 原始数据）自检，前缀缓存全程命中。
- 保底 `future_peek`：按步摘要指定未来会话。
- 持久化：会话模式 + 子会话登记 + 决策落账（UTF-8 无 BOM 原子写、孤儿清理）。
- 零运行时依赖、零构建；`npm run selfcheck` 冒烟自检。
