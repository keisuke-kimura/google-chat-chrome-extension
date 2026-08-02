/**
 * 設定画面。フォームと chrome.storage.sync を双方向にバインドし、変更即保存する。
 * 接続まわりだけは background にお願いする。
 */

import { DEFAULT_SETTINGS, getSettings, setSettings } from '../lib/defaults.js';

const TEXT_FIELDS = ['displayName'];
/** [id, 最小値] — 0 を許す項目があるので下限は個別に持つ */
const NUMBER_FIELDS = [
  ['pollSeconds', 30],
  ['unreadScanSeconds', 0],
];
const CHECK_FIELDS = [
  'matchAll',
  'notifyDms',
  'notifyAllMessages',
  'notify',
  'notifyWhenFocused',
  'sound',
  'badge',
  'domAccelerator',
  'hoverToolbar',
  'syncReadState',
];

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg).catch((e) => ({ ok: false, error: String(e) }));

let statusTimer = null;
function flash(text = '保存しました') {
  const status = $('status');
  status.textContent = text;
  status.classList.add('show');
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => status.classList.remove('show'), 1400);
}

/* ------------------------------------------------------------------ *
 * 設定フォーム
 * ------------------------------------------------------------------ */

function fill(settings) {
  for (const key of TEXT_FIELDS) $(key).value = settings[key] ?? '';
  for (const [key] of NUMBER_FIELDS) $(key).value = settings[key] ?? DEFAULT_SETTINGS[key];
  for (const key of CHECK_FIELDS) $(key).checked = Boolean(settings[key]);
  $('keywords').value = (settings.keywords || []).join('\n');
  $('volume').value = settings.volume ?? DEFAULT_SETTINGS.volume;
  $('volumeOut').textContent = `${Math.round(($('volume').value || 0) * 100)}%`;
}

async function persist(patch) {
  await setSettings(patch);
  flash();
}

function wireSettings() {
  for (const key of TEXT_FIELDS) {
    $(key).addEventListener('change', () => persist({ [key]: $(key).value.trim() }));
  }
  for (const key of CHECK_FIELDS) {
    $(key).addEventListener('change', () => persist({ [key]: $(key).checked }));
  }
  for (const [key, min] of NUMBER_FIELDS) {
    $(key).addEventListener('change', () => {
      const raw = Number($(key).value);
      // 0 を明示的に入れたときは 0（無効）として扱う
      const value = raw === 0 && min === 0 ? 0 : Math.max(min, raw || DEFAULT_SETTINGS[key]);
      $(key).value = value;
      persist({ [key]: value });
    });
  }

  $('keywords').addEventListener('change', () => {
    const keywords = $('keywords')
      .value.split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    persist({ keywords });
  });

  $('volume').addEventListener('input', () => {
    $('volumeOut').textContent = `${Math.round($('volume').value * 100)}%`;
  });
  $('volume').addEventListener('change', () => persist({ volume: Number($('volume').value) }));

  $('test').addEventListener('click', async () => {
    await send({ type: 'TEST_NOTIFY' });
    flash('通知を送りました');
  });
}

/* ------------------------------------------------------------------ *
 * 接続
 * ------------------------------------------------------------------ */

function fmtTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('ja-JP', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

async function renderStatus() {
  const s = await send({ type: 'STATUS' });
  const dot = $('conn-dot');
  const title = $('conn-title');
  const detail = $('conn-detail');
  const error = $('conn-error');

  if (!s || s.ok === false) {
    dot.className = 'dot bad';
    title.textContent = '状態を取得できません';
    detail.textContent = s?.error || '';
    return;
  }

  $('redirect-uri').textContent = s.redirectUri || '—';

  $('connect').style.display = s.connected ? 'none' : '';
  $('connect').disabled = !s.configured;
  $('disconnect').style.display = s.connected ? '' : 'none';
  $('poll').style.display = s.connected ? '' : 'none';

  if (s.connected) {
    dot.className = 'dot good';
    title.textContent = s.me?.email || s.me?.displayName || '接続済み';
    const durability = s.durable
      ? '自動更新あり'
      : `トークン有効 ${fmtTime(s.expiresAt)} まで（シークレット未設定）`;
    detail.textContent =
      `監視中のスペース ${s.spaceCount} 件・最終同期 ${fmtTime(s.lastOkAt)}・${durability}`;
  } else if (!s.configured) {
    dot.className = 'dot idle';
    title.textContent = 'クライアント ID が未設定';
    detail.textContent = '下の手順で取得した ID を入力してください。';
  } else {
    dot.className = 'dot idle';
    title.textContent = '未接続';
    detail.textContent = 'Google アカウントに接続すると監視を開始します。';
  }

  if (s.lastError && s.lastError !== 'not-connected') {
    error.textContent = `直近のエラー: ${s.lastError}`;
    error.style.display = '';
  } else {
    error.style.display = 'none';
  }
}

async function fillCredentials() {
  const config = (await send({ type: 'GET_OAUTH_CONFIG' })) || {};
  $('clientId').value = config.clientId || '';
  $('clientSecret').value = config.clientSecret || '';
}

function wireConnection() {
  $('copy-redirect').addEventListener('click', async () => {
    const uri = $('redirect-uri').textContent.trim();
    if (!uri || uri === '—') return;
    try {
      await navigator.clipboard.writeText(uri);
      flash('リダイレクト URI をコピーしました');
    } catch {
      flash('コピーに失敗しました');
    }
  });

  // 認証情報を変えると今のトークンは無効になるので、background 側で接続解除される
  for (const key of ['clientId', 'clientSecret']) {
    $(key).addEventListener('change', async () => {
      await send({ type: 'SET_OAUTH_CONFIG', config: { [key]: $(key).value.trim() } });
      flash('認証情報を保存しました（再接続が必要です）');
      renderStatus();
    });
  }

  $('connect').addEventListener('click', async () => {
    $('connect').disabled = true;
    const res = await send({ type: 'CONNECT' });
    $('connect').disabled = false;
    if (!res?.ok) {
      $('conn-error').textContent = `接続に失敗: ${res?.error || '不明なエラー'}`;
      $('conn-error').style.display = '';
    }
    renderStatus();
  });

  $('disconnect').addEventListener('click', async () => {
    if (!confirm('接続を解除します。保存済みのデータは残ります。')) return;
    await send({ type: 'DISCONNECT' });
    renderStatus();
  });

  $('poll').addEventListener('click', async () => {
    $('poll').disabled = true;
    $('poll').textContent = '同期中…';
    const res = await send({ type: 'POLL_NOW' });
    await send({ type: 'SCAN_UNREAD', force: true });
    $('poll').disabled = false;
    $('poll').textContent = '今すぐ同期';
    flash(res?.ok ? `同期しました（新着 ${res.found ?? 0} 件）` : '同期に失敗しました');
    renderStatus();
  });
}

/* ------------------------------------------------------------------ */

(async () => {
  fill(await getSettings());
  await fillCredentials();
  wireSettings();
  wireConnection();
  await renderStatus();
  setInterval(renderStatus, 15000);
})();
