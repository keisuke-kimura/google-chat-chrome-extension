/**
 * 通知音を鳴らすためだけの offscreen document。
 *
 * プリセットは音声ファイルを同梱せず Web Audio で合成する（拡張が軽く済み、
 * ウェブストアの審査でも余計な同梱物を説明せずに済む）。
 * 利用者が自分の音源を読み込んだ場合だけ、storage に入れた data URL を再生する。
 */

let ctx = null;

function audioContext() {
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

/* ------------------------------------------------------------------ *
 * 合成のための小道具
 * ------------------------------------------------------------------ */

/** 単音。type は sine / triangle / square / sawtooth */
function tone(ac, master, { freq, at = 0, dur = 0.28, type = 'sine', gain = 0.6 }) {
  const now = ac.currentTime;
  const osc = ac.createOscillator();
  const env = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, now + at);
  env.gain.setValueAtTime(0, now + at);
  env.gain.linearRampToValueAtTime(gain, now + at + 0.012);
  env.gain.exponentialRampToValueAtTime(0.0001, now + at + dur);
  osc.connect(env).connect(master);
  osc.start(now + at);
  osc.stop(now + at + dur + 0.02);
}

/** 短いノイズ。ノックなどの打撃系に使う */
function noise(ac, master, { at = 0, dur = 0.12, gain = 0.35, cutoff = 900 }) {
  const now = ac.currentTime;
  const frames = Math.max(1, Math.floor(ac.sampleRate * dur));
  const buffer = ac.createBuffer(1, frames, ac.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i += 1) {
    data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
  }
  const src = ac.createBufferSource();
  src.buffer = buffer;
  const filter = ac.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = cutoff;
  const env = ac.createGain();
  env.gain.setValueAtTime(gain, now + at);
  env.gain.exponentialRampToValueAtTime(0.0001, now + at + dur);
  src.connect(filter).connect(env).connect(master);
  src.start(now + at);
}

/* ------------------------------------------------------------------ *
 * プリセット
 * ------------------------------------------------------------------ */

const PRESETS = {
  /** 既定。上がる2音（E6 → A6） */
  chime(ac, master) {
    tone(ac, master, { freq: 1318.5, at: 0, dur: 0.28 });
    tone(ac, master, { freq: 1760.0, at: 0.11, dur: 0.28 });
  },

  /** 単発の澄んだ音 */
  ping(ac, master) {
    tone(ac, master, { freq: 1567.98, at: 0, dur: 0.42, gain: 0.5 });
    tone(ac, master, { freq: 3135.96, at: 0, dur: 0.16, gain: 0.12 });
  },

  /** 木琴風。倍音を足して柔らかく */
  marimba(ac, master) {
    [0, 0.09].forEach((at, i) => {
      const base = i === 0 ? 880 : 1174.66;
      tone(ac, master, { freq: base, at, dur: 0.4, type: 'triangle', gain: 0.5 });
      tone(ac, master, { freq: base * 4, at, dur: 0.12, type: 'sine', gain: 0.1 });
    });
  },

  /** 控えめな一発。会議中でも刺さりにくい */
  pop(ac, master) {
    tone(ac, master, { freq: 660, at: 0, dur: 0.14, type: 'triangle', gain: 0.55 });
    tone(ac, master, { freq: 990, at: 0.03, dur: 0.1, type: 'sine', gain: 0.25 });
  },

  /** ノック風。音程感がないぶん通知だと気づきやすい */
  knock(ac, master) {
    noise(ac, master, { at: 0, dur: 0.1, gain: 0.5, cutoff: 700 });
    noise(ac, master, { at: 0.13, dur: 0.1, gain: 0.45, cutoff: 620 });
  },

  /** 3音で上がる。急ぎのキーワード向け */
  alert(ac, master) {
    tone(ac, master, { freq: 987.77, at: 0, dur: 0.18, type: 'square', gain: 0.3 });
    tone(ac, master, { freq: 1318.5, at: 0.1, dur: 0.18, type: 'square', gain: 0.3 });
    tone(ac, master, { freq: 1975.53, at: 0.2, dur: 0.3, type: 'square', gain: 0.3 });
  },

  /** ごく静か */
  subtle(ac, master) {
    tone(ac, master, { freq: 1046.5, at: 0, dur: 0.5, gain: 0.25 });
  },
};

/* ------------------------------------------------------------------ *
 * 再生
 * ------------------------------------------------------------------ */

let customAudio = null;

/** 利用者が読み込んだ音源（data URL）を鳴らす */
async function playCustom(volume) {
  const got = await chrome.storage.local.get('customSound');
  const dataUrl = got.customSound?.dataUrl;
  if (!dataUrl) return false;

  // 連打時に前の再生を止める
  if (customAudio) {
    customAudio.pause();
    customAudio = null;
  }
  customAudio = new Audio(dataUrl);
  customAudio.volume = Math.max(0, Math.min(1, volume));
  try {
    await customAudio.play();
    return true;
  } catch {
    return false;
  }
}

async function play({ preset = 'chime', volume = 0.5 } = {}) {
  let name = preset;

  if (name === 'custom') {
    if (await playCustom(volume)) return;
    name = 'chime'; // 音源が消えていたら既定音にフォールバック
  }

  const ac = audioContext();
  const master = ac.createGain();
  master.gain.value = Math.max(0, Math.min(1, volume));
  master.connect(ac.destination);

  (PRESETS[name] || PRESETS.chime)(ac, master);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return false;
  if (msg.type === 'PLAY_SOUND') {
    play({ preset: msg.preset, volume: msg.volume })
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // 非同期レスポンス
  }
  return false;
});
