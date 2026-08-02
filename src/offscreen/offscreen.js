/**
 * 通知音を鳴らすためだけの offscreen document。
 * 音声ファイルを同梱せず Web Audio で合成するので、拡張が軽く済む。
 */

let ctx = null;

function chime(volume = 0.5) {
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === 'suspended') ctx.resume();

  const now = ctx.currentTime;
  const master = ctx.createGain();
  master.gain.value = Math.max(0, Math.min(1, volume));
  master.connect(ctx.destination);

  // 2音の軽いチャイム（E6 → A6）
  [
    { freq: 1318.5, at: 0 },
    { freq: 1760.0, at: 0.11 },
  ].forEach(({ freq, at }) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, now + at);
    gain.gain.linearRampToValueAtTime(0.6, now + at + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.28);
    osc.connect(gain).connect(master);
    osc.start(now + at);
    osc.stop(now + at + 0.3);
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return false;
  if (msg.type === 'PLAY_CHIME') {
    try {
      chime(msg.volume);
      sendResponse({ ok: true });
    } catch (err) {
      sendResponse({ ok: false, error: String(err) });
    }
  }
  return false;
});
