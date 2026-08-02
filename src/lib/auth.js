/**
 * OAuth 認証。クライアント ID を **ユーザーが自分で入力する** 前提の実装。
 *
 * なぜ chrome.identity.getAuthToken を使わないか:
 *   getAuthToken は manifest.json の oauth2.client_id しか読まない。実行時に差し替える
 *   手段が無いので、「利用者が自分の Google Cloud プロジェクトを使う」構成にできない。
 *   そのため launchWebAuthFlow で OAuth のフローを自前で回している。
 *
 * 2通りのフローに対応する（利用者がクライアント シークレットを入れるかで自動判定）:
 *
 *   A. 認可コード + PKCE（シークレットあり）… リフレッシュトークンが得られる。推奨。
 *      バックグラウンドのポーリングが再認証なしで動き続ける。
 *   B. インプリシット（シークレットなし）… 手軽だがリフレッシュトークンが無く、
 *      アクセストークンは約1時間で失効する。失効時は Google のセッションが生きていれば
 *      画面を出さずに取り直す（prompt=none）。ダメなら再接続を促す。
 */

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';

export const SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/chat.spaces.readonly',
  'https://www.googleapis.com/auth/chat.messages.readonly',
  'https://www.googleapis.com/auth/chat.users.readstate',
];

const CONFIG_KEY = 'oauthConfig'; // storage.sync: 利用者が入力した認証情報
const TOKEN_KEY = 'oauthToken'; // storage.local: 取得したトークン（同期しない）

export class AuthError extends Error {
  constructor(message, { needsSetup = false, needsReconnect = false } = {}) {
    super(message);
    this.name = 'AuthError';
    this.needsSetup = needsSetup;
    this.needsReconnect = needsReconnect;
  }
}

/* ------------------------------------------------------------------ *
 * 設定（クライアント ID / シークレット）
 * ------------------------------------------------------------------ */

export async function getOAuthConfig() {
  const got = await chrome.storage.sync.get(CONFIG_KEY);
  const config = got[CONFIG_KEY] || {};
  return {
    clientId: (config.clientId || '').trim(),
    clientSecret: (config.clientSecret || '').trim(),
  };
}

export async function setOAuthConfig(patch) {
  const current = await getOAuthConfig();
  const next = { ...current, ...patch };
  await chrome.storage.sync.set({ [CONFIG_KEY]: next });
  return next;
}

/** Google Cloud Console の「承認済みのリダイレクト URI」に登録してもらう値 */
export function getRedirectUri() {
  return chrome.identity.getRedirectURL();
}

/* ------------------------------------------------------------------ *
 * トークンの保管
 * ------------------------------------------------------------------ */

async function readToken() {
  const got = await chrome.storage.local.get(TOKEN_KEY);
  return got[TOKEN_KEY] || null;
}

async function writeToken(token) {
  await chrome.storage.local.set({ [TOKEN_KEY]: token });
  return token;
}

async function clearStoredToken() {
  await chrome.storage.local.remove(TOKEN_KEY);
}

/* ------------------------------------------------------------------ *
 * PKCE
 * ------------------------------------------------------------------ */

function base64url(bytes) {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomString(byteLength = 48) {
  return base64url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

async function challengeFor(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(digest);
}

/* ------------------------------------------------------------------ *
 * 認可 URL の組み立てと応答の解釈
 * ------------------------------------------------------------------ */

function buildAuthUrl(params) {
  const url = new URL(AUTH_ENDPOINT);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
  }
  return url.toString();
}

/** launchWebAuthFlow の戻り URL から、クエリとフラグメントの両方を拾う */
function parseRedirect(redirectUrl) {
  const url = new URL(redirectUrl);
  const params = new URLSearchParams(url.search);
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ''));
  const get = (key) => params.get(key) || fragment.get(key);
  return {
    code: get('code'),
    accessToken: get('access_token'),
    expiresIn: Number(get('expires_in')) || 0,
    state: get('state'),
    error: get('error'),
    errorDescription: get('error_description'),
  };
}

async function launch(url, interactive) {
  const redirectUrl = await chrome.identity.launchWebAuthFlow({ url, interactive });
  if (!redirectUrl) throw new AuthError('認証が完了しませんでした', { needsReconnect: true });
  const result = parseRedirect(redirectUrl);
  if (result.error) {
    throw new AuthError(`認証を拒否されました: ${result.errorDescription || result.error}`, {
      needsReconnect: true,
    });
  }
  return result;
}

/* ------------------------------------------------------------------ *
 * トークン エンドポイント
 * ------------------------------------------------------------------ */

async function postToken(body) {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.error_description || data.error || `HTTP ${res.status}`;
    throw new AuthError(`トークンの取得に失敗しました: ${detail}`, { needsReconnect: true });
  }
  return data;
}

function toStoredToken(data, previous) {
  return {
    accessToken: data.access_token,
    // refresh_token は初回だけ返ることがあるので、無ければ前の値を引き継ぐ
    refreshToken: data.refresh_token || previous?.refreshToken || null,
    expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
    scope: data.scope || '',
  };
}

/* ------------------------------------------------------------------ *
 * 接続
 * ------------------------------------------------------------------ */

/**
 * 対話的にログインさせてトークンを取得する。
 * クライアント シークレットが設定されていれば認可コード + PKCE、無ければインプリシット。
 */
export async function connect() {
  const { clientId, clientSecret } = await getOAuthConfig();
  if (!clientId) {
    throw new AuthError(
      'クライアント ID が未設定です。設定画面の「接続」で入力してください。',
      { needsSetup: true }
    );
  }

  const redirectUri = getRedirectUri();
  const state = randomString(16);

  if (clientSecret) {
    const verifier = randomString(48);
    const challenge = await challengeFor(verifier);
    const url = buildAuthUrl({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent', // refresh_token を確実に受け取るため
      include_granted_scopes: 'true',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
    });

    const result = await launch(url, true);
    if (result.state !== state) throw new AuthError('認証応答が一致しませんでした');
    if (!result.code) throw new AuthError('認可コードを受け取れませんでした');

    const data = await postToken({
      code: result.code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: verifier,
    });
    return writeToken(toStoredToken(data));
  }

  // シークレット無し = インプリシット
  const url = buildAuthUrl({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'token',
    scope: SCOPES.join(' '),
    include_granted_scopes: 'true',
    state,
  });
  const result = await launch(url, true);
  if (result.state !== state) throw new AuthError('認証応答が一致しませんでした');
  if (!result.accessToken) throw new AuthError('アクセストークンを受け取れませんでした');

  return writeToken({
    accessToken: result.accessToken,
    refreshToken: null,
    expiresAt: Date.now() + (result.expiresIn || 3600) * 1000,
    scope: '',
  });
}

/** 画面を出さずにアクセストークンを取り直す */
async function renew(token) {
  const { clientId, clientSecret } = await getOAuthConfig();

  if (token?.refreshToken && clientSecret) {
    const data = await postToken({
      refresh_token: token.refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
    });
    return writeToken(toStoredToken(data, token));
  }

  // インプリシットの場合は、Google のセッションが生きていれば無画面で取り直せる
  const url = buildAuthUrl({
    client_id: clientId,
    redirect_uri: getRedirectUri(),
    response_type: 'token',
    scope: SCOPES.join(' '),
    include_granted_scopes: 'true',
    prompt: 'none',
  });
  const result = await launch(url, false);
  if (!result.accessToken) {
    throw new AuthError('再接続が必要です', { needsReconnect: true });
  }
  return writeToken({
    accessToken: result.accessToken,
    refreshToken: null,
    expiresAt: Date.now() + (result.expiresIn || 3600) * 1000,
    scope: '',
  });
}

/**
 * API 呼び出し用のアクセストークン。期限が近ければ自動で取り直す。
 */
export async function getAccessToken({ forceRenew = false } = {}) {
  const { clientId } = await getOAuthConfig();
  if (!clientId) {
    throw new AuthError('クライアント ID が未設定です', { needsSetup: true });
  }

  const token = await readToken();
  if (!token) throw new AuthError('未接続です', { needsReconnect: true });

  const stillValid = token.expiresAt - 60_000 > Date.now();
  if (stillValid && !forceRenew) return token.accessToken;

  const renewed = await renew(token);
  return renewed.accessToken;
}

/** 保存済みトークンを捨てる（サーバ側の許可も落とす） */
export async function disconnect() {
  const token = await readToken();
  const target = token?.refreshToken || token?.accessToken;
  if (target) {
    await fetch(`${REVOKE_ENDPOINT}?token=${encodeURIComponent(target)}`, {
      method: 'POST',
    }).catch(() => {});
  }
  await clearStoredToken();
}

/** 未接続でも例外を投げずに状態だけ返す */
export async function getAuthStatus() {
  const { clientId, clientSecret } = await getOAuthConfig();
  const token = await readToken();
  return {
    configured: Boolean(clientId),
    hasSecret: Boolean(clientSecret),
    connected: Boolean(token?.accessToken),
    /** リフレッシュトークンがあれば再認証なしで動き続けられる */
    durable: Boolean(token?.refreshToken),
    expiresAt: token?.expiresAt || 0,
    redirectUri: getRedirectUri(),
  };
}

export async function isConnected() {
  const token = await readToken();
  return Boolean(token?.accessToken);
}
