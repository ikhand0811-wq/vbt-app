// VBT の計測ロジック。画面には依存しない。
// 座標の単位は m、y は上向きが正、時刻は秒。

export const ZONES = [
  { below: 0.5, name: '最大筋力' },
  { below: 0.75, name: '加速筋力' },
  { below: 1.0, name: '筋力スピード' },
  { below: 1.3000001, name: 'スピード筋力' },
  { below: Infinity, name: 'スターティングストレングス' },
];

export function zoneName(v) {
  return ZONES.find((z) => v < z.below).name;
}

// まっすぐ立った姿勢の鼻〜かかと（ピクセル）から 1px が何 m かを求める。
// 鼻〜かかとは身長のおよそ 0.91 倍。
export const NOSE_TO_HEEL_RATIO = 0.91;
export function scaleFromStanding(nose, heelL, heelR, heightM) {
  const heel = { x: (heelL.x + heelR.x) / 2, y: (heelL.y + heelR.y) / 2 };
  const px = Math.hypot(nose.x - heel.x, nose.y - heel.y);
  if (!(px > 0) || !(heightM > 0)) return null;
  return (heightM * NOSE_TO_HEEL_RATIO) / px;
}

// 点列 [{t, v}] の回帰直線の傾き
function slope(points, key) {
  const n = points.length;
  let st = 0, sv = 0;
  for (const p of points) { st += p.t; sv += p[key]; }
  const mt = st / n, mv = sv / n;
  let num = 0, den = 0;
  for (const p of points) { num += (p.t - mt) * (p[key] - mv); den += (p.t - mt) ** 2; }
  return den > 0 ? num / den : 0;
}

// 追跡点の位置をならし、今の速度を出す。
export class Tracker {
  constructor({ smooth = 0.05, window = 0.1, maxGap = 0.3 } = {}) {
    Object.assign(this, { smooth, window, maxGap });
    this.recent = [];
    this.raw = [];
    this.pts = [];
    this.lastT = null;
  }

  push(t, p) {
    if (this.lastT !== null && t - this.lastT > this.maxGap) { this.recent = []; this.raw = []; this.pts = []; }
    if (!p) return;
    this.lastT = t;

    // 1コマだけ飛んだ値（検出の誤り）を、直近3コマの中央値で取り除く
    this.recent.push({ t, x: p.x, y: p.y });
    if (this.recent.length > 3) this.recent.shift();
    if (this.recent.length < 3) return;
    const mid = (k) => this.recent.map((r) => r[k]).sort((a, b) => a - b)[1];
    const s = { t: this.recent[1].t, x: mid('x'), y: mid('y') };

    this.raw.push(s);
    while (this.raw[0].t < s.t - this.smooth) this.raw.shift();
    const n = this.raw.length;
    const avg = (k) => this.raw.reduce((sum, r) => sum + r[k], 0) / n;
    this.pts.push({ t: avg('t'), x: avg('x'), y: avg('y') });
    while (this.pts[0].t < s.t - this.smooth - this.window * 1.5) this.pts.shift();
  }

  // ならした後の最新位置。時刻は平均の分だけ少し遅れる。
  position() {
    return this.pts.length ? this.pts.at(-1) : null;
  }

  velocity() {
    if (!this.pts.length) return null;
    const end = this.pts.at(-1).t;
    const w = this.pts.filter((p) => p.t >= end - this.window - 1e-9);
    if (w.length < 3 || end - w[0].t < this.window * 0.5) return null;
    const vx = slope(w, 'x'), vy = slope(w, 'y');
    return { vx, vy, speed: Math.hypot(vx, vy) };
  }
}

// バーの上下動から挙上（上向きの動き）を1レップずつ取り出す。
export class RepDetector {
  constructor({
    reversal = 0.03,   // この幅だけ逆に動いたら折り返しとみなす (m)
    minRom = 0.15,     // これ未満の動きはレップにしない (m)
    stall = 0.15,      // トップでこの時間伸びなければ確定 (s)
    slow = 0.05,       // これ以下の速度を「止まっている」とみなす (m/s)
    nearEnd = 0.03,    // 最下点・最高点の「付近」の幅 (m)
    half = 0.06,       // 速度を求めるときに前後に見る時間 (s)
    maxGap = 0.3,      // これより長く見失ったらやり直し (s)
    history = 0.3,     // レップ確定後に残しておく過去の長さ (s)
  } = {}) {
    Object.assign(this, { reversal, minRom, stall, slow, nearEnd, half, maxGap, history });
    this.reset();
  }

  reset() {
    this.buf = [];
    this.dir = 'down';
    this.min = null;
    this.max = null;
    this.lastT = null;
  }

  push(t, y) {
    if (this.lastT !== null && t - this.lastT > this.maxGap) this.reset();
    if (y === null || y === undefined || Number.isNaN(y)) return null;
    this.lastT = t;
    const s = { t, y };
    this.buf.push(s);
    if (this.buf.length > 3000) this.buf.shift();

    if (this.dir === 'down') {
      if (!this.min || y < this.min.y) this.min = s;
      else if (y > this.min.y + this.reversal) { this.dir = 'up'; this.max = s; }
      return null;
    }

    if (y > this.max.y) this.max = s;
    if (y < this.max.y - this.reversal || t - this.max.t >= this.stall) {
      const rep = this.#measure();
      this.buf = this.buf.filter((b) => b.t >= t - this.history);
      this.dir = 'down';
      this.min = s;
      this.max = null;
      return rep;
    }
    return null;
  }

  #velocityAt(i) {
    const c = this.buf[i].t;
    const w = [];
    for (let j = i; j >= 0 && this.buf[j].t >= c - this.half; j--) w.push(this.buf[j]);
    for (let j = i + 1; j < this.buf.length && this.buf[j].t <= c + this.half; j++) w.push(this.buf[j]);
    return w.length >= 2 ? slope(w, 'y') : 0;
  }

  #measure() {
    const buf = this.buf;
    const iMin = buf.indexOf(this.min), iMax = buf.indexOf(this.max);
    if (iMin < 0 || iMax <= iMin) return null;
    const v = buf.map((_, i) => this.#velocityAt(i));

    // 開始：最下点付近で、止まっている（または下がっている）最後の瞬間。
    // 見つからなければ、動きの途中から見え始めたレップなので捨てる。
    let iStart = -1;
    for (let i = iMax; i >= 0; i--) {
      if (buf[i].y <= this.min.y + this.nearEnd && v[i] <= this.slow) { iStart = i; break; }
    }
    if (iStart < 0) return null;

    // 終了：最高点付近で、最初に止まった瞬間。
    let iEnd = iMax;
    for (let i = iStart + 1; i < buf.length; i++) {
      if (buf[i].y >= this.max.y - this.nearEnd && v[i] <= this.slow) { iEnd = i; break; }
    }

    // 動き出し・止まった瞬間はコマとコマの間にあるので、速度が「止まっている」境目を
    // またぐ位置を按分して求める（コマ数が少なくても時間の誤差を小さくする）
    const cross = (a, b) => {
      const f = (this.slow - v[a]) / (v[b] - v[a]);
      return { t: buf[a].t + f * (buf[b].t - buf[a].t), y: buf[a].y + f * (buf[b].y - buf[a].y) };
    };
    let from = buf[iStart], to = buf[iEnd];
    if (iStart + 1 <= iEnd && v[iStart + 1] > this.slow) from = cross(iStart, iStart + 1);
    if (iEnd !== iMax && iEnd - 1 > iStart && v[iEnd - 1] > this.slow) to = cross(iEnd, iEnd - 1);

    const rom = to.y - from.y;
    const duration = to.t - from.t;
    if (rom < this.minRom || duration <= 0) return null;
    let peak = 0;
    for (let i = iStart; i <= iEnd; i++) peak = Math.max(peak, v[i]);
    return { mean: rom / duration, peak, rom, duration };
  }
}

// 体の速さから、動き出し〜停止を1試技として取り出す。
export class TrialDetector {
  constructor({
    start = 0.3,       // これを超えたら試技開始 (m/s)
    stop = 0.15,       // これ未満が続いたら終了 (m/s)
    stopHold = 0.15,   // 終了とみなすまでの時間 (s)
    minPeak = 0.5,     // 最大速度がこれ未満なら捨てる (m/s)
    minDuration = 0.2, // これより短ければ捨てる (s)
    maxGap = 0.3,
  } = {}) {
    Object.assign(this, { start, stop, stopHold, minPeak, minDuration, maxGap });
    this.reset();
  }

  reset() {
    this.active = false;
    this.t0 = null;
    this.peak = 0;
    this.belowSince = null;
    this.lastT = null;
  }

  push(t, speed) {
    if (this.lastT !== null && t - this.lastT > this.maxGap) this.reset();
    if (speed === null || speed === undefined || Number.isNaN(speed)) return null;
    this.lastT = t;

    if (!this.active) {
      if (speed > this.start) { this.active = true; this.t0 = t; this.peak = speed; this.belowSince = null; }
      return null;
    }

    this.peak = Math.max(this.peak, speed);
    if (speed >= this.stop) { this.belowSince = null; return null; }
    this.belowSince ??= t;
    if (t - this.belowSince < this.stopHold) return null;

    const trial = { peak: this.peak, duration: this.belowSince - this.t0 };
    this.active = false;
    this.belowSince = null;
    return trial.peak >= this.minPeak && trial.duration >= this.minDuration ? trial : null;
  }
}

// 1セット分の記録。最速からの低下率と、アラートの要否を返す。
export class SetTracker {
  constructor(settings) {
    this.settings = settings;
    this.reset();
  }

  reset() {
    this.entries = [];
    this.best = 0;
  }

  add(value) {
    const s = this.settings;
    this.best = Math.max(this.best, value);
    const lossPct = this.best > 0 ? ((this.best - value) / this.best) * 100 : 0;
    const entry = {
      n: this.entries.length + 1,
      value,
      best: this.best,
      lossPct,
      floorAlert: Boolean(s.floorOn) && value < s.floor,
      lossAlert: Boolean(s.lossOn) && lossPct >= s.lossPct,
    };
    this.entries.push(entry);
    return entry;
  }
}
