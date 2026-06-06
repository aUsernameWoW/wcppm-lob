# wcppm-lob → 独立中间件 设计文档

- 日期:2026-06-06
- 状态:已通过 brainstorm,待 spec 评审 → writing-plans
- 作者:协同(用户 + Claude)

## 1. 背景与动机

现状:`wcppm-lob` 是一个 WeChatPadProMax(WCPPM)→ OpenClaw 的渠道插件,**进程内**寄生于 OpenClaw 网关(`gateway.startAccount/stopAccount`)。微信收发的全部逻辑(传输、去重、归一化、发送、媒体)都跑在 OpenClaw 进程里。

四个痛点:

- **A 生命周期耦合** — OpenClaw 重启 = 微信会话被一起拆掉。
- **B SDK 脆弱** — 插件深度耦合 OpenClaw 内部(`createChannelPluginBase` 静默丢 `gateway`、`isEnabled` 不能调 `isConfigured` 等已踩过的坑),协同调试抓狂。
- **C 迭代慢** — 改一行要重启整个网关才能验。
- **D 不可复用** — 微信能力锁死在 OpenClaw,别的 bot/脚本接不进来。

评估过三条路(① 直接采用他人的 `~/wechatpadpromax-plugin` 成果 / ② 守现有 TS 就地缝功能 / ③ 独立中间件)。① 是横向移动:仍进程内、耦合更深、且其 bootstrap 调 `/Msg/StartAutoSync`(作者注释自承内部触发 `NewInit`)——正是本项目封过号的风控雷,弃。② 治标不治本(A/C/D 不动)。**选 ③:独立中间件 = 复用我们干净的 TS 核 + 按需移植两边精华。** 这是唯一同时治 A/B/C/D 的路。

## 2. 核心决策(brainstorm 四刀)

| 决策点 | 结论 |
|---|---|
| **路线** | ③ 独立中间件;OpenClaw 沦为可替换的瘦客户端,**脑子(agent/LLM)仍在 OpenClaw**,不重写 agent 栈(YAGNI)。 |
| **边界** | 中间件 = **机械管道**(传输/去重/归一化/缓存/媒体/重放);下游 = **访问策略 + 生成回复**。 |
| **下行协议** | 客户端**主动连**中间件:`WS /subscribe` 收 inbound + `HTTP POST /send` 发送。连接方向对路 → 真正解决痛点 A。 |
| **持久化** | **SQLite 单文件**(零守护进程、可备份、`node:sqlite`/better-sqlite3),两张表。 |

### 2.1 边界:什么进中间件、什么不进(两处修正)

进中间件(机械活,跟"微信这条管子"强绑):
- 上行传输:WS 消费 / webhook 接收 / forceSync 单拉
- 去重(`NewMsgId`)、age 过滤
- 归一化(分组前缀拆分、MsgType 处理、媒体 XML 解析)
- 联系人/群缓存
- 媒体下载(图/语音/视频)
- 入站重放日志(痛点 A)

**不进中间件**(评审中修正的两点):
- **DM 配对 / allowlist** —— 属于"谁有资格跟这个 bot 说话"的**应用层访问策略**,不是机械活。焊进中间件会:(a) 与痛点 D 冲突(别的 bot 想要自己的策略);(b) 重造 OpenClaw 已有的 `createChannelPairingController`。适配器仍是跑在 OpenClaw 里的插件,`ctx.runtime` 与其配对库照常可用——**配对/allowlist 留在 OpenClaw 适配器**。中间件把 DM 全推给订阅方,适配器在调 agent 前 gate;发配对挑战就调中间件 `/send`。代价仅"陌生人 DM 也过一趟 WS 才被拦",本机内网量极小、拦下前不 send 任何东西,无碍。
- **SyncKey 游标** —— 权威态在 **WCPPM 自己手里(存它的 Redis)**,由服务端 `ensureSyncKeyReady`/auto-sync 链维护。我们的 forceSync 是**故意无状态的一次性补拉**(首调 `{"Scene":0}` 省略 Synckey,WCPPM 用自存游标续 push)。不在我们 SQLite 里再存一份。("forceSync 拿到 KeyBuf 后是否翻 Scene=3" 的开放问题随之归 WCPPM 侧,与我们无关。)

### 2.2 账号安全(不变的硬约束)

全程**永不调** `/Login/Newinit`、`StartAutoSync`。中间件消费的就是插件今天在用的同一套 WS/webhook/Sync,不新增任何风控面。longlink/push 由 WCPPM 登录时自动建立,属运维侧职责(`/Login/*` 不在本项目范围)。

## 3. 整体架构

```
远端 · Tailscale 100.64.0.8
  WeChatPadProMax 服务器   HTTP :8062 · WS :8089 /ws/sync   (登录/longlink 运维侧负责)
        ▲ WS push / webhook / HTTP Sync        ▼ /api/Msg/Send*
┌──────────────────────────────────────────────────────────┐
│ 本机 · 中间件(新 systemd --user 常驻服务)                │
│  ① 上行传输   WS 消费 / webhook 收 / forceSync;去重 + age 过滤 │
│  ② 核心处理   归一化 / 联系人缓存 / 媒体解析下载                 │
│  ③ 下行接口   WS /subscribe 推 inbound;HTTP /send /forceSync /healthz │
│  🗄 SQLite 单文件   inbound_log(去重+重放) · contacts(缓存)      │
└──────────────────────────────────────────────────────────┘
        ▲ WS 订阅 inbound        ▼ HTTP /send(bearer token)
  OpenClaw 瘦适配器(现插件瘦身)：连 WS → 跑 agent(含 DM 配对 gate)→ POST /send
  〔未来〕别的 bot / 脚本：同一套 WS+HTTP 接口接入(痛点 D)；考虑 OneBot,v1 不做
```

一句话:现仓库的 `client.ts`(微信核心)抽成中间件 ①②;加一层 ③ + SQLite;`channel.ts/dispatch.ts` 瘦成 OpenClaw 适配器。

## 4. 下行接口契约

下游(OpenClaw 适配器 / 未来 bot)通过两类口对接,均带一个 bearer token(本机 + Tailscale 内网,token 足够)。

### 4.1 `WS /subscribe` —— 推 inbound

连上后服务器每条入站消息推一帧稳定 JSON(已脱离微信原始格式):

```jsonc
{
  "type": "message",
  "id": "<NewMsgId>",              // 全局唯一,客户端可二次去重
  "account": "default",
  "chatType": "group" | "direct",
  "from":  { "wxid": "...", "name": "..." },
  "chat":  { "id": "群id或对方wxid", "name": "..." },
  "text":  "已归一化的可读文本",
  "mentionedMe": true,            // 群里 @bot
  "media": { "kind": "image|voice|video", "mimeType": "...", "fileName": "...", "url|localPath": "..." }, // 有才带
  "ts": 1775677433
}
```

- 连上时先推一帧 `{ "type": "ready", "selfWxid": "..." }`。
- 心跳 ping/pong 保活 + 探活死连接。
- **媒体进推送**:中间件管媒体,故帧内含 `media` 描述符(kind + 元数据,可选 url/本地路径),客户端按需取。补上现版本"只发文本"的遗憾。

### 4.2 HTTP —— 发送 & 控制(同 token)

- `POST /send` `{ account?, to, text, replyTo? }` → 文本;带 `replyTo` 自动走引用(`/Msg/Quote`)。返回 `{ ok, msgId }`。
- `POST /forceSync` `{ account? }` → 一次性补拉(现 `wechatpadpro.forceSync` RPC 搬成 HTTP;**仍只做一次** `POST /api/Msg/Sync`,不循环 ContinueFlag)。
- `GET /healthz` → 存活 + 状态(到 WCPPM 的 WS 通不通、self-wxid、最后消息时间)。

### 4.3 重启不丢消息(兑现痛点 A)

每条入站先落 SQLite `inbound_log`,客户端按 `id` ack;OpenClaw 重启重连时带 `?since=<lastAckId>`,中间件重放 age 窗口内未 ack 的帧。v1 单消费者(只有 OpenClaw)假设让这事简单。

## 5. 持久化:SQLite 两张表

```sql
-- ① 入站日志:同时干"去重"和"重放/ack"
inbound_log(
  id TEXT PRIMARY KEY,      -- NewMsgId;INSERT OR IGNORE,撞了=重复直接丢(去重)
  account TEXT,
  ts INTEGER,               -- 用于 age 窗口与重放/清理
  payload TEXT,             -- 推给 WS 的那帧归一化 JSON
  delivered_at INTEGER      -- NULL=未 ack;客户端 ack 后写时间
);
-- 索引:(delivered_at, ts) 供重放查询

-- ② 联系人/群缓存(可重建,缓存省请求)
contacts(
  account TEXT, wxid TEXT, name TEXT, type TEXT, extra TEXT, updated_at INTEGER,
  PRIMARY KEY(account, wxid)
);
```

- `inbound_log` 是 SQLite 真正挣到饭票的表(去重 + 重放)。清理:定期删超过 `max(maxMessageAge, 1h)` 的行——保留期 ≥ 重复投递窗口(几秒级)即足以去重。
- `contacts` 仅缓存,理论上可放内存,落盘近零成本就顺手存。
- **不含**配对表、SyncKey 表(见 2.1 修正)。

## 6. 仓库结构与代码迁移

**就地重构成单仓两目标**(保住 `client.ts` 的 git 历史;不另起新仓库):

```
wcppm-lob/
├── core/              ← 中间件(零 OpenClaw import,可单跑/可复用)
├── adapters/openclaw/ ← 瘦插件
├── shared/            ← 共享类型(NormalizedMessage 帧、配置)
└── tools/             ← debug CLI(重新指向 core 或运行中的中间件)
```

迁移图:

| 现文件 | 去向 |
|---|---|
| `client.ts`(1753 行,过胖) | 拆进 **core**:`wcpp-client`(HTTP/auth/send/forceSync)· `transport`(WS 消费 + webhook 收)· `normalize`(分组前缀/MsgType/媒体 XML)· `media`(resolve/download/attachment) |
| DM 闸门(`channel.ts:buildDmAuthorizer` + `dispatch.ts` 调用点) | → **adapters/openclaw**(整套访问策略留在适配器,用 `ctx.runtime`;**不进 core**) |
| `dispatch.ts` 的 agent 管线 | → **adapters/openclaw** |
| `channel.ts` 生命周期 + config 面 | → **adapters/openclaw**(连 WS、POST send) |
| `index.ts` / `setup-entry.ts` / `shims/` | → **adapters/openclaw** |
| `proxy.ts` | → **core**(连 WCPPM 的 undici 代理 dispatcher) |
| — 新增 — | **core**:`server.ts`(WS /subscribe + HTTP)· `db.ts`(SQLite)· `main.ts`(入口 = systemd 服务) |
| — 新增 — | **adapters/openclaw**:`bridge-client.ts`(WS 订阅 + HTTP send,取代直连微信) |

## 7. 部署拓扑

```
远端 WCPPM 100.64.0.8 (HTTP 8062 / WS 8089)   ← Tailscale,不变
┌──────────────────────────────────────────────┐
│ 本机                                           │
│  中间件 systemd --user(仿 openclaw-gateway)   │
│   ├─ 下行接口 127.0.0.1:8077  WS /subscribe + HTTP /send │
│   ├─ webhook 接收 127.0.0.1:8000(从插件搬来,caddy 不动) │
│   └─ SQLite  ~/.local/share/wcppm/state.db     │
│        ▲ WS 订阅 + POST /send(bearer token)   │
│  OpenClaw gateway(不变)+ 瘦适配器插件         │
└──────────────────────────────────────────────┘
caddy wcpp.ripplecraft.cn:8443 → 127.0.0.1:8000   ← 不变,只是 8000 后面的进程换成中间件
```

- 中间件读自己的配置 `~/.config/wcppm/config.json`,**不碰 openclaw.json**;适配器只从 openclaw.json 读"桥地址 + token"。
- 端口:远端 WCPPM 8062/8089(不变);中间件下行 127.0.0.1:8077(新);中间件 webhook 接收 127.0.0.1:8000(从插件搬来,caddy 不变);OpenClaw 网关不变。
- 两个部署目标、同一仓库:① 中间件服务(本机)② 适配器插件(`~/.openclaw/extensions/wcppm-lob`,沿用现有 deploy flow:push → pull --ff-only → npm install → npm run build → systemctl --user restart)。新依赖须在扩展目录也装。

## 8. 分阶段落地(不大爆炸,每阶段可独立验证)

- **P0 · 重构搬家,零行为变化** — 仓库切成 `core/ + adapters/openclaw/ + shared/`,`client.ts` 进 core 并按职责拆开。**插件仍进程内直接 import core**,不起中间件进程。验证点:渠道收发与现状一模一样。先把最大那坨机械移动做掉且可回归。
- **P1 · 立起中间件进程 + 下行接口** — 加 `server.ts`(WS+HTTP)、`main.ts`、`db.ts`(两表)。中间件单独跑,用 curl + debug CLI 的小 WS 客户端验:连 WCPPM、去重、归一化、推帧、收 `/send`。**全程不需 OpenClaw**(兑现痛点 C)。此时 OpenClaw 仍走 P0 进程内老路,中间件在旁被独立证明。
- **P2 · 写瘦适配器 + 切换** — `bridge-client.ts`:连中间件 WS 收帧 → 跑 agent → POST `/send`,DM 配对 gate 在这层(用 `ctx.runtime`)。把 `channel.ts/dispatch.ts` 改成走 bridge,不再进程内连微信。切过去,端到端验证:微信 → 中间件 → WS → 适配器 → agent → 回复 → `/send` → 微信。
- **P3 · 收尾** — 删插件死代码、定稿 systemd unit、更新 CLAUDE.md。

**回滚安全**:P0/P1 全程保留可用的进程内老路,直到 P2 才切;唯一有风险的是 P2 那一刀,而它很小(适配器换数据源)。任何阶段出问题都能退回上一阶段的工作渠道。

## 9. 范围与非目标(YAGNI)

- **v1 不做**:中间件自带 agent/LLM(脑子留在 OpenClaw);OneBot 协议(为未来第三方留门,接口不为它妥协也不堵死);多账号、语音转写(STT)、OSS 媒体上传等"精华移植"——留 v1 后再议。
- **不碰**:`/Login/*`、`/User/*`、`/Admin/*`(运维侧职责);WCPPM 的 SyncKey/longlink 管理。
- **保持**:`readOnly`、`allowMsgTypes`、`passRevokemsg`、`maxMessageAge` 等现有过滤语义,迁移到 core。

## 10. 待评审 / 开放问题

- 下行端口 8077 为占位,落地时确认未被占用。
- `media.localPath` vs `url`:v1 优先哪种交付方式(中间件下载到本地临时文件给路径,还是只给 CDN url + 元数据让下游自取)——倾向"有则给 localPath,失败回退 url",writing-plans 阶段定细节。
- bearer token 的下发方式(中间件配置生成 → 手动填进 openclaw.json,还是共享一个文件),落地定。
