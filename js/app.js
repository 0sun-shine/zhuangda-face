// 妆搭 · 人脸采集与分析（P05 拍照取景 + P06 面部分析报告）
import { loadLandmarker, detectVideo, detectImage, grabPixels, evaluateQuality, analyzeFace, makeupTips, explain, OPTIONS, SEASON_PALETTE } from './face.js';
import * as store from './store.js';

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ICONS = {
  back: '<path d="M15 5l-7 7 7 7"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  right: '<path d="M9 5l7 7-7 7"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z"/>',
  share: '<path d="M12 3v12M7 8l5-5 5 5M5 14v5a2 2 0 002 2h10a2 2 0 002-2v-5"/>',
  flip: '<path d="M4 9a8 8 0 0114-3l2 2M20 15a8 8 0 01-14 3l-2-2M20 4v4h-4M4 20v-4h4"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/>',
  camera: '<path d="M3 8a2 2 0 012-2h2.5l1.5-2h6l1.5 2H19a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><circle cx="12" cy="13" r="4"/>',
  shield: '<path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  face: '<circle cx="12" cy="12" r="9"/><path d="M9 10h.01M15 10h.01M8.5 15c1.8 1.6 5.2 1.6 7 0"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  wand: '<path d="M4 20L15 9M14 4v3M19 9h3M18 5l2-2M17.5 12.5L20 15M12 2l.5 1.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 018 0v3"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4.5 4.5-6.5 8-6.5s7 2 8 6.5"/>',
  alert: '<path d="M12 3l9.5 17h-19z"/><path d="M12 10v4M12 17.5h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5h.01"/>',
};
const icon = n => `<svg data-i="${n}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[n] || ''}</svg>`;
function hydrateIcons(root = document) {
  root.querySelectorAll('svg[data-i]:not([viewBox])').forEach(s => { s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true'); s.innerHTML = ICONS[s.dataset.i] || ''; });
}

let toastTimer;
function toast(msg, ms = 2200) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

/* ------------------------------------------------------------------ */
/* 页面导航（自建页面栈，安卓返回键 / 侧滑返回会回到上一页）            */
/* ------------------------------------------------------------------ */
const stack = ['home'];
const top = () => stack[stack.length - 1];
function go(view, { reset = false } = {}) {
  const atRoot = stack.length === 1;
  if (reset) stack.splice(1);
  if (atRoot && view !== 'home') history.pushState({ zd: 1 }, '');
  if (view !== 'home') stack.push(view);
  render();
}
function back() {
  if (sheetOpen()) { closeSheet(); return; }
  if (stack.length > 1) { stack.pop(); render(); }
}
window.addEventListener('popstate', () => {
  back();
  if (stack.length > 1) history.pushState({ zd: 1 }, '');
});
document.addEventListener('click', e => {
  if (e.target.closest('[data-back]')) { e.preventDefault(); history.back(); }
  if (e.target.closest('[data-close-sheet]')) closeSheet();
});

function render() {
  const v = top();
  document.querySelectorAll('.view').forEach(el => { el.hidden = el.dataset.view !== v; });
  if (v !== 'camera') stopCamera();
  if (v === 'home') renderHome();
  if (v === 'camera') startCamera();
  if (v === 'report') renderReport();
  if (v === 'review') renderReview();
  document.querySelector('meta[name=theme-color]').content = v === 'camera' ? '#000000' : '#FBF7F5';
}

/* ------------------------------------------------------------------ */
/* 底部弹层                                                            */
/* ------------------------------------------------------------------ */
const sheetOpen = () => !$('#sheet-wrap').hidden;
function openSheet(html, onMount) {
  const s = $('#sheet'); s.innerHTML = '<div class="grab"></div>' + html; hydrateIcons(s);
  $('#sheet-wrap').hidden = false; s.scrollTop = 0;
  onMount?.(s);
}
function closeSheet() { $('#sheet-wrap').hidden = true; $('#sheet').innerHTML = ''; }

function confirmSheet({ title, text, ok = '确定', danger = false }) {
  return new Promise(resolve => {
    openSheet(`<h2>${danger ? icon('alert') : ''}${esc(title)}</h2><p class="lead">${esc(text)}</p>
      <button class="btn" id="cf-ok">${esc(ok)}</button><button class="text-center" id="cf-no">取消</button>`, s => {
      s.querySelector('#cf-ok').onclick = () => { closeSheet(); resolve(true); };
      s.querySelector('#cf-no').onclick = () => { closeSheet(); resolve(false); };
    });
  });
}

/* ------------------------------------------------------------------ */
/* 人脸信息单独同意                                                    */
/* ------------------------------------------------------------------ */
function ensureConsent() {
  if (store.hasConsent()) return Promise.resolve(true);
  return new Promise(resolve => {
    openSheet(`
      <h2>${icon('shield')}人脸信息单独授权</h2>
      <p class="lead">人脸信息属于敏感个人信息。为了分析脸型五官、给你推荐妆容，需要先取得你的单独同意。不同意也不影响查看示例报告。</p>
      <div class="consent-item"><div class="ic">${icon('face')}</div><div><b>人脸照片与面部分析</b>
        <small>用于脸型、三庭五眼、五官和肤色分析，以及后续试妆。识别和分析都在手机上完成，照片只保存在这台手机的浏览器里，不会上传到服务器。</small></div></div>
      <details class="rules"><summary>《人脸信息处理规则》摘要</summary><ol>
        <li>处理目的：面部分析、妆容推荐与试妆底图。</li>
        <li>处理方式：在手机本地识别 478 个面部关键点并计算比例、取色；不上传照片。</li>
        <li>存储位置与期限：保存在本机浏览器，最多 5 张，直到你删除。清除浏览器数据也会一并删除。</li>
        <li>你的权利：可随时查看、删除照片；删除照片时同步删除对应分析结果；「清除全部数据」会删除全部照片并撤回本授权。</li>
        <li>不用于模型训练，不提供给任何第三方。</li>
        <li>请只使用本人照片。未满 14 周岁请在监护人同意后使用。</li></ol></details>
      <label class="check"><input type="checkbox" id="cs-check"><span>我已阅读并同意《人脸信息处理规则》，同意处理我的人脸信息</span></label>
      <button class="btn" id="cs-ok" disabled>同意并继续</button>
      <button class="text-center" id="cs-no">暂不同意</button>`, s => {
      const cb = s.querySelector('#cs-check'), ok = s.querySelector('#cs-ok');
      cb.onchange = () => { ok.disabled = !cb.checked; };
      ok.onclick = () => { store.setConsent(true); closeSheet(); resolve(true); };
      s.querySelector('#cs-no').onclick = () => { closeSheet(); toast('未授权，暂时不能拍照或上传照片'); resolve(false); };
    });
  });
}

/* ------------------------------------------------------------------ */
/* 模型加载提示                                                        */
/* ------------------------------------------------------------------ */
function busy(text, p) {
  let b = $('#busy');
  if (text === false) { b?.remove(); return; }
  if (!b) {
    b = document.createElement('div'); b.id = 'busy'; b.className = 'analyzing';
    b.innerHTML = '<div class="busy-box" style="display:grid;gap:14px;justify-items:center;text-align:center"><div class="spinner" style="width:34px;height:34px;border-radius:50%;border:3px solid #F1D6DC;border-top-color:var(--rose);animation:spin .8s linear infinite"></div><div id="busy-t" style="font-size:15px;font-weight:600"></div><div class="progress" style="background:#F1E6E9"><i id="busy-p" style="background:var(--rose)"></i></div><div class="muted" style="font-size:12px">首次使用需下载约 18MB 识别模型，之后会快很多</div></div>';
    $('#app').append(b);
  }
  $('#busy-t').textContent = text;
  $('#busy-p').style.width = Math.round((p ?? 0) * 100) + '%';
}
async function ensureModel() {
  let shown = false;
  const t = setTimeout(() => { shown = true; busy('正在准备人脸识别', 0); }, 150);
  try { await loadLandmarker((p, msg) => { if (shown) busy(msg, p); }); }
  finally { clearTimeout(t); busy(false); }
}

/* ------------------------------------------------------------------ */
/* 首页：我的人脸照片                                                  */
/* ------------------------------------------------------------------ */
const urls = new Map();
const urlFor = rec => { if (!urls.has(rec.id)) urls.set(rec.id, URL.createObjectURL(rec.blob)); return urls.get(rec.id); };
const dropUrl = id => { const u = urls.get(id); if (u) { URL.revokeObjectURL(u); urls.delete(id); } };
let photos = [];

const valuesOf = rec => ({ ...(rec.analysis?.values || {}), ...(rec.edits || {}) });
function summaryChips(rec) {
  const v = valuesOf(rec);
  return [v.脸型, v.三庭, v.冷暖调 && v.季型 ? `${v.冷暖调} · ${v.季型}` : null].filter(Boolean).map(x => `<span>${esc(x)}</span>`).join('');
}

async function renderHome() {
  pending.replaceId = null;
  photos = await store.listPhotos();
  const body = $('#home-body');
  const def = photos.find(p => p.isDefault) || photos[0];
  if (!def) {
    body.innerHTML = `
      <div class="hero">
        <div class="hero-face"><img src="img/sample-face.jpg" alt="正脸照片示例：素颜、露出额头、正对镜头"></div>
        <h2>拍一张正脸照，看懂你的脸</h2>
        <p>识别脸型、三庭五眼、眉眼鼻唇和肤色冷暖，<br>并告诉你每一项该怎么画。</p>
        <div class="actions">
          <button class="btn" id="h-cam">${icon('camera')}拍照采集</button>
          <button class="btn secondary" id="h-album">${icon('image')}从相册选择</button>
        </div>
      </div>
      <div class="section-title">分析内容</div>
      <div class="what-list"><div><b>脸型</b>7 种脸型</div><div><b>三庭五眼</b>比例测量</div><div><b>五官</b>眉眼鼻唇</div><div><b>肤色</b>冷暖与季型</div></div>
      <div class="home-foot">
        <button class="entry" id="h-sample"><span class="ic">${icon('spark')}</span><span><b>先看示例报告</b><small>用示例照片完整走一遍分析</small></span>${icon('right')}</button>
        <p class="note">${icon('lock')}<span>照片和分析结果只保存在这台手机的浏览器里，不会上传。拍照前会请你单独授权。</span></p>
      </div>`;
  } else {
    body.innerHTML = `
      <div class="section-title">默认试妆底图 <small>已保存 ${photos.length} / ${store.MAX_PHOTOS}</small></div>
      <div class="card default-card">
        <button class="thumb" data-open="${def.id}" aria-label="查看分析报告"><img src="${urlFor(def)}" alt="默认试妆底图"></button>
        <div class="info">
          <h3>我的面部档案 <span class="tag rose">默认</span></h3>
          <div class="summary-chips">${summaryChips(def)}</div>
          <span class="muted" style="font-size:12px">${new Date(def.createdAt).toLocaleDateString('zh-CN')} ${def.source === 'album' ? '上传' : '拍摄'}</span>
          <button class="btn sm" data-open="${def.id}">查看分析报告</button>
        </div>
      </div>
      <div class="section-title">全部照片 <small>点照片查看报告</small></div>
      <div class="photo-grid">
        ${photos.map(p => `<button class="photo-tile" data-open="${p.id}"><img src="${urlFor(p)}" alt="已保存的人脸照片">${p === def ? '<span class="badge def">默认</span>' : ''}</button>`).join('')}
        ${photos.length < store.MAX_PHOTOS ? `<button class="photo-tile add" id="h-add"><span>${icon('plus')}添加照片</span></button>` : ''}
      </div>
      <div class="home-foot">
        <button class="btn" id="h-cam">${icon('camera')}拍一张新照片</button>
        <button class="entry" id="h-sample"><span class="ic">${icon('spark')}</span><span><b>查看示例报告</b><small>用示例照片完整走一遍分析</small></span>${icon('right')}</button>
        <p class="note">${icon('lock')}<span>照片和分析结果只保存在这台手机的浏览器里，不会上传。${store.isMemoryOnly() ? '当前浏览器不支持本机存储（可能是无痕模式），关闭页面后照片会丢失。' : ''}</span></p>
        <button class="text-btn" id="h-clear">清除全部数据并撤回授权</button>
      </div>`;
  }
  hydrateIcons(body);
  body.querySelector('#h-cam')?.addEventListener('click', openCamera);
  body.querySelector('#h-album')?.addEventListener('click', pickFromAlbum);
  body.querySelector('#h-add')?.addEventListener('click', () => chooseSource());
  body.querySelector('#h-sample')?.addEventListener('click', openSample);
  body.querySelector('#h-clear')?.addEventListener('click', clearAllData);
  body.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => openReport(b.dataset.open)));
}

function chooseSource() {
  openSheet(`<h2>添加人脸照片</h2><p class="lead">建议素颜或淡妆、正面自然光，露出额头和双眉。</p>
    <button class="btn" id="cs-cam">${icon('camera')}拍照</button>
    <button class="btn secondary" id="cs-album" style="margin-top:10px">${icon('image')}从相册选择</button>
    <button class="text-center" data-close-sheet>取消</button>`, s => {
    s.querySelector('#cs-cam').onclick = () => { closeSheet(); openCamera(); };
    s.querySelector('#cs-album').onclick = () => { closeSheet(); pickFromAlbum(); };
  });
}

async function clearAllData() {
  const ok = await confirmSheet({ title: '清除全部数据', text: '将删除这台手机上保存的全部人脸照片和分析结果，并撤回人脸信息授权。删除后无法恢复。', ok: '全部删除', danger: true });
  if (!ok) return;
  await store.clearAll(); store.setConsent(false);
  urls.forEach(u => URL.revokeObjectURL(u)); urls.clear();
  toast('已删除全部照片与分析结果'); renderHome();
}

/* ------------------------------------------------------------------ */
/* P05 拍照取景                                                        */
/* ------------------------------------------------------------------ */
const cam = { stream: null, facing: 'user', running: false, raf: 0, lastT: -1, guide: null, stable: {}, okSince: 0, errors: 0, starting: false };

async function openCamera(opts = {}) {
  if (!(await ensureConsent())) return;
  go('camera', opts);
}

function camOverlay(html) {
  const o = $('#cam-overlay');
  if (html == null) { o.hidden = true; o.innerHTML = ''; return; }
  o.innerHTML = `<div class="box">${html}</div>`; o.hidden = false; hydrateIcons(o);
}

async function startCamera() {
  if (cam.running || cam.starting) return;
  cam.starting = true;
  resetFeedback();
  const lastPhoto = photos[0];
  const albumImg = $('#cam-album-img');
  if (lastPhoto) albumImg.src = urlFor(lastPhoto); else albumImg.removeAttribute('src');

  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    cam.starting = false;
    camOverlay(`<h3>当前页面无法打开摄像头</h3><p>${window.isSecureContext ? '这个浏览器不支持网页调用摄像头，请用 Safari 或 Chrome 打开。' : '摄像头需要通过 https 网址打开。'}也可以直接从相册选择一张正脸照。</p>
      <button class="btn" data-cam-album>${icon('image')}从相册选择</button><button class="btn secondary" data-back>返回</button>`);
    return;
  }
  camOverlay(`<h3>正在打开摄像头</h3><div class="progress"><i id="cam-p"></i></div><p id="cam-pt">正在准备人脸识别</p>`);
  const modelP = loadLandmarker((p, msg) => { const i = $('#cam-p'), t = $('#cam-pt'); if (i) i.style.width = Math.round(p * 100) + '%'; if (t) t.textContent = msg; });
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: cam.facing, width: { ideal: 1920 }, height: { ideal: 1920 } } });
    if (top() !== 'camera') { stream.getTracks().forEach(t => t.stop()); cam.starting = false; return; }
    cam.stream = stream;
    const v = $('#cam-video');
    v.srcObject = stream;
    v.classList.toggle('mirror', cam.facing === 'user');
    await v.play().catch(() => {});
    await modelP;
    if (top() !== 'camera') { stopCamera(); cam.starting = false; return; }
    camOverlay(null);
    layoutGuide();
    cam.running = true; cam.errors = 0; cam.lastT = -1;
    cam.raf = requestAnimationFrame(tick);
  } catch (err) {
    stopCamera();
    const name = err?.name || '';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      camOverlay(`<h3>没有摄像头权限</h3><p>请允许浏览器使用摄像头：<br>iPhone：点地址栏左侧「大小」图标 › 网站设置 › 相机 › 允许<br>安卓：点地址栏左侧图标 › 权限 › 相机 › 允许</p>
        <button class="btn" data-cam-retry>重新打开摄像头</button><button class="btn secondary" data-cam-album>从相册选择</button>`);
    } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      camOverlay(`<h3>没有找到可用的摄像头</h3><p>可以从相册选择一张正脸照。</p><button class="btn" data-cam-album>${icon('image')}从相册选择</button><button class="btn secondary" data-back>返回</button>`);
    } else if (name === 'NotReadableError') {
      camOverlay(`<h3>摄像头正被占用</h3><p>请关闭其他正在使用摄像头的 App 后重试。</p><button class="btn" data-cam-retry>重试</button><button class="btn secondary" data-cam-album>从相册选择</button>`);
    } else {
      camOverlay(`<h3>打开失败</h3><p>${esc(err?.message || '未知错误')}</p><button class="btn" data-cam-retry>重试</button><button class="btn secondary" data-cam-album>从相册选择</button>`);
    }
  } finally { cam.starting = false; }
}

function stopCamera() {
  cam.running = false;
  cancelAnimationFrame(cam.raf);
  if (cam.stream) { cam.stream.getTracks().forEach(t => t.stop()); cam.stream = null; }
  const v = $('#cam-video'); if (v) v.srcObject = null;
}

function layoutGuide() {
  const st = $('#cam-stage'); const W = st.clientWidth, H = st.clientHeight;
  const sat = safeTop();
  const rx = Math.min(W * 0.36, H * 0.24), ry = rx * 1.31;
  const cy = Math.max(sat + 64 + ry, H * 0.39), cx = W / 2;
  for (const id of ['#cam-hole-e', '#cam-ring']) { const e = $(id); e.setAttribute('cx', cx); e.setAttribute('cy', cy); e.setAttribute('rx', rx); e.setAttribute('ry', ry); }
  $('#cam-feedback').style.top = (cy + ry + 16) + 'px';
  cam.guidePx = { cx, cy, rx, ry, W, H };
}
window.addEventListener('resize', () => { if (top() === 'camera') layoutGuide(); });

/** 取景框（屏幕像素）→ 视频帧归一化坐标 */
function guideNorm() {
  const v = $('#cam-video'), g = cam.guidePx; if (!g || !v.videoWidth) return null;
  const vw = v.videoWidth, vh = v.videoHeight;
  const s = Math.max(g.W / vw, g.H / vh), ox = (g.W - vw * s) / 2, oy = (g.H - vh * s) / 2;
  let cx = (g.cx - ox) / s / vw; const cy = (g.cy - oy) / s / vh;
  if (cam.facing === 'user') cx = 1 - cx;
  return { cx, cy, rx: g.rx / s / vw, ry: g.ry / s / vh };
}

async function tick() {
  if (!cam.running) return;
  const v = $('#cam-video');
  if (v.readyState >= 2 && v.currentTime !== cam.lastT && !document.hidden) {
    cam.lastT = v.currentTime;
    try {
      const r = await detectVideo(v, performance.now());
      if (!cam.running) return;
      const px = grabPixels(v, 256);
      const q = evaluateQuality(r, px, v.videoWidth / v.videoHeight, guideNorm());
      updateFeedback(q);
      cam.errors = 0;
    } catch (e) {
      if (++cam.errors > 5) { stopCamera(); camOverlay(`<h3>识别出错</h3><p>${esc(e?.message || '')}</p><button class="btn" data-cam-retry>重试</button><button class="btn secondary" data-cam-album>从相册选择</button>`); return; }
    }
  }
  cam.raf = requestAnimationFrame(tick);
}

const CHIP_KEYS = ['light', 'pose', 'distance', 'occlusion'];
function safeTop() {
  const d = document.createElement('div');
  d.style.cssText = 'position:absolute;visibility:hidden;padding-top:env(safe-area-inset-top,0px)';
  document.body.append(d); const v = parseFloat(getComputedStyle(d).paddingTop) || 0; d.remove(); return v;
}
function resetFeedback() {
  cam.stable = {}; cam.okSince = 0; cam.lastTip = '';
  CHIP_KEYS.forEach(k => { cam.stable[k] = { ok: false, cand: false, n: 0 }; $(`.cchip[data-k=${k}]`).classList.remove('ok'); });
  $('#cam-tip').textContent = '把脸放进框里'; $('#cam-tip').classList.remove('ok');
  $('#cam-ring').classList.remove('ok');
  const sh = $('#cam-shutter'); sh.classList.remove('ready'); sh.setAttribute('aria-disabled', 'true');
}
function updateFeedback(q) {
  // 每项连续 3 帧一致才切换显示，避免闪烁
  for (const k of CHIP_KEYS) {
    const s = cam.stable[k], now = !!q.checks[k]?.ok && q.faces > 0;
    if (now === s.cand) s.n++; else { s.cand = now; s.n = 1; }
    if (s.n >= 3 && s.ok !== now) { s.ok = now; $(`.cchip[data-k=${k}]`).classList.toggle('ok', now); }
  }
  const allOk = q.ok && CHIP_KEYS.every(k => cam.stable[k].ok);
  const t = performance.now();
  if (allOk) { if (!cam.okSince) cam.okSince = t; } else cam.okSince = 0;
  const ready = allOk && t - cam.okSince > 350;
  const sh = $('#cam-shutter');
  sh.classList.toggle('ready', ready); sh.setAttribute('aria-disabled', String(!ready));
  $('#cam-ring').classList.toggle('ok', ready);
  const tip = ready ? '很好，保持不动，按下快门' : q.tip;
  if (tip !== cam.lastTip && (t - (cam.tipAt || 0) > 450 || ready)) {
    cam.lastTip = tip; cam.tipAt = t;
    const el = $('#cam-tip'); el.textContent = tip; el.classList.toggle('ok', ready);
  }
}

async function capture() {
  const v = $('#cam-video'), g = cam.guidePx;
  if (!v.videoWidth || !g) return;
  // 只保存屏幕上看到的区域（竖版），前置摄像头保存为镜像（与取景一致）
  const vw = v.videoWidth, vh = v.videoHeight;
  const s = Math.max(g.W / vw, g.H / vh);
  const cw = g.W / s, ch = g.H / s, sx = (vw - cw) / 2, sy = (vh - ch) / 2;
  const k = Math.min(1, 1440 / Math.max(cw, ch));
  const c = document.createElement('canvas'); c.width = Math.round(cw * k); c.height = Math.round(ch * k);
  const ctx = c.getContext('2d');
  if (cam.facing === 'user') { ctx.translate(c.width, 0); ctx.scale(-1, 1); }
  ctx.drawImage(v, sx, sy, cw, ch, 0, 0, c.width, c.height);
  const fl = document.createElement('div'); fl.className = 'flash'; $('#v-camera').append(fl); setTimeout(() => fl.remove(), 400);
  stopCamera();
  await prepareCandidate(c, 'camera');
}

$('#cam-shutter').addEventListener('click', () => {
  if (!cam.running) return;
  if ($('#cam-shutter').classList.contains('ready')) capture();
  else toast($('#cam-tip').textContent || '请先按提示调整');
});
$('#cam-close').addEventListener('click', () => history.back());
$('#cam-flip').addEventListener('click', async () => { cam.facing = cam.facing === 'user' ? 'environment' : 'user'; stopCamera(); resetFeedback(); startCamera(); });
$('#cam-help').addEventListener('click', showExample);
$('#cam-mode-sample').addEventListener('click', showExample);
$('#cam-album').addEventListener('click', pickFromAlbum);
$('#cam-mode-album').addEventListener('click', pickFromAlbum);
$('#v-camera').addEventListener('click', e => {
  if (e.target.closest('[data-cam-retry]')) { camOverlay(null); startCamera(); }
  if (e.target.closest('[data-cam-album]')) pickFromAlbum();
});
document.addEventListener('visibilitychange', () => {
  if (top() !== 'camera') return;
  if (document.hidden) stopCamera(); else if (!cam.running && $('#cam-overlay').hidden) startCamera();
});

function showExample() {
  openSheet(`<h2>这样拍，分析更准</h2>
    <div class="sample-good" style="margin-top:12px"><img src="img/sample-face.jpg" alt="合格的正脸照片示例"><ul>
      <li>素颜或淡妆</li><li>面向窗户等自然光</li><li>露出额头和双眉</li><li>摘下眼镜、口罩</li><li>手机与眼睛同高，正对镜头</li><li>表情自然，嘴巴闭合</li></ul></div>
    <div class="bad-grid">
      <div><b>✕</b>侧脸超过 15°</div><div><b>✕</b>逆光、太暗或过曝</div><div><b>✕</b>刘海遮住眉毛</div>
      <div><b>✕</b>戴眼镜或口罩</div><div><b>✕</b>画面里有多张脸</div><div><b>✕</b>离得太远或太近</div></div>
    <button class="btn" data-close-sheet>知道了</button>`);
}

/* ------------------------------------------------------------------ */
/* 相册上传                                                            */
/* ------------------------------------------------------------------ */
async function pickFromAlbum() {
  if (!(await ensureConsent())) return;
  const input = $('#file-input'); input.value = ''; input.click();
}
$('#file-input').addEventListener('change', async e => {
  const f = e.target.files?.[0]; if (!f) return;
  if (!/^image\//.test(f.type) && !/\.(jpe?g|png|webp|heic|heif)$/i.test(f.name)) { toast('请选择图片文件'); return; }
  if (f.size > 20 * 1024 * 1024) { toast('图片超过 20MB，请换一张'); return; }
  const url = URL.createObjectURL(f);
  try {
    const img = new Image(); img.src = url; await img.decode();
    const k = Math.min(1, 1440 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    stopCamera();
    await prepareCandidate(c, 'album', { w: img.naturalWidth, h: img.naturalHeight });
  } catch (err) {
    toast('这张图片无法读取，请换一张（HEIC 格式可先在相册里导出为 JPG）', 3200);
  } finally { URL.revokeObjectURL(url); }
});

/* ------------------------------------------------------------------ */
/* 照片检测（拍照 / 相册共用）                                          */
/* ------------------------------------------------------------------ */
const pending = { canvas: null, blob: null, url: null, quality: null, source: null, replaceId: null };

async function prepareCandidate(canvas, source, orig) {
  await ensureModel();
  const r = await detectImage(canvas);
  const px = grabPixels(canvas, 480);
  const q = evaluateQuality(r, px, canvas.width / canvas.height, null, orig || { w: canvas.width, h: canvas.height });
  const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.9));
  if (pending.url) URL.revokeObjectURL(pending.url);
  Object.assign(pending, { canvas, blob, url: URL.createObjectURL(blob), quality: q, source });
  if (top() === 'review') render(); else go('review');
}

const CHECK_NAMES = { light: '光线', pose: '角度与表情', distance: '距离与完整度', occlusion: '遮挡' };
function renderReview() {
  const q = pending.quality, body = $('#review-body');
  if (!q) { body.innerHTML = ''; return; }
  const again = pending.source === 'camera' ? '重拍' : '重新选择';
  const rows = q.faces === 0
    ? `<div class="check-row"><span class="dot bad">${icon('close')}</span><div><b>人脸</b><span>${esc(q.tip)}</span></div></div>`
    : Object.keys(CHECK_NAMES).map(k => {
      const c = q.checks[k];
      return `<div class="check-row"><span class="dot ${c.ok ? '' : 'bad'}">${icon(c.ok ? 'check' : 'close')}</span><div><b>${CHECK_NAMES[k]}</b><span>${esc(c.ok ? (k === 'pose' ? '正脸，表情自然' : c.msg) : c.msg)}</span></div></div>`;
    }).join('') + (q.multi ? `<div class="check-row"><span class="dot bad">${icon('close')}</span><div><b>人数</b><span>画面里有多张脸，请只保留你自己</span></div></div>` : '');
  body.innerHTML = `
    <div class="review-photo"><img src="${pending.url}" alt="待检测的照片"></div>
    <div class="card check-list">${rows}</div>
    ${q.ok
      ? `<div class="verdict ok">${icon('check')}<span>照片合格，可以用来分析，也会作为你的试妆底图。</span></div>`
      : `<div class="verdict bad">${icon('alert')}<span>这张照片暂时不能用于分析：${esc(q.tip)}。调整后${again}即可。</span></div>`}
    <div class="review-actions">
      ${q.ok ? `<button class="btn" id="rv-use">使用这张照片并分析</button>` : ''}
      <button class="btn ${q.ok ? 'secondary' : ''}" id="rv-again">${again}</button>
      ${q.ok ? '' : `<button class="text-center" id="rv-example">查看拍摄示例</button>`}
    </div>`;
  hydrateIcons(body);
  body.querySelector('#rv-use')?.addEventListener('click', useCandidate);
  body.querySelector('#rv-again').addEventListener('click', () => {
    if (pending.source === 'camera') history.back();
    else pickFromAlbum();
  });
  body.querySelector('#rv-example')?.addEventListener('click', showExample);
}

async function useCandidate() {
  photos = await store.listPhotos();
  let replaceId = pending.replaceId;
  if (!replaceId && photos.length >= store.MAX_PHOTOS) {
    replaceId = await pickReplacement();
    if (!replaceId) return;
  }
  const analysis = await runAnalysis(pending.canvas, pending.url);
  if (!analysis) return;
  const old = replaceId ? photos.find(p => p.id === replaceId) : null;
  const rec = {
    id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    createdAt: Date.now(), blob: pending.blob, w: pending.canvas.width, h: pending.canvas.height,
    source: pending.source, analysis, edits: {}, isDefault: old ? !!old.isDefault : photos.length === 0,
  };
  if (old) { await store.deletePhoto(old.id); dropUrl(old.id); }
  await store.putPhoto(rec);
  if (rec.isDefault) await store.setDefault(rec.id);
  pending.replaceId = null;
  current = { rec, sample: false };
  go('report', { reset: true });
  toast(old ? '已替换照片并完成分析' : '已保存到本机并完成分析');
}

function pickReplacement() {
  return new Promise(resolve => {
    let chosen = null;
    openSheet(`<h2>最多保存 ${store.MAX_PHOTOS} 张</h2><p class="lead">选择一张替换，它的分析结果会一起删除。</p>
      <div class="replace-list">${photos.map(p => `<button data-id="${p.id}"><img src="${urlFor(p)}" alt="已保存的照片">${p.isDefault ? '<span class="badge def" style="position:absolute;left:6px;top:6px;font-size:10px;padding:2px 6px;border-radius:8px;background:var(--rose);color:#fff">默认</span>' : ''}</button>`).join('')}</div>
      <button class="btn" id="rp-ok" disabled>替换这张</button><button class="text-center" id="rp-no">取消</button>`, s => {
      s.querySelectorAll('[data-id]').forEach(b => b.onclick = () => { s.querySelectorAll('[data-id]').forEach(x => x.classList.toggle('on', x === b)); chosen = b.dataset.id; s.querySelector('#rp-ok').disabled = false; });
      s.querySelector('#rp-ok').onclick = () => { closeSheet(); resolve(chosen); };
      s.querySelector('#rp-no').onclick = () => { closeSheet(); resolve(null); };
    });
  });
}

/* ------------------------------------------------------------------ */
/* 分析                                                                */
/* ------------------------------------------------------------------ */
async function runAnalysis(source, previewUrl) {
  const ov = $('#analyzing'); $('#an-img').src = previewUrl; ov.hidden = false;
  const steps = [...document.querySelectorAll('#an-steps li')];
  steps.forEach(s => s.className = '');
  const t0 = performance.now();
  try {
    await ensureModel();
    steps[0].className = 'on';
    const w = source.naturalWidth || source.width, h = source.naturalHeight || source.height;
    const r = await detectImage(source);
    const faces = r.faceLandmarks || [];
    if (!faces.length) throw new Error('没有检测到人脸');
    const sizes = faces.map(lm => Math.abs(lm[454].x - lm[234].x));
    const lm = faces[sizes.indexOf(Math.max(...sizes))];
    const px = grabPixels(source, 900);
    const result = analyzeFace(lm, px, w, h);
    for (let i = 0; i < steps.length; i++) { // 逐步展示（总计约 1.5 秒）
      steps[i].className = 'on'; await sleep(330); steps[i].className = 'done';
    }
    result.ms = Math.round(performance.now() - t0);
    result.analyzedAt = Date.now();
    return result;
  } catch (e) {
    toast('分析失败：' + (e?.message || '请换一张照片'), 3000);
    return null;
  } finally { ov.hidden = true; }
}

let sampleCache = null;
async function openSample() {
  try {
    if (!sampleCache) {
      const img = new Image(); img.src = 'img/sample-face.jpg'; await img.decode();
      const analysis = await runAnalysis(img, img.src);
      if (!analysis) return;
      sampleCache = { id: 'sample', createdAt: Date.now(), w: img.naturalWidth, h: img.naturalHeight, analysis, edits: {}, url: img.src };
    }
    current = { rec: sampleCache, sample: true };
    go('report');
  } catch (e) { toast('示例加载失败，请检查网络后重试'); }
}

/* ------------------------------------------------------------------ */
/* P06 面部分析报告                                                    */
/* ------------------------------------------------------------------ */
let current = null;
let tipsExpanded = false;

async function openReport(id) {
  const rec = await store.getPhoto(id);
  if (!rec) { toast('照片不存在'); renderHome(); return; }
  current = { rec, sample: false }; tipsExpanded = false;
  go('report');
}

const LIP_T = { 薄: '偏薄', 标准: '厚度适中', 厚: '偏厚' };
const BROW_C = { 浓: '眉色浓', 中: '眉色适中', 淡: '眉色偏淡' };
const pend = t => `<span class="pending">${t}</span>`;
const ROWS = [
  { name: '脸型', keys: ['脸型'], why: '脸型', val: (v, m, ed) => `${esc(v.脸型)} ${ed.脸型 ? '' : `<span class="tag" title="匹配度">${m.shapeConf}%</span>`}` },
  { name: '三庭比例', keys: ['三庭'], why: '三庭', val: v => esc(v.三庭) },
  { name: '眼型', keys: ['眼皮', '眼型', '眼尾', '眼距'], why: '眼', val: v => [v.眼皮 ? esc(v.眼皮) : pend('眼皮待确认'), esc(v.眼型), '眼尾' + esc(v.眼尾), v.眼距 !== '标准' ? '眼距' + esc(v.眼距) : null].filter(Boolean).join(' · ') },
  { name: '眉形', keys: ['眉形', '眉色', '眉眼距'], why: '眉', val: v => [esc(v.眉形) + '眉', BROW_C[v.眉色], v.眉眼距 !== '适中' ? '眉眼距' + esc(v.眉眼距) : null].filter(Boolean).join(' · ') },
  { name: '鼻', keys: ['鼻梁', '鼻翼'], why: '鼻', val: v => [v.鼻梁 ? '鼻梁' + esc(v.鼻梁) : pend('鼻梁待确认'), '鼻翼' + esc(v.鼻翼)].join(' · ') },
  { name: '唇形', keys: ['唇形', '唇厚', '嘴角'], why: '唇', val: v => [esc(v.唇形), LIP_T[v.唇厚], v.嘴角 !== '平直' ? '嘴角' + esc(v.嘴角) : null].filter(Boolean).join(' · ') },
  { name: '肤色', keys: ['冷暖调', '季型', '肤色'], why: '肤色', val: (v, m) => `${esc(v.冷暖调)} · ${esc(v.季型)} <span class="swatches"><i class="me" style="background:${m.skinHex}" title="测得肤色"></i>${(SEASON_PALETTE[v.季型]?.colors || []).map(c => `<i style="background:${c}"></i>`).join('')}</span>` },
];

function photoSvg(rec) {
  const g = rec.analysis.geo, W = rec.w, H = rec.h;
  const boxH = (g.box.bottom - g.box.top) * H;
  const el = $('#report-body'); const boxW = Math.max(240, el.clientWidth - 32);
  // 优先完整显示发际线到下巴；照片偏窄时把画框加高
  let ch = Math.min(H, boxH), cw = Math.min(W, ch * boxW / 268);
  const dispH = Math.min(400, boxW * ch / cw);
  let x0 = g.box.cx * W - cw / 2, y0 = g.box.top * H - (ch - boxH) / 2;
  x0 = Math.max(0, Math.min(W - cw, x0)); y0 = Math.max(0, Math.min(H - ch, y0));
  const u = ch / dispH; // 1 个屏幕像素对应的图片像素
  photoSvg.h = Math.round(dispH);
  const href = rec.url || urlFor(rec);
  const lines = g.lines.map(([a, b], i) => {
    const est = g.hairlineEstimated && i === 0;
    return `<line x1="${a.x * W}" y1="${a.y * H}" x2="${b.x * W}" y2="${b.y * H}" stroke="${est ? '#C49A6C' : '#654633'}" stroke-width="${1.6 * u}" stroke-dasharray="${6 * u} ${4.5 * u}" opacity=".85"/>`;
  }).join('');
  const labels = ['上庭', '中庭', '下庭'].map((t, i) => {
    const p = g.labelsAt[i]; let x = p.x * W; x = Math.min(x, x0 + cw - 30 * u);
    return `<text x="${x}" y="${p.y * H + 5 * u}" font-size="${13 * u}" font-weight="600" fill="#fff" stroke="#654633" stroke-width="${3 * u}" paint-order="stroke">${t}</text>`;
  }).join('');
  const pts = g.points.map(p => `<circle cx="${p.x * W}" cy="${p.y * H}" r="${3.6 * u}" fill="#3FBF8A" stroke="#fff" stroke-width="${1.2 * u}"/>`).join('');
  return `<svg viewBox="${x0} ${y0} ${cw} ${ch}" preserveAspectRatio="xMidYMid slice" role="img" aria-label="照片上的三庭比例线和五官关键点">
    <image href="${href}" x="0" y="0" width="${W}" height="${H}"/>${lines}${pts}${labels}</svg>`;
}

function renderReport() {
  const body = $('#report-body');
  if (!current) { body.innerHTML = ''; return; }
  const { rec, sample } = current;
  const a = rec.analysis, m = a.metrics, ed = rec.edits || {};
  const v = valuesOf(rec);
  const missing = ['眼皮', '鼻梁'].filter(k => !v[k]);
  const tips = makeupTips(v, m);
  const shown = tipsExpanded ? tips : tips.slice(0, 3);
  body.innerHTML = `
    <div class="report-photo" style="height:${(photoSvg(rec), photoSvg.h)}px">${photoSvg(rec)}
      <span class="chip rose">${icon('spark')} AI 分析完成</span>${sample ? '<span class="chip">示例照片</span>' : ''}</div>
    <div class="legend"><span><i></i>三庭分界线</span><span><i class="pt"></i>五官关键点</span>${a.geo.hairlineEstimated ? '<span>发际线为估算</span>' : ''}</div>
    ${missing.length ? `<button class="confirm-bar" id="rp-confirm">${icon('info')}<span>${missing.join('、')}从正脸照片判断不准，请你来选</span>${icon('right')}</button>` : ''}
    <div class="card kv-card">
      ${ROWS.map((r, i) => {
        const edited = r.keys.some(k => ed[k] != null && ed[k] !== a.values[k]);
        const why = explain(r.why, v, m);
        return `<button class="kv" data-row="${i}"><span class="k">${r.name}</span><span class="r"><span class="v">${r.val(v, m, ed)} ${edited ? '<span class="edited">已修改</span>' : ''}${icon('edit')}</span>${why ? `<span class="why">${esc(why)}</span>` : ''}</span></button>`;
      }).join('')}
    </div>
    <div class="card tips">
      <h3>${icon('wand')} 给你的化妆建议</h3>
      <ul>${shown.map(t => `<li>${esc(t.text)}</li>`).join('')}</ul>
      ${tips.length > 3 ? `<button class="more" id="rp-more">${tipsExpanded ? '收起' : `展开全部 ${tips.length} 条`}</button>` : ''}
    </div>
    <button class="btn" style="margin-top:14px" id="rp-next">查看适合我的妆容</button>
    <button class="entry" id="rp-ai"><span class="ic">${icon('spark')}</span><span><b>按分析结果生成 AI 人物 · P1</b><small>五官可微调，先生成脸部再补全身</small></span>${icon('right')}</button>
    ${sample
      ? `<button class="btn secondary" style="margin-top:12px" id="rp-mine">${icon('camera')}拍我自己的照片</button>`
      : `<div class="report-actions">${rec.isDefault ? '<span class="muted" style="padding:6px 2px">默认试妆底图</span>' : '<button id="rp-def">设为默认底图</button>'}<button id="rp-retake">重拍替换</button><button class="danger" id="rp-del">删除照片</button></div>`}
    <p class="note" style="margin-top:16px">${icon('lock')}<span>分析在手机本地完成${m && a.ms ? `（用时 ${(a.ms / 1000).toFixed(1)} 秒）` : ''}。结果按关键点比例和取色规则估算，光线会影响肤色判断；点任意一项都可以手动修改。</span></p>`;
  hydrateIcons(body);
  body.querySelectorAll('[data-row]').forEach(b => b.addEventListener('click', () => editRow(ROWS[+b.dataset.row])));
  body.querySelector('#rp-confirm')?.addEventListener('click', () => editRow({ name: '待确认项', keys: missing }));
  body.querySelector('#rp-more')?.addEventListener('click', () => { tipsExpanded = !tipsExpanded; renderReport(); });
  body.querySelector('#rp-next').addEventListener('click', () => toast('妆容推荐（P07）将在下一阶段开放'));
  body.querySelector('#rp-ai').addEventListener('click', () => toast('AI 人物（P1）将在后续迭代开放'));
  body.querySelector('#rp-mine')?.addEventListener('click', () => openCamera({ reset: true }));
  body.querySelector('#rp-def')?.addEventListener('click', async () => { await store.setDefault(rec.id); rec.isDefault = true; toast('已设为默认试妆底图'); renderReport(); });
  body.querySelector('#rp-retake')?.addEventListener('click', () => { pending.replaceId = rec.id; chooseSource(); });
  body.querySelector('#rp-del')?.addEventListener('click', async () => {
    const ok = await confirmSheet({ title: '删除这张照片？', text: '照片和它的分析结果会一起删除，无法恢复。', ok: '删除', danger: true });
    if (!ok) return;
    await store.deletePhoto(rec.id); dropUrl(rec.id); current = null;
    toast('已删除照片和分析结果'); history.back();
  });
}

const OPT_TITLES = { 眼皮: '眼皮', 眼型: '眼睛形状', 眼尾: '眼尾走向', 眼距: '眼距', 眉形: '眉形', 眉色: '眉毛浓淡', 眉眼距: '眉眼距离', 鼻梁: '鼻梁高低', 鼻翼: '鼻翼宽窄', 唇形: '唇形', 唇厚: '唇厚', 嘴角: '嘴角走向', 肤色: '肤色深浅', 冷暖调: '冷暖调', 季型: '个人色彩季型', 脸型: '脸型', 三庭: '三庭比例' };
function editRow(row) {
  const { rec, sample } = current;
  const ai = rec.analysis.values;
  const draft = { ...valuesOf(rec) };
  const groups = () => row.keys.map(k => `<div class="opt-group"><h4>${OPT_TITLES[k] || k}${ai[k] ? '' : ' <span class="pending">AI 无法判断，请选择</span>'}</h4><div class="opts">
    ${OPTIONS[k].map(o => `<button class="opt ${draft[k] === o ? 'on' : ''}" data-k="${k}" data-o="${o}">${o}${ai[k] === o ? '<span class="ai">AI</span>' : ''}</button>`).join('')}</div></div>`).join('');
  openSheet(`<h2>修改${row.name}</h2><p class="lead">标着 AI 的是分析结果。改完后，化妆建议会按你的选择更新。</p>
    <div id="ed-groups">${groups()}</div>
    <button class="btn" id="ed-save">保存</button>
    <button class="text-center" id="ed-reset">恢复 AI 结果</button>`, s => {
    s.querySelector('#ed-groups').addEventListener('click', e => {
      const b = e.target.closest('.opt'); if (!b) return;
      draft[b.dataset.k] = b.dataset.o; s.querySelector('#ed-groups').innerHTML = groups();
    });
    const save = async edits => {
      rec.edits = edits;
      if (!sample) await store.putPhoto(rec);
      closeSheet(); renderReport();
    };
    s.querySelector('#ed-save').onclick = () => {
      const edits = { ...(rec.edits || {}) };
      for (const k of row.keys) { if (draft[k] != null && draft[k] !== ai[k]) edits[k] = draft[k]; else delete edits[k]; }
      save(edits).then(() => toast(sample ? '已修改（示例不会保存）' : '已保存修改'));
    };
    s.querySelector('#ed-reset').onclick = () => {
      const edits = { ...(rec.edits || {}) }; for (const k of row.keys) delete edits[k];
      save(edits).then(() => toast('已恢复 AI 结果'));
    };
  });
}

$('#report-share').addEventListener('click', () => toast('分享报告（可选择隐藏照片）将在下一阶段开放'));

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */
hydrateIcons();
history.replaceState({ zd: 0 }, '');
render();
// 提前在后台加载识别模型，进入拍照页时更快
// 只对已授权的用户预加载，避免首次打开就消耗流量
if (store.hasConsent()) {
  const idle = window.requestIdleCallback || (f => setTimeout(f, 800));
  idle(() => loadLandmarker().catch(() => {}));
}
