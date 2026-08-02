/**
 * Google Chat のページに注入されるスクリプト。役割は2つだけ。
 *
 *   1. ★保存ボタン（Chat の UI 上でその場でブックマークするため）
 *   2. DOM が動いたら background に知らせる（= すぐ API を叩かせる）
 *
 * メンションの検知はここでは一切やらない。Chat API 側で USER_MENTION
 * アノテーションを見ているので、Chat の DOM が変わっても通知は壊れない。
 * ここが壊れても失われるのは「ホバー保存ボタン」だけ。
 *
 * ES module ではないので即時関数で閉じる。
 */
(() => {
  'use strict';

  if (window.__chatBoosterLoaded) return;
  window.__chatBoosterLoaded = true;

  const DEFAULTS = { hoverToolbar: true, domAccelerator: true };
  let settings = { ...DEFAULTS };

  /* ---------------------------------------------------------------- *
   * 拡張コンテキストの生存確認
   *
   * 拡張をリロード／更新すると、既に開いているページに残った content script は
   * 孤児になり chrome.runtime が undefined になる（extension context invalidated）。
   * Chat は DOM が絶えず動くので、素で呼ぶと例外が出続ける。
   * .catch() では防げない（同期的な TypeError なので）。呼ぶ前に生存を確認する。
   * ---------------------------------------------------------------- */

  let dead = false;

  function alive() {
    if (dead) return false;
    try {
      if (chrome?.runtime?.id) return true;
    } catch {
      /* アクセス自体が投げることもある */
    }
    teardown();
    return false;
  }

  /** 孤児になったら後片付けして黙る。ページをリロードすれば新しい script が入る。 */
  function teardown() {
    if (dead) return;
    dead = true;
    try {
      observer.disconnect();
    } catch {
      /* まだ observe していない */
    }
    toolbar?.remove();
    flashEl?.remove();
    toolbar = null;
    flashEl = null;
  }

  /** 生きているときだけ background に送る */
  function sendToBackground(message) {
    if (!alive()) return Promise.reject(new Error('extension context invalidated'));
    try {
      return chrome.runtime.sendMessage(message).catch((err) => {
        // 送信中に拡張が落ちた場合もここに来る
        if (String(err?.message || '').includes('context invalidated')) teardown();
        throw err;
      });
    } catch (err) {
      teardown();
      return Promise.reject(err);
    }
  }

  try {
    chrome.storage.sync.get('settings').then((stored) => {
      settings = { ...DEFAULTS, ...(stored.settings || {}) };
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync' || !changes.settings) return;
      settings = { ...DEFAULTS, ...(changes.settings.newValue || {}) };
      if (!settings.hoverToolbar) toolbar?.classList.remove('cb-visible');
    });
  } catch {
    // 読み込み直後に孤児化しているケース。既定値のまま動かす。
  }

  /* ---------------------------------------------------------------- *
   * メッセージ要素の特定（保存ボタンを出す位置を決めるためだけに使う）
   * ---------------------------------------------------------------- */

  const MESSAGE_SELECTORS = [
    '[data-message-id]',
    '[data-topic-id] [role="listitem"]',
    'div[role="list"] > div[role="listitem"]',
    'div[role="listitem"]',
  ];

  let activeSelector = null;

  /** 探索範囲を会話領域に限定する（左のスペース一覧を拾わないため） */
  function messageRoot() {
    return document.querySelector('[role="main"]') || document.body || document;
  }

  function resolveSelector() {
    const root = messageRoot();
    if (!root) return null;
    if (activeSelector && root.querySelector(activeSelector)) return activeSelector;
    for (const sel of MESSAGE_SELECTORS) {
      try {
        if (root.querySelector(sel)) {
          activeSelector = sel;
          return sel;
        }
      } catch {
        /* 無効なセレクタは無視 */
      }
    }
    return null;
  }

  function closestMessage(node) {
    if (!node || node.nodeType !== 1) return null;
    const sel = resolveSelector();
    if (!sel) return null;
    const el = node.closest(sel);
    return el && messageRoot().contains(el) ? el : null;
  }

  /* ---------------------------------------------------------------- *
   * メッセージ要素 → 保存用データ
   * ---------------------------------------------------------------- */

  const SENDER_SELECTORS = ['[data-hovercard-id]', '[data-member-id]', '[data-name]'];

  function extractSender(el) {
    for (const sel of SENDER_SELECTORS) {
      const found = el.querySelector(sel);
      const text = (found?.getAttribute('data-name') || found?.innerText || '').trim();
      if (text) return text.split('\n')[0].slice(0, 80);
    }
    const first = (el.innerText || '').trim().split('\n')[0];
    return first ? first.slice(0, 80) : '';
  }

  function extractText(el) {
    const body =
      el.querySelector('[data-message-text], [jsname][dir="auto"], [role="presentation"] > div') ||
      el;
    return (body.innerText || '').replace(/\s+\n/g, '\n').trim();
  }

  function spaceName() {
    const raw = (document.title || '').replace(/^\(\d+\)\s*/, '');
    const cut = raw.split(' - ')[0].trim();
    if (cut && cut !== 'Google Chat') return cut;
    return (document.querySelector('[role="main"] h1, h1')?.innerText || '').trim().slice(0, 80);
  }

  /**
   * 保存したメッセージのキー。API 由来のメンションと同じ "spaces/X/messages/Y" を
   * 作れる場合はそれに揃えると、サイドパネル上で重複しない。
   */
  function messageKey(el) {
    const raw = el.getAttribute('data-message-id') || el.getAttribute('data-id') || '';
    const room = location.pathname.match(/\/(?:room|space|dm)\/([^/?#]+)/);
    if (raw && room) {
      const id = raw.split('/').pop();
      return `spaces/${room[1]}/messages/${id}`;
    }
    return raw || null;
  }

  function messageUrl(el) {
    const key = messageKey(el);
    const m = key && /^spaces\/([^/]+)\/messages\/(.+)$/.exec(key);
    return m ? `https://chat.google.com/room/${m[1]}/${m[2]}` : location.href.split('#')[0];
  }

  function toRecord(el) {
    const text = extractText(el);
    if (!text) return null;
    const sender = extractSender(el);
    return {
      key: messageKey(el) || `dom-${hash(`${sender}|${text.slice(0, 200)}`)}`,
      text: text.slice(0, 2000),
      sender,
      spaceName: spaceName(),
      url: messageUrl(el),
      ts: Date.now(),
    };
  }

  function hash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i += 1) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  /* ---------------------------------------------------------------- *
   * ホバー保存ツールバー
   * ---------------------------------------------------------------- */

  let toolbar = null;
  let hoveredEl = null;
  let hideTimer = null;

  function ensureToolbar() {
    if (toolbar) return toolbar;
    toolbar = document.createElement('div');
    toolbar.className = 'cb-toolbar';
    toolbar.innerHTML = `
      <button type="button" class="cb-btn" data-action="save" title="このメッセージを保存 (Alt+S)">★ 保存</button>
      <button type="button" class="cb-btn" data-action="copy" title="リンクをコピー">🔗</button>
    `;
    toolbar.addEventListener('mouseenter', () => clearTimeout(hideTimer));
    toolbar.addEventListener('mouseleave', scheduleHide);
    toolbar.addEventListener('click', (e) => {
      const action = e.target?.dataset?.action;
      if (!action || !hoveredEl) return;
      e.preventDefault();
      e.stopPropagation();
      if (action === 'save') saveElement(hoveredEl);
      if (action === 'copy') copyLink(hoveredEl);
    });
    document.body.appendChild(toolbar);
    return toolbar;
  }

  function showToolbar(el) {
    if (!settings.hoverToolbar) return;
    const tb = ensureToolbar();
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    tb.style.top = `${Math.max(4, rect.top + window.scrollY - 8)}px`;
    tb.style.left = `${Math.max(4, rect.right + window.scrollX - 130)}px`;
    tb.classList.add('cb-visible');
  }

  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => toolbar?.classList.remove('cb-visible'), 250);
  }

  document.addEventListener(
    'mouseover',
    (e) => {
      if (toolbar && toolbar.contains(e.target)) return;
      const el = closestMessage(e.target);
      if (!el) {
        scheduleHide();
        return;
      }
      clearTimeout(hideTimer);
      hoveredEl = el;
      showToolbar(el);
    },
    true
  );

  /* ---------------------------------------------------------------- *
   * 保存アクション
   * ---------------------------------------------------------------- */

  function saveElement(el, overrideText) {
    const record = toRecord(el);
    if (!record) return;
    if (overrideText) record.text = overrideText;
    sendToBackground({ type: 'SAVE_MESSAGE', payload: record })
      .then(() => flash('★ 保存しました'))
      .catch(() => flash('保存に失敗しました（拡張を再読み込みした場合はページを更新してください）'));
  }

  function copyLink(el) {
    const record = toRecord(el);
    if (!record) return;
    navigator.clipboard
      .writeText(record.url)
      .then(() => flash('🔗 リンクをコピーしました'))
      .catch(() => flash('コピーに失敗しました'));
  }

  /** 選択テキストがあればそれを、無ければホバー中のメッセージを保存 */
  function saveCurrent() {
    const selection = String(window.getSelection?.() || '').trim();
    if (selection) {
      const anchor = window.getSelection().anchorNode;
      const el =
        closestMessage(anchor?.nodeType === 1 ? anchor : anchor?.parentElement) || hoveredEl;
      if (el) {
        saveElement(el, selection);
        return;
      }
    }
    if (hoveredEl) saveElement(hoveredEl);
    else flash('保存したいメッセージにカーソルを合わせてください');
  }

  let flashEl = null;
  let flashTimer = null;
  function flash(text) {
    if (dead) return;
    if (!flashEl) {
      flashEl = document.createElement('div');
      flashEl.className = 'cb-flash';
      document.body.appendChild(flashEl);
    }
    flashEl.textContent = text;
    flashEl.classList.add('cb-visible');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => flashEl.classList.remove('cb-visible'), 1800);
  }

  try {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg?.type === 'SAVE_HOVERED') {
        saveCurrent();
        sendResponse({ ok: true });
      }
      return false;
    });
  } catch {
    /* 孤児化済み */
  }

  /* ---------------------------------------------------------------- *
   * ポーリングの前倒し
   *
   * 「新着っぽい DOM 変化があった」ことだけを background に伝える。
   * 中身は API 側で取り直すので、ここでの取りこぼし・誤検知は無害。
   * ---------------------------------------------------------------- */

  let nudgeTimer = null;
  const observer = new MutationObserver((records) => {
    if (dead || !settings.domAccelerator || nudgeTimer) return;
    if (!records.some((r) => r.addedNodes && r.addedNodes.length > 0)) return;

    nudgeTimer = setTimeout(() => {
      nudgeTimer = null;
      // 孤児化していれば sendToBackground 側で observer ごと止まる
      sendToBackground({ type: 'DOM_ACTIVITY' }).catch(() => {
        /* service worker 再起動中などは黙って捨てる */
      });
    }, 1200);
  });

  if (alive()) observer.observe(document.body, { childList: true, subtree: true });
})();
