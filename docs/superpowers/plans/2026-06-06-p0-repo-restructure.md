# P0 · 仓库重构搬家 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `wcppm-lob` 的源码切成 `core/`(微信核心,零 OpenClaw 依赖)+ `adapters/openclaw/`(瘦插件)+ `shared/`(共享类型)三层,且**行为零变化**——插件仍进程内直接 import core,渠道收发与现状一模一样。

**Architecture:** 纯目录重构 + 一处类型解耦。`client.ts`(微信传输/发送/媒体,已几乎与 OpenClaw 无关,仅一个 `import type { Logger }`)和 `proxy.ts` 移入 `src/core/`;`channel.ts`/`dispatch.ts`/`index.ts`/`setup-entry.ts`/`shims/` 移入 `src/adapters/openclaw/`;新增 `src/shared/logger.ts` 取代 client 对 openclaw shim 的 `Logger` 类型依赖。不引入任何新运行时(中间件进程是 P1 的事)。

**Tech Stack:** TypeScript(ESM, `tsc` build, `node:test` via `tsx`)。无新依赖。

**前置:** 当前分支 `feat/standalone-middleware`。工作树里有与 P0 无关的未提交改动(`.gitignore`、`CLAUDE.md`、未跟踪的 `tools/forge-webhook.mjs`)——**P0 的提交只 `git add` 本计划点名的文件,绝不裹进这些。**

**回归网:** 这是重构,正确性靠两件事守:① `npm run build`(tsc)零报错;② `npm test`(现有 `parse.test.ts` 14 例 + `proxy.test.ts`)`# fail 0`。

**范围说明(对 spec §8 P0 的一处有意收窄):** spec 写 "client.ts 进 core **并按职责拆开**"。本计划只做**整体搬入 core + Logger 解耦**,**不**在 P0 把 `WcppClient`(单个约 1400 行、方法共享 `this` 状态的类)拆成 `wcpp-client/transport/normalize/media` 子模块。理由:类内方法拆文件是实打实的重构,与 "零行为变化、先做最低风险那一步" 的 P0 价值相悖;放到 P1 真正动 core 时一并做更稳。**如需 P0 就拆,见末尾"可选:P0 内拆 client"。**

---

### Task 1: 解耦 `client.ts` 的 Logger 类型(为搬入 core 铺路)

**Files:**
- Create: `src/shared/logger.ts`
- Modify: `src/client.ts:18`

- [ ] **Step 1: 建共享 Logger 类型**

新建 `src/shared/logger.ts`,内容与现 shim(`src/shims/openclaw/channel-core.ts:13-18`)结构一致:

```ts
/**
 * Logger — 结构化日志接口。core 不依赖 OpenClaw,故在此自有定义;
 * OpenClaw 适配器传入的 ctx.log 结构兼容(info/error/warn/debug)。
 */
export interface Logger {
  info: (...args: any[]) => void;
  error: (...args: any[]) => void;
  warn: (...args: any[]) => void;
  debug: (...args: any[]) => void;
}
```

- [ ] **Step 2: 把 client.ts 的 Logger import 指向自有类型**

在 `src/client.ts`,把第 18 行:

```ts
import type { Logger } from "openclaw/plugin-sdk/channel-core";
```

改为(此刻 client 仍在 `src/`,shared 在 `src/shared/`,故同级 `./shared/`):

```ts
import type { Logger } from "./shared/logger.js";
```

- [ ] **Step 3: 构建 + 测试,确认零变化**

Run: `npm run build && npm test`
Expected: build 无报错;测试 `# fail 0`(parse.test.ts / proxy.test.ts 全过)。

- [ ] **Step 4: 提交**

```bash
git add src/shared/logger.ts src/client.ts
git commit -m "refactor(P0): decouple client.ts Logger type from openclaw shim"
```

---

### Task 2: 三层目录搬家 + 修路径 + 改构建配置

**Files:**
- Move → `src/core/`: `client.ts`, `proxy.ts`, `parse.test.ts`, `proxy.test.ts`
- Move → `src/adapters/openclaw/`: `channel.ts`, `dispatch.ts`, `index.ts`, `setup-entry.ts`, `shims/`(整棵树)
- Modify: `src/core/client.ts`(Logger 相对路径)、`src/adapters/openclaw/channel.ts`(client 相对路径)、`tsconfig.json:15`、`package.json`

- [ ] **Step 1: 建目录并 git mv core 文件**

```bash
mkdir -p src/core src/adapters/openclaw
git mv src/client.ts src/core/client.ts
git mv src/proxy.ts src/core/proxy.ts
git mv src/parse.test.ts src/core/parse.test.ts
git mv src/proxy.test.ts src/core/proxy.test.ts
```

(`proxy.ts` 只 import 第三方包、`proxy.test.ts`/`parse.test.ts` 都 import 同级 `./proxy.js`/`./client.js`——同目录整体搬,这些相对 import 不变。)

- [ ] **Step 2: git mv 适配器文件**

```bash
git mv src/channel.ts src/adapters/openclaw/channel.ts
git mv src/dispatch.ts src/adapters/openclaw/dispatch.ts
git mv src/index.ts src/adapters/openclaw/index.ts
git mv src/setup-entry.ts src/adapters/openclaw/setup-entry.ts
git mv src/shims src/adapters/openclaw/shims
```

- [ ] **Step 3: 修 `core/client.ts` 的 Logger 相对路径**

client 从 `src/` 进了 `src/core/`,shared 仍在 `src/shared/`。把 `src/core/client.ts` 里:

```ts
import type { Logger } from "./shared/logger.js";
```

改为:

```ts
import type { Logger } from "../shared/logger.js";
```

- [ ] **Step 4: 修 `adapters/openclaw/channel.ts` 对 client 的相对路径**

channel 进了 `src/adapters/openclaw/`,client 在 `src/core/`。把 `src/adapters/openclaw/channel.ts` 里:

```ts
import { WcppClient, type NormalizedMessage } from "./client.js";
```

改为:

```ts
import { WcppClient, type NormalizedMessage } from "../../core/client.js";
```

(`dispatch.ts` 不 import client,无需改;`index.ts`/`setup-entry.ts` import `./channel.js`,同目录搬,不变;适配器对 `openclaw/plugin-sdk/*` 的 import 由 tsconfig path 解析,见 Step 5。)

- [ ] **Step 5: 修 tsconfig 的 shim 路径映射**

shims 移到了 `src/adapters/openclaw/shims/openclaw/`。把 `tsconfig.json:15`:

```json
"openclaw/plugin-sdk/*": ["./src/shims/openclaw/*"]
```

改为:

```json
"openclaw/plugin-sdk/*": ["./src/adapters/openclaw/shims/openclaw/*"]
```

- [ ] **Step 6: 修 package.json 的产物入口路径**

`rootDir=src`、`outDir=dist`,搬家后 `index.ts`/`setup-entry.ts` 产物变成 `dist/adapters/openclaw/`。在 `package.json` 改四处:

```json
  "main": "dist/adapters/openclaw/index.js",
  "types": "dist/adapters/openclaw/index.d.ts",
```

以及 `openclaw` 块:

```json
  "openclaw": {
    "extensions": [
      "./dist/adapters/openclaw/index.js"
    ],
    "setupEntry": "./dist/adapters/openclaw/setup-entry.js",
```

(`scripts.test` 的 glob `src/**/*.test.ts` 仍能匹配 `src/core/*.test.ts`,不用改;`scripts.debug` 指向 `tools/debug.ts`,见 Task 3。)

- [ ] **Step 7: 构建 + 测试**

Run: `npm run build && npm test`
Expected: build 无报错(tsc 解析新路径);测试 `# fail 0`。若报 "Cannot find module ./client.js" 类错误,回查 Step 3/4 相对路径。

- [ ] **Step 8: 核对产物布局**

Run: `ls dist/adapters/openclaw/index.js dist/adapters/openclaw/setup-entry.js dist/core/client.js dist/shared/logger.js`
Expected: 四个文件都存在(证明 outDir 镜像了新结构、openclaw 入口指得对)。

- [ ] **Step 9: 提交**

```bash
git add src/core src/adapters src/shared tsconfig.json package.json
git commit -m "refactor(P0): split into core/ + adapters/openclaw/ + shared/ layout"
```

---

### Task 3: 校验 tools 与端到端不变,收尾

**Files:**
- Verify (可能 Modify): `tools/debug.ts`

- [ ] **Step 1: 确认 debug CLI 不依赖被搬动的文件**

Run: `grep -nE "src/|\.\./(client|channel|proxy)" tools/debug.ts || echo "debug.ts self-contained"`
Expected: 打印 `debug.ts self-contained`(它只 import `fs`/`path`/`ws`,自带 API 调用)。
若意外打印了对 `../src/client` 之类的引用,把该 import 改成 `../src/core/client.js` 后再 `npx tsx tools/debug.ts status`(需 `local-config.json`)做一次冒烟——否则跳过本步无需改动。

- [ ] **Step 2: 全量回归**

Run: `npm run build && npm test`
Expected: build 无报错;`# fail 0`。

- [ ] **Step 3:(部署侧手测,非阻塞)端到端确认行为零变化**

> 这步需要实环境(OpenClaw 网关 + 远端 WCPPM),按 deploy flow 走:
> `git push` → 扩展目录 `git pull --ff-only && npm install && npm run build` → `systemctl --user restart openclaw-gateway`。
> 期望:渠道照常起、收发一条测试消息正常。若起不来,先查 `openclaw channels status`(参 CLAUDE.md 的两个 silent-drop 陷阱),最可能是 package.json 的 `extensions` 入口路径没对上 dist 新布局。

- [ ] **Step 4: 标记 P0 完成**

P0 不引入新功能,无独立提交内容时本任务可不提交。若 Step 1 改了 `debug.ts`:

```bash
git add tools/debug.ts
git commit -m "refactor(P0): repoint debug CLI imports to core/"
```

---

## 完成判据

- `src/` 呈现 `core/ + adapters/openclaw/ + shared/` 三层,`src/` 根下不再有散落的 `client.ts`/`channel.ts` 等。
- `src/core/` 内无任何 `openclaw/plugin-sdk` import(用 `grep -rE "openclaw/plugin-sdk" src/core/ || echo clean` 验,应为 `clean`)。
- `npm run build` 与 `npm test` 全绿;`dist/adapters/openclaw/index.js` 存在。
- 行为与重构前一致(P1 才开始加中间件进程)。

## 接下来(不在本计划内)

P1(立中间件进程 + 下行 WS/HTTP 接口 + SQLite 两表)在 P0 落地后另写计划——其确切模块边界与签名依赖 P0 实际产出的 `core/` 形态。
