/**
 * Service worker: 認証・ポーリングのスケジュール・データ操作の窓口。
 *
 * 検知ロジックは lib/poller.js、副作用は lib/notify.js に置いてあり、
 * ここは「いつ動かすか」と「UI からの要求をさばく」だけを持つ。
 */

import { KEYS, LIMITS, getSettings } from './lib/defaults.js';
import { readList, writeList, capFor, getPollState, resetPollState } from './lib/store.js';
import { refreshBadge, showNotification, playChime, openChatUrl } from './lib/notify.js';
import { pollOnce, scanUnread, pollPeriodMinutes } from './lib/poller.js';
import { updateSpaceReadState, ApiError } from './lib/chat-api.js';
import {
  connect as authConnect,
  disconnect as authDisconnect,
  getAuthStatus,
  getOAuthConfig,
  setOAuthConfig,
  AuthError,
} from './lib/auth.js';

const ALARM = 'chat-booster-poll';

/* ------------------------------------------------------------------ *
 * スケジュール
 * ------------------------------------------------------------------ */

async function scheduleAlarm() {
  const settings = await getSettings();
  const periodInMinutes = pollPeriodMinutes(settings);
  await chrome.alarms.clear(ALARM);
  await chrome.alarms.create(ALARM, { periodInMinutes, delayInMinutes: 0.1 });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM) return;
  await pollOnce();
  // 未読スキャンは重いので、自前の間隔判定で間引かれる（too-soon なら即返る）
  await scanUnread();
});

/**
 * Chat のタブで DOM が動いた合図。API より先に「何か来た」ことだけは分かるので、
 * ポーリング間隔を待たずに取りに行く。連打されるので間引く。
 */
let lastNudge = 0;
async function nudge() {
  const settings = await getSettings();
  if (!settings.domAccelerator) return;
  const now = Date.now();
  if (now - lastNudge < 5000) return;
  lastNudge = now;
  await pollOnce();
}

/* ------------------------------------------------------------------ *
 * 認証
 * ------------------------------------------------------------------ */

async function connect() {
  try {
    await authConnect();
    await resetPollState();
    const result = await pollOnce({ force: true, silent: true });
    await scanUnread({ force: true });
    await scheduleAlarm();
    return { ok: true, result };
  } catch (error) {
    return {
      ok: false,
      error: error?.message || String(error),
      needsSetup: error instanceof AuthError ? error.needsSetup : false,
    };
  }
}

async function disconnect() {
  await authDisconnect();
  await resetPollState();
  await chrome.storage.local.set({ [KEYS.unread]: [] });
  await chrome.action.setBadgeText({ text: '' });
  await chrome.alarms.clear(ALARM);
  return { ok: true };
}

async function status() {
  const [auth, state, settings] = await Promise.all([
    getAuthStatus(),
    getPollState(),
    getSettings(),
  ]);
  return {
    ...auth,
    me: state.me,
    spaceCount: state.spaces.length,
    lastOkAt: state.lastOkAt,
    lastPollAt: state.lastPollAt,
    lastError: state.lastError,
    backoffUntil: state.backoffUntil,
    pollSeconds: settings.pollSeconds,
  };
}

/* ------------------------------------------------------------------ *
 * データ操作
 * ------------------------------------------------------------------ */

async function saveItem(item) {
  const saved = await readList(KEYS.saved);
  const key = item.key || item.id || `manual-${Date.now()}`;
  const without = saved.filter((s) => s.key !== key);
  const record = { ...item, key, kind: 'saved', savedAt: Date.now() };
  await writeList(KEYS.saved, [record, ...without], LIMITS.saved);
  return { ok: true, count: without.length + 1 };
}

async function markRead({ keys, all }) {
  const settings = await getSettings();
  const mentions = await readList(KEYS.mentions);
  const target = new Set(keys || []);
  const touched = [];

  const next = mentions.map((m) => {
    if (!m.read && (all || target.has(m.key))) {
      touched.push(m);
      return { ...m, read: true };
    }
    return m;
  });

  await writeList(KEYS.mentions, next, LIMITS.mentions);
  await refreshBadge();

  // Chat 本体の未読も動かすのは明示的にオンにしたときだけ（既定オフ）
  if (settings.syncReadState && touched.length > 0) {
    const latestPerSpace = new Map();
    for (const item of touched) {
      if (!item.space || !item.createTime) continue;
      const current = latestPerSpace.get(item.space);
      if (!current || item.createTime > current) latestPerSpace.set(item.space, item.createTime);
    }
    await Promise.all(
      [...latestPerSpace].map(([space, time]) =>
        updateSpaceReadState(space, time).catch((err) => {
          console.warn('[chat-booster] 既読同期に失敗:', space, err?.message);
        })
      )
    );
  }

  return { ok: true, synced: settings.syncReadState };
}

async function muteSpace(space, muted) {
  const settings = await getSettings();
  const set = new Set(settings.mutedSpaces || []);
  if (muted) set.add(space);
  else set.delete(space);
  await chrome.storage.sync.set({ settings: { ...settings, mutedSpaces: [...set] } });
  // ミュートしたスペースを未読一覧からも即座に消す
  const unread = await readList(KEYS.unread);
  await chrome.storage.local.set({
    [KEYS.unread]: unread.filter((u) => !set.has(u.space)),
  });
  return { ok: true, mutedSpaces: [...set] };
}

/** スペースをまるごと既読にする（Chat 本体の状態を書き換える） */
async function markSpaceRead(space) {
  const nowIso = new Date().toISOString();
  await updateSpaceReadState(space, nowIso);
  const unread = await readList(KEYS.unread);
  await chrome.storage.local.set({
    [KEYS.unread]: unread.filter((u) => u.space !== space),
  });
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * メッセージルーティング
 * ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target === 'offscreen') return false;

  (async () => {
    switch (msg?.type) {
      case 'CONNECT':
        sendResponse(await connect());
        break;

      case 'DISCONNECT':
        sendResponse(await disconnect());
        break;

      case 'STATUS':
        sendResponse(await status());
        break;

      case 'GET_OAUTH_CONFIG':
        sendResponse(await getOAuthConfig());
        break;

      case 'SET_OAUTH_CONFIG':
        // 認証情報が変わったら、今のトークンは無効なので捨てる
        await authDisconnect();
        await resetPollState();
        sendResponse({ ok: true, config: await setOAuthConfig(msg.config) });
        break;

      // ボタン操作。バックオフ中でも無理やり取りに行く。
      case 'POLL_NOW':
        sendResponse(await pollOnce({ force: true }));
        break;

      // 定期的な催促。レート制限中はおとなしく見送る。
      case 'POLL_TICK':
        sendResponse(await pollOnce());
        break;

      case 'DOM_ACTIVITY':
        nudge();
        sendResponse({ ok: true });
        break;

      case 'SAVE_MESSAGE':
        sendResponse(await saveItem(msg.payload));
        break;

      case 'LIST': {
        const [mentions, saved, unread, settings] = await Promise.all([
          readList(KEYS.mentions),
          readList(KEYS.saved),
          readList(KEYS.unread),
          getSettings(),
        ]);
        sendResponse({ mentions, saved, unread, mutedSpaces: settings.mutedSpaces || [] });
        break;
      }

      case 'SCAN_UNREAD':
        sendResponse(await scanUnread({ force: msg.force !== false }));
        break;

      case 'MARK_SPACE_READ':
        sendResponse(await markSpaceRead(msg.space));
        break;

      case 'MARK_READ':
        sendResponse(await markRead(msg));
        break;

      case 'MUTE_SPACE':
        sendResponse(await muteSpace(msg.space, msg.muted));
        break;

      case 'REMOVE': {
        const key = msg.listKey === 'saved' ? KEYS.saved : KEYS.mentions;
        const list = await readList(key);
        await writeList(
          key,
          list.filter((i) => i.key !== msg.key),
          capFor(key)
        );
        await refreshBadge();
        sendResponse({ ok: true });
        break;
      }

      case 'CLEAR': {
        const key = msg.listKey === 'saved' ? KEYS.saved : KEYS.mentions;
        await chrome.storage.local.set({ [key]: [] });
        await refreshBadge();
        sendResponse({ ok: true });
        break;
      }

      case 'OPEN_URL':
        await openChatUrl(msg.url);
        sendResponse({ ok: true });
        break;

      case 'TEST_NOTIFY': {
        const settings = await getSettings();
        await showNotification({
          key: 'test',
          sender: 'Chat Booster',
          spaceName: 'テスト',
          text: 'この見た目・音でメンションを通知します。',
          url: 'https://chat.google.com/',
        });
        if (settings.sound) await playChime(settings.volume);
        sendResponse({ ok: true });
        break;
      }

      default:
        sendResponse({ ok: false, error: `unknown message type: ${msg?.type}` });
    }
  })().catch((error) => {
    const detail = error instanceof ApiError ? error.message : String(error?.message || error);
    console.warn('[chat-booster] メッセージ処理に失敗:', detail);
    sendResponse({ ok: false, error: detail });
  });

  return true; // 非同期レスポンスを使う
});

/* ------------------------------------------------------------------ *
 * ショートカット
 * ------------------------------------------------------------------ */

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'save-hovered-message') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'SAVE_HOVERED' });
  } catch {
    // Chat 以外のタブ。何もしない。
  }
});

/* ------------------------------------------------------------------ *
 * ライフサイクル
 * ------------------------------------------------------------------ */

chrome.runtime.onInstalled.addListener(async (details) => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  await refreshBadge();
  await scheduleAlarm();
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
});

chrome.runtime.onStartup.addListener(async () => {
  await refreshBadge();
  await scheduleAlarm();
  pollOnce();
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'sync' || !changes.settings) return;
  await refreshBadge();
  const before = changes.settings.oldValue || {};
  const after = changes.settings.newValue || {};
  if (before.pollSeconds !== after.pollSeconds) await scheduleAlarm();
});
