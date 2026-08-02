/**
 * chrome.storage.local に置く永続データのアクセサ。
 * service worker はいつでも落ちるので、実行中の状態もここに書く。
 */

import { KEYS, LIMITS } from './defaults.js';

export async function readList(key) {
  const got = await chrome.storage.local.get(key);
  return Array.isArray(got[key]) ? got[key] : [];
}

export async function writeList(key, list, cap) {
  const trimmed = cap ? list.slice(0, cap) : list;
  await chrome.storage.local.set({ [key]: trimmed });
  return trimmed;
}

export const capFor = (key) => (key === KEYS.saved ? LIMITS.saved : LIMITS.mentions);

/* ------------------------------------------------------------------ *
 * ポーリング状態
 * ------------------------------------------------------------------ */

const EMPTY_POLL_STATE = {
  /** listSpaces() の結果と取得時刻 */
  spaces: [],
  spacesFetchedAt: 0,
  /** { "spaces/XXXX": "RFC3339" } 各スペースでどこまで読んだか */
  cursors: {},
  /** 自分のユーザー情報 */
  me: null,
  /** 429/5xx を食らったときに再開する時刻 */
  backoffUntil: 0,
  /** UI 表示用 */
  lastPollAt: 0,
  lastOkAt: 0,
  lastError: null,
};

export async function getPollState() {
  const got = await chrome.storage.local.get(KEYS.pollState);
  return { ...EMPTY_POLL_STATE, ...(got[KEYS.pollState] || {}) };
}

export async function setPollState(patch) {
  const current = await getPollState();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [KEYS.pollState]: next });
  return next;
}

export async function resetPollState() {
  await chrome.storage.local.set({ [KEYS.pollState]: { ...EMPTY_POLL_STATE } });
}
