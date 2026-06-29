// mToyota Roadside Rescue — leaderboard backend
// Runs as a Vercel Serverless Function (Node.js runtime).
// Storage: Neon Postgres via the @neondatabase/serverless HTTP driver.
//
// Endpoints (all on this one file, routed by HTTP method):
//   GET  /api/leaderboard            -> public top-N board: [{ name, score }]
//   POST /api/leaderboard            -> submit a score (JSON body), returns rank
//   GET  /api/leaderboard?admin=TOKEN&full=1          -> all rows incl. PII (JSON)
//   GET  /api/leaderboard?admin=TOKEN&full=1&format=csv -> same, as CSV download
//
// Rules enforced server-side:
//   * One row per person. Identity = normalised email + phone.
//   * Only the player's HIGHEST score is kept.
//   * No two players share the same score (ties are nudged down deterministically),
//     so leaderboard places are always unambiguous.

import { neon } from '@neondatabase/serverless';

// Connection string. The Vercel<->Neon integration injects DATABASE_URL, but the
// names vary: a custom prefix may be set when connecting (here it's LEADERBOARD_),
// so we check the prefixed names first, then the standard ones.
function connString() {
  return (
    process.env.LEADERBOARD_DATABASE_URL ||
    process.env.LEADERBOARD_POSTGRES_URL ||
    process.env.LEADERBOARD_DATABASE_URL_UNPOOLED ||
    process.env.LEADERBOARD_POSTGRES_URL_NON_POOLING ||
    process.env.LEADERBOARD_POSTGRES_PRISMA_URL ||
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.DATABASE_URL_UNPOOLED ||
    process.env.POSTGRES_URL_NON_POOLING ||
    process.env.POSTGRES_PRISMA_URL ||
    ''
  );
}

// Lazily create the client INSIDE the request, never at import time. If the var
// is missing, neon() would throw on load and crash every request before our
// error guard runs — this defers it so we can return a clean JSON message.
let _sql;
function db() {
  if (!_sql) _sql = neon(connString());
  return _sql;
}

const PUBLIC_LIMIT = 100;     // max rows returned on the public board
const MAX_NAME = 40;
const HARD_SCORE_CAP = 5_000_000;   // sanity ceiling for anti-cheat

// ---- one-time table creation (per cold start) ---------------------------
let schemaReady;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await db()`
        CREATE TABLE IF NOT EXISTS players (
          identity   TEXT PRIMARY KEY,
          name       TEXT NOT NULL,
          email      TEXT NOT NULL,
          phone      TEXT NOT NULL,
          score      INTEGER NOT NULL,
          rescued    INTEGER NOT NULL DEFAULT 0,
          boosts     INTEGER NOT NULL DEFAULT 0,
          multiplier REAL    NOT NULL DEFAULT 1,
          time_sec   REAL    NOT NULL DEFAULT 0,
          plays      INTEGER NOT NULL DEFAULT 1,
          user_agent TEXT,
          ip_hint    TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`;
      // Guarantees "no two players with the same score".
      await db()`CREATE UNIQUE INDEX IF NOT EXISTS players_score_uniq ON players (score)`;
      await db()`CREATE INDEX IF NOT EXISTS players_score_desc ON players (score DESC)`;
    })();
  }
  return schemaReady;
}

// ---- helpers ------------------------------------------------------------
function normEmail(s) { return String(s || '').trim().toLowerCase(); }
function normPhone(s) { return String(s || '').replace(/\D/g, ''); }
function identityOf(email, phone) { return canonPhone(phone) + '|' + normEmail(email); }
function isEmail(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s); }
function clean(s, max) { return String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, '').trim().slice(0, max); }

// ---- "real input" validation (authoritative; mirrors the client) ----
const DISPOSABLE_DOMAINS = new Set(['mailinator.com','guerrillamail.com','guerrillamail.info','10minutemail.com','tempmail.com','temp-mail.org','yopmail.com','trashmail.com','sharklasers.com','getnada.com','nada.email','maildrop.cc','dispostable.com','fakeinbox.com','throwawaymail.com','mailnesia.com','mintemail.com','tempr.email','moakt.com','emailondeck.com','spam4.me','grr.la','mohmal.com','tempinbox.com','mailcatch.com','33mail.com','inboxbear.com','vomoto.com','tmail.com','tmpmail.org']);
const TYPO_DOMAINS = { 'gmail.con':'gmail.com','gmail.co':'gmail.com','gmail.cm':'gmail.com','gmial.com':'gmail.com','gmal.com':'gmail.com','gmai.com':'gmail.com','gmaill.com':'gmail.com','gnail.com':'gmail.com','gmail.comm':'gmail.com','hotmial.com':'hotmail.com','hotmai.com':'hotmail.com','hotmal.com':'hotmail.com','hotmail.co':'hotmail.com','yaho.com':'yahoo.com','yahooo.com':'yahoo.com','yhaoo.com':'yahoo.com','yahoo.co':'yahoo.com','outlok.com':'outlook.com','outloo.com':'outlook.com','iclud.com':'icloud.com','icloud.co':'icloud.com' };

function checkEmail(raw) {
  const email = normEmail(raw);
  if (!email) return { ok: false, reason: 'Email is required.' };
  const m = email.match(/^([a-z0-9.!#$%&'*+/=?^_`{|}~-]+)@([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24})$/);
  if (!m) return { ok: false, reason: 'That email is not valid.' };
  const local = m[1], domain = m[2];
  if (local.length > 64 || local.includes('..') || local[0] === '.' || local.endsWith('.'))
    return { ok: false, reason: 'That email is not valid.' };
  if (domain.includes('..')) return { ok: false, reason: 'That email is not valid.' };
  if (TYPO_DOMAINS[domain]) return { ok: false, reason: 'Did you mean @' + TYPO_DOMAINS[domain] + '?' };
  if (DISPOSABLE_DOMAINS.has(domain)) return { ok: false, reason: 'Temporary email addresses are not allowed.' };
  if (email === 'you@email.com' || domain === 'example.com' || domain === 'test.com')
    return { ok: false, reason: 'Please use your real email.' };
  return { ok: true, value: email };
}

// Canonical Indonesian mobile in national 08-form, or '' if implausible.
function canonPhone(raw) {
  let d = normPhone(raw);
  if (!d) return '';
  if (d.startsWith('0')) d = '62' + d.slice(1);
  else if (d.startsWith('62')) { /* national E.164 */ }
  else if (d.startsWith('8')) d = '62' + d;
  else return '';
  if (!/^628\d{8,11}$/.test(d)) return '';
  return '0' + d.slice(2);
}
function checkPhone(raw) {
  const local = canonPhone(raw);
  if (!local) return { ok: false, reason: 'Enter a valid Indonesian mobile number (08…).' };
  const nsn = local.slice(1);                 // 8XXXXXXXX
  if (!/^8[1235789]/.test(nsn)) return { ok: false, reason: 'That is not a valid mobile prefix.' };
  if (/^(\d)\1+$/.test(nsn) || /^(\d)\1+$/.test(nsn.slice(1)) || /1234567890|0987654321/.test(nsn))
    return { ok: false, reason: 'Please enter a real phone number.' };
  return { ok: true, value: local };
}

function setCors(res) {
  // Public board + writes. Tighten the origin if you only embed from one domain.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, accept, x-admin-token');
}

function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;     // Vercel auto-parses JSON
  try { return JSON.parse(req.body || '{}'); } catch { return {}; }
}

// Find a score not already used by a DIFFERENT player. Ties step down by 1
// so the player who reached the value first keeps the higher place.
async function freeScore(want, identity) {
  let s = Math.max(0, Math.floor(want));
  for (let guard = 0; guard < 100000 && s >= 0; guard++) {
    const clash = await db()`SELECT identity FROM players WHERE score = ${s} LIMIT 1`;
    if (clash.length === 0 || clash[0].identity === identity) return s;
    s -= 1;
  }
  return Math.max(0, Math.floor(want)); // give up gracefully; unique index is the backstop
}

// ---- handler ------------------------------------------------------------
export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  if (!connString()) {
    res.status(500).json({
      error: 'No database connection string found. Connect a Neon database to this Vercel project (Storage tab) and redeploy so DATABASE_URL is injected.'
    });
    return;
  }

  try {
    await ensureSchema();

    // ---------------- GET ----------------
    if (req.method === 'GET') {
      const q = req.query || {};
      const adminToken = process.env.ADMIN_TOKEN;
      const givenToken = q.admin || req.headers['x-admin-token'];

      // Admin export (PII) — requires the secret token.
      if (q.full && adminToken && givenToken === adminToken) {
        const rows = await db()`
          SELECT identity, name, email, phone, score, rescued, boosts, multiplier,
                 time_sec, plays, created_at, updated_at
          FROM players ORDER BY score DESC`;
        if (q.format === 'csv') {
          const head = ['name','email','phone','score','rescued','boosts','multiplier','time_sec','plays','created_at','updated_at'];
          const esc = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
          const csv = [head.join(',')]
            .concat(rows.map(r => head.map(k => esc(r[k])).join(',')))
            .join('\r\n');
          res.setHeader('Content-Type', 'text/csv; charset=utf-8');
          res.setHeader('Content-Disposition', 'attachment; filename="mtoyota-players.csv"');
          res.status(200).send(csv);
          return;
        }
        res.status(200).json({ count: rows.length, players: rows });
        return;
      }
      if (q.full && (!adminToken || givenToken !== adminToken)) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      // Public board: name + score only (no PII).
      const limit = Math.min(PUBLIC_LIMIT, Math.max(1, parseInt(q.limit, 10) || 50));
      const rows = await db()`SELECT name, score FROM players ORDER BY score DESC LIMIT ${limit}`;
      res.setHeader('Cache-Control', 'public, s-maxage=5, stale-while-revalidate=30');
      res.status(200).json({ leaderboard: rows });
      return;
    }

    // ---------------- POST ----------------
    if (req.method === 'POST') {
      const b = readBody(req);

      const name  = clean(b.name, MAX_NAME);
      let   score = Math.floor(Number(b.score));

      const eRes = checkEmail(b.email);
      const pRes = checkPhone(b.phone);

      if (!name)                       { res.status(400).json({ error: 'Name is required.' }); return; }
      if (!eRes.ok)                    { res.status(400).json({ error: eRes.reason }); return; }
      if (!pRes.ok)                    { res.status(400).json({ error: pRes.reason }); return; }
      if (!Number.isFinite(score) || score < 0) { res.status(400).json({ error: 'Invalid score.' }); return; }
      if (b.consent !== true)          { res.status(400).json({ error: 'Consent is required.' }); return; }

      const email = eRes.value;        // normalized
      const phone = pRes.value;        // canonical 08-form

      // Basic anti-cheat clamp. Tune to match your scoring if needed.
      const rescued    = Math.max(0, Math.floor(Number(b.rescued) || 0));
      const boosts     = Math.max(0, Math.floor(Number(b.boosts) || 0));
      const multiplier = Math.max(1, Number(b.multiplier) || 1);
      const timeSec    = Math.max(0, Number(b.timeSec) || 0);
      const plausible  = rescued * 460 + boosts * 2000 + 5000;     // generous headroom
      score = Math.min(score, plausible, HARD_SCORE_CAP);

      const identity = identityOf(email, phone);
      const ua  = clean(req.headers['user-agent'], 300);
      const ipRaw = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      const ipHint = ipRaw ? ipRaw.replace(/\.\d+$/, '.x').replace(/:[^:]+$/, ':x') : null; // coarse, privacy-friendly

      const existing = await db()`SELECT score FROM players WHERE identity = ${identity} LIMIT 1`;
      const prevBest = existing.length ? existing[0].score : null;
      const isNewBest = prevBest == null || score > prevBest;

      if (isNewBest) {
        const finalScore = await freeScore(score, identity);
        // Upsert, keeping the higher score and bumping the play counter.
        await db()`
          INSERT INTO players
            (identity, name, email, phone, score, rescued, boosts, multiplier, time_sec, plays, user_agent, ip_hint)
          VALUES
            (${identity}, ${name}, ${email}, ${phone}, ${finalScore}, ${rescued}, ${boosts}, ${multiplier}, ${timeSec}, 1, ${ua}, ${ipHint})
          ON CONFLICT (identity) DO UPDATE SET
            name=${name}, score=${finalScore}, rescued=${rescued}, boosts=${boosts},
            multiplier=${multiplier}, time_sec=${timeSec},
            plays=players.plays+1, user_agent=${ua}, ip_hint=${ipHint}, updated_at=now()`;
      } else {
        // Not a personal best — just record that they played again.
        await db()`UPDATE players SET plays=plays+1, name=${name}, updated_at=now() WHERE identity=${identity}`;
      }

      const meRow = await db()`SELECT score FROM players WHERE identity=${identity} LIMIT 1`;
      const best = meRow.length ? meRow[0].score : score;
      const aboveRows = await db()`SELECT count(*)::int AS n FROM players WHERE score > ${best}`;
      const totalRows = await db()`SELECT count(*)::int AS n FROM players`;
      const rank  = (aboveRows[0]?.n ?? 0) + 1;
      const total = totalRows[0]?.n ?? 1;

      const board = await db()`SELECT identity, name, score FROM players ORDER BY score DESC LIMIT ${PUBLIC_LIMIT}`;
      const leaderboard = board.map(r => ({ name: r.name, score: r.score, me: r.identity === identity || undefined }));

      res.status(200).json({ ok: true, newBest: isNewBest, rank, total, best, leaderboard });
      return;
    }

    // ---------------- DELETE ----------------
    // Admin-only. Token via ?admin=, x-admin-token header, or JSON body { token }.
    //   DELETE /api/leaderboard?admin=TOKEN&identity=<id>   -> remove one player
    //   DELETE /api/leaderboard?admin=TOKEN&all=1           -> remove ALL players
    if (req.method === 'DELETE') {
      const q = req.query || {};
      const body = readBody(req);
      const adminToken = process.env.ADMIN_TOKEN;
      const given = q.admin || req.headers['x-admin-token'] || body.token;

      if (!adminToken || given !== adminToken) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const identity = q.identity || body.identity;
      const wipeAll  = q.all === '1' || body.all === true;

      if (wipeAll) {
        await db()`DELETE FROM players`;
        res.status(200).json({ ok: true, deleted: 'all' });
        return;
      }
      if (identity) {
        const r = await db()`DELETE FROM players WHERE identity = ${identity}`;
        const n = (r && (r.count ?? r.rowCount)) || 0;
        res.status(200).json({ ok: true, deleted: n });
        return;
      }
      res.status(400).json({ error: 'Provide identity, or all=1 to clear everything.' });
      return;
    }

    res.setHeader('Allow', 'GET, POST, DELETE, OPTIONS');
    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('leaderboard error:', err);
    res.status(500).json({ error: 'Server error', detail: String(err && err.message || err) });
  }
}
