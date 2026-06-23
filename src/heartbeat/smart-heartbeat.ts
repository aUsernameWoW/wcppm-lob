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
