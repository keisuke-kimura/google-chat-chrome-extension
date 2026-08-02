/**
 * 設定のデフォルト値と、拡張全体で共有する定数。
 */

export const DEFAULT_SETTINGS = {
  /* ---- 検知 ---- */
  /** 追加のハイライトキーワード（1行1語） */
  keywords: [],
  /** @all / @here 相当を拾うか */
  matchAll: true,
  /** DM は全メッセージを通知するか（Slack 同様の挙動） */
  notifyDms: true,
  /** すべてのスペースの全メッセージを通知するか（うるさいので既定 false） */
  notifyAllMessages: false,
  /** 通知を止めるスペース ("spaces/XXXX" の配列) */
  mutedSpaces: [],
  /**
   * 表示名。メンション判定は API の USER_MENTION アノテーションで行うため通常は不要。
   * ユーザー ID の突き合わせに失敗した場合のフォールバックとしてのみ使う。
   */
  displayName: '',

  /* ---- 取得 ---- */
  /** ポーリング間隔（秒）。alarms の下限があるため実効 30 秒以上 */
  pollSeconds: 60,
  /** Chat のタブを開いている間、DOM 変化を検知して即座にポーリングするか */
  domAccelerator: true,
  /**
   * 未読スペース一覧を更新する間隔（秒）。
   * メンション検知と違い1スペースあたり2リクエスト使うので、既定は長めにしている。
   * 0 にすると未読一覧を取りに行かない。
   */
  unreadScanSeconds: 300,

  /* ---- 通知 ---- */
  notify: true,
  sound: true,
  volume: 0.5,
  /** Chat のタブを見ている最中でも通知するか */
  notifyWhenFocused: false,
  /** 未読メンション数をツールバーのバッジに出すか */
  badge: true,

  /* ---- 操作 ---- */
  /** メッセージへホバー時に保存ボタンを出すか */
  hoverToolbar: true,
  /** 拡張で既読にしたとき、Chat 本体の未読状態も書き換えるか */
  syncReadState: false,
};

export const LIMITS = {
  mentions: 300,
  saved: 1000,
  /** 同時に投げる API リクエスト数 */
  concurrency: 5,
  /** スペース一覧を再取得する間隔 */
  spacesTtlMs: 15 * 60 * 1000,
  /** 初回ポーリング時にさかのぼる範囲 */
  backfillMs: 10 * 60 * 1000,
  /** 未読を数える上限。これを超えたら "N+" と表示する */
  unreadPageSize: 25,
  /** 一度も読んでいないスペースで、未読としてさかのぼる上限 */
  unreadFloorMs: 30 * 24 * 60 * 60 * 1000,
};

export const KEYS = {
  mentions: 'mentions',
  saved: 'saved',
  unread: 'unread',
  notifMap: 'notifMap',
  pollState: 'pollState',
};

export async function getSettings() {
  const stored = await chrome.storage.sync.get('settings');
  return { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
}

export async function setSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await chrome.storage.sync.set({ settings: next });
  return next;
}
