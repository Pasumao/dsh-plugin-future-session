# dsh-plugin-future-session

现实/未来会话：把一个 DeepSeek Harness (dsh) 会话拆成**现实会话**与**未来会话**两层，压缩无效上下文、全程命中前缀缓存。

```
普通会话：理解 → 搜索（原始结果灌入上下文）→ 分析 → 本地翻文件（目录/文件内容灌入上下文）→ 对比 → 输出
本插件：  理解 → 调用工具（就地停摆）→ 未来会话继承全部上下文，搜索+翻文件+消化 →
          只把结论作为这次工具调用的返回值送回 → 对比 → 输出
```

现实会话的上下文里**只有「一次工具调用 + 一份结论」**，搜索过程、文件目录等噪音全部留在未来会话里。未来会话是**插件自持的镜像会话**：由插件直接经核心 Agent 工厂（`ctx.agents.create`）fork，不经原生 subagent 目录（无 `ctx.subagents`、无 subagentCatalog/descriptor），继承现实会话全部已完成轮次前缀——两边系统提示词与工具面**完全同形**，前缀缓存全程命中。

## 工作原理

1. 开关开启（滑动开关或 `/future on`）把当前会话标记为**现实会话**：它可见的每一个工具都会被安装成**同名同描述同参数的影子工具**（作用域遮蔽，wire 层无法区分）。
2. 模型照常发出工具调用 → 影子工具不执行任何实际工作，而是由插件自研的 `FutureSessionRuntime` 直接经核心 Agent 工厂（`ctx.agents.create`，回退 `ctx.agentLoop.createAgent`）在**暗处 fork 一个镜像会话**——它不属于 dsh 原生任何 subagent 格式（不走 `ctx.subagents`、无 subagentCatalog/descriptor），seed 为现实会话的平衡已完成轮次前缀——随后 `whenIdle` 等待：现实会话就地停摆（天然串行，无并发问题）。
   > ⚠ **契约坑（0.4.0 修复）**：`CreateAgentOptions` 的会话身份字段名是 **`sessionId`**，不是 `id`。传 `id` 会被静默忽略，id 由 SessionStore 自增铸成 `session-<n>`，于是抛 `session "session-N" already exists`（并伴随 `agent id "undefined" does not match session id`）。正确做法是**不传 id**，交给核心原子铸造。
3. 未来会话继承现实会话全部已完成上下文（缓存命中），自由使用真工具完成整段工作。
4. **由未来会话自主决定**怎么收口：
   - 中间过程没用（一堆文件目录、噪音输出）→ 调用 `future_return(summary)`：结论成为现实会话那次工具调用的返回值（带 `[future-session]` 标记），未来会话封存；
   - 过程信息对后续有用 → 调用 `future_promote(report)`：未来会话转正为现实会话，原现实会话封存（转正报告登记在案，会话可在 Desktop 会话列表打开）。
5. **身份判定不靠提示词分叉**（分叉会砸掉缓存）：现实与未来看到同一份系统提示词协议段、同一套工具名。模型靠工具返回内容自检——返回原始数据 → 自己在未来会话；返回带 `[future-session]` 标记的结论 → 自己在现实会话。
6. 保底：现实会话可调用 `future_peek(sessionId)` 查看某个未来会话内部的按步摘要（提示词明确「尽量别用」）。

未来会话是插件自持的持久化镜像会话：不进任何原生目录，由插件登记追踪；会话本体可在 Desktop 会话列表打开（`parentSession` 头标记其来源）。

### 折叠框（Phase 2，0.4.0 落地）

用户界面**永远停在现实会话**，未来会话的中间过程作为**工具行内的折叠框**呈现：

- 影子工具的输出带 `output.presentationMeta`，把 `{ futureSession: { childSessionId, mode, toolName } }` 作为**可回放展示元数据**随工具结果持久化，客户端从结果块的 `meta` 读得到；
- 客户端按工具名把同一个 ToolRow 注册进 ui-tool 的 keyed slot `tool.call.toolview`（未登记的工具继续用内置卡片）；
- 运行中：折叠框自动展开，每秒轮询 `GET /transcript` 显示未来会话的按步转录（用户/助手文本、工具调用与结果摘要）；
- 收口后：自动收起成一行（`已回结论` / `已转正` / `已结束` 标签 + 最后一段结论摘要），随时可手动展开，可一键复制子会话 id；
- `future_promote` 时折叠框提示「已转正：可在左侧会话列表打开该未来会话继续接力（本会话已封存）」。

### 宿主路由（客户端数据面，全部 loopback-only）

| 路由 | 用途 |
|---|---|
| `GET /mode?sessionId=` · `PUT /mode` | 模式读取 / 切换（滑动开关） |
| `GET /tools[?sessionId=]` | 影子工具名清单（客户端 keyed 视图预注册；只增不减） |
| `GET /calls?sessionId=` | `callId → 未来会话 id` 索引（结果块元数据缺失时的兜底） |
| `GET /transcript?sessionId=&limit=` | 未来会话按步转录（**只允许读本插件登记过的未来会话**） |
| `POST /answer` | 中继提问作答回传（未来会话 `ask_user_*` → 折叠框提问卡 → 用户点选后回传唤醒） |


## 安装

```powershell
node <dsh>/lib/bin.js plugin --profile <profile> add <本插件目录>
```

重启 Desktop 客户端后生效（启动日志中不应出现 `skipping profile bundle "dsh-plugin-future-session"`）。

## 使用

**滑动开关（推荐）**：会话输入栏左下角有「未来」滑动开关——点一下即开启/关闭本会话的现实会话模式（悬停有说明气泡，无需输入任何指令）。

```
/future on      # 等价指令：进入现实会话模式（摘要返回：工具全部由未来会话代执行，只回蒸馏结论）
/future raw     # 原文并入模式：未来会话的全部调用与结果原样塞回主会话（不写摘要）
/future off     # 退出，工具恢复本地执行
/future status  # 查看当前模式与累计未来会话
```

配置（插件 Config）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `protocolSection` | `true` | 是否注入共享协议提示段 |
| `maxDepth` | `1` | 未来会话委派深度上限（防递归 fork） |

## 设计边界

- **同形原则**：影子工具与真工具、共享协议段在现实/未来两边一字不差；身份只由返回内容判定。这是缓存命中的前提，改动时严禁按会话分叉提示词。
- **串行停摆**：现实会话在一次委派中整体等待，不产生并发 fork。
- **转正不硬删**：`future_promote` 只封存并登记原现实会话，不做不可逆删除。
- 持久化：`$DSH_HOME/dsh-plugin-future-session.json`（UTF-8 无 BOM，原子写），四张表——会话模式、未来会话登记、`callId → 未来会话` 映射、会话可见工具目录。
- **策略继承**：fork 出的未来会话会把 approval 策略钉死为 `never`（delegation 语义）——现实会话在「ask」审批模式下开启本插件后，未来会话内的工具调用**不会再弹审批**，由核心策略层与沙箱约束兜底。

## 已知限制

- 影子注册经 agent 作用域 fiber 微任务落地，理论上存在首个请求抢跑窗口（与 dsh-plugin-context-trim 相同边界，实践中先于首个 pre-step 完成）。
- 未来会话每步的 `future_return` 决策依赖模型自觉调用；未决策时回退使用其最终输出（仍符合「只回结论」语义）。
- 折叠框数据面优先读结果块的 `presentationMeta`，读不到时回退 `GET /calls` 索引；两者都拿不到（例如插件重启前产生的历史调用）则该行不显示折叠框。
- 折叠框按工具名注册 keyed 视图（`tool.call.toolview`）：该 slot 是 keyed 基数，若某工具的内置卡片与我们的视图同 key 并存，会出现「内置卡片 + 折叠框」上下两段——当前按可接受处理，必要时后续用 `priority` 精细收口。
- `future_promote` 语义为「并入」（0.5.0 起）：未来会话的完整过程直接并入现实会话上下文，现实会话不封存、无需用户切换。
- 收口与转正由**未来会话**自主决定；现实会话只是停摆等待返回值，不做二次判断。

## 开发自检

```powershell
cd <本插件目录>
npm run selfcheck
```

## 相关插件

| 插件 | 链接 |
|---|---|
| dsh-notify | [GitHub repo](https://github.com/Pasumao/dsh-plugin-notify) · [npm](https://www.npmjs.com/package/dsh-notify) |
| dsh-plugin-image-tools | [GitHub repo](https://github.com/Pasumao/dsh-plugin-image-tools) · [npm](https://www.npmjs.com/package/dsh-plugin-image-tools) |
| dsh-plugin-table-zoom | [GitHub repo](https://github.com/Pasumao/dsh-plugin-table-zoom) · [npm](https://www.npmjs.com/package/dsh-plugin-table-zoom) |
| dsh-plugin-windows-guard | [GitHub repo](https://github.com/Pasumao/dsh-plugin-windows-guard) · [npm](https://www.npmjs.com/package/dsh-plugin-windows-guard) |
| dsh-plugin-context-trim | [GitHub repo](https://github.com/Pasumao/dsh-plugin-context-trim) · [npm](https://www.npmjs.com/package/dsh-plugin-context-trim) |
| dsh-plugin-dev-kb | [GitHub repo](https://github.com/Pasumao/dsh-plugin-dev-kb) · [npm](https://www.npmjs.com/package/dsh-plugin-dev-kb) |

## License

MIT
