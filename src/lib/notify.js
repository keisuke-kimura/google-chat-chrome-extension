/**
 * 通知・通知音・バッジ。副作用はここに閉じ込める。
 */

import { KEYS, getSettings } from './defaults.js';
import { readList } from './store.js';

const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';

/* ------------------------------------------------------------------ *
 * バッジ
 * ------------------------------------------------------------------ */

export async function refreshBadge() {
  const settings = await getSettings();
  if (!settings.badge) {
    await chrome.action.setBadgeText({ text: '' });
    return;
  }
  const mentions = await readList(KEYS.mentions);
  const unread = mentions.filter((m) => !m.read).length;
  await chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
  await chrome.action.setBadgeText({ text: unread ? String(Math.min(unread, 999)) : '' });
}

/* ------------------------------------------------------------------ *
 * 通知音（offscreen document + Web Audio）
 * ------------------------------------------------------------------ */

let creatingOffscreen = null;

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing.length > 0) return;

  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_PATH,
        reasons: ['AUDIO_PLAYBACK'],
        justification: 'メンション検知時に通知音を鳴らすため',
      })
      .finally(() => {
        creatingOffscreen = null;
      });
  }
  await creatingOffscreen;
}

/**
 * 通知音を鳴らす。preset / volume を省略した場合は設定値を使う。
 */
export async function playSound({ preset, volume } = {}) {
  try {
    const settings = await getSettings();
    await ensureOffscreen();
    await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'PLAY_SOUND',
      preset: preset ?? settings.soundPreset,
      volume: volume ?? settings.volume,
    });
  } catch (err) {
    console.warn('[chat-booster] 通知音の再生に失敗:', err);
  }
}

/* ------------------------------------------------------------------ *
 * デスクトップ通知
 * ------------------------------------------------------------------ */

async function rememberNotification(notifId, item) {
  const got = await chrome.storage.session.get(KEYS.notifMap);
  const map = got[KEYS.notifMap] || {};
  map[notifId] = { url: item.url };
  const entries = Object.entries(map).slice(-50);
  await chrome.storage.session.set({ [KEYS.notifMap]: Object.fromEntries(entries) });
}

export async function showNotification(item) {
  const title = [item.sender, item.spaceName].filter(Boolean).join(' · ') || 'Google Chat';
  const notifId = `cb-${item.key || item.id}-${item.savedAt || Date.now()}`;
  await chrome.notifications.create(notifId, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title,
    message: (item.text || '').slice(0, 220) || '(本文なし)',
    priority: 2,
  });
  await rememberNotification(notifId, item);
  return notifId;
}

/**
 * 複数件まとめて通知する。5件を超えたら1通に集約して通知爆撃を避ける。
 */
export async function notifyMentions(records) {
  if (records.length === 0) return;
  const settings = await getSettings();
  if (!settings.notify) return;

  if (!settings.notifyWhenFocused && (await isChatTabFocused())) return;

  if (records.length <= 5) {
    for (const record of records) await showNotification(record);
  } else {
    const spaces = [...new Set(records.map((r) => r.spaceName).filter(Boolean))];
    await showNotification({
      key: 'digest',
      sender: `新着メンション ${records.length} 件`,
      spaceName: spaces.slice(0, 3).join(' / '),
      text: records
        .slice(0, 4)
        .map((r) => `・${r.sender}: ${(r.text || '').slice(0, 40)}`)
        .join('\n'),
      url: records[0].url,
    });
  }

  if (settings.sound) await playSound();
}

/** Google Chat のタブがアクティブかつウィンドウがフォーカスされているか */
async function isChatTabFocused() {
  try {
    const tabs = await chrome.tabs.query({
      active: true,
      url: ['https://chat.google.com/*', 'https://mail.google.com/chat/*'],
    });
    for (const tab of tabs) {
      const win = await chrome.windows.get(tab.windowId).catch(() => null);
      if (win?.focused) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * 既存の Google Chat タブがあればそれを再利用してフォーカスする。
 */
export async function openChatUrl(url) {
  const target = url || 'https://chat.google.com/';
  const tabs = await chrome.tabs.query({
    url: ['https://chat.google.com/*', 'https://mail.google.com/chat/*'],
  });
  if (tabs.length > 0) {
    const tab = tabs[0];
    await chrome.tabs.update(tab.id, { active: true, url: target });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: target });
  }
}

chrome.notifications.onClicked.addListener(async (notifId) => {
  const got = await chrome.storage.session.get(KEYS.notifMap);
  const entry = (got[KEYS.notifMap] || {})[notifId];
  chrome.notifications.clear(notifId);
  await openChatUrl(entry?.url);
});
