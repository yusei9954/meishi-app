// 名刺ノート：データと写真は、このiPhone（ブラウザの中のIndexedDB）だけに保存する

const DB_NAME = 'meishi-note';
const STORE = 'cards';
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
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => {
      // 別の画面で保存場所の作り直しなどが始まったら、こちらは手を放して詰まらないようにする
      req.result.onversionchange = () => req.result.close();
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => alert('名刺ノートが別の画面でも開いています。ほかの画面を閉じてから開き直してください。');
  });
}
function tx(mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const result = fn(store);
    t.oncomplete = () => resolve(result && result.result !== undefined ? result.result : undefined);
    t.onerror = () => reject(t.error);
  });
}
const getAll = () => tx('readonly', s => s.getAll());
const putCard = card => tx('readwrite', s => s.put(card));
const deleteCard = id => tx('readwrite', s => s.delete(id));

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

function cardItem(c) {
  const li = document.createElement('li');
  // 写真は残さないので、会社名（なければ名前）の頭文字を丸に出す
  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = companyKey(c.company).charAt(0).toUpperCase() || (c.name || '？').charAt(0);
  const meta = document.createElement('div');
  meta.className = 'meta';
  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = c.name || '（名前なし）';
  const sub = document.createElement('div');
  sub.className = 'sub';
  sub.textContent = [c.company, c.title].filter(Boolean).join('　');
  meta.append(name, sub);
  li.append(avatar, meta);
  li.onclick = () => openDetail(c.id);
  return li;
}

function renderList() {
  const q = $('search').value.trim().toLowerCase();
  const hit = cards.filter(c => !q || FIELDS.some(f => (c[f] || '').toLowerCase().includes(q)));
  const list = $('list');
  list.textContent = '';
  $('sort-new').classList.toggle('on', sortMode === 'new');
  $('sort-company').classList.toggle('on', sortMode === 'company');

  if (sortMode === 'company') {
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
  cards = await getAll();
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
  $('btn-scan').textContent = id ? '📷 カメラで読み取り直す' : '📷 カメラで名刺を読み取る';
  show('edit');
  if (!id) openCamera(); // 新しく登録するときは、すぐカメラを開く
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
$('btn-scan').onclick = () => openCamera();

// ---- アプリの中のカメラ（映像を1コマだけ読み取りに使い、ファイルは作らない） ----
let camStream = null;
async function openCamera() {
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

function startAuto() {
  stopAuto();
  prevGray = null;
  stableCount = 0;
  autoBusy = false;
  setCamHint('名刺を<b>横向き</b>にして、わくに入れてください');
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
    if (sharp <= AUTO.sharp) setCamHint('名刺を<b>横向き</b>にして、わくに入れてください');
    else setCamHint('そのまま動かさないでください…');
    return;
  }
  autoBusy = true;
  setCamHint('🔍 読み取り中…', true);
  try {
    const blob = await grabGuideArea();
    const text = await recognizeCard(blob, false);
    if (!camStream) return; // 読み取り中に「やめる」が押されたとき
    if (fieldScore(parseCard(text)) >= AUTO.enoughFields) {
      closeCamera();
      editPhoto = blob;
      setPreview(blob);
      $('ocr-text').value = text.trim();
      applyParsed(parseCard(text), false);
      // カメラを閉じたあと、細かい文字も拾う読み方でもう1回読み、空いている欄を埋める
      setStatus('🔍 細かい文字も読み取り中…');
      const worker = await getOcrWorker();
      await worker.setParameters({ tessedit_pageseg_mode: '11' });
      const { data } = await worker.recognize(blob);
      if (editPhoto !== blob) return;
      const merged = text.trim() + '\n' + data.text.trim();
      $('ocr-text').value = merged;
      applyParsed(parseCard(merged), false);
      setStatus('✅ 読み取りました。まちがっている欄があれば直して「保存」してください。');
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
  try {
    const text = await recognizeCard(blob, true);
    if (editPhoto !== blob) return; // 読み取り中に写真が変わったとき
    $('ocr-text').value = text.trim();
    applyParsed(parseCard(text), false);
    setStatus('✅ 読み取りました。まちがっている欄があれば直して「保存」してください。');
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
  show('detail');
}
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
  const name = (c.name || '').trim();
  const parts = name.split(/\s+/);
  const family = parts.length > 1 ? parts[0] : name;
  const given = parts.length > 1 ? parts.slice(1).join(' ') : '';
  const lines = ['BEGIN:VCARD', 'VERSION:3.0',
    `N:${vEscape(family)};${vEscape(given)};;;`,
    `FN:${vEscape(name || c.company)}`];
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

$('btn-detail-back').onclick = () => { show('list'); renderList(); };
$('btn-edit').onclick = () => openEdit(currentId);
$('btn-delete').onclick = async () => {
  const c = cards.find(x => x.id === currentId);
  if (!confirm(`「${c.name || '名前なし'}」の名刺を消します。元に戻せません。よろしいですか？`)) return;
  await deleteCard(currentId);
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
    await reload();
    $('menu').close();
    alert('読み込みました。');
  } catch {
    alert('このファイルは読み込めませんでした。名刺ノートで書き出したバックアップを選んでください。');
  }
};

// ---- はじめに ----
(async () => {
  db = await openDB();
  await reload();
  // データを消えにくくする（ホーム画面に追加したアプリでは特に効く）
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
