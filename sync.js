// 同期：PCとiPhoneで同じ名刺を見られるようにする。
//
// しくみ（名刺の中身はだれにも読めない）
// 1. 合言葉から、この端末の中で「鍵」と「置き場所の番号」と「通行証」を作る（PBKDF2）。合言葉そのものは保存も送信もしない。
// 2. 名刺の一覧を鍵で暗号化（AES-GCM）してから、Cloudflareの置き場所に送る。
// 3. ほかの端末は同じ合言葉で同じ鍵を作り、取ってきたデータを自分の中で開く。
// 4. 両方にある名刺は「あとで直したほう」を残す。消した名刺は「消した」という印で伝わる。

const Sync = (() => {
  const API = 'api/sync';
  const SALT = 'meishi-note-sync-v1';
  const ITERATIONS = 600000; // 合言葉を総当たりで当てられにくくするため、わざと時間をかける
  const enc = new TextEncoder(), dec = new TextDecoder();

  let conf = null;        // { syncId, token, keyRaw }
  let key = null;         // 暗号化の鍵（CryptoKey）
  let running = null;     // 同期中の Promise
  let again = false;      // 同期中にまた変更があったとき
  let lastOk = 0;
  let timer = null;

  const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const sha256 = async s => hex(await crypto.subtle.digest('SHA-256', typeof s === 'string' ? enc.encode(s) : s));

  // 合言葉 → 鍵・置き場所の番号・通行証
  async function derive(passphrase) {
    const base = await crypto.subtle.importKey('raw', enc.encode(passphrase.normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
    const bits = new Uint8Array(await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(SALT), iterations: ITERATIONS }, base, 512));
    const keyRaw = bits.slice(0, 32);
    const secret = hex(bits.slice(32));
    return { keyRaw: b64(keyRaw), syncId: await sha256('id:' + secret), token: await sha256('auth:' + secret) };
  }

  async function loadKey() {
    key = await crypto.subtle.importKey('raw', unb64(conf.keyRaw), 'AES-GCM', false, ['encrypt', 'decrypt']);
  }

  async function encrypt(obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)));
    const out = new Uint8Array(12 + ct.byteLength);
    out.set(iv);
    out.set(new Uint8Array(ct), 12);
    return b64(out);
  }
  async function decrypt(text) {
    const all = unb64(text);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.slice(0, 12) }, key, all.slice(12));
    return JSON.parse(dec.decode(pt));
  }

  async function api(method, body) {
    const res = await fetch(API, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Sync-Id': conf.syncId, Authorization: 'Bearer ' + conf.token },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  }

  // 2つの一覧を合わせる：同じ名刺は updated が新しいほうを残す
  function merge(localList, remoteList) {
    const map = new Map();
    for (const c of remoteList) map.set(c.id, c);
    for (const c of localList) {
      const r = map.get(c.id);
      if (!r || (c.updated || 0) >= (r.updated || 0)) map.set(c.id, c);
    }
    return [...map.values()];
  }
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // ---- 同期の本体 ----
  async function syncOnce() {
    setStatus('sync');
    for (let attempt = 0; attempt < 3; attempt++) {
      const got = await api('GET');
      if (got.status === 403) throw new Error('auth');
      if (got.status !== 200) throw new Error('server ' + got.status);
      const remoteVersion = got.json.version || 0;
      const remote = got.json.data ? await decrypt(got.json.data) : [];

      const local = await getAll();
      const merged = merge(local, remote);
      const byId = new Map(local.map(c => [c.id, c]));
      // この端末に、ほかの端末で増えた・直した分を入れる
      let changedHere = false;
      for (const c of merged) {
        if (!same(byId.get(c.id), c)) { await putCard(c); changedHere = true; }
      }
      if (changedHere) await refreshScreen();

      // Cloudflareの分が古ければ、合わせた一覧を鍵をかけて置く
      const sortId = list => [...list].sort((a, b) => (a.id < b.id ? -1 : 1));
      if (!got.json.data || !same(sortId(merged), sortId(remote))) {
        const put = await api('PUT', { version: remoteVersion, data: await encrypt(sortId(merged)) });
        if (put.status === 409) continue; // ほかの端末が先に置いた → もう一度合わせる
        if (put.status !== 200) throw new Error('server ' + put.status);
      }
      lastOk = Date.now();
      setStatus('ok');
      return;
    }
    throw new Error('conflict');
  }

  async function run() {
    if (!conf) return;
    if (running) { again = true; return running; }
    running = (async () => {
      try {
        do { again = false; await syncOnce(); } while (again);
      } catch (err) {
        console.error(err);
        setStatus(err.message === 'auth' ? 'auth' : navigator.onLine === false ? 'offline' : 'error');
      } finally {
        running = null;
      }
    })();
    return running;
  }

  // 一覧や見ている画面を、新しいデータで描き直す
  async function refreshScreen() {
    await reload();
    if (!$('view-detail').hidden && currentId) {
      if (cards.some(c => c.id === currentId)) openDetail(currentId);
      else show('list');
    }
  }

  // ---- 状態の表示 ----
  function setStatus(state) {
    const el = $('sync-status');
    if (!el) return;
    const time = lastOk ? new Date(lastOk).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }) : '';
    const text = {
      off: '',
      sync: '☁ 同期中…',
      ok: `☁ 同期ずみ ${time}`,
      offline: '☁ オフライン（つながったら同期します）',
      error: '☁ 同期できませんでした（あとでもう一度ためします）',
      auth: '☁ 合言葉が合いません。メニューから同期を設定し直してください',
    }[state];
    el.textContent = text;
    el.hidden = !text;
    el.className = 'sync-status ' + state;
    const info = $('sync-info');
    if (info) info.textContent = conf ? (text || '☁ 同期オン') : '同期はオフです（名刺はこの端末の中だけ）。';
    $('btn-sync-setup').hidden = !!conf;
    $('btn-sync-now').hidden = !conf;
    $('btn-sync-off').hidden = !conf;
  }

  // ---- 合言葉の設定 ----
  async function setup() {
    const p1 = $('sync-pass').value;
    const p2 = $('sync-pass2').value;
    const msg = $('sync-msg');
    if (p1.length < 12) { msg.textContent = '合言葉は12文字以上にしてください（例：好きな言葉を4つつなげる）。'; return; }
    if (p1 !== p2) { msg.textContent = '2回の合言葉がちがいます。'; return; }
    msg.textContent = '鍵を作っています…（数秒かかります）';
    $('btn-sync-start').disabled = true;
    try {
      conf = await derive(p1);
      await loadKey();
      // 置き場所に入れるか、先に確かめる（ほかの端末で別の合言葉を使っていないか）
      const got = await api('GET');
      if (got.status === 403) { conf = null; key = null; msg.textContent = '同期できませんでした。もう一度ためしてください。'; return; }
      if (got.status !== 200) {
        conf = null; key = null;
        msg.textContent = got.status === 404 ? 'このアドレスでは同期できません。新しいアドレスで開いてください。' : '同期の置き場所につながりません。少したってからためしてください。';
        return;
      }
      if (got.json.data) {
        try { await decrypt(got.json.data); } catch { conf = null; key = null; msg.textContent = '合言葉がちがうようです。ほかの端末で使った合言葉を入れてください。'; return; }
      } else if (!confirm('この合言葉の置き場所は、まだ空です。\n\nはじめて同期する端末なら「OK」。\nほかの端末ですでに同期しているなら「キャンセル」を押して、合言葉を確かめてください（1文字でもちがうと別の置き場所になります）。')) {
        conf = null; key = null;
        msg.textContent = '合言葉を確かめて、もう一度入れてください。';
        return;
      }
      await setMeta('sync', conf);
      $('sync-pass').value = $('sync-pass2').value = '';
      msg.textContent = '';
      $('sync-dialog').close();
      startTimer();
      await run();
      toast('同期をはじめました');
    } catch (err) {
      console.error(err);
      conf = null; key = null;
      msg.textContent = '同期の置き場所につながりません。少したってからためしてください。';
    } finally {
      $('btn-sync-start').disabled = false;
    }
  }

  async function disconnect() {
    conf = null;
    key = null;
    clearInterval(timer);
    await setMeta('sync', undefined);
    setStatus('off');
  }

  function startTimer() {
    clearInterval(timer);
    timer = setInterval(() => { if (document.visibilityState === 'visible') run(); }, 60000);
  }

  // ---- はじめに ----
  async function init() {
    conf = (await getMeta('sync')) || null;
    if (conf) {
      await loadKey();
      startTimer();
      run();
    }
    setStatus(conf ? 'ok' : 'off');
    // 画面に戻ってきたとき・ネットにつながったときに同期する
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') run(); });
    window.addEventListener('online', () => run());

    $('btn-sync-setup').onclick = () => { $('menu').close(); $('sync-msg').textContent = ''; $('sync-dialog').showModal(); };
    $('btn-sync-start').onclick = setup;
    $('btn-sync-cancel').onclick = () => $('sync-dialog').close();
    $('btn-sync-now').onclick = () => run();
    $('btn-sync-off').onclick = async () => {
      if (!confirm('この端末の同期を止めます。名刺はこの端末に残ります。よろしいですか？')) return;
      await disconnect();
      toast('同期を止めました');
    };
  }

  return { init, changed: () => run(), disconnect, _merge: merge, _derive: derive };
})();
