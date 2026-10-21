// 同期：PCとiPhoneで同じ名刺を見られるようにする。
//
// しくみ（名刺の中身はだれにも読めない）
// 1. 合言葉から、この端末の中で「鍵」と「置き場所の番号」と「通行証」を作る（PBKDF2）。合言葉そのものは保存も送信もしない。
// 2. 名刺の一覧を鍵で暗号化（AES-GCM）してから、Cloudflareの置き場所に送る。
// 3. ほかの端末は同じ合言葉で同じ鍵を作り、取ってきたデータを自分の中で開く。
// 4. 両方にある名刺は「あとで直したほう」を残す。消した名刺は「消した」という印で伝わる。
// 5. 鍵は「取り出せない形」（non-extractable）でこの端末に保存する。

const Sync = (() => {
  const API = 'api/sync';
  const SALT = 'meishi-note-sync-v1';
  const ITERATIONS = 600000; // 合言葉を総当たりで当てられにくくするため、わざと時間をかける
  const enc = new TextEncoder(), dec = new TextDecoder();

  let conf = null;        // { syncId, token, key(CryptoKey), synced }
  let running = null;     // 同期中の Promise
  let again = false;      // 同期中にまた変更があったとき
  let lastOk = 0;
  let timer = null;
  let mode = 'start';     // 合言葉の画面：'start'（はじめる）／'change'（変える）

  const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const sha256 = async s => hex(await crypto.subtle.digest('SHA-256', typeof s === 'string' ? enc.encode(s) : s));
  const importAes = (raw, extractable) => crypto.subtle.importKey('raw', raw, 'AES-GCM', extractable, ['encrypt', 'decrypt']);

  // 合言葉 → 鍵・置き場所の番号・通行証
  async function derive(passphrase) {
    const base = await crypto.subtle.importKey('raw', enc.encode(passphrase.normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
    const bits = new Uint8Array(await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(SALT), iterations: ITERATIONS }, base, 512));
    const raw = bits.slice(0, 32);
    const secret = hex(bits.slice(32));
    return {
      syncId: await sha256('id:' + secret),
      token: await sha256('auth:' + secret),
      key: await importAes(raw, false),
      raw, // 保存するときだけ使う（下の saveConf を見る）
    };
  }

  // 同期の設定を保存する。鍵は取り出せない形のまま保存する。
  // （古いブラウザで鍵をそのまま保存できないときだけ、前と同じ形で保存する）
  async function saveConf(c) {
    const { raw, keyRaw, ...rest } = c;
    try {
      await setMeta('sync', rest);
      delete c.raw; // 保存できたら、鍵のもとはメモリからも消す
      delete c.keyRaw;
    } catch (err) {
      const k = keyRaw || (raw && b64(raw));
      if (!k) throw err;
      console.warn('鍵を取り出せない形で保存できませんでした。前の形で保存します', err);
      c.keyRaw = k;
      delete c.raw;
      await setMeta('sync', { ...rest, key: undefined, keyRaw: k });
    }
  }

  async function loadConf() {
    const c = (await getMeta('sync')) || null;
    if (!c) return null;
    if (!c.key && c.keyRaw) {
      // 前の版の形（鍵をそのまま保存していた）→ 取り出せない形に置きかえる
      const raw = unb64(c.keyRaw);
      const upgraded = { syncId: c.syncId, token: c.token, key: await importAes(raw, false), synced: c.synced ?? true, raw };
      await saveConf(upgraded);
      return upgraded;
    }
    return c;
  }

  async function encrypt(obj, key = conf.key) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)));
    const out = new Uint8Array(12 + ct.byteLength);
    out.set(iv);
    out.set(new Uint8Array(ct), 12);
    return b64(out);
  }
  async function decrypt(text, key = conf.key) {
    const all = unb64(text);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.slice(0, 12) }, key, all.slice(12));
    return JSON.parse(dec.decode(pt));
  }

  async function api(method, body, c = conf) {
    const res = await fetch(API, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Sync-Id': c.syncId, Authorization: 'Bearer ' + c.token },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  }

  // ---- 合言葉の強さ ----
  // 新しく同期をはじめるとき・合言葉を変えるときだけ使う（今の合言葉で入るときは使わない）
  function weakReason(p) {
    if (p.length < 16) return '合言葉は16文字以上にしてください。';
    if (new Set(p).size < 8) return '同じ文字が多すぎます。いろいろな文字をまぜてください。';
    return '';
  }
  // 強い合言葉を作る（まちがえやすい文字 0/o・1/l/i などは使わない）
  function generate() {
    const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
    const pick = new Uint32Array(20);
    crypto.getRandomValues(pick);
    const s = [...pick].map(n => chars[n % chars.length]).join('');
    return s.match(/.{4}/g).join('-'); // 例：k7mp-3xq9-…（約99ビット）
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
  const sortId = list => [...list].sort((a, b) => (a.id < b.id ? -1 : 1));

  // ---- 同期の本体 ----
  async function syncOnce() {
    setStatus('sync');
    for (let attempt = 0; attempt < 3; attempt++) {
      const got = await api('GET');
      if (got.status === 403) throw new Error('auth');
      if (got.status !== 200) throw new Error('server ' + got.status);
      // 前は同期できていたのに置き場所がない → ほかの端末で合言葉を変えたか、置き場所が消された
      if (!got.json.data && conf.synced) throw new Error('gone');
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
      if (!got.json.data || !same(sortId(merged), sortId(remote))) {
        const put = await api('PUT', { version: remoteVersion, data: await encrypt(sortId(merged)) });
        if (put.status === 409) continue; // ほかの端末が先に置いた → もう一度合わせる
        if (put.status === 403) throw new Error(put.json.error === 'full' ? 'full' : 'auth');
        if (put.status !== 200) throw new Error('server ' + put.status);
      }
      if (!conf.synced) { conf.synced = true; await saveConf(conf); }
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
        const m = err.message;
        setStatus(['auth', 'gone', 'full'].includes(m) ? m : navigator.onLine === false ? 'offline' : 'error');
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
      auth: '☁ 合言葉が合いません。メニューから同期を止めて、設定し直してください',
      gone: '☁ ほかの端末で合言葉が変わったようです。メニューから同期を止めて、新しい合言葉で設定し直してください',
      full: '☁ 新しい置き場所は作れない設定です。ほかの端末と同じ合言葉で設定し直してください',
    }[state];
    el.textContent = text;
    el.hidden = !text;
    el.className = 'sync-status ' + state;
    const info = $('sync-info');
    if (info) info.textContent = conf ? (text || '☁ 同期オン') : '同期はオフです（名刺はこの端末の中だけ）。';
    $('btn-sync-setup').hidden = !!conf;
    $('btn-sync-now').hidden = !conf;
    $('btn-sync-change').hidden = !conf;
    $('btn-sync-off').hidden = !conf;
    // 同期がオフのときは、一覧のいちばん上に「同期をはじめる」を出す（古いアドレスでは出さない）
    $('sync-invite').hidden = !!conf || !$('moved').hidden;
  }

  // ---- 合言葉の画面 ----
  function openDialog(m) {
    mode = m;
    if ($('menu').open) $('menu').close();
    $('sync-title').textContent = m === 'change' ? '合言葉を変える' : '同期をはじめる';
    $('sync-lead').textContent = m === 'change'
      ? '新しい合言葉に変えます。変えたあと、ほかの端末でも新しい合言葉を入れ直してください（前の合言葉では入れなくなります）。'
      : 'PCとiPhoneで同じ合言葉を入れると、名刺がそろいます。名刺はこの端末の中で合言葉の鍵をかけてから送るので、Cloudflareにもだれにも中身は見えません。';
    $('btn-sync-start').textContent = m === 'change' ? '合言葉を変える' : '同期をはじめる';
    $('sync-pass').value = $('sync-pass2').value = '';
    showPass(false);
    $('sync-msg').textContent = '';
    $('sync-dialog').showModal();
  }
  function showPass(on) {
    $('sync-show').checked = on;
    $('sync-pass').type = $('sync-pass2').type = on ? 'text' : 'password';
  }
  function finishDialog(message) {
    $('sync-pass').value = $('sync-pass2').value = '';
    $('sync-msg').textContent = '';
    $('sync-dialog').close();
    toast(message);
  }

  async function submit() {
    const p1 = $('sync-pass').value;
    const p2 = $('sync-pass2').value;
    const msg = $('sync-msg');
    if (!p1) { msg.textContent = '合言葉を入れてください。'; return; }
    if (p1 !== p2) { msg.textContent = '2回の合言葉がちがいます。'; return; }
    if (mode === 'change') {
      const weak = weakReason(p1);
      if (weak) { msg.textContent = weak + '「強い合言葉を作る」を押すと作れます。'; return; }
    }
    msg.textContent = '鍵を作っています…（数秒かかります）';
    $('btn-sync-start').disabled = true;
    try {
      if (mode === 'change') await changePassphrase(p1);
      else await start(p1);
    } catch (err) {
      console.error(err);
      msg.textContent = '同期の置き場所につながりません。少したってからためしてください。';
    } finally {
      $('btn-sync-start').disabled = false;
    }
  }

  // 同期をはじめる（今ある置き場所に入る／はじめての端末なら新しく作る）
  async function start(passphrase) {
    const msg = $('sync-msg');
    const c = await derive(passphrase);
    const got = await api('GET', null, c);
    if (got.status !== 200) {
      msg.textContent = got.status === 404 ? 'このアドレスでは同期できません。新しいアドレスで開いてください。' : '同期できませんでした。もう一度ためしてください。';
      return;
    }
    if (got.json.data) {
      try { await decrypt(got.json.data, c.key); } catch { msg.textContent = '合言葉がちがうようです。ほかの端末で使った合言葉を入れてください。'; return; }
      c.synced = true;
    } else {
      // この合言葉の置き場所はまだない
      if (!got.json.canCreate) {
        msg.textContent = 'この合言葉の置き場所はありません。ほかの端末で使っている合言葉を、1文字もまちがえずに入れてください。';
        return;
      }
      const weak = weakReason(passphrase);
      if (weak) { msg.textContent = '新しく同期をはじめるときは、強い合言葉にしてください。' + weak + '「強い合言葉を作る」を押すと作れます。'; return; }
      if (!confirm('この合言葉の置き場所は、まだ空です。\n\nはじめて同期する端末なら「OK」。\nほかの端末ですでに同期しているなら「キャンセル」を押して、合言葉を確かめてください（1文字でもちがうと別の置き場所になります）。')) {
        msg.textContent = '合言葉を確かめて、もう一度入れてください。';
        return;
      }
      c.synced = false;
    }
    conf = c;
    await saveConf(conf);
    finishDialog('同期をはじめました');
    startTimer();
    await run();
  }

  // 合言葉を変える（置き場所の番号・通行証・鍵を、新しい合言葉のものに一度に置きかえる）
  async function changePassphrase(passphrase) {
    const msg = $('sync-msg');
    await run(); // まず今の状態をそろえる
    const next = await derive(passphrase);
    for (let attempt = 0; attempt < 3; attempt++) {
      const got = await api('GET');
      if (got.status !== 200 || !got.json.data) { msg.textContent = '今の置き場所が見つかりません。同期できているか確かめてから、もう一度ためしてください。'; return; }
      const list = merge(await getAll(), await decrypt(got.json.data));
      const res = await api('POST', { newId: next.syncId, newToken: next.token, version: got.json.version, data: await encrypt(sortId(list), next.key) });
      if (res.status === 409 && res.json.error === 'taken') { msg.textContent = 'その合言葉は使えません。ちがう合言葉にしてください。'; return; }
      if (res.status === 409) continue; // ほかの端末がちょうど同期した → もう一度
      if (res.status !== 200) { msg.textContent = '合言葉を変えられませんでした。少したってからためしてください。'; return; }
      next.synced = true;
      conf = next;
      await saveConf(conf);
      finishDialog('合言葉を変えました。ほかの端末でも入れ直してください');
      await run();
      return;
    }
    msg.textContent = '合言葉を変えられませんでした。少したってからためしてください。';
  }

  async function disconnect() {
    conf = null;
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
    conf = await loadConf();
    if (conf) {
      startTimer();
      run();
    }
    setStatus(conf ? 'ok' : 'off');
    // 画面に戻ってきたとき・ネットにつながったときに同期する
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') run(); });
    window.addEventListener('online', () => run());

    $('btn-sync-setup').onclick = () => openDialog('start');
    $('btn-sync-invite').onclick = () => openDialog('start');
    $('btn-sync-change').onclick = () => openDialog('change');
    $('btn-sync-start').onclick = submit;
    $('btn-sync-cancel').onclick = () => $('sync-dialog').close();
    $('btn-sync-gen').onclick = () => {
      const p = generate();
      $('sync-pass').value = $('sync-pass2').value = p;
      showPass(true);
      $('sync-msg').textContent = 'この合言葉を紙などにメモしてから進めてください（ほかの端末でも同じものを入れます）。';
    };
    $('sync-show').onchange = e => showPass(e.target.checked);
    $('btn-sync-now').onclick = () => run();
    $('btn-sync-off').onclick = async () => {
      if (!confirm('この端末の同期を止めます。名刺はこの端末に残ります。よろしいですか？')) return;
      await disconnect();
      toast('同期を止めました');
    };
  }

  return { init, changed: () => run(), disconnect, _merge: merge, _weak: weakReason, _gen: generate };
})();
