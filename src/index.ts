// VTech Auction Tracker — daily GeM bid/reverse-auction watch for VTech Technologies.
// Cron pulls open GeM bids matching admin-set keywords (via the Apify GeM scraper), stores them in D1,
// and emails the new ones to the recipient list. Web UI: browse/filter bids, mark interest, manage settings.
import { AUTH_SCHEMA, currentUser, login, logout, setup, createUser, updateUser, listUsers, type User } from './auth';
import { sendMail, esc } from './mail';

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  MAILER: SendEmail;
  ADMIN_EMAIL: string;
  MAIL_FROM: string;
  APIFY_TOKEN?: string;
}

const SCHEMA = `${AUTH_SCHEMA}
CREATE TABLE IF NOT EXISTS bids (
  bid_number TEXT PRIMARY KEY, bid_kind TEXT, items TEXT, quantity INTEGER, ministry TEXT, department TEXT,
  start_at TEXT, end_at TEXT, status TEXT, is_high_value INTEGER, bid_to_ra INTEGER, url TEXT,
  matched_keyword TEXT, first_seen TEXT NOT NULL DEFAULT (datetime('now')), notified INTEGER NOT NULL DEFAULT 0,
  interest TEXT NOT NULL DEFAULT 'new' CHECK (interest IN ('new','interested','ignored','submitted')), note TEXT);
CREATE INDEX IF NOT EXISTS bids_end ON bids(end_at);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY, at TEXT NOT NULL DEFAULT (datetime('now')), fetched INTEGER, new_bids INTEGER, emailed INTEGER, error TEXT);
INSERT OR IGNORE INTO settings VALUES ('keywords', '["audio visual","video conferencing","projector","interactive display","PA system","home automation","CCTV","access control","LED video wall","smart classroom"]');
INSERT OR IGNORE INTO settings VALUES ('recipients', '[]');`;

let schemaReady = false;
async function ensureSchema(db: D1Database) {
  if (schemaReady) return;
  await db.batch(SCHEMA.split(';').map((s) => s.trim()).filter(Boolean).map((s) => db.prepare(s)));
  schemaReady = true;
}

const json = (d: unknown, status = 200) => Response.json(d, { status });
const getSetting = async (db: D1Database, key: string): Promise<string[]> =>
  JSON.parse((await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>())?.value ?? '[]');

// ---- GeM fetch + notify -------------------------------------------------------------------------
interface ApifyBid {
  bidNumber: string; bidKind?: string; items?: string; quantity?: number; ministry?: string; department?: string;
  startAt?: string; endAt?: string; status?: string; isHighValue?: boolean; bidToRaEnabled?: boolean; url?: string; matchedKeyword?: string;
}

export async function runWatch(env: Env) {
  await ensureSchema(env.DB);
  const keywords = (await getSetting(env.DB, 'keywords')).slice(0, 10);
  let fetched = 0, fresh = 0, emailed = 0, error: string | null = null;
  try {
    if (!env.APIFY_TOKEN) throw new Error('APIFY_TOKEN secret not set');
    if (!keywords.length) throw new Error('No keywords configured');
    const res = await fetch('https://api.apify.com/v2/acts/automatic~gem-tenders-scraper/run-sync-get-dataset-items', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.APIFY_TOKEN}` },
      body: JSON.stringify({ keyword: keywords[0], keywords: keywords.slice(1), status: 'open', startedWithinDays: 3, sort: 'newest', maxResults: 300 }),
    });
    if (!res.ok) throw new Error(`Apify ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const bids = (await res.json()) as ApifyBid[];
    fetched = bids.length;
    const stmt = env.DB.prepare(`INSERT OR IGNORE INTO bids (bid_number, bid_kind, items, quantity, ministry, department, start_at, end_at,
      status, is_high_value, bid_to_ra, url, matched_keyword) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const valid = bids.filter((b) => b.bidNumber);
    const results = !valid.length ? [] : await env.DB.batch(
      valid.map((b) =>
        stmt.bind(b.bidNumber, b.bidKind ?? null, b.items ?? null, b.quantity ?? null, b.ministry ?? null, b.department ?? null,
          b.startAt ?? null, b.endAt ?? null, b.status ?? null, b.isHighValue ? 1 : 0, b.bidToRaEnabled ? 1 : 0, /^https:\/\//i.test(b.url ?? '') ? b.url : null, b.matchedKeyword ?? null)),
    );
    fresh = results.reduce((n, r) => n + (r.meta.changes ?? 0), 0);
    emailed = await notifyNew(env);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  await env.DB.prepare('INSERT INTO runs (fetched, new_bids, emailed, error) VALUES (?,?,?,?)').bind(fetched, fresh, emailed, error).run();
  return { fetched, fresh, emailed, error };
}

async function notifyNew(env: Env) {
  const { results } = await env.DB.prepare(`SELECT * FROM bids WHERE notified = 0 ORDER BY end_at`).all<Record<string, string>>();
  if (!results.length) return 0;
  const recipients = await getSetting(env.DB, 'recipients');
  const rows = results.map((b) => `<tr><td><a href="${esc(b.url)}">${esc(b.bid_number)}</a></td><td>${esc(b.items)}</td>
    <td>${esc(b.quantity)}</td><td>${esc(b.ministry)} / ${esc(b.department)}</td><td>${esc(b.end_at?.slice(0, 16).replace('T', ' '))}</td>
    <td>${Number(b.bid_to_ra) === 1 ? 'Yes' : ''}</td></tr>`).join('');
  const html = `<p>${results.length} new GeM bid(s) matched your keywords.</p>
    <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-family:Arial;font-size:13px">
    <tr style="background:#eee"><th>Bid</th><th>Items</th><th>Qty</th><th>Buyer</th><th>Closes</th><th>Bid→RA</th></tr>${rows}</table>
    <p><a href="https://auction.vtech.services">Open Auction Tracker</a></p>`;
  let sent = 0;
  for (const to of recipients) {
    try {
      await sendMail(env.MAILER, env.MAIL_FROM, 'VTech Auction Tracker', to, `GeM: ${results.length} new bid(s) — ${new Date().toISOString().slice(0, 10)}`, html);
      sent++;
    } catch (e) {
      console.error('mail failed', to, e);
    }
  }
  if (sent || !recipients.length) await env.DB.prepare('UPDATE bids SET notified = 1 WHERE notified = 0').run();
  return sent;
}

// ---- HTTP API ------------------------------------------------------------------------------------
async function api(req: Request, env: Env, url: URL): Promise<Response> {
  const db = env.DB;
  const p = url.pathname;
  const body = async () => (req.method === 'GET' ? {} : await req.json().catch(() => ({}))) as Record<string, any>;

  if (p === '/api/login' && req.method === 'POST') return login(db, await body());
  if (p === '/api/setup' && req.method === 'POST') return setup(db, env.ADMIN_EMAIL, await body());
  if (p === '/api/needs-setup') return json({ needsSetup: (await db.prepare('SELECT COUNT(*) n FROM users').first<{ n: number }>())!.n === 0 });

  const user = await currentUser(db, req);
  if (!user) return json({ error: 'unauthorized' }, 401);
  const admin = user.role === 'admin';
  if (p === '/api/logout') return logout(db, req);
  if (p === '/api/me') return json(user);

  if (p === '/api/bids' && req.method === 'GET') {
    const q = `%${url.searchParams.get('q') ?? ''}%`;
    const interest = url.searchParams.get('interest') ?? '';
    const open = url.searchParams.get('open') !== '0';
    const { results } = await db
      .prepare(`SELECT * FROM bids WHERE (items LIKE ?1 OR bid_number LIKE ?1 OR ministry LIKE ?1 OR department LIKE ?1)
                AND (?2 = '' OR interest = ?2) AND (?3 = 0 OR end_at IS NULL OR end_at >= strftime('%Y-%m-%dT%H:%M', 'now', '+330 minutes'))
                ORDER BY end_at LIMIT 500`)
      .bind(q, interest, open ? 1 : 0)
      .all();
    return json(results);
  }
  const bidMatch = p.match(/^\/api\/bids\/(.+)$/);
  if (bidMatch && req.method === 'PATCH') {
    const b = await body();
    const interest = ['new', 'interested', 'ignored', 'submitted'].includes(b.interest) ? b.interest : null;
    await db.prepare('UPDATE bids SET interest = COALESCE(?, interest), note = COALESCE(?, note) WHERE bid_number = ?')
      .bind(interest, b.note ?? null, decodeURIComponent(bidMatch[1])).run();
    return json({ ok: true });
  }
  if (p === '/api/runs') return json((await db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT 20').all()).results);
  if (p === '/api/settings' && req.method === 'GET')
    return json({ keywords: await getSetting(db, 'keywords'), recipients: await getSetting(db, 'recipients'), apifyConfigured: !!env.APIFY_TOKEN });

  if (!admin) return json({ error: 'admin only' }, 403);
  if (p === '/api/settings' && req.method === 'PUT') {
    const b = await body();
    const clean = (a: unknown, re: RegExp) => [...new Set((Array.isArray(a) ? a : []).map((s) => String(s).trim()).filter((s) => re.test(s)))];
    const keywords = clean(b.keywords, /^.{3,100}$/).slice(0, 10);
    const recipients = clean(b.recipients, /^[^@\s]+@[^@\s]+\.[^@\s]+$/);
    await db.batch([
      db.prepare("UPDATE settings SET value = ? WHERE key = 'keywords'").bind(JSON.stringify(keywords)),
      db.prepare("UPDATE settings SET value = ? WHERE key = 'recipients'").bind(JSON.stringify(recipients)),
    ]);
    return json({ keywords, recipients });
  }
  if (p === '/api/run-now' && req.method === 'POST') return json(await runWatch(env));
  if (p === '/api/users' && req.method === 'GET') return listUsers(db);
  if (p === '/api/users' && req.method === 'POST') return createUser(db, await body());
  const userMatch = p.match(/^\/api\/users\/(\d+)$/);
  if (userMatch && req.method === 'PATCH') return updateUser(db, Number(userMatch[1]), await body());
  return json({ error: 'not found' }, 404);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    await ensureSchema(env.DB);
    try {
      return await api(req, env, url);
    } catch (e) {
      console.error(e);
      return json({ error: 'server error' }, 500);
    }
  },
  async scheduled(_c: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runWatch(env));
  },
} satisfies ExportedHandler<Env>;
