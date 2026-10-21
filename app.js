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
const urls = new Map(); // 写真の表示用URL

// ---- 保存場所（IndexedDB） ----
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
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
function photoURL(card) {
  if (!card.photo) return '';
  if (!urls.has(card.id)) urls.set(card.id, URL.createObjectURL(card.photo));
  return urls.get(card.id);
}
function forgetURL(id) {
  if (urls.has(id)) { URL.revokeObjectURL(urls.get(id)); urls.delete(id); }
}

// ---- 画面の切りかえ ----
function show(view) {
  for (const v of ['list', 'edit', 'detail']) $('view-' + v).hidden = v !== view;
  window.scrollTo(0, 0);
}

// ---- 一覧 ----
function renderList() {
  const q = $('search').value.trim().toLowerCase();
  const hit = cards.filter(c => !q || FIELDS.some(f => (c[f] || '').toLowerCase().includes(q)));
  const list = $('list');
  list.textContent = '';
  for (const c of hit) {
    const li = document.createElement('li');
    const img = document.createElement('img');
    img.className = 'thumb';
    img.alt = '';
    if (c.photo) img.src = photoURL(c);
    const meta = document.createElement('div');
    meta.className = 'meta';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = c.name || '（名前なし）';
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = [c.company, c.title].filter(Boolean).join('　');
    meta.append(name, sub);
    li.append(img, meta);
    li.onclick = () => openDetail(c.id);
    list.append(li);
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
  editPhoto = c.photo || null;
  setPreview(editPhoto);
  $('ocr-text').value = c.ocrText || '';
  $('ocr').open = !id;
  show('edit');
}
function setPreview(blob) {
  const img = $('photo-preview');
  if (img.dataset.url) URL.revokeObjectURL(img.dataset.url);
  if (blob) {
    img.dataset.url = URL.createObjectURL(blob);
    img.src = img.dataset.url;
  }
  img.hidden = !blob;
  $('photo-hint').hidden = !!blob;
  $('btn-retake').hidden = !blob;
}
$('btn-retake').onclick = () => $('photo-input').click();

$('photo-input').onchange = async e => {
  const file = e.target.files[0];
  if (!file) return;
  editPhoto = await shrinkPhoto(file);
  setPreview(editPhoto);
  e.target.value = '';
};

// 写真の文字を長押しで選べるよう、写真をタップしても撮り直しにならないようにする
$('photo-box').onclick = e => {
  if (editPhoto && e.target.id === 'photo-preview') {
    e.preventDefault();
  }
};

$('btn-parse').onclick = () => {
  const text = $('ocr-text').value;
  if (!text.trim()) { alert('先に、読み取った文字を枠に貼ってください。'); return; }
  const r = parseCard(text);
  for (const [k, v] of Object.entries(r)) {
    if (v && !$('f-' + k).value) $('f-' + k).value = v;
  }
  $('f-name').scrollIntoView({ behavior: 'smooth', block: 'center' });
};

$('btn-save').onclick = async () => {
  const old = cards.find(x => x.id === currentId) || {};
  const card = { ...old, id: currentId || crypto.randomUUID(), created: old.created || Date.now(), updated: Date.now() };
  for (const f of FIELDS) card[f] = $('f-' + f).value.trim();
  card.ocrText = $('ocr-text').value;
  card.photo = editPhoto;
  if (!card.name && !card.company && !card.photo) { alert('名前・会社・写真のどれかを入れてください。'); return; }
  forgetURL(card.id);
  await putCard(card);
  await reload();
  openDetail(card.id);
};
$('btn-edit-back').onclick = () => (currentId ? openDetail(currentId) : show('list'));

// ---- くわしく見る ----
function openDetail(id) {
  currentId = id;
  const c = cards.find(x => x.id === id);
  if (!c) return show('list');
  const img = $('d-photo');
  img.hidden = !c.photo;
  if (c.photo) img.src = photoURL(c);
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
    if (f === 'address') href = 'https://maps.apple.com/?q=' + encodeURIComponent(c[f]);
    if (href) {
      const a = document.createElement('a');
      a.href = href;
      a.textContent = c[f];
      if (f === 'url' || f === 'address') { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
      dd.append(a);
    } else {
      dd.textContent = c[f];
    }
    row.append(dt, dd);
    dl.append(row);
  }
  show('detail');
}
$('btn-detail-back').onclick = () => { show('list'); renderList(); };
$('btn-edit').onclick = () => openEdit(currentId);
$('btn-delete').onclick = async () => {
  const c = cards.find(x => x.id === currentId);
  if (!confirm(`「${c.name || '名前なし'}」の名刺を消します。元に戻せません。よろしいですか？`)) return;
  forgetURL(currentId);
  await deleteCard(currentId);
  await reload();
  show('list');
};

// ---- 一覧の操作 ----
$('search').oninput = renderList;
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

function blobToDataURL(blob) {
  return new Promise(resolve => { const r = new FileReader(); r.onload = () => resolve(r.result); r.readAsDataURL(blob); });
}
async function dataURLToBlob(url) { return (await fetch(url)).blob(); }

$('btn-export').onclick = async () => {
  const data = [];
  for (const c of cards) data.push({ ...c, photo: c.photo ? await blobToDataURL(c.photo) : null });
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
      if (c.photo) c.photo = await dataURLToBlob(c.photo);
      forgetURL(c.id);
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
