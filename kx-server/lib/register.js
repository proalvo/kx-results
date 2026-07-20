'use strict';

/**
 * Competition provisioning from kx-server.
 *
 * Flow (once per competition, from the "Add a new competition" page):
 *   1. The organization key ("org.{org_id}.{secret}") is stored once in
 *      kx-server settings — obtained from the website when the club was
 *      registered.
 *   2. When the Chief of Scoring creates a competition locally, kx-server
 *      calls registerCompetition() with the SAME competition_id (uuid).
 *   3. KX-Web creates the competition and returns its per-competition
 *      api_key ONCE. kx-server saves it into the competition table's
 *      api_key field (KX-Results spec) and uses it for all syncing.
 *
 * Idempotency: a 409 means the competition already exists on the website.
 * If the key was lost, it must be regenerated on the website — it is
 * never retrievable again by design.
 */

const DEFAULT_TIMEOUT_MS = 10000;

/**
 * @param {object} opts
 * @param {string} opts.baseUrl  e.g. https://example.fi/kx-results
 * @param {string} opts.orgKey   organization key from kx-server settings
 * @param {object} opts.competition
 * @param {string} opts.competition.competition_id  kx-server's uuid
 * @param {string} opts.competition.name
 * @param {string} opts.competition.country         3-letter code
 * @param {string} opts.competition.start_date      YYYY-MM-DD
 * @param {string} opts.competition.end_date        YYYY-MM-DD
 * @param {string} [opts.competition.location]
 * @param {string} [opts.competition.time_zone]
 * @param {string} [opts.competition.comp_type]     Domestic|International|Mixed
 * @param {string} [opts.competition.slug]          optional URL slug wish
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{api_key: string, slug: string, public_url: string}>}
 */
async function registerCompetition({ baseUrl, orgKey, competition, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!baseUrl || !orgKey) throw new Error('baseUrl and orgKey are required');
  for (const f of ['competition_id', 'name', 'country', 'start_date', 'end_date']) {
    if (!competition?.[f]) throw new Error(`competition.${f} is required`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();

  const endpoint = baseUrl.replace(/\/+$/, '') + '/api/v1/competitions';
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${orgKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(competition),
      signal: controller.signal
    });

    const text = await res.text().catch(() => '');
    let data = {};
    try { data = JSON.parse(text); } catch { /* non-JSON: HTML error page etc. */ }

    if (res.status === 201 && data.api_key) {
      return { api_key: data.api_key, slug: data.slug, public_url: data.public_url };
    }
    if (res.status === 401) {
      throw new Error('Website rejected the organization key. Check kx-server settings.');
    }
    if (res.status === 409) {
      throw new Error('Competition already exists on the website: ' + (data.error ?? ''));
    }
    if (res.status === 404) {
      throw new Error(
        `Website returned 404 for ${endpoint}. Check that the website address ` +
        'includes the full path (e.g. https://example.fi/kx-results, not just ' +
        'https://example.fi) and that the website software is up to date ' +
        '(the /api/v1/competitions endpoint exists).'
      );
    }
    const detail = data.error ?? (text ? text.slice(0, 120) : 'no response body');
    throw new Error(`Registration failed (HTTP ${res.status}): ${detail}`);
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { registerCompetition };

/* ----------------------------------------------------------------------
 * Wiring into kx-server's "Add a new competition" handler (pseudocode):
 *
 * const { registerCompetition } = require('./modules/publisher/register');
 *
 * app.post('/competitions', async (req, res) => {
 *   const competitionId = uuid();                          // existing
 *   saveCompetitionLocally(competitionId, req.body);       // existing
 *
 *   if (settings.orgKey && req.body.publishToWeb) {        // NEW
 *     try {
 *       const { api_key, public_url } = await registerCompetition({
 *         baseUrl: settings.webBaseUrl,
 *         orgKey: settings.orgKey,
 *         competition: {
 *           competition_id: competitionId,
 *           name: req.body.competition_name,
 *           country: req.body.country,
 *           start_date: req.body.start_date,
 *           end_date: req.body.end_date,
 *           location: req.body.location
 *         }
 *       });
 *       db.prepare('UPDATE competition SET api_key = ? WHERE competition_id = ?')
 *         .run(api_key, competitionId);
 *       // show public_url in the UI so the organizer can share it
 *     } catch (e) {
 *       // Local competition still works; web publishing can be retried
 *       // from a "Connect to website" button in competition settings.
 *       notifyAdminUI('web-registration-failed', String(e.message));
 *     }
 *   }
 *   res.json({ ok: true, competitionId });
 * });
 * ---------------------------------------------------------------------- */
