/**
 * Service worker: 認証・ポーリングのスケジュール・データ操作の窓口。
 *
 * 検知ロジックは lib/poller.js、副作用は lib/notify.js に置いてあり、
 * ここは「いつ動かすか」と「UI からの要求をさばく」だけを持つ。
 */

import { KEYS, LIMITS, getSettings } from './lib/defaults.js';
import { readList, writeList, capFor, getPollState, resetPollState } from './lib/store.js';
import { refreshBadge, showNotification, playChime, openChatUrl } from './lib/notify.js';
import { pollOnce, pollPeriodMinutes } from './lib/poller.js';
import {
  getToken,
  clearToken,
  isConnected,
  updateSpaceReadState,
  ApiError,
} from './lib/chat-api.js';

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

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) pollOnce();
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
    await getToken({ interactive: true });
    await resetPollState();
    const result = await pollOnce({ force: true, silent: true });
    await scheduleAlarm();
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

async function disconnect() {
  await clearToken();
  await resetPollState();
  await chrome.action.setBadgeText({ text: '' });
  await chrome.alarms.clear(ALARM);
  return { ok: true };
}

async function status() {
  const [connected, state, settings] = await Promise.all([
    isConnected(),
    getPollState(),
    getSettings(),
  ]);
  return {
    connected,
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
  return { ok: true, mutedSpaces: [...set] };
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
        const [mentions, saved, settings] = await Promise.all([
          readList(KEYS.mentions),
          readList(KEYS.saved),
          getSettings(),
        ]);
        sendResponse({ mentions, saved, mutedSpaces: settings.mutedSpaces || [] });
        break;
      }

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
