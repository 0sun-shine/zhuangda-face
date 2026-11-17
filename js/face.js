// 妆搭 · 人脸检测、质量检测与面部分析（全部在手机本地运行）
// 关键点：MediaPipe Face Landmarker（478 点 + 头部姿态矩阵 + 表情系数）
// 分析：基于关键点几何与像素颜色的规则算法，结果可由用户手动修改。
import { FaceLandmarker, FilesetResolver } from '../vendor/mediapipe/vision_bundle.mjs';

const BASE = new URL('../vendor/mediapipe/', import.meta.url).href;

let landmarker = null;
let runMode = null;
let loading = null;

/** 加载识别模型。onProgress(0–1, 文案) */
export function loadLandmarker(onProgress = () => {}) {
  if (landmarker) return Promise.resolve(landmarker);
  if (loading) return loading;
  loading = (async () => {
    onProgress(0.05, '正在准备识别引擎');
    const filesetP = FilesetResolver.forVisionTasks(BASE + 'wasm');
    const model = await fetchWithProgress(BASE + 'face_landmarker.task', p => onProgress(0.05 + p * 0.75, '正在下载人脸模型'));
    const fileset = await filesetP;
    onProgress(0.85, '正在启动识别');
    const make = delegate => FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetBuffer: model, delegate },
      runningMode: 'VIDEO',
      numFaces: 3,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true,
      minFaceDetectionConfidence: 0.5,
      minFacePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    try { landmarker = await make('GPU'); } catch (e) { landmarker = await make('CPU'); }
    runMode = 'VIDEO';
    onProgress(1, '识别已就绪');
    return landmarker;
  })();
  loading.catch(() => { loading = null; });
  return loading;
}

async function fetchWithProgress(url, onP) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('模型下载失败（' + res.status + '）');
  const total = +res.headers.get('content-length') || 0;
  if (!res.body || !total) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const buf = new Uint8Array(total);
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (got + value.length > buf.length) { // content-length 是压缩后大小时退回整体读取
      const chunks = [buf.subarray(0, got), value];
      for (;;) { const r = await reader.read(); if (r.done) break; chunks.push(r.value); }
      const all = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
      let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
      return all;
    }
    buf.set(value, got); got += value.length;
    onP(Math.min(1, got / total));
  }
  return got === total ? buf : buf.subarray(0, got);
}

async function setMode(m) {
  if (runMode !== m) { await landmarker.setOptions({ runningMode: m }); runMode = m; }
}
export async function detectVideo(video, ts) { await setMode('VIDEO'); return landmarker.detectForVideo(video, ts); }
export async function detectImage(source) { await setMode('IMAGE'); return landmarker.detect(source); }

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

/** 把图片 / 视频帧画到一张小画布上，返回像素数据，用于取色。 */
export function grabPixels(source, maxSide = 480) {
  const sw = source.videoWidth || source.naturalWidth || source.width;
  const sh = source.videoHeight || source.naturalHeight || source.height;
  const k = Math.min(1, maxSide / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * k)), h = Math.max(1, Math.round(sh * k));
  const c = grabPixels.canvas || (grabPixels.canvas = document.createElement('canvas'));
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, w, h);
  return { data: ctx.getImageData(0, 0, w, h).data, w, h };
}

const srgb2lin = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
export function rgb2lab([r, g, b]) {
  const R = srgb2lin(r), G = srgb2lin(g), B = srgb2lin(b);
  let x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  let y = (R * 0.2126 + G * 0.7152 + B * 0.0722);
  let z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = t => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  x = f(x); y = f(y); z = f(z);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
const dE = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const luma = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
const hex = ([r, g, b]) => '#' + [r, g, b].map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');

/** 取以 (x,y)（归一化坐标）为中心、半径 r（归一化到宽度）的方块颜色。去掉最亮、最暗各 20% 后取平均。 */
function patch(px, x, y, r) {
  const cx = x * px.w, cy = y * px.h, R = Math.max(1, r * px.w);
  const x0 = Math.max(0, Math.floor(cx - R)), x1 = Math.min(px.w - 1, Math.ceil(cx + R));
  const y0 = Math.max(0, Math.floor(cy - R)), y1 = Math.min(px.h - 1, Math.ceil(cy + R));
  const arr = [];
  for (let j = y0; j <= y1; j++) for (let i = x0; i <= x1; i++) {
    const o = (j * px.w + i) * 4; const d = px.data;
    arr.push([d[o], d[o + 1], d[o + 2], luma(d[o], d[o + 1], d[o + 2])]);
  }
  if (!arr.length) return { rgb: [0, 0, 0], lab: [0, 0, 0], y: 0, clip: 0 };
  const clip = arr.filter(p => p[3] > 248).length / arr.length;
  arr.sort((a, b) => a[3] - b[3]);
  const s = arr.slice(Math.floor(arr.length * 0.2), Math.max(Math.floor(arr.length * 0.2) + 1, Math.ceil(arr.length * 0.8)));
  const m = [0, 1, 2].map(k => s.reduce((t, p) => t + p[k], 0) / s.length);
  return { rgb: m, lab: rgb2lab(m), y: luma(...m), clip };
}

/** 局部亮度梯度能量（用于判断眼镜框）。 */
function gradEnergy(px, x, y, rw, rh) {
  const cx = x * px.w, cy = y * px.h, W = rw * px.w, H = rh * px.w;
  const x0 = Math.max(1, Math.floor(cx - W)), x1 = Math.min(px.w - 2, Math.ceil(cx + W));
  const y0 = Math.max(1, Math.floor(cy - H)), y1 = Math.min(px.h - 2, Math.ceil(cy + H));
  let s = 0, n = 0; const d = px.data;
  const L = (i, j) => { const o = (j * px.w + i) * 4; return luma(d[o], d[o + 1], d[o + 2]); };
  for (let j = y0; j <= y1; j++) for (let i = x0; i <= x1; i++) { s += Math.abs(L(i, j + 1) - L(i, j - 1)); n++; }
  return n ? s / n : 0;
}

/** 头部姿态（度）。优先用模型给出的变换矩阵。 */
function headPose(result, idx, lm) {
  const m = result.facialTransformationMatrixes?.[idx]?.data;
  if (m && m.length >= 16) {
    const r00 = m[0], r10 = m[1], r20 = m[2], r21 = m[6], r22 = m[10];
    const deg = 180 / Math.PI;
    return { yaw: Math.asin(Math.max(-1, Math.min(1, -r20))) * deg, pitch: Math.atan2(r21, r22) * deg, roll: Math.atan2(r10, r00) * deg };
  }
  const a = lm[234], b = lm[454], n = lm[1];
  const mid = (a.x + b.x) / 2, half = Math.abs(b.x - a.x) / 2 || 1;
  return { yaw: Math.asin(Math.max(-1, Math.min(1, (n.x - mid) / half))) * 57.3, pitch: 0, roll: Math.atan2(lm[263].y - lm[33].y, lm[263].x - lm[33].x) * 57.3 };
}

// 模型给出的俯仰角在正视时约有 +10° 偏差
const PITCH_BIAS = 10;
const bs = (result, idx, name) => result.faceBlendshapes?.[idx]?.categories?.find(c => c.categoryName === name)?.score ?? 0;

/* ------------------------------------------------------------------ */
/* 质量检测                                                            */
/* ------------------------------------------------------------------ */

/**
 * @param result  Face Landmarker 结果
 * @param px      grabPixels() 的像素
 * @param aspect  图像宽/高
 * @param guide   取景框（归一化坐标 {cx,cy,rx,ry}），相册照片传 null
 * @param srcSize 原图尺寸 {w,h}，用于判断分辨率
 */
export function evaluateQuality(result, px, aspect, guide = null, srcSize = null) {
  const faces = result?.faceLandmarks || [];
  const out = { faces: faces.length, checks: {}, ok: false, tip: '' };
  const C = out.checks;
  if (!faces.length) {
    C.light = C.pose = C.distance = C.occlusion = { ok: false, msg: '' };
    out.tip = guide ? '把脸放进框里' : '没有检测到人脸，请换一张清晰的正脸照';
    out.code = 'noface';
    return out;
  }
  // 取最大的脸为主体
  const sizes = faces.map(lm => Math.abs(lm[454].x - lm[234].x));
  const idx = sizes.indexOf(Math.max(...sizes));
  const lm = faces[idx];
  const others = sizes.filter((s, i) => i !== idx && s > sizes[idx] * 0.35).length;

  // 1 光线
  const pf = patch(px, lm[151].x, lm[151].y, 0.025);
  const pl = patch(px, lm[50].x, lm[50].y, 0.025);
  const pr = patch(px, lm[280].x, lm[280].y, 0.025);
  const pc = patch(px, lm[199].x, lm[199].y, 0.02);
  const meanY = (pf.y + pl.y + pr.y + pc.y) / 4;
  const clip = (pf.clip + pl.clip + pr.clip) / 3;
  if (meanY < 70) C.light = { ok: false, msg: '光线太暗，面向窗户或打开灯' };
  else if (meanY > 232 || clip > 0.35) C.light = { ok: false, msg: '脸部过曝，避开直射的强光' };
  else if (Math.abs(pl.y - pr.y) > 42) C.light = { ok: false, msg: '左右脸明暗不均，请正对光源' };
  else C.light = { ok: true, msg: '光线充足' };

  // 2 角度与表情
  const pose = headPose(result, idx, lm);
  out.pose = pose;
  const blink = Math.min(bs(result, idx, 'eyeBlinkLeft'), bs(result, idx, 'eyeBlinkRight'));
  const jaw = bs(result, idx, 'jawOpen');
  const smile = (bs(result, idx, 'mouthSmileLeft') + bs(result, idx, 'mouthSmileRight')) / 2;
  if (Math.abs(pose.yaw) > 15) C.pose = { ok: false, msg: `请正对镜头，脸侧转了约 ${Math.round(Math.abs(pose.yaw))}°` };
  else if (Math.abs(pose.pitch - PITCH_BIAS) > 15) C.pose = { ok: false, msg: '保持平视，不要抬头或低头' };
  else if (Math.abs(pose.roll) > 12) C.pose = { ok: false, msg: '头摆正一点，不要歪头' };
  else if (blink > 0.55) C.pose = { ok: false, msg: '睁开眼睛，看向镜头' };
  else if (jaw > 0.25 || smile > 0.55) C.pose = { ok: false, msg: '保持自然表情，嘴巴轻轻闭上' };
  else C.pose = { ok: true, msg: '正脸' };

  // 3 距离与位置
  const fw = Math.abs(lm[454].x - lm[234].x);
  let minX = 1, maxX = 0, minY = 1, maxY = 0;
  for (const p of lm) { if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x; if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y; }
  if (guide) {
    const ratio = fw / (guide.rx * 2);
    const cx = (lm[234].x + lm[454].x) / 2, cy = (lm[10].y + lm[152].y) / 2;
    const dx = (cx - guide.cx) / (guide.rx * 2), dy = (cy - guide.cy) / (guide.ry * 2);
    out.metrics = { ratio, dx, dy };
    if (ratio < 0.6) C.distance = { ok: false, msg: '再靠近一点' };
    else if (ratio > 0.98) C.distance = { ok: false, msg: '离远一点' };
    else if (Math.abs(dx) > 0.17 || Math.abs(dy) > 0.15) C.distance = { ok: false, msg: '把脸移到框中间' };
    else C.distance = { ok: true, msg: '距离合适' };
  } else {
    const pxW = srcSize ? fw * srcSize.w : 999;
    if (minX < -0.01 || maxX > 1.01 || minY < -0.01 || maxY > 1.01) C.distance = { ok: false, msg: '脸没有拍全，需要完整露出额头到下巴' };
    else if (pxW < 220) C.distance = { ok: false, msg: '人脸太小或分辨率太低，请换一张近一点、清晰的照片' };
    else if (fw < 0.18) C.distance = { ok: false, msg: '人脸在照片里太小，请换一张近一点的照片' };
    else C.distance = { ok: true, msg: '距离合适' };
  }

  // 4 遮挡（刘海 / 眼镜 / 口罩）
  const r = 0.02 * Math.max(0.6, fw / 0.4);
  const fore = [patch(px, lm[151].x, lm[151].y, r), patch(px, lm[108].x, lm[108].y, r), patch(px, lm[337].x, lm[337].y, r)];
  const glab = patch(px, lm[9].x, lm[9].y, r * 0.8);
  const cheekU = [patch(px, lm[118].x, lm[118].y, r), patch(px, lm[347].x, lm[347].y, r)];
  const lower = [patch(px, lm[199].x, lm[199].y, r), patch(px, lm[164].x, lm[164].y, r * 0.7), patch(px, lm[205].x, lm[205].y, r), patch(px, lm[425].x, lm[425].y, r)];
  const avgLab = ps => [0, 1, 2].map(k => ps.reduce((s, p) => s + p.lab[k], 0) / ps.length);
  const cheekLab = avgLab(cheekU), lowerLab = avgLab(lower);
  const foreHits = fore.filter(p => dE(p.lab, cheekLab) > 24 && p.lab[0] < cheekLab[0] - 12).length;
  const glabHit = dE(glab.lab, cheekLab) > 26 && glab.lab[0] < cheekLab[0] - 14;
  const foreLab = avgLab(fore);
  const maskHit = dE(lowerLab, cheekLab) > 28 && dE(lowerLab, foreLab) > 28;
  const gBridge = gradEnergy(px, lm[168].x, lm[168].y, fw * 0.06, fw * 0.03);
  const gCheek = (gradEnergy(px, lm[50].x, lm[50].y, fw * 0.06, fw * 0.03) + gradEnergy(px, lm[280].x, lm[280].y, fw * 0.06, fw * 0.03)) / 2;
  const glasses = gBridge > 14 && gBridge > gCheek * 4.5;
  out.occl = { foreHits, glabHit, maskHit, gBridge, gCheek };
  if (foreHits >= 2 || glabHit) C.occlusion = { ok: false, msg: '刘海挡住了额头或眉毛，请撩到耳后或夹起来' };
  else if (maskHit) C.occlusion = { ok: false, msg: '请摘下口罩，露出完整的脸' };
  else if (glasses) C.occlusion = { ok: false, msg: '好像戴着眼镜，请摘下后再拍' };
  else C.occlusion = { ok: true, msg: '额头与双眉无遮挡' };

  if (others > 0) out.multi = true;
  const order = guide ? ['distance', 'pose', 'light', 'occlusion'] : ['distance', 'light', 'pose', 'occlusion'];
  const bad = order.find(k => !C[k].ok);
  out.ok = !bad && !out.multi;
  out.tip = out.multi ? '画面里有多张脸，只保留你自己' : bad ? C[bad].msg : (guide ? '很好，保持不动，按下快门' : '照片合格');
  out.code = out.multi ? 'multi' : bad || 'ok';
  out.faceIndex = idx;
  return out;
}

/* ------------------------------------------------------------------ */
/* 面部分析                                                            */
/* ------------------------------------------------------------------ */

export const OPTIONS = {
  脸型: ['鹅蛋脸', '圆脸', '方圆脸', '方脸', '长脸', '心形脸', '菱形脸'],
  三庭: ['三庭均衡', '上庭偏长', '上庭偏短', '中庭偏长', '中庭偏短', '下庭偏长', '下庭偏短'],
  眼距: ['偏宽', '标准', '偏窄'],
  眼皮: ['宽双', '窄双', '内双', '单眼皮', '肿眼泡'],
  眼型: ['圆眼', '杏眼', '细长眼'],
  眼尾: ['上扬', '平直', '下垂'],
  眉形: ['平', '弯', '挑'],
  眉色: ['浓', '中', '淡'],
  眉眼距: ['偏近', '适中', '偏远'],
  鼻梁: ['高', '中', '低'],
  鼻翼: ['窄', '标准', '宽'],
  唇形: ['M 唇', '微笑唇', '平直唇'],
  唇厚: ['薄', '标准', '厚'],
  嘴角: ['上扬', '平直', '下垂'],
  肤色: ['冷白', '自然白', '暖黄', '小麦', '深肤色'],
  冷暖调: ['冷调', '中性', '暖调'],
  季型: ['暖春型', '冷夏型', '暖秋型', '冷冬型'],
};

// 脸型原型（长宽比、下颌宽/颧宽、额宽/颧宽、下巴宽/下颌宽）。由 10 位已标注写实 CG 人物与示例照片校准。
const SHAPES = {
  鹅蛋脸: [1.28, 0.745, 0.868, 0.398],
  圆脸: [1.18, 0.765, 0.868, 0.425],
  方圆脸: [1.21, 0.778, 0.872, 0.43],
  方脸: [1.23, 0.80, 0.885, 0.45],
  长脸: [1.39, 0.75, 0.868, 0.40],
  心形脸: [1.27, 0.72, 0.895, 0.37],
  菱形脸: [1.30, 0.722, 0.835, 0.375],
};
const SHAPE_W = [9, 40, 30, 22];

/**
 * @param lm   主体人脸 478 点（归一化）
 * @param px   grabPixels() 像素（建议 ≥ 640 边长）
 * @param W,H  原图尺寸
 */
export function analyzeFace(lm, px, W, H) {
  // 像素坐标 + 去掉头部倾斜
  const P = lm.map(p => ({ x: p.x * W, y: p.y * H, z: p.z * W }));
  const ang = Math.atan2(P[263].y - P[33].y, P[263].x - P[33].x);
  const c = { x: (P[33].x + P[263].x) / 2, y: (P[33].y + P[263].y) / 2 };
  const cos = Math.cos(-ang), sin = Math.sin(-ang);
  const U = P.map(p => ({ x: c.x + (p.x - c.x) * cos - (p.y - c.y) * sin, y: c.y + (p.x - c.x) * sin + (p.y - c.y) * cos, z: p.z }));
  const back = (x, y) => { // 正立坐标 → 原图归一化坐标
    const ca = Math.cos(ang), sa = Math.sin(ang);
    return { x: (c.x + (x - c.x) * ca - (y - c.y) * sa) / W, y: (c.y + (x - c.x) * sa + (y - c.y) * ca) / H };
  };
  const d = (a, b) => Math.hypot(U[a].x - U[b].x, U[a].y - U[b].y);
  const mean = (ids, k) => ids.reduce((s, i) => s + U[i][k], 0) / ids.length;

  const faceW = d(234, 454);
  const pr = px.w / W; // 原图像素 → 取色画布像素

  // ---------- 皮肤取色 ----------
  const rr = 0.018 * faceW / W;
  const skinPatches = [151, 50, 280, 205, 425].map(i => patch(px, lm[i].x, lm[i].y, rr));
  const skinRgb = [0, 1, 2].map(k => skinPatches.reduce((s, p) => s + p.rgb[k], 0) / skinPatches.length);
  const skinLab = rgb2lab(skinRgb);

  // ---------- 发际线（沿额头向上找肤色到头发的分界） ----------
  const browIds = [70, 63, 105, 66, 107, 336, 296, 334, 293, 300, 46, 53, 52, 65, 55, 285, 295, 282, 283, 276];
  const browY = mean(browIds, 'y'); // 眉毛中线
  const noseY = U[2].y;
  const chinY = U[152].y;
  const midH = noseY - browY;
  const foreRef = patch(px, lm[151].x, lm[151].y, rr).lab;
  const midX = (U[10].x + U[152].x) / 2;
  const hits = [];
  for (const off of [-0.2, -0.12, 0.12, 0.2]) {
    const x = midX + off * faceW;
    let run = 0, found = null;
    const start = U[10].y + 0.15 * midH, stop = U[10].y - 1.1 * midH;
    for (let y = start; y > stop; y -= Math.max(1, 1 / pr)) {
      const q = back(x, y);
      if (q.x < 0 || q.x > 1 || q.y < 0 || q.y > 1) break;
      const s = patch(px, q.x, q.y, 1.2 / px.w);
      const far = dE(s.lab, foreRef) > 16 && s.lab[0] < foreRef[0] - 8;
      run = far ? run + 1 : 0;
      if (run >= 4) { found = y + 3 * Math.max(1, 1 / pr); break; }
    }
    if (found != null) hits.push(found);
  }
  hits.sort((a, b) => a - b);
  let hairY, hairlineEstimated = false;
  if (hits.length >= 2) hairY = hits[Math.floor(hits.length / 2)];
  else { hairY = browY - midH; hairlineEstimated = true; }
  // 发际线与额头取色亮度对比（头发明暗）
  const hairSample = patch(px, back(midX + 0.15 * faceW, hairY - 0.08 * midH).x, back(midX + 0.15 * faceW, hairY - 0.08 * midH).y, rr);

  // ---------- 三庭 ----------
  const upH = browY - hairY, lowH = chinY - noseY;
  const tot = upH + midH + lowH;
  const thirds = [upH, midH, lowH].map(v => v / tot);
  const thirdsDev = thirds.map(v => v * 3 - 1);
  const names3 = ['上庭', '中庭', '下庭'];
  let thirdsLabel = '三庭均衡', thirdsSev = 0;
  {
    // 发际线受发型影响大，上庭按 0.6 权重参与判断
    const cand = thirdsDev.map((v, i) => ({ i, v, w: i === 0 ? 0.6 : 1 })).filter(o => !(hairlineEstimated && o.i === 0));
    cand.sort((a, b) => Math.abs(b.v) * b.w - Math.abs(a.v) * a.w);
    const top = cand[0];
    if (top && Math.abs(top.v) * top.w >= 0.07) {
      thirdsLabel = names3[top.i] + (top.v > 0 ? '偏长' : '偏短');
      thirdsSev = Math.abs(top.v) * top.w;
    }
  }

  // ---------- 脸型 ----------
  const faceL = chinY - hairY;
  const jawW = d(172, 397), foreW = d(54, 284), chinW = d(176, 400);
  const feat = [faceL / faceW, jawW / faceW, foreW / faceW, chinW / jawW];
  const scores = Object.entries(SHAPES).map(([k, v]) => {
    const dist2 = v.reduce((s, x, i) => s + Math.pow((feat[i] - x) * SHAPE_W[i], 2), 0);
    return { k, s: Math.exp(-dist2 * 1.2) };
  }).sort((a, b) => b.s - a.s);
  const sumS = scores.reduce((s, o) => s + o.s, 0) || 1;
  const shape = scores[0].k;
  const shapeConf = Math.round(Math.max(50, Math.min(95, (scores[0].s / sumS) * 100 + 10)));

  // ---------- 眼 ----------
  const eyeWR = d(33, 133), eyeWL = d(263, 362), eyeW = (eyeWR + eyeWL) / 2;
  const gap = d(133, 362);
  const gapRatio = gap / eyeW;
  const eyeSpacing = gapRatio > 1.45 ? '偏宽' : gapRatio < 1.22 ? '偏窄' : '标准';
  const openR = (d(159, 145) / eyeWR + d(386, 374) / eyeWL) / 2;
  const eyeShape = openR > 0.385 ? '圆眼' : openR < 0.31 ? '细长眼' : '杏眼';
  const tiltR = Math.atan2(U[133].y - U[33].y, U[133].x - U[33].x) * 57.3; // 画面左侧眼：外角 33 在左
  const tiltL = Math.atan2(U[362].y - U[263].y, U[263].x - U[362].x) * 57.3; // 画面右侧眼：外角 263 在右
  const tilt = (tiltR + tiltL) / 2; // 正值 = 外眼角高于内眼角
  const eyeTail = tilt > 11 ? '上扬' : tilt < 4 ? '下垂' : '平直';
  const eyeSize = eyeW / faceW;

  // ---------- 眉 ----------
  const browOne = (head, tail, upper) => {
    const H = U[head], T = U[tail];
    const len = Math.hypot(T.x - H.x, T.y - H.y);
    let arch = 0;
    for (const i of upper) {
      const t = ((U[i].x - H.x) * (T.x - H.x) + (U[i].y - H.y) * (T.y - H.y)) / (len * len);
      const ly = H.y + (T.y - H.y) * t;
      arch = Math.max(arch, ly - U[i].y);
    }
    const rise = Math.atan2(H.y - T.y, Math.abs(T.x - H.x)) * 57.3;
    return { arch: arch / len, rise, len };
  };
  const bR = browOne(107, 70, [63, 105, 66]);
  const bL = browOne(336, 300, [293, 334, 296]);
  const arch = (bR.arch + bL.arch) / 2, rise = (bR.rise + bL.rise) / 2;
  const browShape = rise > 2 && arch >= 0.14 ? '挑' : arch < 0.14 ? '平' : '弯';
  const browPatch = [patch(px, (lm[105].x + lm[52].x) / 2, (lm[105].y + lm[52].y) / 2, rr * 0.55), patch(px, (lm[334].x + lm[282].x) / 2, (lm[334].y + lm[282].y) / 2, rr * 0.55)];
  const browL = (browPatch[0].lab[0] + browPatch[1].lab[0]) / 2;
  const browContrast = foreRef[0] - browL;
  const browColor = browContrast > 38 ? '浓' : browContrast < 24 ? '淡' : '中';
  const beDist = ((U[159].y - mean([52, 65], 'y')) + (U[386].y - mean([282, 295], 'y'))) / 2 / eyeW;
  const browEye = beDist > 0.64 ? '偏远' : beDist < 0.46 ? '偏近' : '适中';

  // ---------- 鼻 ----------
  const alarW = d(129, 358);
  const alarR = alarW / gap;
  const alar = alarR > 1.12 ? '宽' : alarR < 0.98 ? '窄' : '标准';
  const bridgeDepth = ((U[133].z + U[362].z) / 2 - U[168].z) / faceW;
  const tipDepth = ((U[234].z + U[454].z) / 2 - U[1].z) / faceW;
  const bridge = null; // 正脸照片无法可靠判断鼻梁高低，交给用户确认

  // ---------- 唇 ----------
  const mouthW = d(61, 291);
  const upT = U[13].y - U[0].y, loT = U[17].y - U[14].y;
  const thick = (upT + loT) / mouthW;
  const lipThick = thick > 0.5 ? '厚' : thick < 0.4 ? '薄' : '标准';
  const peakY = (U[37].y + U[267].y) / 2;
  const bow = (U[0].y - peakY) / Math.max(1, upT);
  const cornerD = (((U[13].y + U[14].y) / 2) - (U[61].y + U[291].y) / 2) / mouthW; // 正值 = 嘴角高
  const corner = cornerD > 0.035 ? '上扬' : cornerD < -0.01 ? '下垂' : '平直';
  const lipShape = bow > 0.195 ? 'M 唇' : corner === '上扬' ? '微笑唇' : '平直唇';
  const lipPatch = patch(px, (lm[0].x + lm[13].x) / 2, (lm[0].y + lm[13].y) / 2 + 0.002, rr * 0.4);

  // ---------- 肤色 ----------
  const [L, a, b] = skinLab;
  const ita = Math.atan2(L - 50, b) * 57.3;
  const hue = Math.atan2(b, a) * 57.3;
  const chroma = Math.hypot(a, b);
  const undertone = hue > 52 ? '暖调' : hue < 46 ? '冷调' : '中性';
  const warmish = hue >= 49;
  let depth;
  if (ita > 55) depth = undertone === '暖调' ? '暖黄' : undertone === '冷调' && ita > 66 ? '冷白' : '自然白';
  else if (ita > 45) depth = warmish ? '暖黄' : '自然白';
  else if (ita > 30) depth = '小麦';
  else depth = '深肤色';
  const contrast = Math.max(L - hairSample.lab[0], L - browL);
  let season;
  if (warmish) season = L > 72 && chroma >= 18 ? '暖春型' : '暖秋型';
  else season = contrast > 45 || L < 62 ? '冷冬型' : '冷夏型';

  const values = {
    脸型: shape, 三庭: thirdsLabel, 眼距: eyeSpacing, 眼皮: null, 眼型: eyeShape, 眼尾: eyeTail,
    眉形: browShape, 眉色: browColor, 眉眼距: browEye, 鼻梁: bridge, 鼻翼: alar,
    唇形: lipShape, 唇厚: lipThick, 嘴角: corner, 肤色: depth, 冷暖调: undertone, 季型: season,
  };

  const metrics = {
    shapeConf, shapeRank: scores.slice(0, 3).map(o => [o.k, +(o.s / sumS).toFixed(2)]), feat: feat.map(v => +v.toFixed(3)),
    thirds: thirds.map(v => +v.toFixed(3)), thirdsSev, hairlineEstimated,
    gapRatio: +gapRatio.toFixed(2), openR: +openR.toFixed(3), tilt: +tilt.toFixed(1), eyeSize: +eyeSize.toFixed(3),
    arch: +arch.toFixed(3), rise: +rise.toFixed(1), browContrast: +browContrast.toFixed(1), beDist: +beDist.toFixed(2),
    alarR: +alarR.toFixed(2), bridgeDepth: +bridgeDepth.toFixed(3), tipDepth: +tipDepth.toFixed(3),
    thick: +thick.toFixed(3), bow: +bow.toFixed(2), cornerD: +cornerD.toFixed(3),
    skinHex: hex(skinRgb), lipHex: hex(lipPatch.rgb), skinLab: skinLab.map(v => +v.toFixed(1)), ita: +ita.toFixed(1), hue: +hue.toFixed(1), chroma: +chroma.toFixed(1), contrast: +contrast.toFixed(1),
  };

  // 标注用几何（原图归一化坐标）
  const lineAt = y => { const l = back(U[234].x - 0.12 * faceW, y), r = back(U[454].x + 0.12 * faceW, y); return [l, r]; };
  const pick = ids => ids.map(i => ({ x: lm[i].x, y: lm[i].y }));
  const geo = {
    lines: [lineAt(hairY), lineAt(browY), lineAt(noseY), lineAt(chinY)],
    labelsAt: [(hairY + browY) / 2, (browY + noseY) / 2, (noseY + chinY) / 2].map(y => back(U[454].x + 0.14 * faceW, y)),
    points: pick([33, 133, 362, 263, 105, 334, 1, 129, 358, 61, 291, 0, 17, 234, 454, 152]),
    hairlineEstimated,
    box: (() => {
      const t = back(midX, hairY - 0.25 * midH), btm = back(midX, chinY + 0.12 * midH);
      const cx = (lm[234].x + lm[454].x) / 2;
      const h = Math.abs(btm.y - t.y) * H;
      return { cx, top: Math.min(t.y, btm.y), bottom: Math.max(t.y, btm.y), hPx: h };
    })(),
  };

  return { values, metrics, geo, version: 1 };
}

/* ------------------------------------------------------------------ */
/* 结果说明与化妆建议（随手动修改实时重算）                              */
/* ------------------------------------------------------------------ */

export const SEASON_PALETTE = {
  暖春型: { colors: ['#F2A07B', '#EF8B7A', '#C99A7E'], words: '橘粉、珊瑚、奶茶色' },
  暖秋型: { colors: ['#B8574A', '#C47A4D', '#8E5F45'], words: '砖红、焦糖、大地色' },
  冷夏型: { colors: ['#D98A9C', '#B97C8C', '#A390B0'], words: '玫瑰粉、豆沙、灰紫' },
  冷冬型: { colors: ['#B8243C', '#8E2F55', '#5B2238'], words: '正红、莓果、酒红' },
};

export function makeupTips(v, m = {}) {
  const t = [];
  const add = (pri, key, text) => t.push({ pri, key, text });
  const thirdsMap = {
    中庭偏长: '中庭偏长：腮红横向晕染，鼻影不要拉太长，视觉上缩短中庭',
    中庭偏短: '中庭偏短：腮红斜向上扫，鼻影可从眉头自然拉长',
    上庭偏长: '上庭偏长：发际线边缘轻扫阴影，或用空气刘海修饰',
    上庭偏短: '上庭偏短：额头中央提亮，眉形不要画得太粗',
    下庭偏长: '下庭偏长：唇妆画得饱满一些，下巴尖轻扫修容',
    下庭偏短: '下庭偏短：下巴中央提亮，唇形不宜外扩',
  };
  if (thirdsMap[v.三庭]) add(10 + (m.thirdsSev || 0.06) * 100, '三庭', thirdsMap[v.三庭]);
  const shapeMap = {
    圆脸: '圆脸：腮红从颧骨斜向太阳穴扫，下颌两侧轻修容',
    方圆脸: '方圆脸：下颌角修容柔化轮廓，腮红斜向上',
    方脸: '方脸：下颌角修容，腮红用圆形打法柔化线条',
    长脸: '长脸：腮红横向晕染，额头上缘和下巴尖轻扫修容',
    心形脸: '心形脸：额角修容，下巴两侧提亮让下半脸更饱满',
    菱形脸: '菱形脸：太阳穴和两颊提亮，颧骨外侧轻修容',
    鹅蛋脸: '鹅蛋脸：轮廓均衡，大多数妆容都适合，腮红按妆容风格选择打法',
  };
  add(8, '脸型', shapeMap[v.脸型]);
  const lidMap = {
    内双: '内双：眼影高度不超过褶皱 2mm，避免显肿',
    单眼皮: '单眼皮：用渐层眼影，颜色画到睁眼后能看见的高度',
    宽双: '宽双：可以在褶皱内加深，让眼妆更有层次',
    窄双: '窄双：眼线贴着睫毛根部画细，不要盖住双眼皮褶',
    肿眼泡: '肿眼泡：选哑光大地色，避开珠光暖粉',
  };
  if (v.眼皮) add(9, '眼皮', lidMap[v.眼皮]);
  if (v.眼距 === '偏宽') add(9, '眼距', '眼距偏宽：眼影和眼线重点放在内眼角，眉头可以稍微往内画');
  if (v.眼距 === '偏窄') add(9, '眼距', '眼距偏窄：眼影重点放在眼尾，内眼角用浅色提亮');
  if (v.眼尾 === '上扬') add(6, '眼尾', '眼尾上扬：下眼线后三分之一加深，平衡眼型');
  if (v.眼尾 === '下垂') add(7, '眼尾', '眼尾下垂：眼线尾端微微上翘，下眼尾不要画重');
  if (v.眼型 === '细长眼') add(5, '眼型', '细长眼：眼影中间加一点浅色亮片，让眼睛显得更圆');
  if (v.眉色 === '淡') add(6, '眉色', '眉毛偏淡：用眉粉填充空隙，再用眉笔补出毛流');
  if (v.眉眼距 === '偏远') add(6, '眉眼距', '眉眼距偏远：眉毛下缘补画一点，拉近眉眼距离');
  if (v.眉眼距 === '偏近') add(6, '眉眼距', '眉眼距偏近：修掉眉毛下缘杂毛，眼影不要扫到眉骨');
  if (v.鼻翼 === '宽') add(6, '鼻翼', '鼻翼偏宽：在鼻翼两侧轻扫阴影');
  if (v.鼻梁 === '低') add(6, '鼻梁', '鼻梁偏低：山根两侧加一点阴影，鼻梁中线提亮');
  if (v.唇厚 === '薄') add(6, '唇厚', '唇偏薄：用水光质地，唇线可以外扩 0.5mm');
  if (v.唇厚 === '厚') add(6, '唇厚', '唇偏厚：选雾面质地，唇线贴着边缘或略微内收');
  if (v.嘴角 === '下垂') add(6, '嘴角', '嘴角下垂：嘴角上方用遮瑕提亮，唇线尾端微微上提');
  const sp = SEASON_PALETTE[v.季型];
  if (sp) add(9.5, '季型', `${v.季型.replace('型', '')}型：优先${sp.words}系`);
  return t.sort((a, b) => b.pri - a.pri);
}

/** 每一项的说明（"为什么这么判断"） */
export function explain(key, v, m) {
  if (!m) return '';
  const pct = x => Math.round(x * 100) + '%';
  switch (key) {
    case '脸型': return `长宽比 ${m.feat[0]} · 下颌宽 / 颧骨宽 ${m.feat[1]}`;
    case '三庭': return m.thirds ? `上 ${pct(m.thirds[0])} · 中 ${pct(m.thirds[1])} · 下 ${pct(m.thirds[2])}${m.hairlineEstimated ? '（发际线被遮挡，上庭按估算）' : ''}` : '';
    case '眼': return `眼距是眼宽的 ${m.gapRatio} 倍 · 眼尾角度 ${m.tilt > 0 ? '+' : ''}${m.tilt}°`;
    case '眉': return `眉峰弧度 ${pct(m.arch)} · ${m.rise >= 0 ? `眉尾比眉头高 ${m.rise}°` : `眉尾比眉头低 ${Math.abs(m.rise)}°`}`;
    case '鼻': return `鼻翼宽是内眼角间距的 ${m.alarR} 倍`;
    case '唇': return `唇厚 / 唇宽 ${m.thick} · 唇峰起伏 ${pct(Math.max(0, m.bow))}`;
    case '肤色': return `测得肤色 ${m.skinHex} · 色调角 ${m.hue}°`;
    default: return '';
  }
}
