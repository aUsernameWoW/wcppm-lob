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
