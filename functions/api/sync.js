// 同期の置き場所（Cloudflare Pages Functions ＋ D1）。
// ここに届くのは、端末の中で鍵をかけたあとのデータだけ。サーバーには鍵がないので中身は読めない。
//
// 決まり
// - 置き場所の番号（X-Sync-Id）と通行証（Authorization: Bearer ...）は、合言葉から端末の中で作ったもの。
// - サーバーは通行証そのものではなく、その SHA-256 だけを保存する。
// - GET：{ version, data }（まだ何もなければ version 0・data null）
// - PUT：{ version, data } を送る。version が今のものと同じときだけ置きかえる（ちがえば 409）。

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

export async function onRequest({ request, env }) {
  if (!env.DB) return json(500, { error: 'no-db' });
  const id = request.headers.get('X-Sync-Id') || '';
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer /, '');
  if (!HEX64.test(id) || !HEX64.test(token)) return json(400, { error: 'bad-request' });

  await ensureTable(env.DB);
  const authHash = await sha256(token);
  const row = await env.DB.prepare('SELECT auth_hash, version, data FROM vault WHERE id = ?').bind(id).first();
  if (row && row.auth_hash !== authHash) return json(403, { error: 'forbidden' });

  if (request.method === 'GET') {
    return json(200, row ? { version: row.version, data: row.data } : { version: 0, data: null });
  }

  if (request.method === 'PUT') {
    const body = await request.json().catch(() => null);
    if (!body || typeof body.data !== 'string' || !Number.isInteger(body.version)) return json(400, { error: 'bad-request' });
    if (body.data.length > MAX_DATA) return json(413, { error: 'too-large' });
    const now = Date.now();
    if (!row) {
      if (body.version !== 0) return json(409, { error: 'conflict' });
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

  return json(405, { error: 'method-not-allowed' });
}
