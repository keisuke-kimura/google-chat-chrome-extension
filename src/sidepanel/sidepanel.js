/**
 * サイドパネル: メンションフィード / 未読スペース / 保存済み一覧。
 * データは background 経由でのみ読み書きし、storage の変更を購読して自動更新する。
 * パネルを開いている間は少し短い間隔でポーリングを促す。
 */

const els = {
  list: document.getElementById('list'),
  search: document.getElementById('search'),
  tabs: document.querySelectorAll('.tab'),
  countMentions: document.getElementById('count-mentions'),
  countUnread: document.getElementById('count-unread'),
  countSaved: document.getElementById('count-saved'),
  markAll: document.getElementById('mark-all'),
  sync: document.getElementById('sync'),
  clear: document.getElementById('clear'),
  settings: document.getElementById('settings'),
  tpl: document.getElementById('item-tpl'),
  unreadTpl: document.getElementById('unread-tpl'),
  banner: document.getElementById('banner'),
  bannerText: document.getElementById('banner-text'),
  bannerAction: document.getElementById('banner-action'),
};

let view = 'mentions';
let data = { mentions: [], saved: [], unread: [], mutedSpaces: [] };
let query = '';

const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);

/* ------------------------------------------------------------------ *
 * 接続バナー
 * ------------------------------------------------------------------ */

async function renderBanner() {
  const status = await send({ type: 'STATUS' });
  if (status?.connected) {
    if (status.lastError && status.lastError !== 'not-connected') {
      showBanner(`同期エラー: ${status.lastError}`, '再試行', () => send({ type: 'POLL_NOW' }));
    } else {
      els.banner.hidden = true;
    }
    return;
  }
  showBanner('Google アカウントに未接続です', '接続する', () => chrome.runtime.openOptionsPage());
}

function showBanner(text, actionLabel, onClick) {
  els.banner.hidden = false;
  els.bannerText.textContent = text;
  els.bannerAction.textContent = actionLabel;
  els.bannerAction.onclick = async () => {
    await onClick();
    setTimeout(renderBanner, 500);
  };
}

/* ------------------------------------------------------------------ *
 * 一覧
 * ------------------------------------------------------------------ */

async function refresh() {
  const res = await send({ type: 'LIST' });
  if (res) data = { mutedSpaces: [], unread: [], ...res };
  render();
}

function relTime(ts) {
  if (!ts) return '';
  const min = Math.floor((Date.now() - ts) / 60000);
  if (min < 1) return 'たった今';
  if (min < 60) return `${min}分前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}時間前`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}日前`;
  return new Date(ts).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' });
}

/** 一致語をハイライトしつつ、必ずテキストとして挿入する（XSS を避ける） */
function renderText(node, text, terms) {
  node.textContent = '';
  const needles = (terms || [])
    .filter((t) => t && !['DM', '新着', '@メンション'].includes(t))
    .map((t) => t.toLowerCase());
  if (needles.length === 0) {
    node.textContent = text;
    return;
  }
  const lower = text.toLowerCase();
  let i = 0;
  while (i < text.length) {
    let hitAt = -1;
    let hitLen = 0;
    for (const n of needles) {
      const at = lower.indexOf(n, i);
      if (at !== -1 && (hitAt === -1 || at < hitAt)) {
        hitAt = at;
        hitLen = n.length;
      }
    }
    if (hitAt === -1) {
      node.appendChild(document.createTextNode(text.slice(i)));
      break;
    }
    if (hitAt > i) node.appendChild(document.createTextNode(text.slice(i, hitAt)));
    const mark = document.createElement('mark');
    mark.textContent = text.slice(hitAt, hitAt + hitLen);
    node.appendChild(mark);
    i = hitAt + hitLen;
  }
}

function currentList() {
  const list = view === 'saved' ? data.saved : view === 'unread' ? data.unread : data.mentions;
  if (!query) return list;
  const q = query.toLowerCase();
  return list.filter((i) =>
    [i.text, i.latestText, i.sender, i.latestSender, i.spaceName].some((v) =>
      (v || '').toLowerCase().includes(q)
    )
  );
}

const EMPTY_TEXT = {
  mentions:
    'メンションはまだありません。\n自分宛の @メンション と、設定したキーワードがここに溜まります。',
  unread:
    '未読はありません。\nGoogle Chat 側の既読状態をそのまま映しています。',
  saved:
    'まだ保存がありません。\nGoogle Chat のメッセージにカーソルを合わせて「★ 保存」、または Alt+S。',
};

function render() {
  const unreadMentions = data.mentions.filter((m) => !m.read).length;
  const unreadTotal = data.unread.reduce((sum, u) => sum + (u.count || 0), 0);

  els.countMentions.textContent = unreadMentions ? String(unreadMentions) : '';
  els.countUnread.textContent = unreadTotal ? String(Math.min(unreadTotal, 999)) : '';
  els.countSaved.textContent = data.saved.length ? String(data.saved.length) : '';

  els.markAll.style.display = view === 'mentions' ? '' : 'none';
  els.clear.style.display = view === 'unread' ? 'none' : '';

  const list = currentList();
  els.list.textContent = '';

  if (list.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = EMPTY_TEXT[view];
    els.list.appendChild(empty);
    return;
  }

  const renderer = view === 'unread' ? renderUnread : renderItem;
  for (const item of list) els.list.appendChild(renderer(item));
}

/** 未読スペース1件 */
function renderUnread(item) {
  const node = els.unreadTpl.content.firstElementChild.cloneNode(true);

  node.querySelector('.badge-count').textContent = item.hasMore
    ? `${item.count}+`
    : String(item.count);
  node.querySelector('.space').textContent = item.spaceName || item.space;
  node.querySelector('.when').textContent = relTime(item.ts);
  node.querySelector('.latest-sender').textContent = item.latestSender
    ? `${item.latestSender}: `
    : '';
  node.querySelector('.latest-text').textContent = item.latestText || '';

  const muteBtn = node.querySelector('.mute');
  if (data.mutedSpaces.includes(item.space)) muteBtn.textContent = '🔔';

  node.querySelector('.open').addEventListener('click', async () => {
    await send({ type: 'OPEN_URL', url: item.url });
  });

  node.querySelector('.read').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = '…';
    const res = await send({ type: 'MARK_SPACE_READ', space: item.space });
    if (!res?.ok) {
      btn.disabled = false;
      btn.textContent = '失敗';
    }
    refresh();
  });

  muteBtn.addEventListener('click', async () => {
    const muted = !data.mutedSpaces.includes(item.space);
    await send({ type: 'MUTE_SPACE', space: item.space, muted });
    refresh();
  });

  return node;
}

function renderItem(item) {
  const node = els.tpl.content.firstElementChild.cloneNode(true);
  if (view === 'mentions' && !item.read) node.classList.add('is-unread');

  node.querySelector('.sender').textContent = item.sender || '(送信者不明)';
  node.querySelector('.space').textContent = item.spaceName || '';
  node.querySelector('.when').textContent = relTime(item.ts || item.savedAt);
  renderText(node.querySelector('.text'), item.text || '', item.matched);

  const chips = node.querySelector('.chips');
  for (const term of item.matched || []) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = term;
    chips.appendChild(chip);
  }

  const saveBtn = node.querySelector('.save');
  const muteBtn = node.querySelector('.mute');
  if (view === 'saved') saveBtn.remove();
  if (!item.space) muteBtn.remove();
  else if (data.mutedSpaces.includes(item.space)) muteBtn.textContent = '🔔';

  node.querySelector('.open').addEventListener('click', async () => {
    await send({ type: 'OPEN_URL', url: item.url });
    if (view === 'mentions' && !item.read) {
      await send({ type: 'MARK_READ', keys: [item.key] });
      refresh();
    }
  });

  saveBtn?.addEventListener('click', async () => {
    await send({ type: 'SAVE_MESSAGE', payload: item });
    saveBtn.textContent = '★ 保存済み';
    refresh();
  });

  muteBtn?.addEventListener('click', async () => {
    const muted = !data.mutedSpaces.includes(item.space);
    await send({ type: 'MUTE_SPACE', space: item.space, muted });
    refresh();
  });

  node.querySelector('.remove').addEventListener('click', async () => {
    await send({ type: 'REMOVE', listKey: view, key: item.key });
    refresh();
  });

  return node;
}

/* ------------------------------------------------------------------ *
 * イベント
 * ------------------------------------------------------------------ */

els.tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    els.tabs.forEach((t) => t.classList.toggle('is-active', t === tab));
    view = tab.dataset.view;
    render();
  });
});

els.search.addEventListener('input', () => {
  query = els.search.value.trim();
  render();
});

els.markAll.addEventListener('click', async () => {
  await send({ type: 'MARK_READ', all: true });
  refresh();
});

els.sync.addEventListener('click', async () => {
  els.sync.textContent = '同期中…';
  await send({ type: 'POLL_NOW' });
  await send({ type: 'SCAN_UNREAD', force: true });
  els.sync.textContent = '今すぐ同期';
  refresh();
  renderBanner();
});

els.clear.addEventListener('click', async () => {
  const label = view === 'saved' ? '保存済み' : 'メンション';
  if (!confirm(`${label}の一覧をすべて削除します。よろしいですか?`)) return;
  await send({ type: 'CLEAR', listKey: view });
  refresh();
});

els.settings.addEventListener('click', () => chrome.runtime.openOptionsPage());

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.mentions || changes.saved || changes.unread)) refresh();
  if (area === 'sync' && changes.settings) refresh();
});

// パネルを開いている間は service worker が生きているので、少し詰めて取りに行く。
// 未読スキャンは重いので force を付けず、poller 側の間隔判定に任せる。
setInterval(() => send({ type: 'POLL_TICK' }), 20000);
setInterval(() => send({ type: 'SCAN_UNREAD', force: false }), 60000);
setInterval(renderBanner, 30000);

refresh();
renderBanner();
send({ type: 'POLL_TICK' });
send({ type: 'SCAN_UNREAD', force: false });
