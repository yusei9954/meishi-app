// 電波がないところでもアプリの画面を開けるように、プログラムだけを覚えておく
// （名刺のデータはここでは扱わない）
const CACHE = 'meishi-note-v11';
const FILES = ['./', 'index.html', 'style.css', 'parse.js', 'app.js', 'sync.js', 'manifest.webmanifest', 'icon-180.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// 新しい版があればそれを使い、つながらないときは覚えている版を使う
// （アプリの部品は毎回「新しい版があるか」を確かめる。読み取りソフトは大きくて変わらないので、ふつうに取る）
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // 同期（/api/）は覚えておかず、いつもCloudflareに聞く
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/api/')) return;
  const isVendor = url.pathname.includes('/vendor/');
  e.respondWith(
    fetch(e.request, isVendor ? {} : { cache: 'no-cache' })
      .then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return res; })
      .catch(() => caches.match(e.request))
  );
});
