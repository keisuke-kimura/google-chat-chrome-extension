/**
 * Google Chat REST API クライアント（ユーザー認証 / OAuth）。
 *
 * 認証・トークン管理は lib/auth.js が持つ。クライアント ID は利用者が設定画面で
 * 入力したものを使う（manifest には埋め込まない）。
 *
 * 参考:
 *   spaces.list            … user auth / chat.spaces.readonly
 *   spaces.messages.list   … user auth / chat.messages.readonly, filter=createTime > "RFC3339"
 *   users.spaces.spaceReadState get|update … chat.users.readstate
 */

import { getAccessToken } from './auth.js';

const CHAT_BASE = 'https://chat.googleapis.com/v1';
const USERINFO = 'https://www.googleapis.com/oauth2/v3/userinfo';

export class ApiError extends Error {
  constructor(status, body, url) {
    super(`Chat API ${status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    this.url = url;
  }

  /** 一時的な失敗（時間を置けば直る）か */
  get retryable() {
    return this.status === 429 || this.status >= 500;
  }
}

/* ------------------------------------------------------------------ *
 * リクエスト
 * ------------------------------------------------------------------ */

async function request(path, { method = 'GET', params, body, _retried = false } = {}) {
  const token = await getAccessToken({ forceRenew: _retried });
  const url = new URL(path.startsWith('http') ? path : `${CHAT_BASE}/${path}`);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401 && !_retried) {
    // トークンが失効している。取り直して一度だけやり直す。
    return request(path, { method, params, body, _retried: true });
  }

  if (!res.ok) {
    let payload;
    try {
      payload = await res.json();
    } catch {
      payload = await res.text().catch(() => '');
    }
    throw new ApiError(res.status, payload?.error?.message || payload, url.toString());
  }

  if (res.status === 204) return null;
  return res.json();
}

/** nextPageToken を上限つきで辿る */
async function paged(path, { params, itemsKey, maxPages = 5 } = {}) {
  const items = [];
  let pageToken;
  for (let page = 0; page < maxPages; page += 1) {
    const data = await request(path, { params: { ...params, pageToken } });
    items.push(...(data?.[itemsKey] || []));
    pageToken = data?.nextPageToken;
    if (!pageToken) break;
  }
  return items;
}

/* ------------------------------------------------------------------ *
 * エンドポイント
 * ------------------------------------------------------------------ */

/** 自分のユーザー ID。Chat の users/{id} は OAuth の sub と同じ値。 */
export async function getMe() {
  const info = await request(USERINFO);
  return {
    id: info.sub,
    name: `users/${info.sub}`,
    displayName: info.name || '',
    email: info.email || '',
  };
}

/** 自分が参加しているスペース・グループ・DM */
export async function listSpaces() {
  return paged('spaces', { params: { pageSize: 1000 }, itemsKey: 'spaces' });
}

/**
 * 指定スペースの、sinceIso より後に作られたメッセージを古い順で。
 * @param {string} space "spaces/XXXX"
 * @param {string} sinceIso RFC-3339
 */
export async function listMessagesSince(space, sinceIso, { pageSize = 50, maxPages = 3 } = {}) {
  return paged(`${space}/messages`, {
    params: {
      pageSize,
      orderBy: 'createTime ASC',
      filter: `createTime > "${sinceIso}"`,
    },
    itemsKey: 'messages',
    maxPages,
  });
}

/**
 * 未読メッセージ（lastReadTime より後）を新しい順に取る。
 * 「何件あるか」と「一覧に出すプレビュー」を 1 リクエストで兼ねる。
 */
export async function listUnreadMessages(space, lastReadTimeIso, { pageSize = 25 } = {}) {
  const data = await request(`${space}/messages`, {
    params: {
      pageSize,
      orderBy: 'createTime DESC',
      filter: `createTime > "${lastReadTimeIso}"`,
    },
  });
  return {
    messages: data?.messages || [],
    /** 次ページがある = 上限まで数えきれていない */
    hasMore: Boolean(data?.nextPageToken),
  };
}

export async function getSpaceReadState(space) {
  const spaceId = space.split('/').pop();
  return request(`users/me/spaces/${spaceId}/spaceReadState`);
}

/** スペースへのリンク */
export function spacePermalink(spaceName) {
  const id = String(spaceName || '').split('/').pop();
  return id ? `https://chat.google.com/room/${id}` : 'https://chat.google.com/';
}

/** lastReadTime までを既読にする（Chat 本体の未読状態を実際に書き換える） */
export async function updateSpaceReadState(space, lastReadTimeIso) {
  const spaceId = space.split('/').pop();
  return request(`users/me/spaces/${spaceId}/spaceReadState`, {
    method: 'PATCH',
    params: { updateMask: 'lastReadTime' },
    body: { lastReadTime: lastReadTimeIso },
  });
}

/* ------------------------------------------------------------------ *
 * ヘルパ
 * ------------------------------------------------------------------ */

/** スペースの表示名。DM は displayName が空なので相手名などで代替する。 */
export function spaceLabel(space) {
  if (!space) return '';
  if (space.displayName) return space.displayName;
  if (space.spaceType === 'DIRECT_MESSAGE') return 'ダイレクトメッセージ';
  if (space.spaceType === 'GROUP_CHAT') return 'グループチャット';
  return space.name || '';
}

/** メッセージへのリンク。Chat の Web UI が解釈できる形に組み立てる。 */
export function messagePermalink(message) {
  // message.name = "spaces/AAAA/messages/BBBB.CCCC"
  const m = /^spaces\/([^/]+)\/messages\/(.+)$/.exec(message?.name || '');
  if (!m) return 'https://chat.google.com/';
  return `https://chat.google.com/room/${m[1]}/${m[2]}`;
}
