// Mars smart-heartbeat constants — copied verbatim from
// mars/stn/config.h. Do not "tune" these; they are the algorithm.
export const MIN_HEART_INTERVAL = 3 * 60 * 1000 + 30 * 1000; // 210000 (3.5 min)
export const MAX_HEART_INTERVAL = 10 * 60 * 1000;            // 600000 (10 min)
export const HEART_STEP = 60 * 1000;                         // 60000
export const SUCCESS_STEP = 20 * 1000;                       // 20000
export const MAX_HEART_FAIL_COUNT = 2;
export const BASE_SUCC_COUNT = 5;
export const NET_STABLE_TEST_COUNT = 3;
