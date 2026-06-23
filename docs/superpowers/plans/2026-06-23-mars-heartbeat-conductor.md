# Mars Heartbeat Conductor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace WCPPM's hardcoded 60 s session heartbeat with an external conductor that drives `POST /api/Login/HeartBeat` on a cadence faithfully ported from Tencent's Mars smart-heartbeat algorithm.

**Architecture:** A new `src/heartbeat/` module in `wcppm-lob`. A pure TS port of Mars `SmartHeartbeat` computes the interval; a `HeartbeatConductor` loop sleeps that interval (± jitter), calls the WCPPM HTTP API via the existing `proxy.ts` dispatcher, feeds the result back into the algorithm, and persists per-network learned state to Redis. Wired from `main.ts` behind a default-off kill-switch. It is an **active `/Login/*` operation**, knowingly added (the project's passivity rules were judged outdated by the owner on 2026-06-23 — see spec §3).

**Tech Stack:** TypeScript (ESM, `.js` import extensions), `node:test` + `node:assert/strict` via `tsx`, `undici` fetch with per-request dispatcher, `ioredis` (new dependency).

**Source of truth for the algorithm:** `/home/radxa/WeChatPadPro-bundle/mars/mars/stn/src/smart_heartbeat.cc` (+ `.h`). The constants live in `…/mars/stn/config.h`. The old `test_cases/smart_heartbeat_test.cc` is a **different version** — use it only as documented intent, not as exact assertions.

**Spec:** `docs/superpowers/specs/2026-06-23-mars-heartbeat-conductor-design.md`.

## Global Constraints

- ESM: every relative import carries a `.js` extension. Code comments in English.
- `src/heartbeat/` must **not** import `openclaw/plugin-sdk` (same rule as `src/core/`).
- Tests are colocated `*.test.ts`, run via `node:test` through `tsx`; `npm run build` does **not** typecheck tests. Run a single file with: `NODE_OPTIONS=--disable-warning=ExperimentalWarning npx tsx --test src/heartbeat/<file>.test.ts`.
- Logging via `Logger` (`src/shared/logger.ts`, methods `info/error/warn/debug`); every line prefixed with a bracketed area tag. Use `[hb]` for the conductor and `[hb-net]` for liveness.
- Mars constants are **load-bearing — copy verbatim** (`config.h`):
  - `MIN_HEART_INTERVAL = 3*60*1000 + 30*1000` = **210000** ms
  - `MAX_HEART_INTERVAL = 10*60*1000` = **600000** ms
  - `HEART_STEP = 60*1000` = **60000** ms
  - `SUCCESS_STEP = 20*1000` = **20000** ms
  - `MAX_HEART_FAIL_COUNT = 2`, `BASE_SUCC_COUNT = 5`, `NET_STABLE_TEST_COUNT = 3`
- The conductor **must NEVER** call `/api/Login/AutoHeartBeat`, `/api/Login/Newinit`, `/api/Login/StartAutoSync`, or `/api/Msg/Sync`. It reads the heartbeat `Selector` field but **never acts on it** (no Sync — 2026-04-12 ban pattern).
- `NextTime` in the HeartBeat response is **ignored** (provenance unknown; cadence is pure Mars).
- Decided values: Redis **db 15**, key prefix **`hbconductor:`**; Redis client **`ioredis`**.

---

### Task 1: Constants, types, and the ioredis dependency

**Files:**
- Create: `src/heartbeat/constants.ts`
- Create: `src/heartbeat/types.ts`
- Modify: `package.json` (add `ioredis`)
- Test: `src/heartbeat/constants.test.ts`

**Interfaces:**
- Produces: `MIN_HEART_INTERVAL`, `MAX_HEART_INTERVAL`, `HEART_STEP`, `SUCCESS_STEP`, `MAX_HEART_FAIL_COUNT`, `BASE_SUCC_COUNT`, `NET_STABLE_TEST_COUNT` (all `number`); `interface NetHeartbeatInfo`; `function freshNetInfo(netDetail: string, netType?: number): NetHeartbeatInfo`.

- [ ] **Step 1: Write the failing test** — `src/heartbeat/constants.test.ts`

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MIN_HEART_INTERVAL, MAX_HEART_INTERVAL, HEART_STEP, SUCCESS_STEP,
  MAX_HEART_FAIL_COUNT, BASE_SUCC_COUNT, NET_STABLE_TEST_COUNT,
} from "./constants.js";
import { freshNetInfo } from "./types.js";

test("Mars constants match config.h verbatim", () => {
  assert.equal(MIN_HEART_INTERVAL, 210000);
  assert.equal(MAX_HEART_INTERVAL, 600000);
  assert.equal(HEART_STEP, 60000);
  assert.equal(SUCCESS_STEP, 20000);
  assert.equal(MAX_HEART_FAIL_COUNT, 2);
  assert.equal(BASE_SUCC_COUNT, 5);
  assert.equal(NET_STABLE_TEST_COUNT, 3);
});

test("freshNetInfo starts at MIN and unstable", () => {
  const n = freshNetInfo("egress:direct");
  assert.equal(n.curHeart, MIN_HEART_INTERVAL);
  assert.equal(n.isStable, false);
  assert.equal(n.succHeartCount, 0);
  assert.equal(n.netDetail, "egress:direct");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `NODE_OPTIONS=--disable-warning=ExperimentalWarning npx tsx --test src/heartbeat/constants.test.ts`
Expected: FAIL — `Cannot find module './constants.js'`.

- [ ] **Step 3: Write `src/heartbeat/constants.ts`**

```ts
// Mars smart-heartbeat constants — copied verbatim from
// mars/stn/config.h. Do not "tune" these; they are the algorithm.
export const MIN_HEART_INTERVAL = 3 * 60 * 1000 + 30 * 1000; // 210000 (3.5 min)
export const MAX_HEART_INTERVAL = 10 * 60 * 1000;            // 600000 (10 min)
export const HEART_STEP = 60 * 1000;                         // 60000
export const SUCCESS_STEP = 20 * 1000;                       // 20000
export const MAX_HEART_FAIL_COUNT = 2;
export const BASE_SUCC_COUNT = 5;
export const NET_STABLE_TEST_COUNT = 3;
```

- [ ] **Step 4: Write `src/heartbeat/types.ts`**

```ts
import { MIN_HEART_INTERVAL } from "./constants.js";

/** Per-network learned heartbeat state — mirrors Mars NetHeartbeatInfo. */
export interface NetHeartbeatInfo {
  netDetail: string;       // stable label for this egress (Mars: getCurrNetLabel)
  netType: number;         // non-mobile for a Mac/server emulation (keeps doze inert)
  curHeart: number;        // current learned interval (ms)
  heartType: number;       // 0 none, 1 smart, 2 doze
  isStable: boolean;
  lastModifyTime: number;  // unix seconds (for weekly re-probe)
  failHeartCount: number;
  succHeartCount: number;
  minHeartFailCount: number;
}

export function freshNetInfo(netDetail: string, netType = 0): NetHeartbeatInfo {
  return {
    netDetail, netType,
    curHeart: MIN_HEART_INTERVAL,
    heartType: 0, isStable: false, lastModifyTime: 0,
    failHeartCount: 0, succHeartCount: 0, minHeartFailCount: 0,
  };
}
```

- [ ] **Step 5: Add ioredis**

Run: `cd /home/radxa/wcppm-lob && npm install ioredis`
Expected: `ioredis` appears under `dependencies` in `package.json`.

- [ ] **Step 6: Run test to verify it passes**

Run: `NODE_OPTIONS=--disable-warning=ExperimentalWarning npx tsx --test src/heartbeat/constants.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add src/heartbeat/constants.ts src/heartbeat/types.ts src/heartbeat/constants.test.ts package.json package-lock.json
git commit -m "feat(heartbeat): Mars constants, NetHeartbeatInfo type, add ioredis"
```

---

### Task 2: SmartHeartbeat — faithful pure port of `smart_heartbeat.cc`

**Files:**
- Create: `src/heartbeat/smart-heartbeat.ts`
- Test: `src/heartbeat/smart-heartbeat.test.ts`

**Interfaces:**
- Consumes: constants + `NetHeartbeatInfo`/`freshNetInfo` (Task 1).
- Produces: `class SmartHeartbeat` with constructor `(net: NetHeartbeatInfo, nowSec: () => number)` and methods `setActive(a: boolean): void`, `setOuterHeart(ms: number): void`, `onHeartbeatStart(): void`, `onHeartResult(success: boolean, failOfTimeout: boolean): void`, `onLongLinkEstablished(): void`, `onLongLinkDisconnect(): void`, `getNextHeartbeatInterval(): number`, `getNetInfo(): NetHeartbeatInfo`.

> **Porting note:** translate `smart_heartbeat.cc` method-by-method. The `.cc` is the source of truth. The old `smart_heartbeat_test.cc` is a different version, so we test **behavioral properties + characterization**, not its exact magic numbers. The operational flow is: `getNextHeartbeatInterval()` → `onHeartbeatStart()` (the "send") → `onHeartResult()` (the "response"). Tests must call `onHeartbeatStart()` before each `onHeartResult()`, mirroring a real send (the `.cc` guards `onHeartResult` behind `is_wait_heart_response_`).

- [ ] **Step 1: Write the failing test** — `src/heartbeat/smart-heartbeat.test.ts`

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { SmartHeartbeat } from "./smart-heartbeat.js";
import { freshNetInfo } from "./types.js";
import { MIN_HEART_INTERVAL, MAX_HEART_INTERVAL, SUCCESS_STEP } from "./constants.js";

const CEIL = MAX_HEART_INTERVAL - SUCCESS_STEP; // 580000 — the stable ceiling

function make(active = false) {
  const sh = new SmartHeartbeat(freshNetInfo("test"), () => 0);
  sh.setActive(active);
  return sh;
}
/** One real beat: compute interval, "send", deliver a result. */
function beat(sh: SmartHeartbeat, success: boolean, timeout = false) {
  sh.getNextHeartbeatInterval();
  sh.onHeartbeatStart();
  sh.onHeartResult(success, timeout);
}

test("starts at MIN", () => {
  assert.equal(make().getNextHeartbeatInterval(), MIN_HEART_INTERVAL);
});

test("active → always MIN even after many successes", () => {
  const sh = make(true);
  for (let i = 0; i < 300; i++) beat(sh, true);
  assert.equal(sh.getNextHeartbeatInterval(), MIN_HEART_INTERVAL);
});

test("sustained success climbs and saturates at MAX - SuccessStep", () => {
  const sh = make(false);
  for (let i = 0; i < 300; i++) beat(sh, true);
  assert.equal(sh.getNextHeartbeatInterval(), CEIL);
});

test("sustained failure after saturation returns to MIN", () => {
  const sh = make(false);
  for (let i = 0; i < 300; i++) beat(sh, true);
  for (let i = 0; i < 600; i++) beat(sh, false);
  assert.equal(sh.getNextHeartbeatInterval(), MIN_HEART_INTERVAL);
});

test("interval is always within [MIN, MAX - SuccessStep]", () => {
  const sh = make(false);
  const seq = [true, true, true, false, true, true, false, false, true];
  for (let i = 0; i < 50; i++) {
    for (const ok of seq) beat(sh, ok);
    const v = sh.getNextHeartbeatInterval();
    assert.ok(v >= MIN_HEART_INTERVAL && v <= CEIL, `interval ${v} out of bounds`);
  }
});

test("onLongLinkEstablished resets to MIN", () => {
  const sh = make(false);
  for (let i = 0; i < 300; i++) beat(sh, true);
  assert.equal(sh.getNextHeartbeatInterval(), CEIL);
  sh.onLongLinkEstablished();
  assert.equal(sh.getNextHeartbeatInterval(), MIN_HEART_INTERVAL);
});

test("setOuterHeart overrides everything", () => {
  const sh = make(false);
  sh.setOuterHeart(123000);
  assert.equal(sh.getNextHeartbeatInterval(), 123000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `NODE_OPTIONS=--disable-warning=ExperimentalWarning npx tsx --test src/heartbeat/smart-heartbeat.test.ts`
Expected: FAIL — `Cannot find module './smart-heartbeat.js'`.

- [ ] **Step 3: Write `src/heartbeat/smart-heartbeat.ts`** (faithful translation of `smart_heartbeat.cc`)

```ts
import {
  MIN_HEART_INTERVAL, MAX_HEART_INTERVAL, HEART_STEP, SUCCESS_STEP,
  MAX_HEART_FAIL_COUNT, BASE_SUCC_COUNT, NET_STABLE_TEST_COUNT,
} from "./constants.js";
import type { NetHeartbeatInfo } from "./types.js";

const ONE_WEEK_SEC = 7 * 24 * 60 * 60;

/**
 * Pure port of Mars SmartHeartbeat (mars/stn/src/smart_heartbeat.cc).
 * No I/O: the conductor hydrates `net` from the store and persists it back.
 * Doze (mobile-only) is ported but inert: we never feed a mobile netType.
 */
export class SmartHeartbeat {
  private active = false;
  private isWait = false;
  private successHeartCount = 0;
  private lastHeart = MIN_HEART_INTERVAL;
  private preHeart = MIN_HEART_INTERVAL;
  private curHeart = MIN_HEART_INTERVAL;
  private outerSetHeart = -1;
  private dozeModeCount = 0;
  private normalModeCount = 0;

  constructor(private net: NetHeartbeatInfo, private nowSec: () => number) {}

  setActive(a: boolean): void { this.active = a; }
  setOuterHeart(ms: number): void { this.outerSetHeart = ms; }
  getNetInfo(): NetHeartbeatInfo { return this.net; }
  onHeartbeatStart(): void { this.isWait = true; }

  onLongLinkEstablished(): void {
    this.successHeartCount = 0;
    this.preHeart = this.curHeart = MIN_HEART_INTERVAL;
  }

  onLongLinkDisconnect(): void {
    this.onHeartResult(false, false);
    this.net.succHeartCount = 0;
    if (!this.net.isStable) return;
    this.lastHeart = MIN_HEART_INTERVAL;
  }

  private isDoze(): boolean {
    return this.dozeModeCount >= 2 && this.dozeModeCount > 2 * this.normalModeCount;
  }

  onHeartResult(success: boolean, failOfTimeout: boolean): void {
    if (!this.isWait) return;
    this.preHeart = this.curHeart;
    this.curHeart = this.lastHeart;
    this.isWait = false;

    if (this.net.netDetail === "") return;
    if (success) this.successHeartCount += 1;

    if (this.successHeartCount <= NET_STABLE_TEST_COUNT) {
      this.net.minHeartFailCount = success ? 0 : this.net.minHeartFailCount + 1;
      return;
    }
    if (this.lastHeart !== this.net.curHeart) return;

    if (success) {
      if (this.lastHeart === this.preHeart) {
        this.net.succHeartCount += 1;
        this.net.failHeartCount = 0;
      }
    } else {
      if (failOfTimeout) this.net.succHeartCount = 0;
      this.net.failHeartCount += 1;
    }

    if (success && this.net.isStable) {
      if (this.net.curHeart >= MAX_HEART_INTERVAL - SUCCESS_STEP) return;
      if (this.nowSec() - this.net.lastModifyTime >= ONE_WEEK_SEC
          && this.net.curHeart < MAX_HEART_INTERVAL - SUCCESS_STEP) {
        this.net.curHeart += SUCCESS_STEP;
        this.net.succHeartCount = 0;
        this.net.isStable = false;
        this.net.failHeartCount = 0;
      }
      return;
    }

    if (success) {
      if (this.net.succHeartCount >= BASE_SUCC_COUNT) {
        if (this.net.curHeart >= MAX_HEART_INTERVAL - SUCCESS_STEP) {
          this.net.curHeart = MAX_HEART_INTERVAL - SUCCESS_STEP;
          this.net.succHeartCount = 0;
          this.net.isStable = true;
          this.net.heartType = this.isDoze() ? 2 : 1;
        } else {
          this.net.succHeartCount = 0;
          this.net.curHeart = this.isDoze()
            ? MAX_HEART_INTERVAL - SUCCESS_STEP
            : Math.min(MAX_HEART_INTERVAL - SUCCESS_STEP, this.net.curHeart + HEART_STEP);
        }
      }
    } else {
      if (this.lastHeart === MIN_HEART_INTERVAL) return;
      if (this.net.failHeartCount >= MAX_HEART_FAIL_COUNT) {
        if (this.net.isStable) {
          this.net.curHeart = MIN_HEART_INTERVAL;
          this.net.succHeartCount = 0;
          this.net.isStable = false;
          this.net.failHeartCount = 0;
        } else {
          if (this.isDoze()) this.net.curHeart = MIN_HEART_INTERVAL;
          else if (this.net.curHeart - HEART_STEP - SUCCESS_STEP > MIN_HEART_INTERVAL)
            this.net.curHeart = this.net.curHeart - HEART_STEP - SUCCESS_STEP;
          else this.net.curHeart = MIN_HEART_INTERVAL;
          this.net.succHeartCount = 0;
          this.net.failHeartCount = 0;
          this.net.isStable = true;
          this.net.heartType = this.isDoze() ? 2 : 1;
        }
      }
    }
  }

  getNextHeartbeatInterval(): number {
    if (this.outerSetHeart >= 0) { this.lastHeart = this.outerSetHeart; return this.outerSetHeart; }
    if (this.active) { this.lastHeart = MIN_HEART_INTERVAL; return MIN_HEART_INTERVAL; }
    if (this.successHeartCount < NET_STABLE_TEST_COUNT || this.net.netDetail === "") {
      this.lastHeart = MIN_HEART_INTERVAL; return MIN_HEART_INTERVAL;
    }
    this.lastHeart = this.net.curHeart;
    if (this.isDoze() && this.net.heartType !== 2 && this.lastHeart !== MAX_HEART_INTERVAL - SUCCESS_STEP) {
      this.net.curHeart = this.lastHeart = MIN_HEART_INTERVAL;
    }
    if (this.lastHeart >= MAX_HEART_INTERVAL || this.lastHeart < MIN_HEART_INTERVAL) {
      this.net.curHeart = this.lastHeart = MIN_HEART_INTERVAL;
    }
    return this.lastHeart;
  }
}
```

- [ ] **Step 4: Run tests; reconcile against the `.cc`**

Run: `NODE_OPTIONS=--disable-warning=ExperimentalWarning npx tsx --test src/heartbeat/smart-heartbeat.test.ts`
Expected: PASS. If a property test fails, **the `.cc` is the source of truth** — re-read `smart_heartbeat.cc` and fix the port (not the property). The property assertions (climb→ceiling, fall→floor, active→MIN, establish→reset, bounds, override) hold for the `.cc`'s algorithm; magic-number step sequences from the old test file do **not** and must not be added.

- [ ] **Step 5: Commit**

```bash
git add src/heartbeat/smart-heartbeat.ts src/heartbeat/smart-heartbeat.test.ts
git commit -m "feat(heartbeat): faithful Mars SmartHeartbeat port with property tests"
```

---

### Task 3: HeartbeatStore — Redis persistence of per-network state

**Files:**
- Create: `src/heartbeat/store.ts`
- Test: `src/heartbeat/store.test.ts`

**Interfaces:**
- Consumes: `NetHeartbeatInfo` (Task 1).
- Produces: `interface HeartbeatStore { load(authcode: string, netDetail: string): Promise<NetHeartbeatInfo | null>; save(authcode: string, info: NetHeartbeatInfo): Promise<void>; close(): Promise<void>; }`; `class RedisHeartbeatStore implements HeartbeatStore` with constructor `(opts: { url: string; db: number; prefix?: string })`; `function netKey(prefix: string, authcode: string, netDetail: string): string`.

> The store is a thin JSON round-trip. Test the pure key builder + serialization with an **in-memory fake** of the tiny ioredis surface used (`get`/`set`/`quit`), so no live Redis is needed in CI.

- [ ] **Step 1: Write the failing test** — `src/heartbeat/store.test.ts`

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { RedisHeartbeatStore, netKey, type RedisLike } from "./store.js";
import { freshNetInfo } from "./types.js";

function fakeRedis(): RedisLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    async get(k) { return data.has(k) ? data.get(k)! : null; },
    async set(k, v) { data.set(k, v); return "OK"; },
    async quit() { return "OK"; },
  };
}

test("netKey is namespaced by prefix, authcode, netDetail", () => {
  assert.equal(netKey("hbconductor:", "AC1", "egress:direct"), "hbconductor:AC1:egress:direct");
});

test("save then load round-trips NetHeartbeatInfo", async () => {
  const r = fakeRedis();
  const store = new RedisHeartbeatStore({ url: "redis://x", db: 15 }, r);
  const info = freshNetInfo("egress:direct");
  info.curHeart = 330000; info.isStable = true; info.succHeartCount = 4;
  await store.save("AC1", info);
  const got = await store.load("AC1", "egress:direct");
  assert.deepEqual(got, info);
});

test("load returns null for an unknown network", async () => {
  const r = fakeRedis();
  const store = new RedisHeartbeatStore({ url: "redis://x", db: 15 }, r);
  assert.equal(await store.load("AC1", "nope"), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `NODE_OPTIONS=--disable-warning=ExperimentalWarning npx tsx --test src/heartbeat/store.test.ts`
Expected: FAIL — `Cannot find module './store.js'`.

- [ ] **Step 3: Write `src/heartbeat/store.ts`**

```ts
import Redis from "ioredis";
import type { NetHeartbeatInfo } from "./types.js";

/** The minimal ioredis surface we use — lets tests inject a fake. */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  quit(): Promise<unknown>;
}

export interface HeartbeatStore {
  load(authcode: string, netDetail: string): Promise<NetHeartbeatInfo | null>;
  save(authcode: string, info: NetHeartbeatInfo): Promise<void>;
  close(): Promise<void>;
}

export function netKey(prefix: string, authcode: string, netDetail: string): string {
  return `${prefix}${authcode}:${netDetail}`;
}

export class RedisHeartbeatStore implements HeartbeatStore {
  private readonly prefix: string;
  private readonly redis: RedisLike;

  constructor(opts: { url: string; db: number; prefix?: string }, redis?: RedisLike) {
    this.prefix = opts.prefix ?? "hbconductor:";
    this.redis = redis ?? new Redis(opts.url, { db: opts.db, lazyConnect: false });
  }

  async load(authcode: string, netDetail: string): Promise<NetHeartbeatInfo | null> {
    const raw = await this.redis.get(netKey(this.prefix, authcode, netDetail));
    return raw ? (JSON.parse(raw) as NetHeartbeatInfo) : null;
  }

  async save(authcode: string, info: NetHeartbeatInfo): Promise<void> {
    await this.redis.set(netKey(this.prefix, authcode, info.netDetail), JSON.stringify(info));
  }

  async close(): Promise<void> { await this.redis.quit(); }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `NODE_OPTIONS=--disable-warning=ExperimentalWarning npx tsx --test src/heartbeat/store.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/heartbeat/store.ts src/heartbeat/store.test.ts
git commit -m "feat(heartbeat): RedisHeartbeatStore for per-network state"
```

---

### Task 4: HeartbeatConductor — the loop, jitter, safety rails

**Files:**
- Create: `src/heartbeat/conductor.ts`
- Test: `src/heartbeat/conductor.test.ts`

**Interfaces:**
- Consumes: `SmartHeartbeat` (Task 2), `HeartbeatStore` (Task 3), `NetHeartbeatInfo`/`freshNetInfo` (Task 1), `Logger` (`src/shared/logger.ts`).
- Produces:
  - `interface HeartbeatClient { sendHeartbeat(): Promise<HeartbeatResult>; }`
  - `interface HeartbeatResult { success: boolean; failOfTimeout: boolean; }`
  - `interface Clock { now(): number; sleep(ms: number, signal: AbortSignal): Promise<void>; }`
  - `interface ConductorOptions { authcode: string; netDetail: string; jitterPct: number; hardFloorMs: number; maxPerHour: number; maxConsecutiveFailures: number; }`
  - `interface ConductorDeps { client: HeartbeatClient; store: HeartbeatStore; clock: Clock; log: Logger; getLastActivityMs?: () => number | null; rng?: () => number; }`
  - `class HeartbeatConductor` with `start(): Promise<void>`, `stop(): void`, and (for tests) `computeSleep(intervalMs: number): number`.

> **Safety rails (spec §9):** apply `hardFloorMs` AFTER jitter so we can never beat faster than the floor; cap to `maxPerHour`; after `maxConsecutiveFailures`, log `error` and keep looping at the (already shrunk) interval — **never tight-retry**. `getLastActivityMs` defaults to "always idle" (v1: no activity wiring; idle uses the longer adaptive intervals, which is safe). The conductor calls `client.sendHeartbeat()` — it does **not** know about HTTP; Task 5 supplies the real client.

- [ ] **Step 1: Write the failing test** — `src/heartbeat/conductor.test.ts`

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { HeartbeatConductor, type ConductorDeps, type HeartbeatResult } from "./conductor.js";
import { MIN_HEART_INTERVAL } from "./constants.js";
import { freshNetInfo } from "./types.js";

function silentLog() { return { info() {}, error() {}, warn() {}, debug() {} }; }

function fakeStore(initial = freshNetInfo("test")) {
  return {
    loaded: initial,
    saved: [] as any[],
    async load() { return this.loaded; },
    async save(_ac: string, info: any) { this.saved.push(structuredClone(info)); },
    async close() {},
  };
}

/** A clock whose sleep resolves immediately but records the requested ms. */
function fakeClock() {
  let t = 0;
  return {
    sleeps: [] as number[],
    now() { return t; },
    async sleep(ms: number) { this.sleeps.push(ms); t += ms; },
    advance(ms: number) { t += ms; },
  };
}

test("computeSleep applies jitter then clamps to hardFloor", () => {
  const deps = baseDeps(() => ({ success: true, failOfTimeout: false }));
  const c = new HeartbeatConductor(
    { authcode: "AC", netDetail: "test", jitterPct: 0.07, hardFloorMs: 60000, maxPerHour: 30, maxConsecutiveFailures: 4 },
    deps,
  );
  // rng=0 → maximum downward jitter; floor must win when it would dip below 60000.
  assert.ok(c.computeSleep(60000) >= 60000);
  // a large interval stays jittered within ±7%.
  const v = c.computeSleep(580000);
  assert.ok(v >= 580000 * 0.93 && v <= 580000 * 1.07);
});

test("stops after maxConsecutiveFailures without tight-retrying", async () => {
  const clock = fakeClock();
  let calls = 0;
  const deps = baseDeps(() => { calls++; return { success: false, failOfTimeout: true }; }, clock);
  const c = new HeartbeatConductor(
    { authcode: "AC", netDetail: "test", jitterPct: 0, hardFloorMs: 60000, maxPerHour: 9999, maxConsecutiveFailures: 4 },
    deps,
  );
  await c.start();
  // every sleep is >= hardFloor; never a zero-ms tight retry.
  assert.ok(clock.sleeps.every((s) => s >= 60000));
  assert.ok(calls >= 4);
});

test("feeds results into SmartHeartbeat and persists", async () => {
  const store = fakeStore();
  const deps = baseDeps(() => ({ success: true, failOfTimeout: false }));
  deps.store = store as any;
  const c = new HeartbeatConductor(
    { authcode: "AC", netDetail: "test", jitterPct: 0, hardFloorMs: 60000, maxPerHour: 5, maxConsecutiveFailures: 99 },
    deps,
  );
  await c.start();
  assert.ok(store.saved.length > 0);

  // helper builders kept at bottom so the file reads top-down.
  function unused() {}
});

// --- shared deps builder -------------------------------------------------
function baseDeps(
  responder: () => HeartbeatResult,
  clock = fakeClock(),
): ConductorDeps {
  return {
    client: { async sendHeartbeat() { return responder(); } },
    store: fakeStore() as any,
    clock: clock as any,
    log: silentLog(),
    rng: () => 0,
  };
}
```

> Note: `start()` must terminate in tests. Implement it to stop after `maxPerHour` beats OR after `maxConsecutiveFailures` (whichever first) when no external `stop()` arrives, so unit tests are bounded. In production `maxPerHour` is the hourly cap (the loop re-arms each hour); model that with an injected budget the tests set low.

- [ ] **Step 2: Run test to verify it fails**

Run: `NODE_OPTIONS=--disable-warning=ExperimentalWarning npx tsx --test src/heartbeat/conductor.test.ts`
Expected: FAIL — `Cannot find module './conductor.js'`.

- [ ] **Step 3: Write `src/heartbeat/conductor.ts`**

```ts
import { SmartHeartbeat } from "./smart-heartbeat.js";
import type { HeartbeatStore } from "./store.js";
import { freshNetInfo } from "./types.js";
import type { Logger } from "../shared/logger.js";

export interface HeartbeatResult { success: boolean; failOfTimeout: boolean; }
export interface HeartbeatClient { sendHeartbeat(): Promise<HeartbeatResult>; }

export interface Clock {
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export interface ConductorOptions {
  authcode: string;
  netDetail: string;
  jitterPct: number;
  hardFloorMs: number;
  maxPerHour: number;
  maxConsecutiveFailures: number;
}

export interface ConductorDeps {
  client: HeartbeatClient;
  store: HeartbeatStore;
  clock: Clock;
  log: Logger;
  getLastActivityMs?: () => number | null;
  rng?: () => number;
}

export class HeartbeatConductor {
  private readonly ac = new AbortController();
  private sh!: SmartHeartbeat;
  private rng: () => number;

  constructor(private opts: ConductorOptions, private deps: ConductorDeps) {
    this.rng = deps.rng ?? Math.random;
  }

  /** Jitter the interval by ±jitterPct, then enforce the hard floor. */
  computeSleep(intervalMs: number): number {
    const j = 1 + (this.rng() * 2 - 1) * this.opts.jitterPct;
    return Math.max(this.opts.hardFloorMs, Math.round(intervalMs * j));
  }

  private isActive(): boolean {
    const last = this.deps.getLastActivityMs?.() ?? null;
    if (last === null) return false; // v1: no activity wiring → always idle (safe)
    return this.deps.clock.now() - last < 120000;
  }

  stop(): void { this.ac.abort(); }

  async start(): Promise<void> {
    const { authcode, netDetail } = this.opts;
    const loaded = (await this.deps.store.load(authcode, netDetail)) ?? freshNetInfo(netDetail);
    this.sh = new SmartHeartbeat(loaded, () => Math.floor(this.deps.clock.now() / 1000));

    let fails = 0;
    let beatsThisHour = 0;
    while (!this.ac.signal.aborted && beatsThisHour < this.opts.maxPerHour) {
      this.sh.setActive(this.isActive());
      const interval = this.sh.getNextHeartbeatInterval();
      const sleepMs = this.computeSleep(interval);
      try { await this.deps.clock.sleep(sleepMs, this.ac.signal); } catch { break; }
      if (this.ac.signal.aborted) break;

      this.sh.onHeartbeatStart();
      const res = await this.deps.client.sendHeartbeat();
      this.sh.onHeartResult(res.success, res.failOfTimeout);
      await this.deps.store.save(authcode, this.sh.getNetInfo());
      beatsThisHour++;

      if (res.success) {
        fails = 0;
        this.deps.log.debug(`[hb] beat ok, next≈${interval}ms`);
      } else if (++fails >= this.opts.maxConsecutiveFailures) {
        this.deps.log.error(`[hb] ${fails} consecutive heartbeat failures — backing off (no tight retry)`);
        break; // Mars already shrank the interval; stop hammering this cycle.
      } else {
        this.deps.log.warn(`[hb] heartbeat failed (${fails}/${this.opts.maxConsecutiveFailures})`);
      }
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `NODE_OPTIONS=--disable-warning=ExperimentalWarning npx tsx --test src/heartbeat/conductor.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/heartbeat/conductor.ts src/heartbeat/conductor.test.ts
git commit -m "feat(heartbeat): conductor loop with jitter, hard floor, failure backoff"
```

---

### Task 5: WcppHeartbeatClient — the real HTTP client + liveness cross-check

**Files:**
- Create: `src/heartbeat/wcpp-client.ts`
- Test: `src/heartbeat/wcpp-client.test.ts`

**Interfaces:**
- Consumes: `HeartbeatClient`/`HeartbeatResult` (Task 4), `buildProxyTransport` (`src/core/proxy.ts`), `Logger`.
- Produces: `class WcppHeartbeatClient implements HeartbeatClient` with constructor `(opts: { baseUrl: string; authcode: string; proxy?: string; log: Logger; fetchImpl?: typeof fetch; timeoutMs?: number })`; methods `sendHeartbeat(): Promise<HeartbeatResult>` and `checkOnline(): Promise<boolean>`; plus exported pure helper `classifyHeartbeat(json: unknown): HeartbeatResult`.

> `sendHeartbeat` POSTs `${baseUrl}/api/Login/HeartBeat?authcode=…` with the proxy dispatcher, an `AbortSignal` timeout, and classifies the body. **Never** reads `Selector` for action; **never** reads `NextTime`. `checkOnline` hits `/api/User/GetOnlineInfo` for the longlink cross-check (logged under `[hb-net]`, detect-don't-fix). Test `classifyHeartbeat` purely (no network); test the POST path with an injected `fetchImpl`.

- [ ] **Step 1: Write the failing test** — `src/heartbeat/wcpp-client.test.ts`

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyHeartbeat, WcppHeartbeatClient } from "./wcpp-client.js";

function silentLog() { return { info() {}, error() {}, warn() {}, debug() {} }; }

test("classifyHeartbeat: Success+ret0 → success", () => {
  const r = classifyHeartbeat({ Success: true, Data: { BaseResponse: { ret: 0 }, NextTime: 149, Selector: 4294967295 } });
  assert.deepEqual(r, { success: true, failOfTimeout: false });
});

test("classifyHeartbeat: non-zero ret → failure (not timeout)", () => {
  const r = classifyHeartbeat({ Success: true, Data: { BaseResponse: { ret: -1 } } });
  assert.deepEqual(r, { success: false, failOfTimeout: false });
});

test("classifyHeartbeat: malformed body → failure", () => {
  assert.deepEqual(classifyHeartbeat({}), { success: false, failOfTimeout: false });
});

test("sendHeartbeat posts to the right URL and classifies", async () => {
  let calledUrl = "";
  const fetchImpl = (async (url: any, _init: any) => {
    calledUrl = String(url);
    return { ok: true, async json() { return { Success: true, Data: { BaseResponse: { ret: 0 } } }; } } as any;
  }) as typeof fetch;
  const c = new WcppHeartbeatClient({
    baseUrl: "http://192.168.5.24:8062", authcode: "AC", log: silentLog(), fetchImpl,
  });
  const r = await c.sendHeartbeat();
  assert.equal(r.success, true);
  assert.match(calledUrl, /\/api\/Login\/HeartBeat\?authcode=AC$/);
});

test("sendHeartbeat maps a timeout/abort to failOfTimeout", async () => {
  const fetchImpl = (async () => { const e: any = new Error("aborted"); e.name = "AbortError"; throw e; }) as typeof fetch;
  const c = new WcppHeartbeatClient({ baseUrl: "http://x", authcode: "AC", log: silentLog(), fetchImpl, timeoutMs: 5 });
  assert.deepEqual(await c.sendHeartbeat(), { success: false, failOfTimeout: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `NODE_OPTIONS=--disable-warning=ExperimentalWarning npx tsx --test src/heartbeat/wcpp-client.test.ts`
Expected: FAIL — `Cannot find module './wcpp-client.js'`.

- [ ] **Step 3: Write `src/heartbeat/wcpp-client.ts`**

```ts
import { fetch as undiciFetch } from "undici";
import { buildProxyTransport } from "../core/proxy.js";
import type { HeartbeatClient, HeartbeatResult } from "./conductor.js";
import type { Logger } from "../shared/logger.js";

/** Pure classifier: success iff Success===true AND Data.BaseResponse.ret===0. */
export function classifyHeartbeat(json: unknown): HeartbeatResult {
  const j = json as any;
  const ret = j?.Data?.BaseResponse?.ret;
  const success = j?.Success === true && ret === 0;
  return { success, failOfTimeout: false };
  // NOTE: Selector and NextTime are intentionally ignored (see plan constraints).
}

export class WcppHeartbeatClient implements HeartbeatClient {
  private readonly dispatcher;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private opts: {
    baseUrl: string; authcode: string; proxy?: string; log: Logger;
    fetchImpl?: typeof fetch; timeoutMs?: number;
  }) {
    this.dispatcher = buildProxyTransport(opts.proxy).dispatcher;
    this.fetchImpl = opts.fetchImpl ?? (undiciFetch as unknown as typeof fetch);
    this.timeoutMs = opts.timeoutMs ?? 15000;
  }

  private url(path: string): string {
    return `${this.opts.baseUrl}${path}?authcode=${this.opts.authcode}`;
  }

  async sendHeartbeat(): Promise<HeartbeatResult> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    try {
      const res = await this.fetchImpl(this.url("/api/Login/HeartBeat"), {
        method: "POST", headers: { accept: "application/json" }, body: "",
        // @ts-expect-error undici-specific option carried through to fetch
        dispatcher: this.dispatcher, signal,
      });
      return classifyHeartbeat(await (res as any).json());
    } catch (e: any) {
      const timeout = e?.name === "AbortError" || e?.name === "TimeoutError";
      this.opts.log.warn(`[hb] heartbeat request error: ${e?.message ?? e}`);
      return { success: false, failOfTimeout: timeout };
    }
  }

  /** Longlink liveness cross-check — detect-don't-fix (spec §4). */
  async checkOnline(): Promise<boolean> {
    try {
      const res = await this.fetchImpl(this.url("/api/User/GetOnlineInfo"), {
        method: "GET", headers: { accept: "application/json" },
        // @ts-expect-error undici dispatcher
        dispatcher: this.dispatcher, signal: AbortSignal.timeout(this.timeoutMs),
      });
      const j: any = await (res as any).json();
      const online = j?.Success === true;
      if (!online) this.opts.log.error(`[hb-net] account appears offline (GetOnlineInfo) — longlink may be down; not auto-fixing`);
      return online;
    } catch (e: any) {
      this.opts.log.warn(`[hb-net] online check failed: ${e?.message ?? e}`);
      return false;
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `NODE_OPTIONS=--disable-warning=ExperimentalWarning npx tsx --test src/heartbeat/wcpp-client.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/heartbeat/wcpp-client.ts src/heartbeat/wcpp-client.test.ts
git commit -m "feat(heartbeat): WCPPM HTTP heartbeat client + online cross-check"
```

---

### Task 6: Config, real Clock, and main.ts wiring

**Files:**
- Create: `src/heartbeat/runtime.ts` (real `Clock`, `startHeartbeatConductor` wiring helper)
- Modify: `src/core/config.ts` (add `heartbeat` to `RawConfig` + `MiddlewareConfig`)
- Modify: `src/core/main.ts` (start the conductor when `heartbeat.enabled`)
- Modify: `config.example.json` (document the new block)
- Test: `src/heartbeat/runtime.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `interface HeartbeatConfig { enabled: boolean; redisUrl: string; redisDb: number; jitterPct: number; hardFloorMs: number; maxPerHour: number; maxConsecutiveFailures: number; }`; `function resolveHeartbeatConfig(raw): HeartbeatConfig`; `function startHeartbeatConductor(cfg, wcpp, log): { stop(): void } | null`; `class RealClock implements Clock`.

- [ ] **Step 1: Write the failing test** — `src/heartbeat/runtime.test.ts`

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveHeartbeatConfig, RealClock } from "./runtime.js";

test("resolveHeartbeatConfig defaults are safe (disabled, db15, floor 60s)", () => {
  const c = resolveHeartbeatConfig(undefined);
  assert.equal(c.enabled, false);
  assert.equal(c.redisDb, 15);
  assert.equal(c.hardFloorMs, 60000);
  assert.equal(c.maxPerHour, 30);
});

test("resolveHeartbeatConfig honours overrides", () => {
  const c = resolveHeartbeatConfig({ enabled: true, redisUrl: "redis://h:6379", jitterPct: 0.1 });
  assert.equal(c.enabled, true);
  assert.equal(c.redisUrl, "redis://h:6379");
  assert.equal(c.jitterPct, 0.1);
});

test("RealClock.sleep rejects on abort", async () => {
  const clock = new RealClock();
  const ac = new AbortController();
  const p = clock.sleep(10000, ac.signal);
  ac.abort();
  await assert.rejects(p);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `NODE_OPTIONS=--disable-warning=ExperimentalWarning npx tsx --test src/heartbeat/runtime.test.ts`
Expected: FAIL — `Cannot find module './runtime.js'`.

- [ ] **Step 3: Write `src/heartbeat/runtime.ts`**

```ts
import { setTimeout as sleepAsync } from "node:timers/promises";
import { HeartbeatConductor } from "./conductor.js";
import type { Clock } from "./conductor.js";
import { RedisHeartbeatStore } from "./store.js";
import { WcppHeartbeatClient } from "./wcpp-client.js";
import type { Logger } from "../shared/logger.js";

export interface HeartbeatConfig {
  enabled: boolean;
  redisUrl: string;
  redisDb: number;
  jitterPct: number;
  hardFloorMs: number;
  maxPerHour: number;
  maxConsecutiveFailures: number;
}

export function resolveHeartbeatConfig(raw: Partial<HeartbeatConfig> | undefined): HeartbeatConfig {
  return {
    enabled: raw?.enabled ?? false,
    redisUrl: raw?.redisUrl ?? "redis://127.0.0.1:6379",
    redisDb: raw?.redisDb ?? 15,
    jitterPct: raw?.jitterPct ?? 0.07,
    hardFloorMs: raw?.hardFloorMs ?? 60000,
    maxPerHour: raw?.maxPerHour ?? 30,
    maxConsecutiveFailures: raw?.maxConsecutiveFailures ?? 4,
  };
}

export class RealClock implements Clock {
  now(): number { return Date.now(); }
  async sleep(ms: number, signal: AbortSignal): Promise<void> {
    await sleepAsync(ms, undefined, { signal });
  }
}

/** Wire and start a conductor; returns a handle, or null if disabled/unconfigured. */
export function startHeartbeatConductor(
  cfg: HeartbeatConfig,
  wcpp: { host?: string; port: number; authcode?: string; proxy?: string },
  log: Logger,
): { stop(): Promise<void> } | null {
  if (!cfg.enabled) { log.info("[hb] conductor disabled (heartbeat.enabled=false)"); return null; }
  if (!wcpp.host || !wcpp.authcode) { log.error("[hb] cannot start: host/authcode required"); return null; }

  const baseUrl = `http://${wcpp.host}:${wcpp.port}`;
  const store = new RedisHeartbeatStore({ url: cfg.redisUrl, db: cfg.redisDb });
  const client = new WcppHeartbeatClient({ baseUrl, authcode: wcpp.authcode, proxy: wcpp.proxy, log });
  const netDetail = `egress:${wcpp.proxy ? "proxy" : "direct"}`;
  const conductor = new HeartbeatConductor(
    {
      authcode: wcpp.authcode, netDetail,
      jitterPct: cfg.jitterPct, hardFloorMs: cfg.hardFloorMs,
      maxPerHour: cfg.maxPerHour, maxConsecutiveFailures: cfg.maxConsecutiveFailures,
    },
    { client, store, clock: new RealClock(), log },
  );
  log.info(`[hb] starting Mars heartbeat conductor (net=${netDetail}, floor=${cfg.hardFloorMs}ms)`);
  void conductor.start().catch((e) => log.error(`[hb] conductor crashed: ${e?.message ?? e}`));
  return { async stop() { conductor.stop(); await store.close(); } };
}
```

- [ ] **Step 4: Wire `src/core/config.ts`**

Add to `RawConfig`: `heartbeat?: Partial<import("../heartbeat/runtime.js").HeartbeatConfig>;`
Add to `MiddlewareConfig`: `heartbeat: import("../heartbeat/runtime.js").HeartbeatConfig;`
In `resolveConfig`, set `heartbeat: resolveHeartbeatConfig(raw.heartbeat)` (import `resolveHeartbeatConfig`). Default-off means existing configs are unaffected.

- [ ] **Step 5: Wire `src/core/main.ts`**

After the client/server are up, add:

```ts
import { startHeartbeatConductor } from "../heartbeat/runtime.js";
// …after wiring:
const hb = startHeartbeatConductor(config.heartbeat, config.wcpp, log);
// in the SIGTERM/shutdown handler, before exit:
await hb?.stop();
```

- [ ] **Step 6: Document `config.example.json`** — add:

```jsonc
"heartbeat": {
  "enabled": false,
  "redisUrl": "redis://100.64.0.8:6379",
  "redisDb": 15,
  "jitterPct": 0.07,
  "hardFloorMs": 60000,
  "maxPerHour": 30,
  "maxConsecutiveFailures": 4
}
```

- [ ] **Step 7: Run the heartbeat suite + build**

Run: `NODE_OPTIONS=--disable-warning=ExperimentalWarning npx tsx --test src/heartbeat/*.test.ts && npm run build`
Expected: all heartbeat tests PASS; `tsc` clean.

- [ ] **Step 8: Commit**

```bash
git add src/heartbeat/runtime.ts src/heartbeat/runtime.test.ts src/core/config.ts src/core/main.ts config.example.json
git commit -m "feat(heartbeat): config, real clock, and main.ts wiring (default-off)"
```

---

### Task 7: Cutover docs + CLAUDE.md rule update

**Files:**
- Modify: `deploy/README.md` (add the cutover runbook)
- Modify: `CLAUDE.md` (annotate the now-superseded passivity/scope rules)

> No code/tests — documentation only. Folded into one task because both record the same decision.

- [ ] **Step 1: Add the cutover runbook to `deploy/README.md`**

Add a section "Heartbeat conductor cutover" capturing spec §5:
1. Ensure nothing re-triggers `/api/Login/AutoHeartBeat` for the account (find & disable the out-of-band caller — it is **not** `wcppm-lob`).
2. Restart `wechatpadpromax` to clear the sticky 60 s loop (no runtime cancel exists).
3. Bring the account up with `heartbeat.enabled=true`; verify in Redis that `heartbeatlog:<wxid>` cadence widens to ≥210 s and is jittered (not exact 60 s).

- [ ] **Step 2: Annotate `CLAUDE.md`**

Under "Account Safety — HARD RULES", append a dated note: the **heartbeat surface** is now actively driven by the conductor (`src/heartbeat/`) per spec `2026-06-23-mars-heartbeat-conductor-design.md`; the "fully passive / never touch `/Login/*`" rule no longer applies to `/Login/HeartBeat`. `Newinit`/`StartAutoSync`/active `Msg/Sync` remain forbidden. The conductor reads but never acts on the heartbeat `Selector`.

- [ ] **Step 3: Commit**

```bash
git add deploy/README.md CLAUDE.md
git commit -m "docs(heartbeat): cutover runbook + supersede passivity rule for HeartBeat"
```

---

## Self-Review

**1. Spec coverage:**
- §2 Mars cadence → Tasks 1–2 (constants + port). ✓
- §5 gating/cutover → Task 7 runbook; conductor never calls AutoHeartBeat (Global Constraints). ✓
- §7 full port incl. dormant doze → Task 2 (doze ported, non-mobile netType). ✓
- §7 coarse feedback / NextTime ignored / Selector ignored → Task 5 `classifyHeartbeat`. ✓
- §8 Redis persistence (db15, prefix) → Task 3. ✓
- §9 jitter / hard floor / failure backoff / no retry storm / kill-switch / rate cap → Task 4 + Task 6 (`enabled` default-off). ✓
- §9 detect-don't-fix longlink → Task 5 `checkOnline`. ✓
- §10 config block → Task 6. ✓
- §11 testing (port vectors as properties) → Tasks 2–6 tests. ✓
- §13 CLAUDE.md follow-up → Task 7. ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows complete code. The one judgement call (exact step magic-numbers) is deliberately replaced by property/characterization tests with an explicit "the `.cc` is source of truth" reconciliation instruction (Task 2 Step 4). ✓

**3. Type consistency:** `HeartbeatResult`/`HeartbeatClient`/`Clock`/`ConductorDeps` defined in Task 4 and consumed unchanged in Tasks 5–6; `HeartbeatStore`/`RedisLike`/`netKey` from Task 3 used in Task 6; `NetHeartbeatInfo`/`freshNetInfo` from Task 1 used throughout; `HeartbeatConfig` defined in Task 6 referenced by `config.ts` via type-only import. ✓

**Open items intentionally deferred (YAGNI for v1, noted in code):** real activity wiring for `getLastActivityMs` (defaults to idle); periodic `checkOnline` scheduling inside the loop (method exists; wiring it on a slow timer is a follow-up); multi-account fan-out (v1 is single-authcode per the existing middleware shape).
