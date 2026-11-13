import {
  zoneName, scaleFromStanding, Tracker, RepDetector, TrialDetector, SetTracker,
} from './core.js?v=7';

const MP_VERSION = '0.10.14';
const MP_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task';

// MediaPipe の骨格の番号
const NOSE = 0, WRIST_L = 15, WRIST_R = 16, HIP_L = 23, HIP_R = 24, HEEL_L = 29, HEEL_R = 30;
const BONES = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [24, 26], [26, 28], [27, 29], [28, 30], [29, 31], [30, 32],
];
const VISIBLE = 0.5;

const $ = (id) => document.getElementById(id);
const el = {
  camera: $('camera'), modeBar: $('modeBar'), modeBody: $('modeBody'), height: $('height'),
  floorOn: $('floorOn'), floor: $('floor'), lossOn: $('lossOn'), lossPct: $('lossPct'),
  calibrate: $('calibrate'), ruler: $('ruler'), newSet: $('newSet'), testSound: $('testSound'),
  video: $('video'), canvas: $('canvas'), overlay: $('overlay'), overlayText: $('overlayText'),
  start: $('start'), countdown: $('countdown'), poseStatus: $('poseStatus'),
  scaleStatus: $('scaleStatus'), fps: $('fps'), readout: $('readout'), bigLabel: $('bigLabel'),
  big: $('big'), zone: $('zone'), live: $('live'), subExtra: $('subExtra'),
  listTitle: $('listTitle'), bestText: $('bestText'), list: $('list'), hint: $('hint'),
};
const ctx = el.canvas.getContext('2d');

// スマホ・タブレット単体で使っているか（背面カメラを使う）
const isMobile = /iphone|ipad|ipod|android/i.test(navigator.userAgent)
  || (/macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1);

// ---- 設定 ----
const DEFAULTS = { mode: 'bar', heightCm: 170, floorOn: true, floor: 0.5, lossOn: true, lossPct: 20, cameraId: '' };
const settings = { ...DEFAULTS };
try { Object.assign(settings, JSON.parse(localStorage.getItem('vbt-settings') ?? '{}')); } catch { /* 保存できない環境でも動かす */ }
const save = () => { try { localStorage.setItem('vbt-settings', JSON.stringify(settings)); } catch { /* 同上 */ } };

// ---- 状態 ----
let landmarker = null;
let stream = null;
let scale = null;            // m / px
let calibration = null;      // { samples: [] } 収集中
let tracker = new Tracker();
let reps = new RepDetector();
let trials = new TrialDetector();
const set = new SetTracker(settings);
let frameTimes = [];
let cameraFps = 0;       // カメラが出しているコマ数
let lastRawT = null;     // 直前のコマの時刻（ブラウザの値）
let lastT = 0;           // 直前のコマの時刻（そろえた後）
let alertTimer = null;
let audio = null;

// ---- 表示 ----
const fmt = (v) => (v === null || v === undefined ? '–' : v.toFixed(2));

function applySettingsToUi() {
  el.height.value = settings.heightCm;
  el.floorOn.checked = settings.floorOn;
  el.floor.value = settings.floor;
  el.lossOn.checked = settings.lossOn;
  el.lossPct.value = settings.lossPct;
  el.modeBar.setAttribute('aria-checked', settings.mode === 'bar');
  el.modeBody.setAttribute('aria-checked', settings.mode === 'body');
  const bar = settings.mode === 'bar';
  el.bigLabel.textContent = bar ? '平均速度（直前のレップ）' : '最大速度（直前の試技）';
  el.hint.textContent = bar
    ? '両手首の中点をバーの位置として、上向きの動きを1レップずつ測ります。真横から撮ってください。'
    : '腰の中心を追い、動き出しから止まるまでを1試技として測ります。真横から撮ってください。';
}

function resetSet() {
  set.reset();
  reps.reset();
  trials.reset();
  el.list.textContent = '';
  el.big.textContent = '–';
  el.zone.innerHTML = '&nbsp;';
  el.subExtra.textContent = '';
  el.bestText.textContent = '';
  el.readout.classList.remove('alert');
}

function setStatus(node, text, cls) {
  node.textContent = text;
  node.className = cls ?? '';
}

function showOverlay(text, withButton = true) {
  el.overlayText.textContent = text;
  el.start.hidden = !withButton;
  el.overlay.hidden = false;
}

function record(value, extra) {
  const bar = settings.mode === 'bar';
  const e = set.add(value);
  const alerted = e.floorAlert || e.lossAlert;

  el.big.textContent = fmt(value);
  el.zone.innerHTML = bar ? zoneName(value) : '&nbsp;';
  el.subExtra.textContent = bar ? `最大 ${fmt(extra)} m/s` : `最速比 -${e.lossPct.toFixed(0)}%`;
  el.bestText.textContent = `最速 ${fmt(e.best)} m/s`;

  const li = document.createElement('li');
  const reason = [e.floorAlert && '下限', e.lossAlert && '低下'].filter(Boolean).join('・');
  const cell = (cls, text) => { const s = document.createElement('span'); s.className = cls; s.textContent = text; return s; };
  li.append(
    cell('n', `${e.n}${bar ? '回目' : '本目'}`),
    cell('v', fmt(value)),
    cell('loss', e.n === 1 || e.lossPct === 0 ? '—' : `-${e.lossPct.toFixed(0)}%`),
    cell('state', alerted ? `⚠ ${reason}` : 'OK'),
  );
  if (alerted) li.className = 'alert';
  el.list.append(li);
  li.scrollIntoView({ block: 'nearest' });

  if (alerted) alarm();
}

// ---- アラート ----
function ensureAudio() {
  audio ??= new (window.AudioContext ?? window.webkitAudioContext)();
  if (audio.state === 'suspended') audio.resume();
  return audio;
}

function beep() {
  const ac = ensureAudio();
  for (const at of [0, 0.22]) {
    const osc = ac.createOscillator(), gain = ac.createGain();
    osc.type = 'square';
    osc.frequency.value = 880;
    const t = ac.currentTime + at;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.35, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    osc.connect(gain).connect(ac.destination);
    osc.start(t);
    osc.stop(t + 0.18);
  }
}

function alarm() {
  beep();
  el.readout.classList.add('alert');
  clearTimeout(alertTimer);
  alertTimer = setTimeout(() => el.readout.classList.remove('alert'), 1000);
}

// ---- 骨格検出 ----
async function loadPose() {
  try {
    const { PoseLandmarker, FilesetResolver } = await import(MP_BASE);
    const files = await FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
    makeLandmarker = (delegate) => PoseLandmarker.createFromOptions(files, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: 'VIDEO',
      numPoses: 1,
    });
    // Safari は GPU での検出が不安定なので、最初から CPU を使う
    const isSafari = /^((?!chrome|android|crios|fxios).)*safari/i.test(navigator.userAgent);
    if (isSafari && !settings.gpuOk) {
      landmarker = await makeLandmarker('CPU');
      usingCpu = true;
    } else {
      try { landmarker = await makeLandmarker('GPU'); } catch { landmarker = await makeLandmarker('CPU'); usingCpu = true; }
    }
    setStatus(el.poseStatus, '骨格検出：準備OK', 'ok');
  } catch (err) {
    console.error(err);
    poseError = String(err?.message ?? err).slice(0, 80);
    setStatus(el.poseStatus, `骨格検出：読み込めません（${poseError}）`, 'ng');
  }
}

let makeLandmarker = null;
let usingCpu = false;
let poseError = null;
let detectFailures = 0;
let lastStamp = 0;
let rebuilding = false;
let detectMs = 0;       // 1コマの検出にかかる時間（ならした値）
let slowFrames = 0;     // 検出がカメラに追いつかなかった連続コマ数
let gpuTrial = null;    // GPU を試している間の状態

// CPU での検出がカメラのコマ数に追いつかないとき、GPU を試す。
// GPU は「動くが何も検出しない」ことがあるので、CPU と並べて確かめてから切り替える。
function maybeTryGpu() {
  if (!usingCpu || gpuTrial || settings.gpuBad || !makeLandmarker || !cameraFps) return;
  slowFrames = detectMs > 1000 / cameraFps ? slowFrames + 1 : 0;
  if (slowFrames < 90) return;
  slowFrames = 0;
  gpuTrial = { gpu: null, gpuHits: 0, cpuHits: 0 };
  makeLandmarker('GPU')
    .then((lm) => { if (gpuTrial) gpuTrial.gpu = lm; else lm.close(); })
    .catch(() => endGpuTrial(false));
}

function endGpuTrial(ok) {
  const trial = gpuTrial;
  gpuTrial = null;
  if (ok && trial?.gpu) {
    const old = landmarker;
    landmarker = trial.gpu;
    usingCpu = false;
    settings.gpuOk = true;
    try { old.close(); } catch { /* 無視 */ }
  } else {
    settings.gpuBad = true;
    try { trial?.gpu?.close(); } catch { /* 無視 */ }
  }
  save();
}

function stepGpuTrial(cpuResult) {
  if (!gpuTrial?.gpu) return;
  try {
    const g = gpuTrial.gpu.detectForVideo(el.canvas, lastStamp).landmarks?.[0] ?? null;
    if (g) gpuTrial.gpuHits++;
    if (cpuResult) gpuTrial.cpuHits++;
    if (gpuTrial.gpuHits >= 15) endGpuTrial(true);
    else if (gpuTrial.cpuHits >= 15 && gpuTrial.gpuHits === 0) endGpuTrial(false);
  } catch {
    endGpuTrial(false);
  }
}

// 1フレーム分の骨格を返す。続けて失敗したら CPU で作り直す。
function detect(now) {
  if (!landmarker || rebuilding) return null;
  // 検出に渡す時刻は必ず増えていなければならない
  lastStamp = Math.max(lastStamp + 1, Math.round(now));
  try {
    // 動画そのものではなく、描画済みのキャンバスを渡す（Safari でも確実に読める）
    const began = performance.now();
    const lms = landmarker.detectForVideo(el.canvas, lastStamp).landmarks?.[0] ?? null;
    detectMs = detectMs ? detectMs * 0.9 + (performance.now() - began) * 0.1 : performance.now() - began;
    detectFailures = 0;
    poseError = null;
    stepGpuTrial(lms);
    maybeTryGpu();
    return lms;
  } catch (err) {
    console.error(err);
    poseError = String(err?.message ?? err).slice(0, 80);
    if (++detectFailures >= 5 && !usingCpu && makeLandmarker) {
      rebuilding = true;
      usingCpu = true;
      settings.gpuOk = false;
      settings.gpuBad = true;
      save();
      const old = landmarker;
      landmarker = null;
      makeLandmarker('CPU')
        .then((lm) => { landmarker = lm; try { old.close(); } catch { /* 無視 */ } })
        .catch((e) => { poseError = String(e?.message ?? e).slice(0, 80); })
        .finally(() => { rebuilding = false; detectFailures = 0; });
    }
    return null;
  }
}

const seen = (lm) => lm && (lm.visibility ?? 1) >= VISIBLE;
const px = (lm) => ({ x: lm.x * el.canvas.width, y: lm.y * el.canvas.height });

function midpoint(a, b) {
  if (seen(a) && seen(b)) { const p = px(a), q = px(b); return { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }; }
  if (seen(a)) return px(a);
  if (seen(b)) return px(b);
  return null;
}

function trackedPoint(lms) {
  if (!lms) return null;
  return settings.mode === 'bar' ? midpoint(lms[WRIST_L], lms[WRIST_R]) : midpoint(lms[HIP_L], lms[HIP_R]);
}

function draw(lms, point) {
  const { width: w, height: h } = el.canvas;
  if (!lms) return;
  const unit = Math.max(2, w / 400);
  ctx.lineWidth = unit;
  ctx.strokeStyle = 'rgba(255,255,255,.55)';
  ctx.beginPath();
  for (const [a, b] of BONES) {
    if (!seen(lms[a]) || !seen(lms[b])) continue;
    const p = px(lms[a]), q = px(lms[b]);
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(q.x, q.y);
  }
  ctx.stroke();
  if (point) {
    ctx.fillStyle = '#35d6a4';
    ctx.strokeStyle = '#05231a';
    ctx.beginPath();
    ctx.arc(point.x, point.y, unit * 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}

// ---- キャリブレーション ----
function startCalibration() {
  if (calibration) return;
  if (ruler) cancelRuler();
  const heightM = Number(el.height.value) / 100;
  if (!(heightM >= 1 && heightM <= 2.3)) { alert('身長を cm で入力してください。'); return; }
  calibration = { heightM, samples: [], phase: 'count', until: performance.now() + 3000, deadline: 0 };
  el.countdown.hidden = false;
}

function stepCalibration(lms, now) {
  if (!calibration) return;
  if (calibration.phase === 'count') {
    const left = Math.ceil((calibration.until - now) / 1000);
    el.countdown.textContent = left > 0 ? left : '';
    if (left > 0) return;
    calibration.phase = 'collect';
    calibration.deadline = now + 3000;
  }
  if (lms && seen(lms[NOSE]) && (seen(lms[HEEL_L]) || seen(lms[HEEL_R]))) {
    const l = seen(lms[HEEL_L]) ? lms[HEEL_L] : lms[HEEL_R];
    const r = seen(lms[HEEL_R]) ? lms[HEEL_R] : lms[HEEL_L];
    const s = scaleFromStanding(px(lms[NOSE]), px(l), px(r), calibration.heightM);
    if (s) calibration.samples.push(s);
  }
  if (calibration.samples.length >= 15) {
    const sorted = calibration.samples.sort((a, b) => a - b);
    scale = sorted[Math.floor(sorted.length / 2)];
    finishCalibration(`換算：設定済み・身長基準（1m = ${(1 / scale).toFixed(0)}px）`, 'ok');
    resetSet();
    tracker = new Tracker();
  } else if (now > calibration.deadline) {
    finishCalibration(scale ? '換算：失敗（前の設定のまま）' : '換算：失敗。頭から足まで映してください', 'ng');
  }
}

// 映像の中の、長さがわかるもの（プレートの直径など）の両端を2か所クリックして縮尺を決める。
let ruler = null; // { pts: [] }

function startRuler() {
  if (calibration) return;
  ruler = { pts: [] };
  el.canvas.style.cursor = 'crosshair';
  setStatus(el.scaleStatus, '換算：長さがわかるものの両端を2か所クリック（例：プレートの直径）', 'ng');
}

function cancelRuler(text) {
  ruler = null;
  el.canvas.style.cursor = '';
  setStatus(el.scaleStatus, text ?? (scale ? '換算：前の設定のまま' : '換算：未設定'), scale ? 'ok' : 'ng');
}

function onCanvasClick(ev) {
  if (!ruler) return;
  const r = el.canvas.getBoundingClientRect();
  ruler.pts.push({
    x: ((ev.clientX - r.left) / r.width) * el.canvas.width,
    y: ((ev.clientY - r.top) / r.height) * el.canvas.height,
  });
  if (ruler.pts.length < 2) return;
  const [a, b] = ruler.pts;
  const dist = Math.hypot(a.x - b.x, a.y - b.y);
  // 線が画面に描かれてから入力欄を出す
  setTimeout(() => {
    if (!ruler) return;
    const answer = window.prompt('2点の間の長さを cm で入力してください（プレートの直径は 45）', settings.rulerCm ?? 45);
    const cm = Number(answer);
    if (answer === null || !(cm > 0) || !(dist > 5)) { cancelRuler(); return; }
    settings.rulerCm = cm;
    save();
    scale = cm / 100 / dist;
    ruler = null;
    el.canvas.style.cursor = '';
    setStatus(el.scaleStatus, `換算：設定済み・長さ基準（1m = ${(1 / scale).toFixed(0)}px）`, 'ok');
    resetSet();
    tracker = new Tracker();
  }, 150);
}

function drawRuler() {
  if (!ruler?.pts.length) return;
  const unit = Math.max(2, el.canvas.width / 400);
  ctx.strokeStyle = '#ffd23f';
  ctx.fillStyle = '#ffd23f';
  ctx.lineWidth = unit;
  ctx.beginPath();
  ruler.pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.stroke();
  for (const p of ruler.pts) { ctx.beginPath(); ctx.arc(p.x, p.y, unit * 3, 0, Math.PI * 2); ctx.fill(); }
}

function finishCalibration(text, cls) {
  calibration = null;
  el.countdown.hidden = true;
  setStatus(el.scaleStatus, text, cls);
}

// ---- 毎フレーム ----
function onFrame(now, meta) {
  if (!stream) return;
  nextFrame();

  const vw = el.video.videoWidth, vh = el.video.videoHeight;
  if (!vw || !vh) return;
  if (el.canvas.width !== vw || el.canvas.height !== vh) { el.canvas.width = vw; el.canvas.height = vh; }

  const rawT = (meta?.captureTime ?? meta?.presentationTime ?? now) / 1000;
  frameTimes.push(rawT);
  while (frameTimes.length > 30) frameTimes.shift();
  if (frameTimes.length > 5) {
    const span = frameTimes.at(-1) - frameTimes[0];
    if (span > 0) {
      const got = Math.round((frameTimes.length - 1) / span);
      el.fps.textContent = cameraFps ? `${got} コマ/秒（カメラ ${Math.round(cameraFps)}・${usingCpu ? 'CPU' : 'GPU'}）` : `${got} コマ/秒`;
    }
  }

  // ブラウザが知らせてくる時刻は数ミリ秒ずつ揺れ、それがそのまま速度の誤差になる。
  // カメラは一定間隔で撮っているので、時刻をコマ間隔の整数倍にそろえる。
  let t = rawT;
  if (cameraFps >= 10 && lastRawT !== null && rawT - lastRawT < 0.5) {
    t = lastT + Math.max(1, Math.round((rawT - lastRawT) * cameraFps)) / cameraFps;
  }
  lastRawT = rawT;
  lastT = t;

  // 先に映像だけを描き、その絵から骨格を検出してから線を重ねる
  ctx.drawImage(el.video, 0, 0, vw, vh);
  const lms = detect(now);
  const point = trackedPoint(lms);
  draw(lms, point);
  drawRuler();
  stepCalibration(lms, now);

  if (rebuilding) setStatus(el.poseStatus, '骨格検出：切り替え中…', 'ng');
  else if (poseError) setStatus(el.poseStatus, `骨格検出：エラー（${poseError}）`, 'ng');
  else if (landmarker && !calibration) {
    if (!lms) setStatus(el.poseStatus, '骨格検出：未検出', 'ng');
    else if (!point) setStatus(el.poseStatus, settings.mode === 'bar' ? '骨格検出：手首が見えません' : '骨格検出：腰が見えません', 'ng');
    else setStatus(el.poseStatus, '骨格検出：追跡中', 'ok');
  }

  if (!scale) { el.live.textContent = '–'; return; }

  // 画面の y は下向きが正なので、上向きを正に直す
  tracker.push(t, point ? { x: point.x * scale, y: -point.y * scale } : null);
  const pos = tracker.position(), vel = tracker.velocity();

  if (settings.mode === 'bar') {
    el.live.textContent = vel ? fmt(Math.max(0, vel.vy)) : '–';
    const rep = point && pos ? reps.push(pos.t, pos.y) : reps.push(t, null);
    if (rep) record(rep.mean, rep.peak);
  } else {
    el.live.textContent = vel ? fmt(vel.speed) : '–';
    const trial = trials.push(t, point && vel ? vel.speed : null);
    if (trials.active) el.big.textContent = fmt(trials.peak);
    if (trial) record(trial.peak);
  }
}

// ---- カメラ ----
async function listCameras() {
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  el.camera.textContent = '';
  for (const d of devices) el.camera.append(new Option(d.label || 'カメラ', d.deviceId));
  el.camera.disabled = devices.length === 0;
  return devices;
}

async function openCamera(deviceId) {
  stream?.getTracks().forEach((tr) => tr.stop());
  stream = null;
  const video = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 } };
  if (deviceId) video.deviceId = { exact: deviceId };
  else if (isMobile) video.facingMode = { ideal: 'environment' };
  stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
  const track = stream.getVideoTracks()[0];
  try {
    const max = track.getCapabilities?.().frameRate?.max;
    if (max && max > (track.getSettings().frameRate ?? 0) + 1) await track.applyConstraints({ frameRate: { ideal: max } });
  } catch { /* 変えられなければそのまま使う */ }
  cameraFps = track.getSettings().frameRate ?? 0;
  el.video.srcObject = stream;
  await el.video.play();
  frameTimes = [];
  lastRawT = null;
  lastT = 0;
  slowFrames = 0;
  tracker = new Tracker();
  reps.reset();
  trials.reset();
  nextFrame();
}

// 新しいコマが来るたびに onFrame を呼ぶ。対応していないブラウザでは画面の描き替えに合わせる。
let lastVideoTime = -1;
function nextFrame() {
  if (el.video.requestVideoFrameCallback) { el.video.requestVideoFrameCallback(onFrame); return; }
  requestAnimationFrame(function tick(now) {
    if (!stream) return;
    if (el.video.currentTime === lastVideoTime) { requestAnimationFrame(tick); return; }
    lastVideoTime = el.video.currentTime;
    onFrame(now, null);
  });
}

async function start() {
  ensureAudio();
  if (!navigator.mediaDevices?.getUserMedia) {
    showOverlay('このブラウザではカメラを使えません。\nSafari か Chrome で開いてください。', false);
    return;
  }
  showOverlay('カメラに接続しています…', false);
  try {
    await openCamera(settings.cameraId || undefined).catch(() => openCamera());
    const devices = await listCameras();
    const current = stream.getVideoTracks()[0].getSettings().deviceId;
    // 保存したカメラがなければ iPhone を優先する
    // iPhone の名前は自由に付けられるので、Mac 内蔵・デスクビュー以外を iPhone とみなす
    const iphone = isMobile ? null : devices.find((d) => /iphone/i.test(d.label))
      ?? devices.find((d) => d.label && !/facetime|built-?in|内蔵|desk ?view|デスクビュー/i.test(d.label));
    const saved = devices.find((d) => d.deviceId === settings.cameraId);
    const want = saved?.deviceId ?? iphone?.deviceId ?? current;
    if (want && want !== current) await openCamera(want);
    el.camera.value = want ?? '';
    el.calibrate.disabled = false;
    el.ruler.disabled = false;
    el.overlay.hidden = true;
    keepAwake();
    if (!scale) setStatus(el.scaleStatus, '換算：未設定（「身長で合わせる」か「長さで合わせる」）', 'ng');
  } catch (err) {
    console.error(err);
    const denied = err?.name === 'NotAllowedError';
    showOverlay(denied
      ? 'カメラの使用が許可されていません。\nブラウザのアドレスバーにあるカメラのマークから許可して、もう一度押してください。'
      : isMobile
        ? 'カメラを開けませんでした。\nほかのアプリがカメラを使っていないか確かめて、もう一度押してください。'
        : 'カメラが見つかりません。\nカメラがつながっているか確かめて、もう一度押してください。\n（iPhone をカメラにする場合は、ロックして Mac の近くに置きます）');
  }
}

// 計測中に画面が消えないようにする（対応している端末だけ）
let wakeLock = null;
async function keepAwake() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* 使えなければ何もしない */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && stream) keepAwake();
});

// ---- 操作 ----
function setMode(mode) {
  if (settings.mode === mode) return;
  settings.mode = mode;
  save();
  applySettingsToUi();
  resetSet();
  tracker = new Tracker();
}

function bindNumber(input, key, min, max) {
  input.addEventListener('change', () => {
    const v = Number(input.value);
    if (Number.isFinite(v) && v >= min && v <= max) { settings[key] = v; save(); }
    else input.value = settings[key];
  });
}

el.start.addEventListener('click', start);
el.modeBar.addEventListener('click', () => setMode('bar'));
el.modeBody.addEventListener('click', () => setMode('body'));
el.calibrate.addEventListener('click', startCalibration);
el.ruler.addEventListener('click', startRuler);
el.canvas.addEventListener('click', onCanvasClick);
el.newSet.addEventListener('click', resetSet);
$('newSet2').addEventListener('click', resetSet);
$('openSettings').addEventListener('click', () => document.body.classList.add('settings-open'));
$('closeSettings').addEventListener('click', () => document.body.classList.remove('settings-open'));
// 縮尺合わせは映像を見ながら行うので、押したら設定を閉じる
for (const id of ['calibrate', 'ruler']) $(id).addEventListener('click', () => document.body.classList.remove('settings-open'));
const help = $('help');
for (const id of ['openHelp', 'openHelp2', 'openHelp3']) $(id).addEventListener('click', () => help.showModal());
$('closeHelp').addEventListener('click', () => help.close());
help.addEventListener('click', (ev) => { if (ev.target === help) help.close(); });
el.testSound.addEventListener('click', alarm);
el.floorOn.addEventListener('change', () => { settings.floorOn = el.floorOn.checked; save(); });
el.lossOn.addEventListener('change', () => { settings.lossOn = el.lossOn.checked; save(); });
bindNumber(el.height, 'heightCm', 100, 230);
bindNumber(el.floor, 'floor', 0, 10);
bindNumber(el.lossPct, 'lossPct', 1, 90);
el.camera.addEventListener('change', async () => {
  settings.cameraId = el.camera.value;
  save();
  try { await openCamera(settings.cameraId); } catch (err) { console.error(err); showOverlay('このカメラを開けませんでした。'); }
  // カメラが変わると映り方が変わるので換算をやり直す
  scale = null;
  ruler = null;
  setStatus(el.scaleStatus, '換算：未設定（「身長で合わせる」か「長さで合わせる」）', 'ng');
  resetSet();
});
navigator.mediaDevices?.addEventListener?.('devicechange', () => { if (stream) listCameras().then(() => { el.camera.value = stream.getVideoTracks()[0]?.getSettings().deviceId ?? ''; }); });

el.overlayText.textContent = isMobile
  ? 'スマホを横向きに固定し、選手の真横に置いてから、カメラを開始してください。'
  : 'カメラを選手の真横に固定してから、カメラを開始してください。\nパソコンの内蔵カメラでも、iPhone をカメラにしても使えます。';
applySettingsToUi();
loadPose();

// はじめて開いたときは使い方を見せる
try {
  if (!localStorage.getItem('vbt-help-seen')) { help.showModal(); localStorage.setItem('vbt-help-seen', '1'); }
} catch { /* 保存できない環境では毎回は出さない */ }
