# Mars Heartbeat Conductor — Design Spec

**Date:** 2026-06-23
**Status:** Draft — awaiting review
**Component of:** the `wcppm-lob` middleware (this is one module, not the whole middleware)

## 1. Goal

Replace the WCPPM server's hardcoded **60 s** session heartbeat with an external
**heartbeat conductor** that drives the manual `POST /api/Login/HeartBeat`
entry point on a cadence faithfully ported from Tencent's **Mars smart-heartbeat**
algorithm.

Primary objective: **风控 camouflage** — make the account's heartbeat behaviour
resemble a genuine WeChat client instead of a 60 s metronome.

## 2. Why (the real finding)

Mars's actual constants (`mars/stn/config.h`):

| Constant | Value | Meaning |
|---|---|---|
| `MinHeartInterval` | **210 s** (3.5 min) | interval while *active* |
| `MaxHeartInterval` | **600 s** (10 min) | probe ceiling |
| `HeartStep` | 60 s | upward probe step |
| `SuccessStep` | 20 s | back-off from a found ceiling → stable value |
| `MaxHeartFailCount` | 2 | consecutive fails before shrinking |
| `BaseSuccCount` | 5 | consecutive successes before enlarging |
| `NetStableTestCount` | 3 | min-interval heartbeats before probing starts |

The framework's hardcoded 60 s is therefore **not merely metronomic — it is ~3.5×
more frequent than even the most aggressive real-client interval (210 s)**, and
never jitters. An account heartbeating every 60 s reads as *abnormally high
frequency*, not just *too regular*. Porting Mars moves the cadence to **210 s–580 s
adaptive**, which is simultaneously more authentic and ~4× less request volume.

The heartbeat is **session keepalive only** — message push rides the server-side
longlink (webhook / WS), not this heartbeat. So lengthening the interval has **no
latency cost** to message delivery; it is purely a camouflage/keepalive concern.

## 3. Known conflict & decision (recorded deliberately)

`wcppm-lob`'s `CLAUDE.md` carries two load-bearing, ban-derived rules that this
component contradicts:

> *Account Safety:* never run active dispatch loops; an account was **banned
> 2026-04-12** from "active dispatch with no live consumer → retry storm".
> *Scope Boundary:* all `/Login/*` operations are the WCPPM **operator's**
> responsibility; the middleware stays **fully passive**.

A heartbeat conductor is, by definition, an **active `/Login/*` loop** inside the
middleware. **The operator (project owner) has explicitly judged these rules
outdated and authorized proceeding** (decision 2026-06-23).

To honour the *lesson* behind those rules at zero cost to the goal, the design
retains conservative safety rails (§9). **Action item:** update `CLAUDE.md` so the
passivity/scope rules are annotated as superseded for the heartbeat surface —
otherwise a future session will re-trip on them.

## 4. Scope & non-goals

**In scope:** an external conductor that (a) drives `/api/Login/HeartBeat` on the
Mars cadence, (b) does *not* invoke the server's 60 s `/Login/AutoHeartBeat`,
(c) persists learned per-network intervals to Redis, (d) detects offline/longlink
trouble and surfaces it.

**Non-goals:**
- **Not** fixing the broken longlink MMTLS `Identify` timeout — that is inside the
  closed WCPPM binary (TcpClient) and is a separate track. The conductor only
  *detects and reports* it; it does not try to "wake" or repair it.
- **Not** a true Mars closed loop. Mars's `OnHeartResult` feedback is the
  long-link's per-packet RTT/disconnect signal, which is invisible from outside the
  binary. We feed the algorithm a **coarse proxy** signal (§7) and label this
  limitation explicitly rather than pretending it is real NAT probing.
- **Not** touching `/Login/Newinit` or `StartAutoSync` (still genuine ban triggers,
  unrelated to heartbeat).

## 5. Gating — RESOLVED (2026-06-23)

**Is the server's 60 s `AutoHeartBeat` opt-in or always-on?** → **Opt-in.** Verified
against the live API (operator-provided):

- `POST /api/Login/AutoHeartBeat?authcode=…` returns `{"Message":"自动心跳已启动"}` and
  thereafter pulls `/Login/HeartBeat` **every 60 s**. It runs **only when called** — so
  if we never call it, there is no 60 s loop. ✅ the conductor can fully replace it.
- **No runtime cancel.** Once started there is **no stop endpoint** — the only way to
  stop the 60 s loop is to **restart the `wechatpadpromax` binary**.
- `wcppm-lob` itself **never calls** `AutoHeartBeat`/`HeartBeat` today (grep-confirmed,
  consistent with its passive design). The current 60 s loop is started **out-of-band**
  (operator / admin backend / a startup script).

**Cutover procedure (for an account currently running the 60 s loop):**
1. Ensure nothing will re-trigger `AutoHeartBeat` for this account (find & disable the
   out-of-band caller).
2. **Restart `wechatpadpromax`** to clear the sticky 60 s loop.
3. Bring the account up with the conductor owning the heartbeat from login; the
   conductor calls `/Login/HeartBeat` on the Mars cadence and **never** calls
   `AutoHeartBeat`.

No "always-on" risk exists → the component is viable as designed.

## 6. Placement & architecture

New module `src/heartbeat/` (sibling to `src/core/`; reuses `core/proxy.ts` and
`core/config.ts`). It calls the WCPPM HTTP API exactly like `client.ts` does.

```
src/heartbeat/
  smart-heartbeat.ts        # faithful TS port of Mars SmartHeartbeat (pure, no I/O)
  smart-heartbeat.test.ts   # port of mars/stn/test_cases/smart_heartbeat_test.cc vectors
  conductor.ts              # the loop: interval → jitter → HeartBeat call → OnHeartResult
  conductor.test.ts         # fake clock + fake client; safety-rail + active/idle tests
  store.ts                  # Redis persistence of per-network NetHeartbeatInfo
  types.ts                  # NetHeartbeatInfo, env inputs, deps interfaces
```

Wired from `src/core/main.ts` (or a dedicated entry) behind a config flag, so it is
trivially disabled (kill-switch, §9).

## 7. The Mars port (faithful)

Port `SmartHeartbeat` (`mars/stn/src/smart_heartbeat.{h,cc}`) verbatim in behaviour:

- **State:** `cur_heart`, `last_heart`, `pre_heart`, `success_heart_count`,
  per-network `NetHeartbeatInfo { cur_heart, succ_heart_count, fail_heart_count,
  min_heart_fail_count, is_stable, heart_type, last_modify_time, net_detail }`.
- **Methods:** `getNextHeartbeatInterval()`, `onHeartResult(success, failOfTimeout)`,
  `onLongLinkEstablished()`, `onLongLinkDisconnect()`, `judgeDozeStyle()`, and the
  `outer_setted_heart` override hook (`setHeartBeat`).
- **Constants:** copied exactly from §2.
- **Full port, incl. doze code path.** Doze (`__IsDozeStyle` / `judgeDozeStyle`) is
  gated on `getNetInfo() == kMobile`. We emulate a **Mac client → non-mobile**, so we
  feed `netType = non-mobile`; the doze branch is then *naturally dormant*, exactly as
  on a real Mac/Windows WeChat client. No code is deleted — the environment input
  makes it inert. This is why "full port" is both simpler (no cherry-picking) and
  correct for this target.
- **Weekly re-probe** ("probe bigger on Wednesday", `7 * ONE_DAY`) is kept — cheap,
  gives slow long-term adaptation.

### Environment inputs (the seams we control)

| Mars source | Our binding |
|---|---|
| `ActiveLogic::IsActive()` | recent inbound (webhook/WS) or outbound (`/send`) within `activeWindowMs` → active |
| `getCurrNetLabel()` / `net_type` | a stable label for this instance's egress (e.g. proxy id); non-mobile type |
| `OnHeartResult(success, failOfTimeout)` | **coarse proxy:** `HeartBeat` HTTP result; `failOfTimeout` ← request timeout vs. error body; cross-checked by periodic `GET /api/User/GetOnlineInfo` |
| `OnLongLinkEstablished/Disconnect` | derived from `GetOnlineInfo` / `/ws/health` transitions (online→established, offline→disconnect) |

The coarse signal is the one honest compromise (§4). It is *good enough* to drive the
interval state machine; it is *not* per-packet NAT probing.

### HeartBeat response handling (decided 2026-06-23)

A `/Login/HeartBeat` success looks like:
```json
{ "Code":0, "Success":true, "Message":"成功",
  "Data": { "BaseResponse": {"ret":0,"errMsg":{}}, "NextTime":149, "Selector":4294967295 } }
```

- **Success classification:** `Success==true && Data.BaseResponse.ret==0` → success;
  request timeout → `(false, failOfTimeout=true)`; any other non-zero `ret`/error →
  `(false, failOfTimeout=false)`. This is the §7 coarse feedback into `onHeartResult`.
- **`NextTime` is deliberately IGNORED.** Cadence is **pure Mars**. Rationale: we cannot
  determine whether `NextTime` originates from Tencent (authoritative) or is fabricated
  by `wechatpadpromax`; the WCPPM `AutoHeartBeat` itself ignores it (hardcodes 60 s),
  which is evidence it is not treated as authoritative. Mars is Tencent's own,
  known-real-client algorithm, so anchoring the cadence to Mars is more defensible than
  to a value of unknown provenance. (If provenance is ever confirmed as Tencent's, a
  future revision may revisit `NextTime` as the primary source.)
- **`Selector` is deliberately IGNORED — do NOT trigger Sync.** `Selector!=0` signals
  "new data waiting", but acting on it = active Sync dispatch, which is exactly the
  2026-04-12 ban pattern. Message delivery is the server-side longlink/webhook's job,
  not the conductor's. The conductor reads heartbeat results **only** for liveness.

## 8. Data model & Redis persistence (`store.ts`)

Mirror Mars's `Heartbeat.ini` sections (keyed per network) into the **existing WCPPM
Redis** (`100.64.0.8:6379`). New dependency: a Redis client (`ioredis` proposed).

- Key: `hbconductor:<authcode>:<net_label>` → JSON of `NetHeartbeatInfo`.
- Load on `onLongLinkEstablished`; save on every state change (debounced).
- `LimitINISize` equivalent: cap stored networks per authcode (Mars caps at 20).
- **Decision needed:** which Redis **db index** (the server uses db0/db1/db8 for
  per-account `PERM:*` / `heartbeatlog:*`). Proposal: a dedicated index (e.g. db15) or
  a clearly namespaced `hbconductor:*` prefix to avoid colliding with WCPPM keys.

## 9. Control flow & safety rails

Loop per authcode:
1. `interval = smartHeartbeat.getNextHeartbeatInterval()` (active→210 s, else adaptive).
2. `sleep(interval ± jitter)` — jitter (e.g. ±5–8 %) guarantees no exact-multiple
   metronome even at the floor.
3. `POST /api/Login/HeartBeat`; classify result → `onHeartResult(success, timeout)`.
4. Periodically (decoupled, slower) `GET /api/User/GetOnlineInfo` to cross-check
   liveness and detect the broken-longlink condition.

**Safety rails (honouring the ban lesson):**
- **Kill-switch:** single config flag (`heartbeat.enabled`) + responds to SIGTERM;
  off by default until verified.
- **No retry storm:** a failed heartbeat does **not** immediately retry; it feeds
  `onHeartResult(false)` and waits the *next* computed interval (Mars already shrinks
  on `MaxHeartFailCount`). Hard floor on minimum spacing (never below, say, 60 s even
  under failure) so we can never out-pace the old behaviour.
- **Failure backoff + alert:** N consecutive failures or `GetOnlineInfo == offline`
  → stop hammering, log `error`, surface via the middleware's existing alert path;
  do **not** attempt `/Login/*` recovery calls (scope boundary on *recovery* still
  holds — detect, don't fix).
- **Global rate cap:** an absolute ceiling on heartbeats/hour per account as a
  backstop independent of the state machine.

## 10. Config additions (`core/config.ts`)

```jsonc
"heartbeat": {
  "enabled": false,            // kill-switch; off until §5 verified
  "redisUrl": "redis://100.64.0.8:6379",
  "redisDb": 15,               // §8 decision
  "activeWindowMs": 120000,    // recent activity → "active"
  "jitterPct": 0.07,
  "onlineCheckIntervalMs": 600000,
  "maxConsecutiveFailures": 4,
  "hardFloorMs": 60000,        // never faster than this, even on failure
  "maxPerHour": 30             // absolute backstop
}
```

Validation must be added to the `openclaw.plugin.json` schema if exposed adapter-side
(it is **not** — this is middleware-only config; keep it out of the channel schema).

## 11. Testing (TDD, `node:test` via `tsx`)

- `smart-heartbeat.test.ts`: **port Mars's own `smart_heartbeat_test.cc` vectors** —
  they encode the exact expected progression (`MinHeartInterval`,
  `MinHeartInterval + HeartStep`, `… + HeartStep*2`, `MaxHeartInterval - SuccessStep`,
  shrink-on-fail, re-establish behaviour). This gives a ready-made oracle proving the
  port matches Mars bit-for-bit.
- `conductor.test.ts`: inject a **fake clock** and **fake WCPPM client**; assert
  jitter bounds, active/idle interval selection, the hard floor, backoff after
  `maxConsecutiveFailures`, kill-switch, and that a failing `GetOnlineInfo` triggers
  alert-not-retry.
- `store.test.ts`: round-trip `NetHeartbeatInfo` through a fake/real Redis; eviction
  cap.

## 12. Open questions

1. Redis db index / namespacing (§8) — proposed db15 or `hbconductor:*` prefix.
2. `ioredis` vs `node-redis` (the project currently has neither; SQLite is its store).

*Resolved 2026-06-23:* §5 gating (AutoHeartBeat is opt-in, no runtime cancel — see §5);
HeartBeat success/feedback mapping and NextTime/Selector handling (see §7).

## 13. Follow-up (separate tracks)

- Update `CLAUDE.md` passivity/scope rules (annotate as superseded for heartbeat).
- The broken longlink MMTLS `Identify` timeout — diagnose independently (network/proxy
  path to the oversea longlink host, or WCPPM operator side).
