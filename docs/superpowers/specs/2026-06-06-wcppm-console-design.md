# wcppm console — 实时仪表盘 + 命令行 设计文档

- 日期:2026-06-06
- 状态:已通过 brainstorm,待 spec 评审 → writing-plans
- 作者:协同(用户 + Claude)

## 1. 背景与动机

中间件(`src/core/main.ts`)作为 systemd `--user` 服务跑起来后,只往 stdout/journald 打 `[wcppm] …` 日志行。运维盯着这堆 stdout 既无聊、又看不清当下消息流、连接状态、计数。

诉求:给它一个 **CLI interface** —— 一个**实时仪表盘 + 底部命令行**的全屏终端工具,把"盯 stdout"换成一个活的、能交互的窗口。

关键约束(从 brainstorm 锁定):

- 不碰服务进程本身。服务照常打日志,console 只是同一条消息流上一个更好看的实时窗口。
- 贴合仓库现状:ESM、`node:test` TDD、依赖刻意精简(只有 ws/undici/proxy-agent/fetch-socks,无 UI 框架)。
- **守住账号安全硬规则**(见 CLAUDE.md):console 不得新增任何主动 WeChat 调用,不得触发 `/Login/*` 或 `StartAutoSync`。

## 2. 核心决策(brainstorm 锁定)

| 决策点 | 结论 |
|---|---|
| **形态** | 仪表盘 + 底部命令行(二合一)。上半屏实时消息流,底部一行命令输入。 |
| **进程模型** | **独立客户端进程**,attach 到正在运行的 middleware,走它已有的 bridge。不碰服务、不改 stdout。可同时开多个。 |
| **命令能力** | 全功能:过滤/搜索消息流、`send` 发消息、`forcesync`(operator-only)、查联系人/历史。 |
| **技术栈** | **零依赖**:Node 内置 `readline` + 纯函数渲染模块 + 薄 ANSI 终端驱动。不引 blessed/ink(CommonJS/JSX 跟纯 tsc+ESM 打架,且给精简仓库加重量)。 |
| **bridge 客户端** | 把 `bridge-client.ts` 提升到 `src/shared/`,adapter 与 console 共用,新增两个 GET 方法。 |
| **ack 语义** | console 以 **autoAck:false 只读观察者**订阅,避免偷走 adapter 的 ack。 |

### 2.1 关键正确性发现:ack/delivered 是全局态

`db.ts` 的投递态是**全局按 id**,不是按订阅者:

- `markDelivered(id, at)` 按 id 置 `delivered_at`;
- `getUndelivered(account, sinceTs)` 只返回 `delivered_at IS NULL` 的行。

因此若 console 也 auto-ack,它会把消息标记为"已投递",真正的 OpenClaw adapter 重连时就**收不到这些消息的重放**了。

**结论**:console 必须 `autoAck:false`(`bridge-client` 已支持该开关)。代价是 console 自身下线期间的 gap,若 adapter 已 ack,则不会重放给 console —— 对一个监控/观察工具完全可接受。console 是**尽力而为的实时观察者**,不参与投递/ack 协议。

### 2.2 账号安全(不变的硬约束)

console **不新增任何主动 WeChat 操作**:

- `send` 复用现有 `POST /send`(与 adapter 正常回复同一路径)。
- `forcesync` 复用现有 operator-only 的 `POST /forceSync`(服务端已硬性限制为单次、不循环),额外加二次确认门防误触。
- 新增的 `GET /contacts`、`GET /history` 是**纯本地 SQLite 读**,零账号风险,不产生任何主动 WeChat 调用。
- console 以被动只读方式订阅,**无法触发** `/Login/*` 或 `StartAutoSync`。

## 3. 整体架构

```
[ middleware 服务 (systemd --user) ]
   bridge: WS /subscribe · GET /healthz · POST /send · POST /forceSync
           + 新增 GET /contacts · GET /history
                         ▲
                         │  WS + HTTP (bearer token)
        ┌────────────────┴──────────────────┐
        │  wcppm console  (独立进程)          │
        │  `npm run console [configPath]`     │
        └─────────────────────────────────────┘
```

console 读 middleware 同一份配置(`~/.config/wcppm/config.json` 的 `bridgePort`+`bridgeToken`),默认连 `ws://127.0.0.1:<bridgePort>`;支持 `--url`/`--token` 覆盖以连远程 middleware。

最终界面(示意):

```
┌─ wcppm ──────────────── ● WS up · self wxid_abc ─┐
│ 12:03:41 群 张三 → 这个需求得改一下…            │
│ 12:03:55 DM 李四 → 在吗？                        │
│ 12:04:02 群 你   → 收到                          │
├──────────────────────────────────────────────────┤
│ recv 1,204 · subs 1 · last 12:04:02              │
│ : send wxid_li 收到▌                             │
└──────────────────────────────────────────────────┘
```

## 4. 模块拆分

新建 `src/console/`。前三个模块是纯逻辑,走 TDD 单测;后两个是 I/O 胶水,手动冒烟。

| 模块 | 职责 | 测试 |
|---|---|---|
| `state.ts` | 视图模型 + reducer:消息环形缓冲(cap ~500)、连接状态(wsUp/selfWxid/lastMsgTs/subs)、当前过滤器(会话/关键词/dm-only)、滚动偏移 + 跟随模式、选中消息(供回复)、输入缓冲、瞬时状态行。`applyFrame / applyStatus / setFilter / scroll / select / setInput` 全是纯函数。 | ✅ 单测 |
| `render.ts` | **核心纯函数** `render(state, {rows, cols}) → string[]`:算 header 状态条、套过滤+滚动后的可见消息窗、footer 统计行、输入行;按宽度截断/换行、格式化时间/会话标签/发送者/正文、标记 recv/send/img。 | ✅ 单测(给 state+尺寸断言输出行) |
| `commands.ts` | 纯解析器:命令字符串 → 类型化 `Command` union。执行(调 bridge client)与解析分离。 | ✅ 单测 |
| `terminal.ts` | 薄 I/O 驱动(不单测):alt-screen 缓冲(`\x1b[?1049h`)、隐藏光标、原始按键(↑↓/PgUp/PgDn 滚动、Enter 提交、Esc 取消过滤)、`readline` 底部输入、SIGWINCH resize、节流重绘、退出/崩溃/SIGINT 时恢复终端。 | 手动冒烟 |
| `main.ts` | 薄入口:读配置 → 建 bridge client(`autoAck:false`)→ 初始 state → 接线:frame→applyFrame→重绘;输入提交→`commands.parse`→bridge 执行→更新状态行;每 ~2 秒(可配)轮询 `/healthz`→applyStatus。退出收尾。 | — |

### 4.1 命令集(`commands.ts`)

| 命令 | 动作 | 后端 |
|---|---|---|
| `/filter <会话>` | 只看某会话(群名/wxid) | 客户端 |
| `/grep <关键词>` | 正文关键词过滤 | 客户端 |
| `/dm` | 只看 DM | 客户端 |
| `/clear` | 取消所有过滤 | 客户端 |
| `send <to> <text>` | 发文本 | `POST /send` |
| `r <text>` | 回复当前选中的那条 | `POST /send`(带 replyTo) |
| `forcesync` | 二次确认 → 单次 Sync | `POST /forceSync` |
| `who <id|kw>` | 查联系人缓存 | `GET /contacts` |
| `history <chat> [n]` | 翻该会话最近 n 条 | `GET /history` |
| `status` | 显示 `/healthz` 详情 | `GET /healthz` |
| `help` / `quit` | 帮助 / 退出 | 客户端 |

## 5. bridge 客户端复用

把 `src/adapters/openclaw/bridge-client.ts` **提升到 `src/shared/bridge-client.ts`**:

- 它已是纯 WS+HTTP、自带重连、有 `autoAck?` 开关、**无任何 OpenClaw 依赖**(只 import `core/proxy`、`shared/frame`、`shared/logger`)。现在它真有两个消费者(adapter + console)。
- 改动:移文件 + 更新 `channel.ts` 一行 import + 新增两个 GET 方法 `getContacts(q)` / `getHistory({chat,limit})`(GET + bearer)。现有测试已覆盖,风险低。
- console 传 `autoAck:false`。

> 取舍记录:这是"顺手改进正在动的代码"。备选(console 自带迷你客户端)会重复 WS 订阅逻辑,弃。

## 6. middleware 新增两个只读端点(`server.ts`)

经 DI 注入(与现有 `db.getUndelivered/markDelivered` 同样模式),保持 server 可单测:

- `GET /contacts?q=<kw>` → 查 `contacts` 缓存,返回 `[{wxid, name, type, updatedAt}]`。需 bearer 鉴权。
- `GET /history?account=&chat=&limit=` → 读 `inbound_log.payload`(已存完整归一化 frame),按 ts 倒序返回最近 N 条。需 bearer 鉴权。

`db.ts` 相应新增两个只读查询方法(`searchContacts(account, q, limit)` / `recentInbound(account, chat?, limit)`),纯 SQLite 读。

两者**零账号风险,不产生任何主动 WeChat 调用**。

## 7. 数据流 & 错误处理

- **入站**:服务 broadcast Frame → console 收到 → `applyFrame(state)` → 节流 `render` → 重绘。
- **出站**:输入 `send wxid_li 收到` → `commands.parse` → `POST /send` → 状态行 `✓ sent (msgId …)`;该消息稍后也会作为自身 frame 回到流里。
- **状态**:每 ~2 秒(可配)`GET /healthz` → `applyStatus` → 刷 header。
- **forcesync**:二次确认 `(y/N)` → `POST /forceSync` → 状态行显示拉到几条。
- **WS 断**:header 显示 `● WS down, 重连中…`,`bridge-client` 自带 backoff 重连;重连后服务发 `ready` + 重放,console 照常渲染。
- **错误命令 / HTTP 失败**:footer `⚠ …`。
- **终端太小**:渲染精简提示而非崩。
- **退出/崩溃/Ctrl-C**:务必恢复终端(关 alt-screen、显示光标)。

## 8. 配置 & 启动

- `npm run console [configPath]`(dev 经 `npx tsx src/console/main.ts`);构建到 `dist/console/main.js`。
- 复用 middleware 同一份 `~/.config/wcppm/config.json` 取 `bridgePort`+`bridgeToken`,默认连 `ws://127.0.0.1:<port>`。
- 覆盖项:`--url ws://host:port`、`--token <token>`(连远程 middleware)。

## 9. 测试策略(TDD)

| 测试 | 覆盖 |
|---|---|
| `render.test.ts` | 空流、套过滤、滚动偏移、长行截断、窄宽度、各种状态条;给 state+尺寸断言输出行。 |
| `state.test.ts` | reducer:`applyFrame` 限缓冲容量、`applyStatus` 刷 header、`setFilter` 过滤、`scroll` 钳位、`select`。 |
| `commands.test.ts` | 每条命令字符串 → 期望 `Command`;非法输入 → 错误。 |
| `server.test.ts`(扩) | `GET /contacts`、`GET /history`:需鉴权、返回形状、`q` 过滤、`limit`。 |
| `db.test.ts`(扩) | `searchContacts` / `recentInbound` 查询正确性。 |
| `terminal.ts` / `main.ts` | 不单测(I/O 胶水),手动冒烟覆盖。 |

## 10. 范围边界(YAGNI)

- 不做出站媒体(中间件 `POST /send` 本就 text-only,见 CLAUDE.md 限制)。
- 不做鼠标交互、不做多窗格/标签页。
- 不做配置持久化(过滤器/布局不落盘)。
- 不重造服务的 stdout 日志 —— 服务照常打 journald,console 与之独立并存。
