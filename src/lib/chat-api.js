/**
 * Google Chat REST API クライアント（ユーザー認証 / OAuth）。
 *
 * 認証は chrome.identity.getAuthToken に任せる。manifest.json の oauth2.client_id に
 * 「Chrome 拡張機能」タイプの OAuth クライアント ID を入れておくこと。
 * リフレッシュは Chrome が面倒を見てくれるので、こちらは 401 時にキャッシュを捨てて
 * 一度だけ再試行する。
 *
 * 参考:
 *   spaces.list            … user auth / chat.spaces.readonly
 *   spaces.messages.list   … user auth / chat.messages.readonly, filter=createTime > "RFC3339"
 *   users.spaces.spaceReadState get|update … chat.users.readstate
 */

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
 * トークン
 * ------------------------------------------------------------------ */

/** getAuthToken は Chrome のバージョンで string / {token} の両方を返しうる */
function unwrapToken(result) {
  return typeof result === 'string' ? result : result?.token;
}

export async function getToken({ interactive = false } = {}) {
  const result = await chrome.identity.getAuthToken({ interactive });
  const token = unwrapToken(result);
  if (!token) throw new Error('アクセストークンを取得できませんでした');
  return token;
}

export async function clearToken() {
  try {
    const token = unwrapToken(await chrome.identity.getAuthToken({ interactive: false }));
    if (token) {
      await chrome.identity.removeCachedAuthToken({ token });
      // サーバ側の許可も落として、次回きれいに再同意させる
      await fetch(`https://oauth2.googleapis.com/revoke?token=${token}`, { method: 'POST' }).catch(
        () => {}
      );
    }
  } catch {
    /* もともと未接続 */
  }
}

/** 未接続なら false を返すだけで、UI をブロックしない */
export async function isConnected() {
  try {
    await getToken({ interactive: false });
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * リクエスト
 * ------------------------------------------------------------------ */

async function request(path, { method = 'GET', params, body, _retried = false } = {}) {
  const token = await getToken({ interactive: false });
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
    // トークンが失効している。キャッシュを捨てて一度だけやり直す。
    await chrome.identity.removeCachedAuthToken({ token });
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

export async function getSpaceReadState(space) {
  const spaceId = space.split('/').pop();
  return request(`users/me/spaces/${spaceId}/spaceReadState`);
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
