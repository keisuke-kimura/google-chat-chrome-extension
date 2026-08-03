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
   * 孤児化への対処
   *
   * 拡張をリロード／更新すると、既に開いているページに残った content script は
   * 孤児になり "Extension context invalidated" を投げるようになる。
   * ウェブストア配布後は自動更新のたびに全利用者で起きるので、静かに死ぬことが重要。
   *
   * 注意: chrome.runtime.id の有無は当てにならない。id が残ったまま
   * sendMessage だけが投げるケースがあるため、事前チェックに頼らず
   * 「すべての chrome API 呼び出しを包む」方針にしている。
   * ---------------------------------------------------------------- */

  let dead = false;

  const isInvalidated = (err) =>
    /context invalidated|Extension context|receiving end does not exist/i.test(
      String(err?.message || err || '')
    );

  /** 孤児になったら後片付けして黙る。ページをリロードすれば新しい script が入る。 */
  function teardown() {
    if (dead) return;
    dead = true;
    // observer は下方で const 宣言しているので、初期化前の呼び出しに備えて包む
    try {
      observer.disconnect();
    } catch {
      /* まだ生成前 */
    }
    try {
      toolbar?.remove();
      flashEl?.remove();
      toolbar = null;
      flashEl = null;
    } catch {
      /* 既に外れている */
    }
  }

  /** chrome API 呼び出しを包む。孤児化なら teardown して静かに諦める。 */
  function guard(fn, fallback = undefined) {
    if (dead) return fallback;
    try {
      return fn();
    } catch (err) {
      if (isInvalidated(err)) teardown();
      else console.warn('[chat-booster]', err);
      return fallback;
    }
  }

  /** background へ送る。失敗しても呼び出し側で握り潰せるよう常に Promise を返す。 */
  function sendToBackground(message) {
    if (dead) return Promise.resolve(null);
    return guard(
      () =>
        chrome.runtime.sendMessage(message).catch((err) => {
          if (isInvalidated(err)) teardown();
          return null; // 呼び出し側に reject を伝播させない
        }),
      Promise.resolve(null)
    );
  }

  guard(() => {
    chrome.storage.sync.get('settings').then(
      (stored) => {
        settings = { ...DEFAULTS, ...(stored.settings || {}) };
      },
      (err) => {
        if (isInvalidated(err)) teardown();
      }
    );

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync' || !changes.settings) return;
      settings = { ...DEFAULTS, ...(changes.settings.newValue || {}) };
      if (!settings.hoverToolbar) toolbar?.classList.remove('cb-visible');
    });
  });

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

  /**
   * 本文を取り出す。Chat の DOM は変わるので、候補セレクタが外れても
   * 要素全体の innerText に落として必ず何かを返す（保存できないより良い）。
   */
  function extractText(el) {
    const candidates = ['[data-message-text]', '[jsname][dir="auto"]', '[role="presentation"] > div'];
    for (const sel of candidates) {
      try {
        const found = el.querySelector(sel);
        const text = (found?.innerText || '').replace(/\s+\n/g, '\n').trim();
        if (text) return text;
      } catch {
        /* 無効なセレクタは無視 */
      }
    }
    return (el.innerText || el.textContent || '').replace(/\s+\n/g, '\n').trim();
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

  // mouseover は Chat 上で毎秒何度も飛ぶ。ここで投げると際限なく積もるので包む。
  document.addEventListener(
    'mouseover',
    (e) => {
      if (dead) return;
      try {
        if (toolbar && toolbar.contains(e.target)) return;
        const el = closestMessage(e.target);
        if (!el) {
          scheduleHide();
          return;
        }
        clearTimeout(hideTimer);
        hoveredEl = el;
        showToolbar(el);
      } catch (err) {
        if (isInvalidated(err)) teardown();
      }
    },
    true
  );

  /* ---------------------------------------------------------------- *
   * 保存アクション
   * ---------------------------------------------------------------- */

  async function saveElement(el, overrideText) {
    const record = toRecord(el);
    if (!record) {
      // 本文を取り出せなかった。黙って何もしないと「効かない」ように見えるので必ず伝える。
      flash('本文を取得できませんでした（このメッセージは保存できません）');
      console.warn('[chat-booster] toRecord に失敗:', el);
      return;
    }
    if (overrideText) record.text = overrideText;

    // sendToBackground は reject しない。成否は応答の中身で判定する。
    const res = await sendToBackground({ type: 'SAVE_MESSAGE', payload: record });
    if (res?.ok) {
      flash('★ 保存しました');
    } else if (dead) {
      flash('拡張が更新されました。ページを再読み込みしてください');
    } else {
      flash('保存に失敗しました');
      console.warn('[chat-booster] 保存の応答が不正:', res, record);
    }
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

  guard(() => {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg?.type === 'SAVE_HOVERED') {
        saveCurrent();
        sendResponse({ ok: true });
      }
      return false;
    });
  });

  /* ---------------------------------------------------------------- *
   * ポーリングの前倒し
   *
   * 「新着っぽい DOM 変化があった」ことだけを background に伝える。
   * 中身は API 側で取り直すので、ここでの取りこぼし・誤検知は無害。
   * ---------------------------------------------------------------- */

  let nudgeTimer = null;

  /**
   * Chat は DOM が絶えず動くので、ここで例外を投げると同じエラーが延々と積もる。
   * 何が起きても1回で止まるよう、コールバック全体を包んで自分を切り離す。
   */
  const observer = new MutationObserver((records) => {
    try {
      if (dead || !settings.domAccelerator || nudgeTimer) return;
      if (!records.some((r) => r && r.addedNodes && r.addedNodes.length > 0)) return;

      nudgeTimer = setTimeout(() => {
        nudgeTimer = null;
        // 孤児化していれば sendToBackground 側で observer ごと止まる
        sendToBackground({ type: 'DOM_ACTIVITY' }).catch(() => {
          /* service worker 再起動中などは黙って捨てる */
        });
      }, 1200);
    } catch (err) {
      console.warn('[chat-booster] DOM 監視を停止しました:', err);
      teardown();
    }
  });

  if (!dead && document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
  }
})();
