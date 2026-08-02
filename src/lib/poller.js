/**
 * Chat API を定期的に叩いて新着メンションを拾う本体。
 *
 * DOM は一切見ない。メンション判定は API が返す USER_MENTION アノテーションで行うので、
 * 「名前が本文に出ただけ」の誤検知や、Chat の DOM 変更による破損が起きない。
 *
 * Chat API には拡張機能へ push する仕組みが無い（Workspace Events API の購読先は
 * Pub/Sub でサーバが要る）ため、ポーリングする。開いている Chat タブがあれば
 * content script が変化を知らせてくれるので、その場合は即座に取りに行く。
 */

import { DEFAULT_SETTINGS, KEYS, LIMITS, getSettings } from './defaults.js';
import { getPollState, setPollState, readList, writeList } from './store.js';
import { notifyMentions, refreshBadge } from './notify.js';
import {
  ApiError,
  isConnected,
  getMe,
  listSpaces,
  listMessagesSince,
  spaceLabel,
  messagePermalink,
} from './chat-api.js';

/* ------------------------------------------------------------------ *
 * 並列実行（1件の失敗で全体を止めない）
 * ------------------------------------------------------------------ */

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        out[index] = { ok: true, value: await fn(items[index], index) };
      } catch (error) {
        out[index] = { ok: false, error };
      }
    }
  });
  await Promise.all(workers);
  return out;
}

/* ------------------------------------------------------------------ *
 * メンション判定
 * ------------------------------------------------------------------ */

/**
 * @returns {string[]} 一致した理由のラベル。空配列なら通知対象外。
 */
export function detectMatches(message, space, { me, settings }) {
  const matched = [];
  const text = message.text || message.formattedText || '';

  // 1) API のメンションアノテーション（これが本命。誤検知しない）
  for (const annotation of message.annotations || []) {
    if (annotation.type !== 'USER_MENTION') continue;
    const mention = annotation.userMention;
    if (!mention?.user) continue;
    // ADD（スペースへの追加）はメンションではない
    if (mention.type && mention.type !== 'MENTION') continue;

    const user = mention.user;
    const isMe =
      (me?.name && user.name === me.name) ||
      (settings.displayName && user.displayName === settings.displayName);
    if (isMe) matched.push('@メンション');
  }

  // 2) @all / @here（全体宛はアノテーションに乗らないことがあるのでテキストでも見る）
  if (settings.matchAll && /@(all|here|everyone|全員)\b/i.test(text)) {
    matched.push('@all');
  }

  // 3) キーワード（Slack のハイライトワード相当）
  const lower = text.toLowerCase();
  for (const raw of settings.keywords || []) {
    const keyword = String(raw).trim();
    if (keyword && lower.includes(keyword.toLowerCase())) matched.push(keyword);
  }

  // 4) DM は全部拾う
  if (settings.notifyDms && space?.spaceType === 'DIRECT_MESSAGE') {
    matched.push('DM');
  }

  return [...new Set(matched)];
}

function toRecord(message, space, matched) {
  return {
    key: message.name, // "spaces/X/messages/Y" 一意なので dedupe キーにそのまま使える
    id: message.name,
    text: (message.text || message.formattedText || '').slice(0, 2000),
    sender: message.sender?.displayName || message.sender?.name || '(不明)',
    senderId: message.sender?.name || '',
    spaceName: spaceLabel(space),
    space: space?.name || '',
    createTime: message.createTime,
    ts: Date.parse(message.createTime) || Date.now(),
    url: messagePermalink(message),
    matched,
    kind: 'mention',
  };
}

/* ------------------------------------------------------------------ *
 * ポーリング
 * ------------------------------------------------------------------ */

let inFlight = null;

/**
 * 1回ぶんのポーリング。多重起動しないよう in-flight を共有する。
 */
export function pollOnce(options = {}) {
  if (inFlight) return inFlight;
  inFlight = runPoll(options).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runPoll({ force = false, silent = false } = {}) {
  const settings = await getSettings();
  const now = Date.now();

  if (!(await isConnected())) {
    await setPollState({ lastPollAt: now, lastError: 'not-connected' });
    return { ok: false, reason: 'not-connected' };
  }

  let state = await getPollState();
  if (!force && state.backoffUntil > now) {
    return { ok: false, reason: 'backoff', until: state.backoffUntil };
  }

  try {
    // --- 自分のユーザー情報（1日1回で十分） ---
    if (!state.me || now - (state.meFetchedAt || 0) > 24 * 60 * 60 * 1000) {
      const me = await getMe();
      state = await setPollState({ me, meFetchedAt: now });
    }

    // --- スペース一覧 ---
    if (state.spaces.length === 0 || now - state.spacesFetchedAt > LIMITS.spacesTtlMs) {
      const spaces = await listSpaces();
      state = await setPollState({ spaces, spacesFetchedAt: now });
    }

    const muted = new Set(settings.mutedSpaces || []);
    const targets = state.spaces.filter((s) => s.name && !muted.has(s.name));
    if (targets.length === 0) {
      await setPollState({ lastPollAt: now, lastOkAt: now, lastError: null });
      return { ok: true, spaces: 0, found: 0 };
    }

    // --- 各スペースの新着 ---
    const cursors = { ...state.cursors };
    const backfillFrom = new Date(now - LIMITS.backfillMs).toISOString();

    const results = await mapPool(targets, LIMITS.concurrency, async (space) => {
      const since = cursors[space.name] || backfillFrom;
      const messages = await listMessagesSince(space.name, since);
      return { space, messages, since };
    });

    const fresh = [];
    let rateLimited = false;
    const errors = [];

    for (const result of results) {
      if (!result.ok) {
        const err = result.error;
        if (err instanceof ApiError && err.status === 429) rateLimited = true;
        // 403（権限が無いスペース）などは黙って飛ばす。毎回出るのでログも1件だけ残す。
        errors.push(err instanceof ApiError ? `${err.status}` : String(err?.message || err));
        continue;
      }

      const { space, messages } = result.value;
      for (const message of messages) {
        if (!message.createTime) continue;
        if (message.deletionMetadata) continue;
        // カーソルは「見たかどうか」に関わらず前へ進める
        if (!cursors[space.name] || message.createTime > cursors[space.name]) {
          cursors[space.name] = message.createTime;
        }
        // 自分の発言は無視
        if (state.me?.name && message.sender?.name === state.me.name) continue;

        const matched = detectMatches(message, space, { me: state.me, settings });
        if (matched.length === 0 && !settings.notifyAllMessages) continue;

        fresh.push(toRecord(message, space, matched.length ? matched : ['新着']));
      }
    }

    // --- 保存 & 通知 ---
    const added = await appendMentions(fresh);

    await setPollState({
      cursors,
      lastPollAt: now,
      lastOkAt: now,
      lastError: errors.length ? `${errors.length}件のスペースで取得に失敗 (${errors[0]})` : null,
      backoffUntil: rateLimited ? now + 5 * 60 * 1000 : 0,
    });

    if (added.length > 0) {
      await refreshBadge();
      // 初回接続時は過去ぶんを一覧に入れるだけで、通知は出さない
      if (!silent) await notifyMentions(added);
    }

    return { ok: true, spaces: targets.length, found: added.length };
  } catch (error) {
    const isApi = error instanceof ApiError;
    const backoffUntil = isApi && error.retryable ? now + 5 * 60 * 1000 : 0;
    await setPollState({
      lastPollAt: now,
      lastError: error?.message || String(error),
      backoffUntil,
    });
    console.warn('[chat-booster] ポーリング失敗:', error);
    return { ok: false, reason: 'error', error: error?.message || String(error) };
  }
}

/** 既存と重複しないものだけ追加して、追加された分を返す */
async function appendMentions(records) {
  if (records.length === 0) return [];
  const existing = await readList(KEYS.mentions);
  const seen = new Set(existing.map((m) => m.key));
  const added = records
    .filter((r) => !seen.has(r.key))
    .map((r) => ({ ...r, read: false, savedAt: Date.now() }));
  if (added.length === 0) return [];

  // 新しい順に並べて保持
  const next = [...added, ...existing].sort((a, b) => (b.ts || 0) - (a.ts || 0));
  await writeList(KEYS.mentions, next, LIMITS.mentions);
  return added;
}

/** 設定のポーリング間隔（alarms の下限に合わせて丸める） */
export function pollPeriodMinutes(settings) {
  const seconds = Math.max(30, Number(settings.pollSeconds) || DEFAULT_SETTINGS.pollSeconds);
  return Math.max(0.5, seconds / 60);
}
