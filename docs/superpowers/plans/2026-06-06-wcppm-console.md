# wcppm console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone full-screen terminal console (live dashboard + bottom command line) that attaches to the running WeChat middleware over its bridge, so operators get a live, interactive window instead of staring at stdout.

**Architecture:** A separate client process subscribes to the middleware's `WS /subscribe` (as a read-only, `autoAck:false` observer so it never steals the real adapter's acks), polls `GET /healthz`, and drives `POST /send` / `POST /forceSync` plus two new read-only endpoints `GET /contacts` / `GET /history`. The TUI is zero-dependency: a pure `render(state,size)→string[]` function + pure state reducers + pure command parser (all unit-tested with `node:test`), driven by a thin imperative `terminal.ts` (readline + ANSI, manual smoke only).

**Tech Stack:** TypeScript (ESM, `.js` import extensions), `node:sqlite`, `ws`, `undici`, Node built-in `readline` + ANSI escapes, `node:test` + `tsx` for tests. No new dependencies.

---

## File Structure

**Middleware backend (enables the data the console needs):**
- Modify `src/core/db.ts` — add read-only `searchContacts()` + `recentInbound()`.
- Modify `src/core/db.test.ts` — tests for the two new queries.
- Modify `src/core/server.ts` — add `GET /contacts` + `GET /history` and optional `queryContacts`/`queryHistory` deps.
- Modify `src/core/server.test.ts` — tests for the two endpoints.
- Modify `src/core/main.ts` — wire `queryContacts`/`queryHistory` into `ServerDeps`.

**Shared bridge client (promote + extend):**
- Move `src/adapters/openclaw/bridge-client.ts` → `src/shared/bridge-client.ts` (+ add `getContacts`/`getHistory`/`getHealth`).
- Move `src/adapters/openclaw/bridge-client.test.ts` → `src/shared/bridge-client.test.ts`.
- Modify `src/adapters/openclaw/channel.ts` — update one import path.

**Console (new module `src/console/`):**
- Create `src/console/commands.ts` + `src/console/commands.test.ts` — pure command parser.
- Create `src/console/state.ts` + `src/console/state.test.ts` — pure view-model + reducers.
- Create `src/console/render.ts` + `src/console/render.test.ts` — pure `render(state,size)→string[]`.
- Create `src/console/terminal.ts` — thin ANSI/readline driver (no unit test).
- Create `src/console/main.ts` — entry: wire config → bridge client → state → terminal.
- Modify `package.json` — add `"console"` script.

---

## Task 1: db.ts — read-only `searchContacts` + `recentInbound`

**Files:**
- Modify: `src/core/db.ts`
- Test: `src/core/db.test.ts`

These are pure SQLite reads — zero account risk, no WeChat calls.

- [ ] **Step 1: Write the failing tests**

Append to `src/core/db.test.ts`:

```ts
test("searchContacts: matches wxid or name substring, newest-updated first, respects limit", () => {
  const db = openDb(":memory:");
  db.upsertContact({ account: "default", wxid: "wxid_li", name: "李四", updatedAt: 100 });
  db.upsertContact({ account: "default", wxid: "wxid_zhang", name: "张三", updatedAt: 200 });
  db.upsertContact({ account: "other", wxid: "wxid_li", name: "李四", updatedAt: 300 });

  const byName = db.searchContacts("default", "李", 10);
  assert.deepEqual(byName.map((c) => c.wxid), ["wxid_li"]);

  const byWxid = db.searchContacts("default", "wxid_", 10);
  assert.deepEqual(byWxid.map((c) => c.wxid), ["wxid_zhang", "wxid_li"]); // newest updated_at first

  const limited = db.searchContacts("default", "wxid_", 1);
  assert.equal(limited.length, 1);

  const empty = db.searchContacts("default", "", 10); // empty q → all in account
  assert.equal(empty.length, 2);

  db.close();
});

test("recentInbound: newest-first rows scoped to account, respects limit", () => {
  const db = openDb(":memory:");
  db.recordInbound({ id: "a", account: "default", ts: 100, payload: '{"id":"a"}' });
  db.recordInbound({ id: "b", account: "default", ts: 200, payload: '{"id":"b"}' });
  db.recordInbound({ id: "x", account: "other", ts: 300, payload: '{"id":"x"}' });

  const rows = db.recentInbound("default", 10);
  assert.deepEqual(rows.map((r) => r.id), ["b", "a"]); // newest ts first, "other" excluded

  const limited = db.recentInbound("default", 1);
  assert.deepEqual(limited.map((r) => r.id), ["b"]);

  db.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `NODE_OPTIONS=--disable-warning=ExperimentalWarning npx tsx --test src/core/db.test.ts`
Expected: FAIL — `db.searchContacts is not a function`.

- [ ] **Step 3: Add the two methods to the `Db` interface**

In `src/core/db.ts`, inside `export interface Db { ... }`, add after `getContact(...)`:

```ts
  /** Read-only: contacts matching wxid/name substring `q`, newest-updated first. Empty q → all in account. */
  searchContacts(account: string, q: string, limit: number): ContactRow[];
  /** Read-only: most-recent inbound rows for an account, newest first. */
  recentInbound(account: string, limit: number): InboundRow[];
```

- [ ] **Step 4: Add the prepared statements**

In `openDb`, after the `getContactStmt` prepare, add:

```ts
  const searchContactsStmt = db.prepare(
    "SELECT account, wxid, name, type, extra, updated_at FROM contacts" +
      " WHERE account = ? AND (wxid LIKE ? OR name LIKE ?) ORDER BY updated_at DESC LIMIT ?",
  );
  const recentInboundStmt = db.prepare(
    "SELECT id, account, ts, payload, delivered_at FROM inbound_log" +
      " WHERE account = ? ORDER BY ts DESC LIMIT ?",
  );
```

- [ ] **Step 5: Add the implementations**

In the returned object, after `getContact(...)`, add:

```ts
    searchContacts(account, q, limit) {
      const like = `%${q}%`;
      return searchContactsStmt.all(account, like, like, limit) as unknown as ContactRow[];
    },
    recentInbound(account, limit) {
      return recentInboundStmt.all(account, limit) as unknown as InboundRow[];
    },
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `NODE_OPTIONS=--disable-warning=ExperimentalWarning npx tsx --test src/core/db.test.ts`
Expected: PASS (all db tests).

- [ ] **Step 7: Commit**

```bash
git add src/core/db.ts src/core/db.test.ts
git commit -m "feat(core/db): read-only searchContacts + recentInbound for the console"
```

---

## Task 2: server.ts — `GET /contacts` + `GET /history`

**Files:**
- Modify: `src/core/server.ts`
- Test: `src/core/server.test.ts`

Both endpoints are authenticated (Bearer token) and back onto pure DB reads. They return `[]` when their dep is not wired, so existing tests/builds stay green.

- [ ] **Step 1: Write the failing tests**

Append to `src/core/server.test.ts` (note: `makeDeps`, `FIXED_NOW_MS` already exist in this file; reuse them). Add a tiny HTTP GET helper at the end of the helpers region, then the tests:

```ts
async function httpGet(port: number, path: string, token?: string): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
  return { status: res.status, body: await res.json() };
}

test("GET /contacts: requires auth and returns queryContacts results", async () => {
  const server = createBridgeServer(
    makeDeps({
      queryContacts: (account, q, limit) => {
        assert.equal(account, "default");
        assert.equal(q, "li");
        assert.equal(limit, 50);
        return [{ wxid: "wxid_li", name: "李四", type: "friend", updatedAt: 123 }];
      },
    }),
  );
  const port = await server.listen(0);
  try {
    const unauth = await httpGet(port, "/contacts?q=li");
    assert.equal(unauth.status, 401);

    const ok = await httpGet(port, "/contacts?q=li", "test-token");
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body, [{ wxid: "wxid_li", name: "李四", type: "friend", updatedAt: 123 }]);
  } finally {
    await server.close();
  }
});

test("GET /history: requires auth and returns queryHistory frames", async () => {
  const frame = { type: "message", id: "h1", account: "default", chatType: "direct",
    from: { wxid: "wxid_li" }, chat: { id: "wxid_li" }, text: "hi", mentionedMe: false, ts: 10 };
  const server = createBridgeServer(
    makeDeps({
      queryHistory: (account, chat, limit) => {
        assert.equal(account, "default");
        assert.equal(chat, "wxid_li");
        assert.equal(limit, 5);
        return [frame as unknown as Frame];
      },
    }),
  );
  const port = await server.listen(0);
  try {
    const unauth = await httpGet(port, "/history?chat=wxid_li&limit=5");
    assert.equal(unauth.status, 401);

    const ok = await httpGet(port, "/history?chat=wxid_li&limit=5", "test-token");
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body, [frame]);
  } finally {
    await server.close();
  }
});

test("GET /contacts: returns [] when queryContacts dep is absent", async () => {
  const server = createBridgeServer(makeDeps()); // no queryContacts
  const port = await server.listen(0);
  try {
    const ok = await httpGet(port, "/contacts?q=li", "test-token");
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body, []);
  } finally {
    await server.close();
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `NODE_OPTIONS=--disable-warning=ExperimentalWarning npx tsx --test src/core/server.test.ts`
Expected: FAIL — `/contacts` currently returns 404, so `assert.equal(ok.status, 200)` fails.

- [ ] **Step 3: Extend `ServerDeps`**

In `src/core/server.ts`, inside `export interface ServerDeps { ... }`, add after `selfWxid()`:

```ts
  /** Read-only contact-cache search for the console (GET /contacts). Optional. */
  queryContacts?(account: string, q: string, limit: number): {
    wxid: string;
    name: string;
    type?: string;
    updatedAt: number;
  }[];
  /** Read-only recent-history query for the console (GET /history). Returns frames newest-first. Optional. */
  queryHistory?(account: string, chat: string | undefined, limit: number): Frame[];
```

- [ ] **Step 4: Add the route handlers**

In the HTTP handler, immediately before the `// Fallthrough` / `sendJson(res, 404, ...)` block, insert:

```ts
    // GET /contacts?q=&account=&limit= — read-only contact-cache search
    if (req.method === "GET" && path === "/contacts") {
      if (!isAuthorized(req)) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }
      const account = url.searchParams.get("account") || "default";
      const q = url.searchParams.get("q") || "";
      const limit = Number(url.searchParams.get("limit")) || 50;
      sendJson(res, 200, deps.queryContacts?.(account, q, limit) ?? []);
      return;
    }

    // GET /history?account=&chat=&limit= — read-only recent inbound frames
    if (req.method === "GET" && path === "/history") {
      if (!isAuthorized(req)) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }
      const account = url.searchParams.get("account") || "default";
      const chat = url.searchParams.get("chat") || undefined;
      const limit = Number(url.searchParams.get("limit")) || 50;
      sendJson(res, 200, deps.queryHistory?.(account, chat, limit) ?? []);
      return;
    }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `NODE_OPTIONS=--disable-warning=ExperimentalWarning npx tsx --test src/core/server.test.ts`
Expected: PASS (all server tests).

- [ ] **Step 6: Commit**

```bash
git add src/core/server.ts src/core/server.test.ts
git commit -m "feat(core/server): read-only GET /contacts + GET /history for the console"
```

---

## Task 3: main.ts — wire `queryContacts` / `queryHistory`

**Files:**
- Modify: `src/core/main.ts`

No new unit test (this is wiring DI into the long-running service; covered by build + the server tests). Verify by build + full test run.

- [ ] **Step 1: Wire the two deps into `ServerDeps`**

In `src/core/main.ts`, inside the `const deps: ServerDeps = { ... }` object, add after the `selfWxid: () => client.wxid ?? undefined,` line:

```ts
    queryContacts: (account, q, limit) =>
      db.searchContacts(account, q, limit).map((c) => ({
        wxid: c.wxid,
        name: c.name,
        type: c.type ?? undefined,
        updatedAt: c.updated_at,
      })),
    queryHistory: (account, chat, limit) => {
      // inbound_log has no chat column; over-fetch then filter parsed frames by chat.
      const fetchN = chat ? Math.min(limit * 20, 500) : limit;
      const rows = db.recentInbound(account, fetchN);
      let frames = rows
        .map((r) => {
          try {
            return JSON.parse(r.payload) as Frame;
          } catch {
            return undefined;
          }
        })
        .filter((f): f is Frame => f !== undefined);
      if (chat) frames = frames.filter((f) => f.chat.id === chat || f.chat.name === chat);
      return frames.slice(0, limit);
    },
```

- [ ] **Step 2: Add the `Frame` type import**

At the top of `src/core/main.ts`, add alongside the other `import type` lines:

```ts
import type { Frame } from "../shared/frame.js";
```

- [ ] **Step 3: Build to verify types**

Run: `npm run build`
Expected: succeeds with no type errors.

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: PASS (all existing + new tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/main.ts
git commit -m "feat(core/main): wire queryContacts/queryHistory into the bridge server"
```

---

## Task 4: Promote `bridge-client` to `src/shared/`

**Files:**
- Move: `src/adapters/openclaw/bridge-client.ts` → `src/shared/bridge-client.ts`
- Move: `src/adapters/openclaw/bridge-client.test.ts` → `src/shared/bridge-client.test.ts`
- Modify: `src/adapters/openclaw/channel.ts` (one import line)

Pure refactor — no behavior change. It is now shared by two consumers (adapter + console). Tests must stay green.

- [ ] **Step 1: Move both files with git**

```bash
git mv src/adapters/openclaw/bridge-client.ts src/shared/bridge-client.ts
git mv src/adapters/openclaw/bridge-client.test.ts src/shared/bridge-client.test.ts
```

- [ ] **Step 2: Fix imports in the moved `src/shared/bridge-client.ts`**

Change these three lines (depth dropped by one; siblings now in `shared/`):

```ts
import { buildProxyTransport } from "../core/proxy.js";
import type { Frame } from "./frame.js";
import type { Logger } from "./logger.js";
```

(Was: `"../../core/proxy.js"`, `"../../shared/frame.js"`, `"../../shared/logger.js"`.)

- [ ] **Step 3: Fix imports in the moved `src/shared/bridge-client.test.ts`**

Change:

```ts
import { createBridgeServer, type ServerDeps } from "../core/server.js";
import type { Frame } from "./frame.js";
import { createBridgeClient } from "./bridge-client.js";
```

(Was: `"../../core/server.js"`, `"../../shared/frame.js"`; the `./bridge-client.js` line is unchanged.)

- [ ] **Step 4: Fix the import in `channel.ts`**

In `src/adapters/openclaw/channel.ts`, change line 25 from:

```ts
import { createBridgeClient, type BridgeClient } from "./bridge-client.js";
```

to:

```ts
import { createBridgeClient, type BridgeClient } from "../../shared/bridge-client.js";
```

- [ ] **Step 5: Build + run the moved test**

Run: `npm run build && NODE_OPTIONS=--disable-warning=ExperimentalWarning npx tsx --test src/shared/bridge-client.test.ts`
Expected: build succeeds; all bridge-client tests PASS.

- [ ] **Step 6: Commit**

```bash
git add -A src/shared/bridge-client.ts src/shared/bridge-client.test.ts src/adapters/openclaw/channel.ts
git commit -m "refactor: promote bridge-client to src/shared (now shared by adapter + console)"
```

---

## Task 5: bridge-client — `getContacts` / `getHistory` / `getHealth`

**Files:**
- Modify: `src/shared/bridge-client.ts`
- Test: `src/shared/bridge-client.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/shared/bridge-client.test.ts`:

```ts
test("getContacts/getHistory/getHealth hit the read-only endpoints", async () => {
  const frame = { type: "message", id: "h1", account: "default", chatType: "direct",
    from: { wxid: "wxid_li" }, chat: { id: "wxid_li" }, text: "hi", mentionedMe: false, ts: 10 };
  const server = createBridgeServer({
    token: "tkn",
    db: { getUndelivered: () => [], markDelivered: () => {} },
    send: async () => ({ ok: true }),
    forceSync: async () => ({ ok: true }),
    status: () => ({ wsUp: true, selfWxid: "wxid_self", lastMsgTs: 42 }),
    selfWxid: () => "wxid_self",
    queryContacts: () => [{ wxid: "wxid_li", name: "李四", type: "friend", updatedAt: 1 }],
    queryHistory: () => [frame as unknown as Frame],
  });
  const port = await server.listen(0);
  const client = createBridgeClient({ url: `ws://127.0.0.1:${port}`, token: "tkn", onMessage: () => {} });
  try {
    assert.deepEqual(await client.getContacts("li"), [
      { wxid: "wxid_li", name: "李四", type: "friend", updatedAt: 1 },
    ]);
    assert.deepEqual(await client.getHistory({ chat: "wxid_li", limit: 5 }), [frame]);
    const health = await client.getHealth();
    assert.equal(health.wsUp, true);
    assert.equal(health.selfWxid, "wxid_self");
  } finally {
    client.close();
    await server.close();
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `NODE_OPTIONS=--disable-warning=ExperimentalWarning npx tsx --test src/shared/bridge-client.test.ts`
Expected: FAIL — `client.getContacts is not a function`.

- [ ] **Step 3: Extend the `BridgeClient` interface**

In `src/shared/bridge-client.ts`, inside `export interface BridgeClient { ... }`, add after `forceSync(...)`:

```ts
  getContacts(q: string): Promise<Array<{ wxid: string; name: string; type?: string; updatedAt: number }>>;
  getHistory(opts: { chat?: string; limit?: number; account?: string }): Promise<Frame[]>;
  getHealth(): Promise<{ wsUp: boolean; selfWxid?: string; lastMsgTs?: number }>;
```

- [ ] **Step 4: Add a `getJson` helper**

Next to `postJson` in the factory, add:

```ts
  async function getJson(path: string): Promise<unknown> {
    try {
      const res = await undiciFetch(`${httpBase}${path}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${opts.token}` },
        dispatcher,
      });
      if (!res.ok) return undefined;
      return await res.json();
    } catch (err) {
      log?.error?.(`bridge-client GET ${path} failed:`, err);
      return undefined;
    }
  }
```

- [ ] **Step 5: Implement the three methods**

In the returned object, after `forceSync(...)`, add:

```ts
    async getContacts(q) {
      const r = await getJson(`/contacts?q=${encodeURIComponent(q)}&account=${encodeURIComponent(account)}`);
      return Array.isArray(r) ? (r as Array<{ wxid: string; name: string; type?: string; updatedAt: number }>) : [];
    },
    async getHistory(o) {
      const params = new URLSearchParams({ account: o.account ?? account });
      if (o.chat) params.set("chat", o.chat);
      if (o.limit) params.set("limit", String(o.limit));
      const r = await getJson(`/history?${params.toString()}`);
      return Array.isArray(r) ? (r as Frame[]) : [];
    },
    async getHealth() {
      const r = await getJson(`/healthz`);
      const obj = (r ?? {}) as Record<string, unknown>;
      return {
        wsUp: obj.wsUp === true,
        selfWxid: typeof obj.selfWxid === "string" ? obj.selfWxid : undefined,
        lastMsgTs: typeof obj.lastMsgTs === "number" ? obj.lastMsgTs : undefined,
      };
    },
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `NODE_OPTIONS=--disable-warning=ExperimentalWarning npx tsx --test src/shared/bridge-client.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/shared/bridge-client.ts src/shared/bridge-client.test.ts
git commit -m "feat(shared/bridge-client): getContacts/getHistory/getHealth read methods"
```

---

## Task 6: console/commands.ts — pure command parser

**Files:**
- Create: `src/console/commands.ts`
- Test: `src/console/commands.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/console/commands.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseCommand } from "./commands.js";

test("parseCommand: slash filters and toggles", () => {
  assert.deepEqual(parseCommand("/filter 产品讨论"), { kind: "filter", chat: "产品讨论" });
  assert.deepEqual(parseCommand("/grep 需求"), { kind: "grep", keyword: "需求" });
  assert.deepEqual(parseCommand("/dm"), { kind: "dm" });
  assert.deepEqual(parseCommand("/clear"), { kind: "clear" });
});

test("parseCommand: send needs a target and text", () => {
  assert.deepEqual(parseCommand("send wxid_li 收到 了"), { kind: "send", to: "wxid_li", text: "收到 了" });
  assert.equal(parseCommand("send wxid_li").kind, "error");
});

test("parseCommand: reply, forcesync, who, history, status, help, quit", () => {
  assert.deepEqual(parseCommand("r 收到"), { kind: "reply", text: "收到" });
  assert.deepEqual(parseCommand("forcesync"), { kind: "forcesync" });
  assert.deepEqual(parseCommand("who 李"), { kind: "who", query: "李" });
  assert.deepEqual(parseCommand("history wxid_li 10"), { kind: "history", chat: "wxid_li", limit: 10 });
  assert.deepEqual(parseCommand("history wxid_li"), { kind: "history", chat: "wxid_li", limit: 20 });
  assert.deepEqual(parseCommand("status"), { kind: "status" });
  assert.deepEqual(parseCommand("help"), { kind: "help" });
  assert.deepEqual(parseCommand("quit"), { kind: "quit" });
  assert.deepEqual(parseCommand("q"), { kind: "quit" });
});

test("parseCommand: unknown and empty are errors", () => {
  assert.equal(parseCommand("frobnicate x").kind, "error");
  assert.equal(parseCommand("   ").kind, "error");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `NODE_OPTIONS=--disable-warning=ExperimentalWarning npx tsx --test src/console/commands.test.ts`
Expected: FAIL — cannot find module `./commands.js`.

- [ ] **Step 3: Write the implementation**

Create `src/console/commands.ts`:

```ts
/**
 * commands.ts — pure parser: a command-line string → a typed Command.
 * Execution (calling the bridge client) lives in main.ts; this is parse-only.
 */

export type Command =
  | { kind: "filter"; chat: string }
  | { kind: "grep"; keyword: string }
  | { kind: "dm" }
  | { kind: "clear" }
  | { kind: "send"; to: string; text: string }
  | { kind: "reply"; text: string }
  | { kind: "forcesync" }
  | { kind: "who"; query: string }
  | { kind: "history"; chat: string; limit: number }
  | { kind: "status" }
  | { kind: "help" }
  | { kind: "quit" }
  | { kind: "error"; message: string };

export function parseCommand(line: string): Command {
  const trimmed = line.trim();
  if (!trimmed) return { kind: "error", message: "empty command" };

  if (trimmed.startsWith("/")) {
    const [head, ...rest] = trimmed.slice(1).split(/\s+/);
    const arg = rest.join(" ").trim();
    switch (head) {
      case "filter":
        return arg ? { kind: "filter", chat: arg } : { kind: "error", message: "/filter needs a chat" };
      case "grep":
        return arg ? { kind: "grep", keyword: arg } : { kind: "error", message: "/grep needs a keyword" };
      case "dm":
        return { kind: "dm" };
      case "clear":
        return { kind: "clear" };
      default:
        return { kind: "error", message: `unknown command: /${head}` };
    }
  }

  const [head, ...rest] = trimmed.split(/\s+/);
  switch (head) {
    case "send": {
      const to = rest[0];
      const text = rest.slice(1).join(" ").trim();
      return to && text ? { kind: "send", to, text } : { kind: "error", message: "usage: send <to> <text>" };
    }
    case "r": {
      const text = rest.join(" ").trim();
      return text ? { kind: "reply", text } : { kind: "error", message: "usage: r <text>" };
    }
    case "forcesync":
      return { kind: "forcesync" };
    case "who": {
      const query = rest.join(" ").trim();
      return query ? { kind: "who", query } : { kind: "error", message: "usage: who <id|keyword>" };
    }
    case "history": {
      const chat = rest[0];
      if (!chat) return { kind: "error", message: "usage: history <chat> [n]" };
      const limit = Number(rest[1]) || 20;
      return { kind: "history", chat, limit };
    }
    case "status":
      return { kind: "status" };
    case "help":
    case "?":
      return { kind: "help" };
    case "quit":
    case "exit":
    case "q":
      return { kind: "quit" };
    default:
      return { kind: "error", message: `unknown command: ${head}` };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `NODE_OPTIONS=--disable-warning=ExperimentalWarning npx tsx --test src/console/commands.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/console/commands.ts src/console/commands.test.ts
git commit -m "feat(console): pure command parser"
```

---

## Task 7: console/state.ts — view-model + reducers

**Files:**
- Create: `src/console/state.ts`
- Test: `src/console/state.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/console/state.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";

import type { Frame } from "../shared/frame.js";
import {
  initState, applyFrame, applyStatus, setFilter, clearFilter,
  scroll, setInput, setStatusLine, setOverlay, clearOverlay, visibleMessages,
} from "./state.js";

function frame(over: Partial<Frame> = {}): Frame {
  return {
    type: "message", id: Math.random().toString(36).slice(2), account: "default",
    chatType: "group", from: { wxid: "wxid_z", name: "张三" }, chat: { id: "g1", name: "产品讨论" },
    text: "hello", mentionedMe: false, ts: 100, ...over,
  };
}

test("applyFrame: appends, counts, caps at the ring size", () => {
  let s = initState(3);
  for (let i = 0; i < 5; i++) s = applyFrame(s, frame({ text: `m${i}` }));
  assert.equal(s.messages.length, 3);
  assert.deepEqual(s.messages.map((m) => m.text), ["m2", "m3", "m4"]); // oldest dropped
  assert.equal(s.recvCount, 5);
});

test("visibleMessages: filter by chat, keyword, and dm-only", () => {
  let s = initState(10);
  s = applyFrame(s, frame({ text: "需求评审", chat: { id: "g1", name: "产品讨论" } }));
  s = applyFrame(s, frame({ text: "闲聊", chat: { id: "g2", name: "灌水群" } }));
  s = applyFrame(s, frame({ text: "在吗", chatType: "direct", chat: { id: "wxid_li", name: "李四" } }));

  assert.equal(visibleMessages(setFilter(s, { chat: "产品" })).length, 1);
  assert.equal(visibleMessages(setFilter(s, { keyword: "需求" })).length, 1);
  assert.equal(visibleMessages(setFilter(s, { dmOnly: true })).length, 1);
  assert.equal(visibleMessages(clearFilter(s)).length, 3);
});

test("scroll: clamps to [0, len-1] and toggles follow", () => {
  let s = initState(10);
  for (let i = 0; i < 4; i++) s = applyFrame(s, frame());
  s = scroll(s, 2);
  assert.equal(s.scrollOffset, 2);
  assert.equal(s.follow, false);
  s = scroll(s, 99); // clamp
  assert.equal(s.scrollOffset, 3);
  s = scroll(s, -99); // back to bottom → follow
  assert.equal(s.scrollOffset, 0);
  assert.equal(s.follow, true);
});

test("input, statusLine, overlay reducers", () => {
  let s = initState(10);
  s = setInput(s, "send x hi");
  assert.equal(s.input, "send x hi");
  s = setStatusLine(s, "✓ sent");
  assert.equal(s.statusLine, "✓ sent");
  s = setOverlay(s, ["line a", "line b"]);
  assert.deepEqual(s.overlay, ["line a", "line b"]);
  s = clearOverlay(s);
  assert.equal(s.overlay, undefined);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `NODE_OPTIONS=--disable-warning=ExperimentalWarning npx tsx --test src/console/state.test.ts`
Expected: FAIL — cannot find module `./state.js`.

- [ ] **Step 3: Write the implementation**

Create `src/console/state.ts`:

```ts
/**
 * state.ts — the console's in-memory view-model and pure reducers.
 * Every reducer returns a new state; no I/O here.
 */
import type { Frame } from "../shared/frame.js";

export interface Filter {
  chat?: string; // matches chat.id exactly or chat.name substring
  keyword?: string; // matches text substring
  dmOnly?: boolean;
}

export interface ConsoleStatus {
  wsUp: boolean;
  selfWxid?: string;
  lastMsgTs?: number;
}

export interface ConsoleState {
  messages: Frame[]; // oldest → newest, capped at `cap`
  cap: number;
  status: ConsoleStatus;
  connected: boolean; // bridge WS connected (console ↔ middleware)
  filter: Filter;
  scrollOffset: number; // 0 = follow latest; N = scrolled N messages up
  follow: boolean;
  input: string;
  statusLine: string; // transient ✓/⚠ line
  recvCount: number;
  overlay?: string[]; // who/history results; shown in place of the live window until dismissed
}

export function initState(cap = 500): ConsoleState {
  return {
    messages: [], cap, status: { wsUp: false }, connected: false,
    filter: {}, scrollOffset: 0, follow: true, input: "", statusLine: "", recvCount: 0,
  };
}

export function applyFrame(s: ConsoleState, f: Frame): ConsoleState {
  const messages = [...s.messages, f];
  if (messages.length > s.cap) messages.splice(0, messages.length - s.cap);
  return { ...s, messages, recvCount: s.recvCount + 1 };
}

export function applyStatus(s: ConsoleState, status: ConsoleStatus): ConsoleState {
  return { ...s, status };
}

export function setConnected(s: ConsoleState, connected: boolean): ConsoleState {
  return { ...s, connected };
}

export function setFilter(s: ConsoleState, filter: Filter): ConsoleState {
  return { ...s, filter, scrollOffset: 0, follow: true };
}

export function clearFilter(s: ConsoleState): ConsoleState {
  return { ...s, filter: {}, scrollOffset: 0, follow: true };
}

export function scroll(s: ConsoleState, delta: number): ConsoleState {
  const max = Math.max(0, visibleMessages(s).length - 1);
  const scrollOffset = Math.min(max, Math.max(0, s.scrollOffset + delta));
  return { ...s, scrollOffset, follow: scrollOffset === 0 };
}

export function setInput(s: ConsoleState, input: string): ConsoleState {
  return { ...s, input };
}

export function setStatusLine(s: ConsoleState, statusLine: string): ConsoleState {
  return { ...s, statusLine };
}

export function setOverlay(s: ConsoleState, overlay: string[]): ConsoleState {
  return { ...s, overlay };
}

export function clearOverlay(s: ConsoleState): ConsoleState {
  return { ...s, overlay: undefined };
}

export function visibleMessages(s: ConsoleState): Frame[] {
  const { chat, keyword, dmOnly } = s.filter;
  return s.messages.filter((m) => {
    if (dmOnly && m.chatType !== "direct") return false;
    if (chat && !(m.chat.id === chat || (m.chat.name ?? "").includes(chat))) return false;
    if (keyword && !m.text.includes(keyword)) return false;
    return true;
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `NODE_OPTIONS=--disable-warning=ExperimentalWarning npx tsx --test src/console/state.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/console/state.ts src/console/state.test.ts
git commit -m "feat(console): view-model state + pure reducers"
```

---

## Task 8: console/render.ts — pure `render(state, size)`

**Files:**
- Create: `src/console/render.ts`
- Test: `src/console/render.test.ts`

Time formatting uses local time; render tests assert structure/content (not the exact timestamp) to stay timezone-independent.

- [ ] **Step 1: Write the failing tests**

Create `src/console/render.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";

import type { Frame } from "../shared/frame.js";
import { initState, applyFrame, applyStatus, setFilter, setInput, setOverlay } from "./state.js";
import { render } from "./render.js";

function frame(over: Partial<Frame> = {}): Frame {
  return {
    type: "message", id: Math.random().toString(36).slice(2), account: "default",
    chatType: "group", from: { wxid: "wxid_z", name: "张三" }, chat: { id: "g1", name: "产品讨论" },
    text: "需求评审", mentionedMe: false, ts: 100, ...over,
  };
}

test("render: returns exactly `rows` lines", () => {
  const s = initState(10);
  const lines = render(s, { rows: 12, cols: 80 });
  assert.equal(lines.length, 12);
});

test("render: header shows WS state and self wxid", () => {
  let s = initState(10);
  s = applyStatus(s, { wsUp: true, selfWxid: "wxid_self" });
  const lines = render(s, { rows: 12, cols: 80 });
  assert.match(lines[0], /WS up/);
  assert.match(lines[0], /wxid_self/);
});

test("render: shows visible messages and hides filtered-out ones", () => {
  let s = initState(10);
  s = applyFrame(s, frame({ text: "需求评审" }));
  s = applyFrame(s, frame({ text: "灌水", chat: { id: "g2", name: "灌水群" } }));
  s = setFilter(s, { keyword: "需求" });
  const body = render(s, { rows: 12, cols: 80 }).join("\n");
  assert.match(body, /需求评审/);
  assert.doesNotMatch(body, /灌水/);
});

test("render: overlay replaces the live window", () => {
  let s = initState(10);
  s = applyFrame(s, frame({ text: "需求评审" }));
  s = setOverlay(s, ["李四 · wxid_li"]);
  const body = render(s, { rows: 12, cols: 80 }).join("\n");
  assert.match(body, /李四 · wxid_li/);
  assert.doesNotMatch(body, /需求评审/);
});

test("render: input line carries the prompt and current input", () => {
  let s = initState(10);
  s = setInput(s, "send wxid_li 收到");
  const lines = render(s, { rows: 12, cols: 80 });
  assert.match(lines[lines.length - 1], /^: send wxid_li 收到/);
});

test("render: degrades gracefully on a tiny terminal", () => {
  const s = initState(10);
  const lines = render(s, { rows: 2, cols: 20 });
  assert.equal(lines.length, 2);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `NODE_OPTIONS=--disable-warning=ExperimentalWarning npx tsx --test src/console/render.test.ts`
Expected: FAIL — cannot find module `./render.js`.

- [ ] **Step 3: Write the implementation**

Create `src/console/render.ts`:

```ts
/**
 * render.ts — pure view: render(state, size) → an array of exactly `rows` lines.
 * No ANSI styling here (kept testable); terminal.ts adds colors/positioning.
 * Layout: [header] [message area = rows-3] [footer] [input].
 */
import type { Frame } from "../shared/frame.js";
import { type ConsoleState, visibleMessages } from "./state.js";

export interface Size {
  rows: number;
  cols: number;
}

function clip(str: string, cols: number): string {
  const chars = Array.from(str);
  return chars.length <= cols ? str : chars.slice(0, Math.max(0, cols - 1)).join("") + "…";
}

function pad(str: string, cols: number): string {
  const len = Array.from(str).length;
  return len >= cols ? clip(str, cols) : str + " ".repeat(cols - len);
}

function hhmmss(ts: number): string {
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function formatFrame(f: Frame, selfWxid: string | undefined, cols: number): string {
  const kind = f.chatType === "group" ? "群" : "DM";
  const sender = f.from.wxid === selfWxid ? "你" : f.from.name ?? f.from.wxid;
  const body = f.media ? `<${f.media.kind}>` : f.text;
  return clip(`${hhmmss(f.ts)} ${kind} ${sender} → ${body}`, cols);
}

export function render(s: ConsoleState, size: Size): string[] {
  const { rows, cols } = size;
  if (rows < 4) return Array.from({ length: Math.max(0, rows) }, () => pad("…terminal too small", cols));

  const header = pad(
    clip(`wcppm  ${s.connected ? "●" : "○"} WS ${s.status.wsUp ? "up" : "down"} · self ${s.status.selfWxid ?? "?"}`, cols),
    cols,
  );

  const areaH = rows - 3;
  let bodyLines: string[];
  if (s.overlay) {
    bodyLines = s.overlay.slice(0, areaH).map((l) => pad(clip(l, cols), cols));
  } else {
    const vis = visibleMessages(s);
    const end = vis.length - s.scrollOffset;
    const start = Math.max(0, end - areaH);
    bodyLines = vis.slice(start, end).map((f) => pad(formatFrame(f, s.status.selfWxid, cols), cols));
  }
  while (bodyLines.length < areaH) bodyLines.push(pad("", cols));

  const filterDesc = describeFilter(s);
  const stats = `recv ${s.recvCount}${filterDesc}${s.follow ? "" : " · [scrolled]"}`;
  const footer = pad(clip(s.statusLine || stats, cols), cols);
  const input = pad(clip(`: ${s.input}`, cols), cols);

  return [header, ...bodyLines, footer, input];
}

function describeFilter(s: ConsoleState): string {
  const parts: string[] = [];
  if (s.filter.chat) parts.push(`chat:${s.filter.chat}`);
  if (s.filter.keyword) parts.push(`grep:${s.filter.keyword}`);
  if (s.filter.dmOnly) parts.push("dm");
  return parts.length ? ` · filter ${parts.join(",")}` : "";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `NODE_OPTIONS=--disable-warning=ExperimentalWarning npx tsx --test src/console/render.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/console/render.ts src/console/render.test.ts
git commit -m "feat(console): pure render(state,size) → lines"
```

---

## Task 9: console/terminal.ts — ANSI/readline driver

**Files:**
- Create: `src/console/terminal.ts`

I/O glue — not unit-tested (verified by manual smoke in Task 11). It owns the alternate screen buffer, keypress handling, a throttled repaint, and terminal restoration on exit.

- [ ] **Step 1: Write the implementation**

Create `src/console/terminal.ts`:

```ts
/**
 * terminal.ts — the thin imperative TUI driver.
 *
 * Owns the alternate screen buffer, raw keypress handling (scroll keys + a
 * single-line input buffer), a throttled repaint, and ALWAYS restores the
 * terminal on exit/crash. Pure rendering is delegated to render.ts; all view
 * state lives in the ConsoleState that the caller mutates via reducers.
 */
import * as readline from "node:readline";
import type { ConsoleState } from "./state.js";
import { render, type Size } from "./render.js";

export interface TerminalHandlers {
  /** Called when the user submits the input line (Enter). */
  onSubmit(line: string): void;
  /** Called on scroll keys; delta>0 = older, <0 = newer. */
  onScroll(delta: number): void;
  /** Called when the user presses a printable/edit key; the driver updates state.input itself. */
  onInputChange(input: string): void;
  /** Called on Esc — used to dismiss an overlay/filter. */
  onEscape(): void;
  /** Called on quit (Ctrl-C / Ctrl-D). */
  onQuit(): void;
}

export interface Terminal {
  /** Repaint now (throttled to once per animation frame). */
  schedulePaint(): void;
  /** Tear down: restore the terminal. Safe to call multiple times. */
  close(): void;
}

const ALT_ON = "\x1b[?1049h";
const ALT_OFF = "\x1b[?1049l";
const CURSOR_HIDE = "\x1b[?25l";
const CURSOR_SHOW = "\x1b[?25h";
const CLEAR = "\x1b[2J\x1b[H";

export function startTerminal(getState: () => ConsoleState, handlers: TerminalHandlers): Terminal {
  const out = process.stdout;
  const input = process.stdin;

  let inputBuffer = "";
  let painting = false;
  let closed = false;

  function size(): Size {
    return { rows: out.rows ?? 24, cols: out.columns ?? 80 };
  }

  function paint(): void {
    if (closed) return;
    const lines = render(getState(), size());
    out.write(CLEAR + lines.join("\r\n"));
  }

  function schedulePaint(): void {
    if (painting || closed) return;
    painting = true;
    setImmediate(() => {
      painting = false;
      paint();
    });
  }

  out.write(ALT_ON + CURSOR_HIDE);
  readline.emitKeypressEvents(input);
  if (input.isTTY) input.setRawMode(true);

  function onKeypress(str: string | undefined, key: readline.Key): void {
    if (!key) return;
    if ((key.ctrl && (key.name === "c" || key.name === "d"))) {
      handlers.onQuit();
      return;
    }
    switch (key.name) {
      case "up":
        handlers.onScroll(1);
        return;
      case "down":
        handlers.onScroll(-1);
        return;
      case "pageup":
        handlers.onScroll(10);
        return;
      case "pagedown":
        handlers.onScroll(-10);
        return;
      case "escape":
        inputBuffer = "";
        handlers.onInputChange(inputBuffer);
        handlers.onEscape();
        return;
      case "return":
      case "enter": {
        const line = inputBuffer;
        inputBuffer = "";
        handlers.onInputChange(inputBuffer);
        handlers.onSubmit(line);
        return;
      }
      case "backspace":
        inputBuffer = Array.from(inputBuffer).slice(0, -1).join("");
        handlers.onInputChange(inputBuffer);
        return;
      default:
        if (str && !key.ctrl && !key.meta && str >= " ") {
          inputBuffer += str;
          handlers.onInputChange(inputBuffer);
        }
    }
  }

  input.on("keypress", onKeypress);
  out.on("resize", schedulePaint);

  function close(): void {
    if (closed) return;
    closed = true;
    input.off("keypress", onKeypress);
    out.off("resize", schedulePaint);
    if (input.isTTY) input.setRawMode(false);
    out.write(CURSOR_SHOW + ALT_OFF);
  }

  // Safety nets: restore the terminal no matter how we exit.
  process.on("exit", close);

  paint();
  return { schedulePaint, close };
}
```

- [ ] **Step 2: Build to verify types**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/console/terminal.ts
git commit -m "feat(console): ANSI/readline terminal driver"
```

---

## Task 10: console/main.ts — entry + `npm run console`

**Files:**
- Create: `src/console/main.ts`
- Modify: `package.json`

Wires config → bridge client (autoAck:false) → state → terminal, and maps parsed commands to bridge calls. Not unit-tested; verified by manual smoke in Task 11.

- [ ] **Step 1: Write the entry**

Create `src/console/main.ts`:

```ts
/**
 * main.ts — the wcppm console entrypoint.
 *
 *   npm run console [configPath] [--url ws://host:port] [--token TOKEN]
 *
 * Attaches to the running middleware as a READ-ONLY observer (autoAck:false) so
 * it never steals the real adapter's acks (delivery state is global — see the
 * design spec §2.1). It adds no active WeChat operations.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { createBridgeClient } from "../shared/bridge-client.js";
import type { Frame } from "../shared/frame.js";
import { parseCommand, type Command } from "./commands.js";
import { startTerminal } from "./terminal.js";
import {
  initState, applyFrame, applyStatus, setConnected, setFilter, clearFilter,
  clearOverlay, scroll, setInput, setStatusLine, setOverlay, visibleMessages,
  type ConsoleState,
} from "./state.js";

interface ConsoleArgs {
  configPath: string;
  url?: string;
  token?: string;
}

function parseArgs(argv: string[]): ConsoleArgs {
  let configPath = join(homedir(), ".config", "wcppm", "config.json");
  let url: string | undefined;
  let token: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") url = argv[++i];
    else if (a === "--token") token = argv[++i];
    else if (!a.startsWith("--")) configPath = a;
  }
  return { configPath, url, token };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const raw = JSON.parse(readFileSync(args.configPath, "utf8")) as Record<string, unknown>;
  const account = (raw.account as string) || "default";
  const token = args.token ?? (raw.bridgeToken as string);
  const port = (raw.bridgePort as number) ?? 8077;
  const url = args.url ?? `ws://127.0.0.1:${port}`;
  if (!token) throw new Error("no bridgeToken (set it in the config or pass --token)");

  let state = initState();
  let terminal: ReturnType<typeof startTerminal> | undefined;
  let pendingForceSync = false;
  let statusTimer: ReturnType<typeof setTimeout> | null = null;

  const update = (next: ConsoleState): void => {
    state = next;
    terminal?.schedulePaint();
  };
  const flash = (line: string): void => {
    update(setStatusLine(state, line));
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(() => update(setStatusLine(state, "")), 3000);
  };

  const bridge = createBridgeClient({
    url, token, account, autoAck: false,
    onMessage: (frame: Frame) => update(applyFrame(state, frame)),
    onReady: (selfWxid) => update(applyStatus(state, { ...state.status, wsUp: true, selfWxid })),
  });

  async function execute(cmd: Command): Promise<void> {
    if (pendingForceSync) {
      pendingForceSync = false;
      // handled in onSubmit's confirm path; ignore here
    }
    switch (cmd.kind) {
      case "filter": update(setFilter(state, { ...state.filter, chat: cmd.chat })); return;
      case "grep": update(setFilter(state, { ...state.filter, keyword: cmd.keyword })); return;
      case "dm": update(setFilter(state, { ...state.filter, dmOnly: true })); return;
      case "clear": update(clearFilter(clearOverlay(state))); return;
      case "send": {
        const r = await bridge.send({ to: cmd.to, text: cmd.text });
        flash(r.ok ? `✓ sent${r.msgId ? ` (${r.msgId})` : ""}` : "⚠ send failed");
        return;
      }
      case "reply": {
        const vis = visibleMessages(state);
        const target = vis[vis.length - 1];
        if (!target) { flash("⚠ nothing to reply to"); return; }
        const r = await bridge.send({ to: target.chat.id, text: cmd.text, replyTo: target.id });
        flash(r.ok ? "✓ replied" : "⚠ reply failed");
        return;
      }
      case "forcesync": {
        flash("⚠ forcesync is operator-only — type 'y' to confirm");
        pendingForceSync = true;
        return;
      }
      case "who": {
        const rows = await bridge.getContacts(cmd.query);
        update(setOverlay(state, rows.length
          ? rows.map((c) => `${c.name} · ${c.wxid}${c.type ? ` (${c.type})` : ""}`)
          : ["(no matching contacts)"]));
        return;
      }
      case "history": {
        const frames = await bridge.getHistory({ chat: cmd.chat, limit: cmd.limit });
        update(setOverlay(state, frames.length
          ? frames.map((f) => `${f.from.name ?? f.from.wxid}: ${f.media ? `<${f.media.kind}>` : f.text}`)
          : ["(no history)"]));
        return;
      }
      case "status": {
        const h = await bridge.getHealth();
        flash(`WS ${h.wsUp ? "up" : "down"} · self ${h.selfWxid ?? "?"} · last ${h.lastMsgTs ?? "-"}`);
        return;
      }
      case "help":
        update(setOverlay(state, [
          "commands: /filter <chat> · /grep <kw> · /dm · /clear",
          "send <to> <text> · r <text> · forcesync · who <q> · history <chat> [n]",
          "status · help · quit   (↑↓ scroll · Esc dismiss)",
        ]));
        return;
      case "quit":
        shutdown();
        return;
      case "error":
        flash(`⚠ ${cmd.message}`);
        return;
    }
  }

  function onSubmit(line: string): void {
    const trimmed = line.trim();
    if (pendingForceSync) {
      pendingForceSync = false;
      if (trimmed === "y" || trimmed === "yes") {
        void bridge.forceSync(account).then((r) =>
          flash(r.ok ? `⟳ synced · +${r.messages ?? 0}` : "⚠ forcesync failed"));
      } else {
        flash("forcesync cancelled");
      }
      return;
    }
    if (!trimmed) return;
    void execute(parseCommand(trimmed));
  }

  function shutdown(): void {
    if (statusTimer) clearTimeout(statusTimer);
    clearInterval(healthTimer);
    try { bridge.close(); } catch { /* ignore */ }
    try { terminal?.close(); } catch { /* ignore */ }
    process.exit(0);
  }

  terminal = startTerminal(() => state, {
    onSubmit,
    onScroll: (delta) => update(scroll(state, delta)),
    onInputChange: (input) => update(setInput(state, input)),
    onEscape: () => update(clearOverlay(state)),
    onQuit: shutdown,
  });

  update(setConnected(state, true));
  bridge.connect();

  // Poll /healthz for the header status (~2s).
  const healthTimer = setInterval(() => {
    void bridge.getHealth().then((h) =>
      update(applyStatus(state, { wsUp: h.wsUp, selfWxid: h.selfWxid ?? state.status.selfWxid, lastMsgTs: h.lastMsgTs })));
  }, 2000);
  healthTimer.unref?.();

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
```

- [ ] **Step 2: Add the `console` script to package.json**

In `package.json`, under `"scripts"`, add after the `"debug"` line:

```json
    "console": "npx tsx src/console/main.ts"
```

(Remember to add the trailing comma to the preceding `"debug"` line.)

- [ ] **Step 3: Build to verify types**

Run: `npm run build`
Expected: succeeds with no type errors.

- [ ] **Step 4: Commit**

```bash
git add src/console/main.ts package.json
git commit -m "feat(console): entrypoint + npm run console script"
```

---

## Task 11: Final verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: PASS — all `src/**/*.test.ts` (db, server, bridge-client, commands, state, render, plus existing).

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: succeeds; `dist/console/main.js` exists.

- [ ] **Step 3: Manual smoke (requires a running middleware)**

With a middleware running (or a throwaway one against a test config), in another terminal:

Run: `npm run console -- ~/.config/wcppm/config.json`
Expected, by eye:
- Full-screen dashboard paints: header shows `WS up/down · self …`, an empty message area, a footer, and a `:` input line.
- Typing `help` + Enter shows the command overlay; `Esc` dismisses it.
- Typing `who <known-name>` shows matching contacts in the overlay (or `(no matching contacts)`).
- `↑`/`↓` scroll the message area; footer shows `[scrolled]` when not at the bottom.
- `Ctrl-C` exits cleanly and **the terminal is restored** (cursor visible, normal screen, shell prompt intact).

- [ ] **Step 4: Verify account-safety invariant by inspection**

Confirm the console issues only: `WS /subscribe` (autoAck:false), `GET /healthz`, `GET /contacts`, `GET /history`, `POST /send`, `POST /forceSync`. No new `/Login/*`, `/Msg/Sync` loop, or `StartAutoSync` paths were added anywhere in `src/console/` or `src/shared/bridge-client.ts`.

Run: `grep -rE "Newinit|StartAutoSync|/Login/" src/console src/shared/bridge-client.ts || echo "clean — no active-risk surfaces"`
Expected: `clean — no active-risk surfaces`.

---

## Self-Review Notes (for the implementer)

- **Spec coverage:** form (dashboard + command line) → Tasks 7–10; command capabilities (filter/grep/dm/clear, send, forcesync, who/history) → Tasks 6 + 10; zero-dep TUI → Tasks 8–9; promote bridge-client → Task 4; autoAck:false observer → Task 10; new read-only endpoints → Tasks 1–2; account safety → Task 11 Step 4.
- **Type consistency:** `Command` kinds (Task 6) are exactly the ones `execute()` switches on (Task 10). `ConsoleState` reducers (Task 7) match every call site in render (Task 8) and main (Task 10). `BridgeClient.getContacts/getHistory/getHealth` shapes (Task 5) match `queryContacts/queryHistory` (Task 2) and the `/healthz` `status()` shape.
- **Known v1 limitations (intentional, YAGNI):** `r` replies to the newest *visible* message (no cursor-based selection yet); CJK double-width is not accounted for in `clip()`/`pad()` (codepoint width only); `who`/`history` render as compact overlay lines, not a scrollable pane; timestamps are local-time.
