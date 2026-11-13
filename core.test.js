import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  zoneName, scaleFromStanding, Tracker, RepDetector, TrialDetector, SetTracker,
} from './core.js';

const near = (a, b, tol, msg) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b}±${tol}, got ${a}`);

// なめらかに a→b へ動く（0〜1 の進み具合 u を受け取る）
const ease = (a, b, u) => a + (b - a) * (1 - Math.cos(Math.PI * u)) / 2;

// 区間のリスト [[秒数, 開始高さ, 終了高さ], ...] から高さの関数を作る
function path(segments) {
  return (t) => {
    let t0 = 0;
    for (const [dur, a, b] of segments) {
      if (t <= t0 + dur) return ease(a, b, (t - t0) / dur);
      t0 += dur;
    }
    return segments.at(-1)[2];
  };
}
const total = (segments) => segments.reduce((s, [d]) => s + d, 0);

function feed(det, fn, seconds, fps = 60) {
  const out = [];
  for (let i = 0; i <= seconds * fps; i++) {
    const t = i / fps;
    const r = det.push(t, fn(t));
    if (r) out.push({ ...r, at: t });
  }
  return out;
}

const oneRep = [[0.5, 1, 1], [1, 1, 0.5], [1, 0.5, 1], [1, 1, 1]];

test('0.5m を 1秒で挙げると平均 0.5 m/s', () => {
  const reps = feed(new RepDetector(), path(oneRep), total(oneRep));
  assert.equal(reps.length, 1);
  near(reps[0].mean, 0.5, 0.02, 'mean');
  near(reps[0].peak, 0.785, 0.05, 'peak');
  near(reps[0].rom, 0.5, 0.02, 'rom');
});

test('30コマ/秒でも同じ結果になる', () => {
  const reps = feed(new RepDetector(), path(oneRep), total(oneRep), 30);
  assert.equal(reps.length, 1);
  near(reps[0].mean, 0.5, 0.02, 'mean');
});

test('3レップ連続で3件', () => {
  const segs = [[0.5, 1, 1]];
  for (let i = 0; i < 3; i++) segs.push([0.8, 1, 0.5], [0.7, 0.5, 1]);
  segs.push([1, 1, 1]);
  const reps = feed(new RepDetector(), path(segs), total(segs));
  assert.equal(reps.length, 3);
  for (const r of reps) near(r.mean, 0.5 / 0.7, 0.05, 'mean');
});

test('床から始まる挙上（デッドリフト）も数える', () => {
  const segs = [[1, 0.2, 0.2], [1, 0.2, 0.8], [1, 0.8, 0.8]];
  const reps = feed(new RepDetector(), path(segs), total(segs));
  assert.equal(reps.length, 1);
  near(reps[0].mean, 0.6, 0.04, 'mean');
});

test('骨格を見失ったら計測中のレップを捨てる', () => {
  const fn = path(oneRep);
  const lost = (t) => (t > 1.9 && t < 2.4 ? null : fn(t)); // 挙上の途中で 0.5 秒見失う
  const reps = feed(new RepDetector(), lost, total(oneRep));
  assert.equal(reps.length, 0);
});

test('静止中の揺れではレップを出さない', () => {
  let seed = 1;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
  const reps = feed(new RepDetector(), () => 1 + rand() * 0.02, 6);
  assert.equal(reps.length, 0);
});

test('トップで止まっても次の下降を待たずに確定する', () => {
  const segs = [[0.5, 1, 1], [1, 1, 0.5], [1, 0.5, 1], [3, 1, 1]];
  const reps = feed(new RepDetector(), path(segs), total(segs));
  assert.equal(reps.length, 1);
  assert.ok(reps[0].at <= 2.5 + 0.2, `確定が遅い: ${reps[0].at}`);
});

test('ボトムで止まった時間は挙上時間に含めない', () => {
  const segs = [[0.5, 1, 1], [1, 1, 0.5], [1.5, 0.5, 0.5], [1, 0.5, 1], [1, 1, 1]];
  const reps = feed(new RepDetector(), path(segs), total(segs));
  assert.equal(reps.length, 1);
  near(reps[0].mean, 0.5, 0.04, 'mean');
  assert.ok(reps[0].duration < 1.1, `duration ${reps[0].duration}`);
});

test('小さすぎる動きは数えない', () => {
  const segs = [[0.5, 1, 1], [0.5, 1, 0.9], [0.5, 0.9, 1], [1, 1, 1]];
  assert.equal(feed(new RepDetector(), path(segs), total(segs)).length, 0);
});

test('速度ゾーンの境界', () => {
  assert.equal(zoneName(0.49), '最大筋力');
  assert.equal(zoneName(0.5), '加速筋力');
  assert.equal(zoneName(0.75), '筋力スピード');
  assert.equal(zoneName(1.0), 'スピード筋力');
  assert.equal(zoneName(1.31), 'スターティングストレングス');
});

test('セット内の低下率と下限でアラート', () => {
  const set = new SetTracker({ floorOn: true, floor: 0.6, lossOn: true, lossPct: 20 });
  const a = set.add(0.7), b = set.add(0.63), c = set.add(0.55);
  assert.deepEqual([a.n, a.lossPct, a.floorAlert, a.lossAlert], [1, 0, false, false]);
  near(b.lossPct, 10, 0.01);
  assert.equal(b.lossAlert, false);
  near(c.lossPct, 21.43, 0.01);
  assert.equal(c.lossAlert, true);
  assert.equal(c.floorAlert, true);
  set.reset();
  assert.equal(set.add(0.4).lossPct, 0);
});

test('アラートを切っていれば鳴らない', () => {
  const set = new SetTracker({ floorOn: false, floor: 0.6, lossOn: false, lossPct: 20 });
  set.add(0.7);
  const e = set.add(0.3);
  assert.equal(e.floorAlert || e.lossAlert, false);
});

test('立位からの換算', () => {
  const s = scaleFromStanding({ x: 100, y: 50 }, { x: 95, y: 960 }, { x: 105, y: 960 }, 1.7);
  near(s, 0.0017, 0.00001);
});

test('Tracker は等速運動の速度を返す', () => {
  const tr = new Tracker();
  assert.equal(tr.velocity(), null);
  for (let i = 0; i <= 30; i++) tr.push(i / 30, { x: 2 * (i / 30), y: 1 + 0.5 * (i / 30) });
  const v = tr.velocity();
  near(v.vx, 2, 0.01); near(v.vy, 0.5, 0.01); near(v.speed, Math.hypot(2, 0.5), 0.01);
  near(tr.position().y, 1.5, 0.03);
});

test('Tracker は見失うと速度を返さない', () => {
  const tr = new Tracker();
  for (let i = 0; i <= 30; i++) tr.push(i / 30, { x: 0, y: i / 30 });
  for (let i = 31; i <= 45; i++) tr.push(i / 30, null);
  assert.equal(tr.velocity(), null);
  assert.equal(tr.position(), null);
});

test('体の試技を1件として最大速度を出す', () => {
  const det = new TrialDetector();
  const speed = (t) => (t < 1 || t > 2 ? 0.05 : 3 * Math.sin(Math.PI * (t - 1)));
  const out = feed(det, speed, 3.5);
  assert.equal(out.length, 1);
  near(out[0].peak, 3, 0.01);
  near(out[0].duration, 1, 0.1);
  assert.equal(det.active, false);
});

test('ゆっくりした揺れは試技にしない', () => {
  const out = feed(new TrialDetector(), (t) => 0.2 + 0.2 * Math.sin(t * 5), 5);
  assert.equal(out.length, 0);
});

test('1コマだけ飛んだ値は速度をほとんど乱さない', () => {
  const tr = new Tracker();
  for (let i = 0; i <= 30; i++) {
    const y = 1 + 0.5 * (i / 30) + (i === 28 ? 0.3 : 0); // 28コマ目だけ 30cm ずれる
    tr.push(i / 30, { x: 0, y });
  }
  // 取り除かなければ数 m/s ずれる。中央値で 1 コマ分のずれまでに抑える
  near(tr.velocity().vy, 0.5, 0.2);
});

test('位置がコマごとに揺れても平均速度はほぼ変わらない', () => {
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
  const fn = path(oneRep);
  const tr = new Tracker(), det = new RepDetector();
  const out = [];
  for (let i = 0; i <= total(oneRep) * 30; i++) {
    const t = i / 30;
    tr.push(t, { x: 0, y: fn(t) + rand() * 0.01 }); // ±5mm の揺れ
    const p = tr.position();
    const r = p ? det.push(p.t, p.y) : null;
    if (r) out.push(r);
  }
  assert.equal(out.length, 1);
  near(out[0].mean, 0.5, 0.04, 'mean');
});

test('試技は止まってから 0.2 秒以内に確定する', () => {
  const speed = (t) => (t < 1 || t > 2 ? 0.05 : 3 * Math.sin(Math.PI * (t - 1)));
  const out = feed(new TrialDetector(), speed, 3.5);
  assert.equal(out.length, 1);
  assert.ok(out[0].at <= 2.2, `確定が遅い: ${out[0].at}`);
});

test('ジャンプの頂点で一瞬速度が 0 になっても試技を切らない', () => {
  // 踏み切り 3 m/s → 頂点で 0 → 落下で 3 m/s → 着地して静止
  const speed = (t) => {
    if (t < 1) return 0.05;
    if (t < 1.2) return 15 * (t - 1);
    if (t < 1.8) return Math.abs(3 - 9.8 * (t - 1.2));
    if (t < 1.9) return 2.9 * (1.9 - t) / 0.1;
    return 0.05;
  };
  const out = feed(new TrialDetector(), speed, 3);
  assert.equal(out.length, 1);
  near(out[0].peak, 3, 0.1);
});
