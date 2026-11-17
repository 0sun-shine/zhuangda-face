// 本机存储：照片与分析结果只保存在当前浏览器（IndexedDB），不上传。
const DB = 'zhuangda-face', STORE = 'photos', VER = 1;
export const MAX_PHOTOS = 5;

let dbp = null;
const memory = new Map(); // IndexedDB 不可用时（如无痕模式）退回内存，仅本次打开有效
let memoryMode = false;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, VER);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { memoryMode = true; resolve(null); };
      req.onblocked = () => { memoryMode = true; resolve(null); };
    } catch (e) { memoryMode = true; resolve(null); }
  });
  return dbp;
}

async function tx(mode, fn) {
  const db = await open();
  if (!db) return fn(null);
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const s = t.objectStore(STORE);
    let out;
    Promise.resolve(fn(s)).then(v => { out = v; });
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
const req2p = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const isMemoryOnly = () => memoryMode;

export async function listPhotos() {
  try {
    const all = await tx('readonly', s => s ? req2p(s.getAll()) : [...memory.values()]);
    return (all || []).sort((a, b) => (b.isDefault - a.isDefault) || (b.createdAt - a.createdAt));
  } catch (e) { memoryMode = true; return [...memory.values()]; }
}

export async function getPhoto(id) {
  try { return await tx('readonly', s => s ? req2p(s.get(id)) : memory.get(id)); }
  catch (e) { return memory.get(id); }
}

export async function putPhoto(rec) {
  try { await tx('readwrite', s => s ? req2p(s.put(rec)) : memory.set(rec.id, rec)); }
  catch (e) { memoryMode = true; memory.set(rec.id, rec); }
  return rec;
}

export async function deletePhoto(id) {
  const list = await listPhotos();
  const target = list.find(p => p.id === id);
  try { await tx('readwrite', s => s ? req2p(s.delete(id)) : memory.delete(id)); }
  catch (e) { memory.delete(id); }
  if (target?.isDefault) {
    const rest = list.filter(p => p.id !== id);
    if (rest[0]) await setDefault(rest[0].id);
  }
}

export async function setDefault(id) {
  const list = await listPhotos();
  for (const p of list) {
    const want = p.id === id;
    if (!!p.isDefault !== want) { p.isDefault = want; await putPhoto(p); }
  }
}

export async function clearAll() {
  try { await tx('readwrite', s => s ? req2p(s.clear()) : memory.clear()); }
  catch (e) { memory.clear(); }
}

/* 人脸信息单独同意 */
const CONSENT_KEY = 'zhuangda.faceConsent.v1';
export function hasConsent() {
  try { return !!localStorage.getItem(CONSENT_KEY); } catch (e) { return !!hasConsent.mem; }
}
export function setConsent(on) {
  hasConsent.mem = on;
  try { on ? localStorage.setItem(CONSENT_KEY, String(Date.now())) : localStorage.removeItem(CONSENT_KEY); } catch (e) { /* 仅本次有效 */ }
}
