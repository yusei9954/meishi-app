// 同期の置き場所（Cloudflare Pages Functions ＋ D1）。
// ここに届くのは、端末の中で鍵をかけたあとのデータだけ。サーバーには鍵がないので中身は読めない。
//
// 決まり
// - 置き場所の番号（X-Sync-Id）と通行証（Authorization: Bearer ...）は、合言葉から端末の中で作ったもの。
// - サーバーは通行証そのものではなく、その SHA-256 だけを保存する。
// - GET：{ version, data }。まだ何もなければ { version: 0, data: null, canCreate }。
// - PUT：{ version, data }。version が今のものと同じときだけ置きかえる（ちがえば 409）。
//        置き場所がまだないときは新しく作る。ただし置き場所の数が MAX_VAULTS（ふつうは1）に
//        達していたら作らない（だれかが勝手に置き場所を増やして、無料枠を使い切らないように）。
// - POST（合言葉を変える）：{ newId, newToken, version, data }。今の通行証で入り、
//        同じ置き場所の番号・通行証・データを一度に置きかえる（置き場所の数は増えない）。
// - DELETE：今の通行証で入り、置き場所を消す。

const MAX_DATA = 2 * 1024 * 1024; // 1つの置き場所は2MBまで（名刺なら数千枚分）
const HEX64 = /^[0-9a-f]{64}$/;

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function ensureTable(db) {
  await db
    .prepare('CREATE TABLE IF NOT EXISTS vault (id TEXT PRIMARY KEY, auth_hash TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL)')
    .run();
}

async function canCreate(env) {
  const max = Number.parseInt(env.MAX_VAULTS ?? '1', 10);
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM vault').first();
  return (row?.n ?? 0) < max;
}

async function readBody(request) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body.data !== 'string' || !Number.isInteger(body.version)) return null;
  return body;
}

export async function onRequest({ request, env }) {
  if (!env.DB) return json(500, { error: 'no-db' });
  const id = request.headers.get('X-Sync-Id') || '';
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer /, '');
  if (!HEX64.test(id) || !HEX64.test(token)) return json(400, { error: 'bad-request' });

  await ensureTable(env.DB);
  const authHash = await sha256(token);
  const row = await env.DB.prepare('SELECT auth_hash, version, data FROM vault WHERE id = ?').bind(id).first();
  if (row && row.auth_hash !== authHash) return json(403, { error: 'forbidden' });
  const now = Date.now();

  if (request.method === 'GET') {
    return json(200, row ? { version: row.version, data: row.data } : { version: 0, data: null, canCreate: await canCreate(env) });
  }

  if (request.method === 'PUT') {
    const body = await readBody(request);
    if (!body) return json(400, { error: 'bad-request' });
    if (body.data.length > MAX_DATA) return json(413, { error: 'too-large' });
    if (!row) {
      if (body.version !== 0) return json(409, { error: 'conflict' });
      if (!(await canCreate(env))) return json(403, { error: 'full' });
      const r = await env.DB.prepare('INSERT OR IGNORE INTO vault (id, auth_hash, version, data, updated_at) VALUES (?, ?, 1, ?, ?)')
        .bind(id, authHash, body.data, now).run();
      if (!r.meta || r.meta.changes !== 1) return json(409, { error: 'conflict' });
      return json(200, { version: 1 });
    }
    // version が同じときだけ置きかえる（ほかの端末が先に置いていたら 409 で、合わせ直してもらう）
    const r = await env.DB.prepare('UPDATE vault SET data = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND auth_hash = ?')
      .bind(body.data, now, id, body.version, authHash).run();
    if (!r.meta || r.meta.changes !== 1) return json(409, { error: 'conflict' });
    return json(200, { version: body.version + 1 });
  }

  if (request.method === 'POST') {
    // 合言葉を変える
    if (!row) return json(404, { error: 'not-found' });
    const body = await readBody(request);
    if (!body || !HEX64.test(body.newId || '') || !HEX64.test(body.newToken || '')) return json(400, { error: 'bad-request' });
    if (body.data.length > MAX_DATA) return json(413, { error: 'too-large' });
    const taken = await env.DB.prepare('SELECT 1 FROM vault WHERE id = ?').bind(body.newId).first();
    if (taken) return json(409, { error: 'taken' });
    const r = await env.DB.prepare('UPDATE vault SET id = ?, auth_hash = ?, data = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND auth_hash = ?')
      .bind(body.newId, await sha256(body.newToken), body.data, now, id, body.version, authHash).run();
    if (!r.meta || r.meta.changes !== 1) return json(409, { error: 'conflict' });
    return json(200, { version: body.version + 1 });
  }

  if (request.method === 'DELETE') {
    if (!row) return json(200, { deleted: false });
    await env.DB.prepare('DELETE FROM vault WHERE id = ? AND auth_hash = ?').bind(id, authHash).run();
    return json(200, { deleted: true });
  }

  return json(405, { error: 'method-not-allowed' });
}
