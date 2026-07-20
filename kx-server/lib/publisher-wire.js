'use strict';

// lib/publisher-wire.js — glue between kx-server and the KX-Web publisher.
//
// One call in server.js attaches everything:
//
//     const { attachWebPublisher } = require('./lib/publisher-wire');
//     const web = attachWebPublisher(db, routes);
//     ...
//     function notify(topic) { ...SSE... ; web.onNotify(topic); }
//
// How it works:
//  * Piggybacks on the existing notify(topic) change signal. On 'results' /
//    'athletes' topics it finds phases dirty since the last check via the
//    updated_at columns (schema was designed for exactly this) and pushes
//    full snapshots of only those phases. 'competitions'/'events' topics
//    push competition metadata.
//  * Web settings live where the spec put them: competition.api_key, plus
//    competition_setting keys 'web_base_url' and 'web_org_key'.
//  * Adds Chief-of-Scoring routes:
//      POST /api/web/register   create the competition on KX-Web (org key),
//                               stores the returned api_key
//      POST /api/web/sync-now   full re-sync
//      POST /api/web/publish-official  push one phase with status=official
//      GET  /api/web/status     publisher queue/sync state for the UI
//  * Writes outcomes to the existing sync_log table (OK / FAILED).

const { uuid } = require('./db');
const { Publisher } = require('./publisher');
const payloads = require('./publisher-payloads');
const { registerCompetition } = require('./register');

// Website settings are SERVER-WIDE: one public website serves all
// competitions of this installation. Only the api_key is per-competition.
function getServerSetting(db, key) {
  return db.prepare('SELECT value FROM server_setting WHERE key = ?').get(key)?.value ?? null;
}

function setServerSetting(db, key, value) {
  db.prepare(
    `INSERT INTO server_setting (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).run(key, value);
}

function logSync(db, competitionId, status, message) {
  db.prepare(
    `INSERT INTO sync_log (sync_id, competition_id, finished_at, status, message)
     VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, ?)`
  ).run(uuid(), competitionId, status, String(message).slice(0, 500));
}

function attachWebPublisher(db, routes) {
  // Lazy upgrade: kx.db files created before this feature get the table now
  db.exec(`CREATE TABLE IF NOT EXISTS server_setting (
    key TEXT PRIMARY KEY, value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`);

  /** @type {Map<string, {publisher: import('./publisher').Publisher, watermark: string}>} */
  const active = new Map(); // competition_id -> state

  const nowIso = () => new Date().toISOString();

  function ensurePublisher(competitionId) {
    let state = active.get(competitionId);
    if (state) return state;

    const comp = db.prepare(
      'SELECT competition_id, api_key FROM competition WHERE competition_id = ?'
    ).get(competitionId);
    const baseUrl = getServerSetting(db, 'web_base_url');
    if (!comp?.api_key || !baseUrl) return null; // web publishing not configured

    const publisher = new Publisher({
      baseUrl,
      apiKey: comp.api_key,
      buildCompetition: () => payloads.buildCompetitionSync(db, competitionId),
      buildPhase: (eventId, webPhase) => payloads.buildPhaseSync(db, eventId, webPhase),
      buildFull: () => payloads.buildFullSync(db, competitionId)
    });
    publisher.on('published', (e) => logSync(db, competitionId, 'OK', `${e.target}: ${e.updated} rows`));
    publisher.on('stalled', (e) => logSync(db, competitionId, 'FAILED', `${e.target}: ${e.attempts} attempts`));
    publisher.on('auth-error', () => logSync(db, competitionId, 'FAILED', 'API key rejected (401)'));
    publisher.on('error', (e) => logSync(db, competitionId, 'FAILED', `${e.target}: ${e.error}`));
    publisher.start();

    state = { publisher, watermark: nowIso() };
    active.set(competitionId, state);
    return state;
  }

  function configuredCompetitions() {
    if (!getServerSetting(db, 'web_base_url')) return [];
    return db.prepare(
      'SELECT competition_id FROM competition WHERE api_key IS NOT NULL'
    ).all().map((r) => r.competition_id);
  }

  // ------------------------------------------------------------------
  // notify() hook — call from server.js on every topic
  // ------------------------------------------------------------------
  function onNotify(topic) {
    if (!['results', 'athletes', 'events', 'competitions'].includes(topic)) return;
    for (const competitionId of configuredCompetitions()) {
      const state = ensurePublisher(competitionId);
      if (!state) continue;

      if (topic === 'competitions' || topic === 'events') {
        state.publisher.publishCompetition();
      }
      if (topic === 'results' || topic === 'athletes' || topic === 'events') {
        const since = state.watermark;
        state.watermark = nowIso();
        try {
          for (const { eventId, webPhase } of payloads.dirtyPhases(db, competitionId, since)) {
            state.publisher.publishPhase(eventId, webPhase);
          }
        } catch (e) {
          logSync(db, competitionId, 'FAILED', `dirty-scan: ${e.message}`);
        }
      }
    }
  }

  // ------------------------------------------------------------------
  // Chief of Scoring routes
  // ------------------------------------------------------------------
  const on = (method, path, fn) => { routes[`${method} ${path}`] = fn; };

  // Server-wide website configuration (the same website for all competitions).
  // The org key is write-only: never echoed back to the browser.
  on('GET', '/api/web/settings', () => ({
    web_base_url: getServerSetting(db, 'web_base_url'),
    org_key_set: !!getServerSetting(db, 'web_org_key')
  }));

  on('POST', '/api/web/settings', (q, body) => {
    if (body.web_base_url !== undefined) {
      const u = String(body.web_base_url).trim().replace(/\/+$/, '');
      if (u && !/^https?:\/\//.test(u)) {
        throw new Error('Website address must start with http:// or https://');
      }
      setServerSetting(db, 'web_base_url', u);
      // publishers cache the URL — rebuild on next use
      for (const st of active.values()) st.publisher.stop();
      active.clear();
    }
    if (body.org_key) setServerSetting(db, 'web_org_key', String(body.org_key).trim());
    return { ok: true };
  });

  // Create the competition on KX-Web and store the returned api_key.
  // body: { competition_id, base_url, org_key } — base_url/org_key are also
  // remembered in competition_setting so registration is one-time.
  on('POST', '/api/web/register', async (q, body) => {
    const comp = db.prepare(
      `SELECT competition_id, competition_name, country, location, start_date, end_date, time_zone, type, api_key
         FROM competition WHERE competition_id = ?`
    ).get(body.competition_id);
    if (!comp) throw new Error('Competition not found');
    if (comp.api_key) throw new Error('Already registered — the website API key is set.');

    const baseUrl = body.base_url ?? getServerSetting(db, 'web_base_url');
    const orgKey = body.org_key ?? getServerSetting(db, 'web_org_key');
    if (!baseUrl || !orgKey) throw new Error('Configure the website address and organization key first (Publish to website settings).');

    const { api_key, slug, public_url } = await registerCompetition({
      baseUrl,
      orgKey,
      competition: {
        competition_id: comp.competition_id,
        name: comp.competition_name,
        country: comp.country,
        location: comp.location ?? '',
        start_date: comp.start_date,
        end_date: comp.end_date,
        time_zone: comp.time_zone,
        comp_type: { DOMESTIC: 'Domestic', INTERNATIONAL: 'International', MIXED: 'Mixed' }[comp.type] ?? 'Domestic'
      }
    });

    db.prepare('UPDATE competition SET api_key = ? WHERE competition_id = ?')
      .run(api_key, comp.competition_id);
    if (body.base_url) setServerSetting(db, 'web_base_url', baseUrl);
    if (body.org_key) setServerSetting(db, 'web_org_key', orgKey);
    logSync(db, comp.competition_id, 'OK', `registered as ${slug}`);

    // First full push so the site is populated immediately
    const state = ensurePublisher(comp.competition_id);
    if (state) state.publisher.publishFull().catch(() => {});

    return { ok: true, slug, public_url };
  });

  on('POST', '/api/web/sync-now', async (q, body) => {
    const state = ensurePublisher(body.competition_id);
    if (!state) throw new Error('Web publishing is not configured for this competition (register first).');
    const r = await state.publisher.publishFull();
    return { ok: true, updated: r.updated ?? 0 };
  });

  // Explicit officialness — a jury decision, not derived from data
  on('POST', '/api/web/publish-official', async (q, body) => {
    const state = ensurePublisher(body.competition_id);
    if (!state) throw new Error('Web publishing is not configured for this competition.');
    const snapshot = payloads.buildPhaseSync(
      db, body.event_id, payloads.toWebPhase(body.phase), { status: 'official' }
    );
    const r = await state.publisher._send(
      `phase:${body.event_id}:${payloads.toWebPhase(body.phase)}`,
      '/api/v1/phase',
      JSON.stringify(snapshot)
    );
    return { ok: true, updated: r.updated ?? 0 };
  });

  on('GET', '/api/web/status', (q) => {
    const state = q.competition_id ? active.get(q.competition_id) : null;
    return {
      configured: q.competition_id ? configuredCompetitions().includes(q.competition_id) : false,
      publisher: state ? state.publisher.status() : null,
      last_syncs: q.competition_id
        ? db.prepare(
            `SELECT started_at, finished_at, status, message FROM sync_log
              WHERE competition_id = ? ORDER BY started_at DESC LIMIT 10`
          ).all(q.competition_id)
        : []
    };
  });

  return { onNotify, ensurePublisher };
}

module.exports = { attachWebPublisher };
