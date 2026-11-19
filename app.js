// 名刺ノート：名刺の文字は、この端末（ブラウザの中のIndexedDB）に保存する。
// 同期をオンにすると、鍵をかけてからCloudflareに置く（sync.js）。写真は保存しない。

const DB_NAME = 'meishi-note';
const STORE = 'cards';
const META = 'meta'; // 同期の設定など
const FIELDS = ['name', 'company', 'title', 'tel', 'mobile', 'email', 'url', 'address', 'met', 'memo'];
const LABELS = { title: '部署・役職', tel: '電話', mobile: '携帯', email: 'メール', url: 'サイト', address: '住所', met: 'もらった日', memo: 'メモ' };

const $ = id => document.getElementById(id);
let db;
let cards = [];
let currentId = null;   // 見ている・編集している名刺
let editPhoto = null;   // 編集中の写真（Blob）

// ---- 保存場所（IndexedDB） ----
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'id' });
      if (!d.objectStoreNames.contains(META)) d.createObjectStore(META);
    };
    req.onsuccess = () => {
      // 別の画面で保存場所の作り直しなどが始まったら、こちらは手を放して詰まらないようにする
      req.result.onversionchange = () => req.result.close();
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => alert('名刺ノートが別の画面でも開いています。ほかの画面を閉じてから開き直してください。');
  });
}
function tx(mode, fn, storeName = STORE) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    const result = fn(store);
    t.oncomplete = () => resolve(result && result.result !== undefined ? result.result : undefined);
    t.onerror = () => reject(t.error);
  });
}
// 消した名刺も「消した」という印（deleted）を残す。同期で、ほかの端末からも消すため
const getAll = () => tx('readonly', s => s.getAll());
const putCard = card => tx('readwrite', s => s.put(card));
const deleteCard = id => putCard({ id, deleted: true, updated: Date.now() });
const getMeta = key => tx('readonly', s => s.get(key), META);
const setMeta = (key, value) => tx('readwrite', s => (value === undefined ? s.delete(key) : s.put(value, key)), META);
// 保存したら同期に知らせる（sync.js があるときだけ）
const notifyChanged = () => typeof Sync !== 'undefined' && Sync.changed();

// ---- 写真を小さくする（保存の量を減らす） ----
async function shrinkPhoto(file, maxSide = 1600) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85));
}
// ---- 画面の切りかえ ----
function show(view) {
  for (const v of ['list', 'edit', 'detail']) $('view-' + v).hidden = v !== view;
  window.scrollTo(0, 0);
}

// ---- 一覧 ----
let sortMode = 'new';
try { sortMode = localStorage.getItem('sortMode') || 'new'; } catch {}

// 「株式会社〇〇」「〇〇(株)」「〇〇 株式会社」を同じ会社としてまとめるための名前
function companyKey(name) {
  return (name || '')
    .replace(/株式会社|有限会社|合同会社|\(株\)|（株）|㈱|\(有\)|（有）|㈲|\s/g, '')
    .toLowerCase();
}

// ---- しばらく連絡していない人 ----
// 「連絡した」を押した日を名刺ごとに残す（contactLog＝'2026-10-27' の並び）。
// 一度も押していない名刺は、名刺をもらった日から数える
const LONG_DAYS = 90; // これより長く連絡していない人を「久しぶり」にする
function dayStr(d = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function lastTouch(c) {
  const log = c.contactLog || [];
  if (log.length) return log[log.length - 1];
  if (/^\d{4}-\d{2}-\d{2}$/.test(c.met || '')) return c.met;
  return dayStr(new Date(c.created || Date.now()));
}
function daysSince(s) {
  const [y, m, d] = s.split('-').map(Number);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.max(0, Math.round((today - new Date(y, m - 1, d)) / 86400000));
}
function agoText(n) {
  if (n === 0) return '今日';
  if (n < 60) return `${n}日`;
  if (n < 730) return `約${Math.floor(n / 30)}か月`;
  return `約${Math.floor(n / 365)}年`;
}

function cardItem(c) {
  // 一覧の1枚＝小さな紙の名刺（会社・名前・役職、右に頭文字の印と電話）
  // 「久しぶり」の並びのときは、電話の代わりに連絡していない日数を出す
  const li = document.createElement('li');
  li.className = 'card';
  const el = (cls, text) => { const e = document.createElement('div'); e.className = cls; e.textContent = text; return e; };
  const n = daysSince(lastTouch(c));
  li.append(
    el('co', c.company || ''),
    el('avatar', (c.name || companyKey(c.company) || '？').charAt(0).toUpperCase()),
    el('name', c.name || '（名前なし）'),
    el('sub', c.title || ''),
    sortMode === 'long' ? el('tel' + (n >= LONG_DAYS ? ' long' : ''), n ? `${agoText(n)} 連絡なし` : ((c.contactLog || []).length ? '今日 連絡した' : '今日 もらった'))
      : el('tel', c.mobile || c.tel || ''),
  );
  li.onclick = () => openDetail(c.id);
  return li;
}

function renderList() {
  const q = $('search').value.trim().toLowerCase();
  const hit = cards.filter(c => !q || FIELDS.some(f => (c[f] || '').toLowerCase().includes(q)));
  const list = $('list');
  list.textContent = '';
  list.classList.toggle('stacked', sortMode === 'company'); // 会社ごとのときは名刺を少し重ねる
  $('sort-new').classList.toggle('on', sortMode === 'new');
  $('sort-company').classList.toggle('on', sortMode === 'company');
  $('sort-long').classList.toggle('on', sortMode === 'long');

  if (sortMode === 'long') {
    // 連絡していない期間が長い順。90日以上・30〜89日・29日以内に分ける
    const withDays = hit.map(c => ({ c, n: daysSince(lastTouch(c)) })).sort((a, b) => b.n - a.n);
    const bands = [
      { label: '90日以上 連絡なし', test: n => n >= LONG_DAYS },
      { label: '30〜89日', test: n => n >= 30 && n < LONG_DAYS },
      { label: '29日以内', test: n => n < 30 },
    ];
    for (const b of bands) {
      const items = withDays.filter(x => b.test(x.n));
      if (!items.length) continue;
      const head = document.createElement('li');
      head.className = 'group-head';
      const t = document.createElement('span');
      t.textContent = b.label;
      const cnt = document.createElement('span');
      cnt.textContent = `${items.length}人`;
      head.append(t, cnt);
      list.append(head);
      for (const x of items) list.append(cardItem(x.c));
    }
  } else if (sortMode === 'company') {
    const groups = new Map();
    for (const c of hit) {
      const key = companyKey(c.company) || '~';
      if (!groups.has(key)) groups.set(key, { label: c.company || '会社名なし', items: [] });
      groups.get(key).items.push(c);
    }
    const keys = [...groups.keys()].sort((a, b) => (a === '~') - (b === '~') || a.localeCompare(b, 'ja'));
    for (const k of keys) {
      const g = groups.get(k);
      const head = document.createElement('li');
      head.className = 'group-head';
      const t = document.createElement('span');
      t.textContent = g.label;
      const n = document.createElement('span');
      n.textContent = `${g.items.length}人`;
      head.append(t, n);
      list.append(head);
      g.items.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ja'));
      for (const c of g.items) list.append(cardItem(c));
    }
  } else {
    for (const c of hit) list.append(cardItem(c));
  }
  $('count').textContent = cards.length ? (q ? `${hit.length}件 / 全${cards.length}件` : `全${cards.length}件`) : '';
  $('empty').hidden = cards.length > 0;
}

async function reload() {
  cards = (await getAll()).filter(c => !c.deleted);
  cards.sort((a, b) => (b.updated || 0) - (a.updated || 0));
  renderList();
}

// ---- 登録・編集 ----
function openEdit(id) {
  currentId = id;
  const c = cards.find(x => x.id === id) || {};
  $('edit-title').textContent = id ? '名刺を編集' : '名刺を登録';
  for (const f of FIELDS) $('f-' + f).value = c[f] || '';
  if (!id) $('f-met').value = new Date().toISOString().slice(0, 10);
  editPhoto = null;
  setPreview(null);
  $('ocr-text').value = c.ocrText || '';
  $('ocr').open = false;
  setStatus('');
  $('btn-scan').textContent = id ? '📷 表を読み直す' : '📷 表を読み取る';
  show('edit');
  if (!id) openCamera('front'); // 新しく登録するときは、すぐカメラを開く
}

// ---- 表と裏 ----
// 読み取った文字は1つの枠に「表の文字 ―― 裏 ―― 裏の文字」の形で入れる。
// 表を読み直しても裏の文字は残し、裏を読み直しても表の文字は残す
const BACK_SEP = '\n―― 裏 ――\n';
function putOcr(side, text) {
  const [front = '', back = ''] = $('ocr-text').value.split(BACK_SEP);
  const f = side === 'front' ? text.trim() : front.trim();
  const b = side === 'back' ? text.trim() : back.trim();
  $('ocr-text').value = b ? f + BACK_SEP + b : f;
}
function doneMessage(side) {
  return side === 'back'
    ? '✅ 裏の文字を取りこみ、空いている欄にだけ入れました。中身を確かめて「保存」してください。'
    : '✅ 読み取って、空いている欄に入れました。裏にも文字があれば「裏を読み取る」。まちがっている欄は直して「保存」。';
}
// 読み取りに使った画像は、この画面にいる間だけ見せる（保存しない）
function setPreview(blob) {
  const img = $('photo-preview');
  if (img.dataset.url) URL.revokeObjectURL(img.dataset.url);
  img.removeAttribute('src');
  if (blob) {
    img.dataset.url = URL.createObjectURL(blob);
    img.src = img.dataset.url;
  }
  img.hidden = !blob;
  $('scan-note').hidden = !blob;
}
$('btn-scan').onclick = () => openCamera('front');
$('btn-scan-back').onclick = () => openCamera('back');

// ---- アプリの中のカメラ（映像を1コマだけ読み取りに使い、ファイルは作らない） ----
let camStream = null;
let scanSide = 'front'; // いま読んでいるのは名刺の表か裏か
async function openCamera(side) {
  scanSide = side;
  $('view-camera').hidden = false;
  $('cam-shot').disabled = true;
  try {
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } },
      audio: false,
    });
    $('cam-video').srcObject = camStream;
    await $('cam-video').play();
    $('cam-shot').disabled = false;
    setCamHint('読み取りの準備中…（はじめてだけ少し時間がかかります）');
    await getOcrWorker();
    if (camStream) startAuto();
  } catch (err) {
    console.error(err);
    closeCamera();
    alert('カメラを使えませんでした。カメラの使用を「許可」するか、編集画面から読み取り直してください。');
  }
}
function closeCamera() {
  stopAuto();
  if (camStream) camStream.getTracks().forEach(t => t.stop());
  camStream = null;
  $('cam-video').srcObject = null;
  $('view-camera').hidden = true;
}

// わくの中だけを切り取る（映像は画面いっぱいに拡大して映しているので、その分を戻して計算する）
// outW を渡すと、その幅に小さくする（動きやピントを調べる用）
function guideCanvas(outW) {
  const video = $('cam-video');
  const vr = video.getBoundingClientRect();
  const gr = $('cam-guide').getBoundingClientRect();
  const vw = video.videoWidth, vh = video.videoHeight;
  const scale = Math.max(vr.width / vw, vr.height / vh);
  const offX = (vr.width - vw * scale) / 2, offY = (vr.height - vh * scale) / 2;
  const pad = 0.04 * gr.width; // 少し外側まで入れる
  let sx = (gr.left - pad - vr.left - offX) / scale, sy = (gr.top - pad - vr.top - offY) / scale;
  let sw = (gr.width + pad * 2) / scale, sh = (gr.height + pad * 2) / scale;
  sx = Math.max(0, sx); sy = Math.max(0, sy);
  sw = Math.min(vw - sx, sw); sh = Math.min(vh - sy, sh);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(outW || sw);
  canvas.height = Math.round(outW ? sh * outW / sw : sh);
  canvas.getContext('2d', { willReadFrequently: !!outW }).drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas;
}
function grabGuideArea() {
  return new Promise(resolve => guideCanvas().toBlob(resolve, 'image/jpeg', 0.92));
}

// ---- わくに名刺が入ったら自動で読み取る ----
// 0.4秒ごとにわくの中を小さくして調べ、「止まっている」かつ「文字がくっきり」なら読み取ってみる。
// 名前・会社・電話・メールのうち3つ以上読めたら完了。読めなければ、そのまま見続ける。
const AUTO = { interval: 400, still: 10, sharp: 6, stableNeeded: 2, enoughFields: 3 };
let autoTimer = null, prevGray = null, stableCount = 0, autoBusy = false;

function grayOf(canvas) {
  const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  const g = new Float32Array(data.length / 4);
  for (let i = 0; i < g.length; i++) g[i] = data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114;
  return g;
}
// 動き：前のコマとの明るさのちがい（小さいほど止まっている）
function motion(a, b) {
  if (!b || a.length !== b.length) return 255;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}
// くっきり度：となりの点との明るさのちがいの平均（文字がはっきり写っているほど大きい）
function sharpness(g, w) {
  let s = 0, n = 0;
  for (let i = 0; i + w + 1 < g.length; i++) {
    if ((i + 1) % w === 0) continue;
    s += Math.abs(g[i] - g[i + 1]) + Math.abs(g[i] - g[i + w]);
    n++;
  }
  return s / n;
}
function fieldScore(r) {
  return ['name', 'company', 'tel', 'mobile', 'email'].filter(k => r[k]).length;
}
function setCamHint(html, ok) {
  $('cam-hint').innerHTML = html;
  $('cam-guide').classList.toggle('ok', !!ok);
}

function placeHint() {
  return scanSide === 'back' ? '名刺の<b>裏</b>を、わくに入れてください' : '名刺を<b>横向き</b>にして、わくに入れてください';
}
// 読めたとみなす目安。表は名前・会社・電話・メールのうち3つ以上。
// 裏は英語だけ・説明文だけのこともあるので、メール・電話・サイトが1つあるか、
// 文字（漢字・かな・英数字）が20字以上あれば読めたことにする（記号だけのゴミは読めていない扱い）
function readEnough(text, side) {
  if (side === 'front') return fieldScore(parseCard(text)) >= AUTO.enoughFields;
  return /@[\w-]+\.|\d{2,4}-\d{2,4}-\d{3,4}|https?:|www\./i.test(text) || (text.match(/[一-龥ぁ-んァ-ヶA-Za-z0-9]/g) || []).length >= 20;
}

function startAuto() {
  stopAuto();
  prevGray = null;
  stableCount = 0;
  autoBusy = false;
  setCamHint(placeHint());
  autoTimer = setInterval(autoTick, AUTO.interval);
}
function stopAuto() {
  clearInterval(autoTimer);
  autoTimer = null;
}
async function autoTick() {
  if (!camStream || autoBusy || !$('cam-video').videoWidth) return;
  const small = guideCanvas(240);
  const g = grayOf(small);
  const moving = motion(g, prevGray);
  prevGray = g;
  const sharp = sharpness(g, small.width);
  stableCount = moving < AUTO.still && sharp > AUTO.sharp ? stableCount + 1 : 0;
  if (stableCount < AUTO.stableNeeded) {
    if (sharp <= AUTO.sharp) setCamHint(placeHint());
    else setCamHint('そのまま動かさないでください…');
    return;
  }
  autoBusy = true;
  setCamHint('🔍 読み取り中…', true);
  try {
    const blob = await grabGuideArea();
    const text = await recognizeCard(blob, false);
    if (!camStream) return; // 読み取り中に「やめる」が押されたとき
    const side = scanSide;
    if (readEnough(text, side)) {
      closeCamera();
      editPhoto = blob;
      setPreview(blob);
      putOcr(side, text);
      applyParsed(parseCard(text), false);
      // カメラを閉じたあと、細かい文字も拾う読み方でもう1回読み、空いている欄を埋める
      setStatus('🔍 細かい文字も読み取り中…');
      const worker = await getOcrWorker();
      await worker.setParameters({ tessedit_pageseg_mode: '11' });
      const { data } = await worker.recognize(blob);
      if (editPhoto !== blob) return;
      const merged = text.trim() + '\n' + data.text.trim();
      putOcr(side, merged);
      applyParsed(parseCard(merged), false);
      setStatus(doneMessage(side));
      return;
    }
    setCamHint('うまく読めませんでした。少し近づけて、まっすぐにしてください');
  } catch (err) {
    console.error(err);
  } finally {
    stableCount = 0;
    autoBusy = false;
  }
}

$('cam-shot').onclick = async () => {
  const blob = await grabGuideArea();
  closeCamera();
  useImage(blob);
};
$('cam-cancel').onclick = () => {
  closeCamera();
  // 新しい登録で、まだ何も入っていなければ一覧に戻る
  if (!currentId && FIELDS.every(f => f === 'met' || !$('f-' + f).value)) show('list');
};
$('photo-input').onchange = async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  closeCamera();
  useImage(await shrinkPhoto(file));
};
function useImage(blob) {
  editPhoto = blob;
  setPreview(blob);
  readPhoto(blob);
}

// ---- 写真の文字を自動で読み取る（Tesseract.js。iPhoneの中だけで動き、どこにも送らない） ----
let ocrWorker = null;
let ocrProgress = () => {};
async function getOcrWorker() {
  if (!ocrWorker) {
    const base = new URL('vendor/', location.href).href;
    ocrWorker = await Tesseract.createWorker(['jpn', 'eng'], 1, {
      workerPath: base + 'worker.min.js',
      corePath: base,
      langPath: base + 'lang',
      gzip: true,
      logger: m => ocrProgress(m),
    });
  }
  return ocrWorker;
}

function setStatus(text) {
  $('ocr-status').hidden = !text;
  $('ocr-status').textContent = text || '';
}

// 画像から文字を読む。retry=true なら、名前が取れなかったときに
// ばらばらの文字を拾う読み方（sparse）でもう1回読み、足りない欄を補う
async function recognizeCard(blob, retry) {
  const worker = await getOcrWorker();
  await worker.setParameters({ tessedit_pageseg_mode: '3' });
  let { data } = await worker.recognize(blob);
  let text = data.text;
  if (retry && !parseCard(text).name) {
    await worker.setParameters({ tessedit_pageseg_mode: '11' });
    ({ data } = await worker.recognize(blob));
    text = data.text + '\n' + text;
  }
  return text;
}

async function readPhoto(blob) {
  const STEPS = { 'loading tesseract core': '準備中', 'initializing api': '準備中', 'loading language traineddata': '読み取りの準備中（はじめてだけ少し時間がかかります）', 'recognizing text': '読み取り中' };
  ocrProgress = m => {
    const label = STEPS[m.status];
    if (label) setStatus(`🔍 ${label}… ${m.status === 'recognizing text' ? Math.round(m.progress * 100) + '%' : ''}`);
  };
  setStatus('🔍 読み取りの準備中…');
  const side = scanSide;
  try {
    const text = await recognizeCard(blob, true);
    if (editPhoto !== blob) return; // 読み取り中に写真が変わったとき
    putOcr(side, text);
    applyParsed(parseCard(text), false);
    setStatus(doneMessage(side));
  } catch (err) {
    console.error(err);
    setStatus('⚠️ 自動の読み取りができませんでした。下の「読み取った文字」からiPhoneの読み取りを使ってください。');
    $('ocr').open = true;
  }
}

// 振り分けた結果を欄に入れる（overwrite=false のときは空の欄だけ）
function applyParsed(r, overwrite) {
  for (const [k, v] of Object.entries(r)) {
    if (v && (overwrite || !$('f-' + k).value)) $('f-' + k).value = v;
  }
}

$('btn-parse').onclick = () => {
  const text = $('ocr-text').value;
  if (!text.trim()) { alert('枠に文字がありません。'); return; }
  applyParsed(parseCard(text), true);
  $('f-name').scrollIntoView({ behavior: 'smooth', block: 'center' });
};

// iPhoneの読み取り（長押し→コピー）した文字を、ボタン1つで貼って振り分ける
$('btn-paste').onclick = async () => {
  let text = '';
  try { text = await navigator.clipboard.readText(); } catch {}
  if (!text.trim()) { alert('コピーした文字が見つかりませんでした。写真の文字を長押し →「すべてを選択」→「コピー」してから押してください。'); return; }
  $('ocr-text').value = text;
  applyParsed(parseCard(text), true);
  setStatus('✅ コピーした文字で振り分けました。');
  $('f-name').scrollIntoView({ behavior: 'smooth', block: 'center' });
};

$('btn-save').onclick = async () => {
  const old = cards.find(x => x.id === currentId) || {};
  const card = { ...old, id: currentId || crypto.randomUUID(), created: old.created || Date.now(), updated: Date.now() };
  for (const f of FIELDS) card[f] = $('f-' + f).value.trim();
  card.ocrText = $('ocr-text').value;
  delete card.photo; // 写真は保存しない
  if (!card.name && !card.company) { alert('名前か会社を入れてください。'); return; }
  setPreview(null);
  editPhoto = null;
  await putCard(card);
  notifyChanged();
  await reload();
  openDetail(card.id);
};
$('btn-edit-back').onclick = () => {
  setPreview(null);
  editPhoto = null;
  currentId ? openDetail(currentId) : show('list');
};

// ---- くわしく見る ----
function openDetail(id) {
  currentId = id;
  const c = cards.find(x => x.id === id);
  if (!c) return show('list');
  $('d-name').textContent = c.name || '（名前なし）';
  $('d-company').textContent = c.company || '';
  $('d-title').textContent = c.title || '';
  // 名刺の表の下の行：電話（なければ携帯）とメール
  const foot = $('d-foot');
  foot.textContent = '';
  for (const v of [c.tel || c.mobile, c.email]) {
    if (!v) continue;
    const s = document.createElement('span');
    s.textContent = v;
    foot.append(s);
  }
  const dl = $('d-fields');
  dl.textContent = '';
  for (const f of ['title', 'tel', 'mobile', 'email', 'url', 'address', 'met', 'memo']) {
    if (!c[f]) continue;
    const row = document.createElement('div');
    const dt = document.createElement('dt');
    dt.textContent = LABELS[f];
    const dd = document.createElement('dd');
    let href = '';
    if (f === 'tel' || f === 'mobile') href = 'tel:' + c[f].replace(/[^\d+]/g, '');
    if (f === 'email') href = 'mailto:' + c[f];
    if (f === 'url') href = /^https?:/i.test(c[f]) ? c[f] : 'https://' + c[f];
    if (href) {
      const a = document.createElement('a');
      a.href = href;
      a.textContent = c[f];
      if (f === 'url') { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
      dd.append(a);
    } else {
      dd.textContent = c[f];
    }
    row.className = 'row';
    const text = document.createElement('div');
    text.append(dt, dd);
    row.append(text);
    if (f !== 'met') {
      const copy = document.createElement('button');
      copy.className = 'copy-btn';
      copy.textContent = 'コピー';
      copy.onclick = () => copyText(c[f], `${LABELS[f]}をコピーしました`);
      row.append(copy);
    }
    dl.append(row);
  }
  renderTouch(c);
  const raw = (c.ocrText || '').trim();
  $('d-ocr').hidden = !raw;
  $('d-ocr-text').textContent = raw;
  show('detail');
}
// 最後に連絡した日と「連絡した」ボタン
function renderTouch(c) {
  const log = c.contactLog || [];
  const n = daysSince(lastTouch(c));
  const last = log.length ? log[log.length - 1] : '';
  $('d-since').textContent = log.length
    ? (n ? `最後に連絡してから ${agoText(n)}（${last.replace(/-/g, '/')}）` : '今日 連絡しました')
    : `まだ「連絡した」の記録がありません（名刺をもらってから ${agoText(n)}）`;
  $('d-since').classList.toggle('long', n >= LONG_DAYS);
  $('d-log').textContent = log.length ? '連絡した日：' + log.slice(-5).reverse().map(s => s.slice(5).replace('-', '/')).join('・') + (log.length > 5 ? ` ほか${log.length - 5}回` : '') : '';
  const today = last === dayStr();
  $('btn-touched').textContent = today ? '今日の「連絡した」を取り消す' : '今日 連絡した';
  $('btn-touched').classList.toggle('secondary', today);
}
let touching = false; // 保存が終わるまで2回目を受けつけない（すばやく2回押したときのため）
$('btn-touched').onclick = async () => {
  const c = cards.find(x => x.id === currentId);
  if (!c || touching) return;
  touching = true;
  $('btn-touched').disabled = true;
  try {
    const today = dayStr();
    let log = (c.contactLog || []).filter(s => s !== today);
    const undo = (c.contactLog || []).includes(today);
    if (!undo) log = [...log, today].sort();
    const card = { ...c, contactLog: log, updated: Date.now() };
    await putCard(card);
    notifyChanged();
    await reload();
    renderTouch(card);
    toast(undo ? '取り消しました' : '連絡した日を残しました');
  } finally {
    touching = false;
    $('btn-touched').disabled = false;
  }
};
$('btn-copy-ocr').onclick = () => {
  const c = cards.find(x => x.id === currentId);
  copyText((c.ocrText || '').trim(), '名刺の文字をコピーしました');
};
// ---- コピー ----
let toastTimer;
function toast(msg) {
  $('toast').textContent = msg;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($('toast').hidden = true), 1800);
}
async function copyText(text, msg) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // 古いやり方（クリップボードの機能が使えないとき）
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(msg);
}
$('btn-copy-all').onclick = () => {
  const c = cards.find(x => x.id === currentId);
  const lines = [c.name, c.company, c.title, ...['tel', 'mobile', 'email', 'url', 'address'].filter(f => c[f]).map(f => `${LABELS[f]}：${c[f]}`)];
  copyText(lines.filter(Boolean).join('\n'), '全部コピーしました');
};

// ---- iPhoneの連絡先に追加（vCardという連絡先のファイルを作って開く） ----
function vEscape(s) { return (s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1'); }
function makeVCard(c) {
  // 連絡先の名前は「会社名 名前」（例：サンプル商事 山田太郎）。
  // 姓の欄に会社名、名の欄に名前を入れるので、iPhoneの連絡先では会社ごとに並ぶ。
  // 「株式会社」などは長くなるので名前からは外す（会社の欄には正式な名前を入れる）
  const name = (c.name || '').trim().replace(/\s+/g, '');
  const shortCompany = (c.company || '')
    .replace(/株式会社|有限会社|合同会社|\(株\)|（株）|㈱|\(有\)|（有）|㈲/g, '')
    .trim();
  const lines = ['BEGIN:VCARD', 'VERSION:3.0',
    `N:${vEscape(shortCompany)};${vEscape(name)};;;`,
    `FN:${vEscape([shortCompany, name].filter(Boolean).join(' '))}`];
  if (c.company) lines.push(`ORG:${vEscape(c.company)}`);
  if (c.title) lines.push(`TITLE:${vEscape(c.title)}`);
  if (c.tel) lines.push(`TEL;TYPE=WORK,VOICE:${c.tel}`);
  if (c.mobile) lines.push(`TEL;TYPE=CELL:${c.mobile}`);
  if (c.email) lines.push(`EMAIL;TYPE=INTERNET,WORK:${c.email}`);
  if (c.url) lines.push(`URL:${/^https?:/i.test(c.url) ? c.url : 'https://' + c.url}`);
  if (c.address) {
    const postal = (c.address.match(/\d{3}-?\d{4}/) || [''])[0];
    const street = c.address.replace(/〒?\s*\d{3}-?\d{4}\s*/, '').trim();
    lines.push(`ADR;TYPE=WORK:;;${vEscape(street)};;;${postal};`);
  }
  const note = [c.met && `名刺をもらった日：${c.met}`, c.memo].filter(Boolean).join('\n');
  if (note) lines.push(`NOTE:${vEscape(note)}`);
  lines.push('END:VCARD');
  return lines.join('\r\n') + '\r\n';
}
$('btn-contact').onclick = async () => {
  const c = cards.find(x => x.id === currentId);
  const file = new File([makeVCard(c)], `${(c.name || c.company || '名刺').replace(/[\\/:*?"<>|]/g, '')}.vcf`, { type: 'text/vcard' });
  // iPhoneでは連絡先の画面が開くので、「新規連絡先を作成」を押す
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
};

// ---- 会ったあとのお礼・再連絡をiPhoneのカレンダーに入れる（予定のファイル .ics を作って開く。サーバーは使わない） ----
// Windowsの改行（\r\n・\r）も \n にそろえてから、カレンダーのファイルの決まりで書きかえる
function icsEscape(s) { return (s || '').replace(/\r\n?/g, '\n').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1'); }
// 長い行は75バイトごとに折り返す（カレンダーのファイルの決まり。日本語は1文字3バイト）
function icsFold(line) {
  const enc = new TextEncoder();
  const out = [];
  let cur = '';
  for (const ch of line) {
    if (enc.encode(cur + ch).length > 74) { out.push(cur); cur = ' ' + ch; } else cur += ch;
  }
  out.push(cur);
  return out.join('\r\n');
}
function makeICS(c, days) {
  const pad = n => String(n).padStart(2, '0');
  const d = new Date();
  d.setDate(d.getDate() + days);
  const day = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const now = new Date();
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
  const who = [c.name ? `${c.name}さん` : '', c.company ? `（${c.company}）` : ''].join('') || '名刺の相手';
  const notes = [
    c.met && `名刺をもらった日：${c.met}`,
    c.tel && `電話：${c.tel}`,
    c.mobile && `携帯：${c.mobile}`,
    c.email && `メール：${c.email}`,
    c.memo && `メモ：${c.memo}`,
  ].filter(Boolean).join('\n');
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//meishi-note//JA', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${crypto.randomUUID()}@meishi-note`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${day}T090000`, // その日の朝9時（iPhoneの時刻のまま）
    'DURATION:PT15M',
    `SUMMARY:${icsEscape('お礼・連絡：' + who)}`,
    notes && `DESCRIPTION:${icsEscape(notes)}`,
    'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEscape('お礼・連絡：' + who)}`, 'TRIGGER:PT0M', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ].filter(Boolean);
  return lines.map(icsFold).join('\r\n') + '\r\n';
}
$('btn-cal').onclick = () => {
  const c = cards.find(x => x.id === currentId);
  $('cal-who').textContent = [c.name, c.company].filter(Boolean).join('　');
  $('cal-dialog').showModal();
};
$('btn-cal-cancel').onclick = () => $('cal-dialog').close();
for (const b of document.querySelectorAll('#cal-dialog [data-days]')) {
  b.onclick = () => {
    const c = cards.find(x => x.id === currentId);
    const file = new File([makeICS(c, Number(b.dataset.days))], `お礼_${(c.name || c.company || '名刺').replace(/[\\/:*?"<>|]/g, '')}.ics`, { type: 'text/calendar' });
    // iPhoneでは、カレンダーに追加する画面が開くはず（ホーム画面から開いたときの動きは実機で確かめる）
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = file.name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    $('cal-dialog').close();
  };
}

$('btn-detail-back').onclick = () => { show('list'); renderList(); };
$('btn-edit').onclick = () => openEdit(currentId);
$('btn-delete').onclick = async () => {
  const c = cards.find(x => x.id === currentId);
  if (!confirm(`「${c.name || '名前なし'}」の名刺を消します。元に戻せません。よろしいですか？`)) return;
  await deleteCard(currentId);
  notifyChanged();
  await reload();
  show('list');
};

// ---- 一覧の操作 ----
$('search').oninput = renderList;
function setSort(mode) {
  sortMode = mode;
  try { localStorage.setItem('sortMode', mode); } catch {}
  renderList();
}
$('sort-new').onclick = () => setSort('new');
$('sort-company').onclick = () => setSort('company');
$('sort-long').onclick = () => setSort('long');
$('btn-add').onclick = () => openEdit(null);

// ---- メニュー（バックアップ） ----
$('btn-menu').onclick = async () => {
  let info = '';
  try {
    const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : false;
    info = `登録数：${cards.length}件　／　消えにくい保存：${persisted ? 'オン' : 'オフ（ホーム画面に追加すると消えにくくなります）'}`;
  } catch { info = `登録数：${cards.length}件`; }
  $('storage-info').textContent = info;
  $('menu').showModal();
};
$('btn-menu-close').onclick = () => $('menu').close();

$('btn-export').onclick = async () => {
  const data = cards.map(({ photo, ...rest }) => rest);
  const file = new File([JSON.stringify({ app: 'meishi-note', version: 1, exported: new Date().toISOString(), cards: data })],
    `名刺ノート_バックアップ_${new Date().toISOString().slice(0, 10)}.json`, { type: 'application/json' });
  // iPhoneでは共有シートから「"ファイル"に保存」を選べる
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
};

$('import-input').onchange = async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const json = JSON.parse(await file.text());
    if (json.app !== 'meishi-note' || !Array.isArray(json.cards)) throw new Error('形がちがう');
    if (!confirm(`${json.cards.length}件の名刺を読み込みます。同じ名刺は上書きされます。よろしいですか？`)) return;
    for (const c of json.cards) {
      delete c.photo; // 前の版のバックアップに写真があっても読み込まない
      await putCard(c);
    }
    notifyChanged();
    await reload();
    $('menu').close();
    alert('読み込みました。');
  } catch {
    alert('このファイルは読み込めませんでした。名刺ノートで書き出したバックアップを選んでください。');
  }
};

// この端末の名刺を全部消す（引っ越しのあと、古いアドレスに残った名刺を消すときなどに使う）。
// 同期は止めるので、ほかの端末とCloudflareに置いた分は消えない
$('btn-wipe').onclick = async () => {
  if (!confirm(`この端末にある名刺${cards.length}件を全部消します。先にバックアップを書き出しましたか？（同期は止まります。ほかの端末の名刺と、クラウドの控えは消えません。控えも消すときは、同期中に「クラウドの控えも消す」を使ってください）`)) return;
  if (!confirm('本当に全部消しますか？')) return;
  if (typeof Sync !== 'undefined') await Sync.disconnect();
  await tx('readwrite', s => s.clear());
  await reload();
  $('menu').close();
  toast('全部消しました');
};

// ---- はじめに ----
// 古いアドレス（GitHub Pages）で開いたときは、引っ越しの案内を出す
const OLD_HOST = 'yusei9954.github.io';
$('moved').hidden = location.hostname !== OLD_HOST;

// sync.js などほかのプログラムが全部読み込まれてから始める（ネットが遅いと、同期が始まらないことがあったため）
document.addEventListener('DOMContentLoaded', async () => {
  db = await openDB();
  await reload();
  if (typeof Sync !== 'undefined') await Sync.init();
  // データを消えにくくする（ホーム画面に追加したアプリでは特に効く）
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
});
