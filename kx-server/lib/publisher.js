'use strict';

/**
 * KX-Results publisher module
 * ---------------------------
 * Pushes snapshots from the local kx-server (Node + SQLite) to the public
 * KX-Web site (PHP + MariaDB) over HTTPS.
 *
 * Design (matches the KX-Web Sync API / OpenAPI spec):
 *  - Full snapshots, idempotent: every push contains the complete current
 *    state of one phase (or the whole competition). Lost/duplicate pushes
 *    can never corrupt the website.
 *  - Debounced: rapid result edits (gate judge taps) collapse into at most
 *    one push per phase per `debounceMs`.
 *  - Hash-skip: a snapshot identical to the last acknowledged one for the
 *    same phase is not sent again.
 *  - Retry queue: failed pushes are retried with exponential backoff.
 *    Because payloads are snapshots, only the LATEST snapshot per target
 *    is kept — retry order does not matter and the queue cannot grow
 *    unboundedly during an uplink outage.
 *  - No hard dependencies: uses global fetch (Node >= 18).
 *
 * Usage (see integration-example.js):
 *   const publisher = new Publisher({
 *     baseUrl: 'https://results.example.fi',
 *     apiKey:  competition.api_key,          // "{competition_id}.{secret}"
 *     buildCompetition: () => payloads.buildCompetitionSync(db, competitionId),
 *     buildPhase: (eventId, phase) => payloads.buildPhaseSync(db, eventId, phase),
 *     buildFull: () => payloads.buildFullSync(db, competitionId),
 *   });
 *   publisher.start();
 *   publisher.publishPhase(eventId, 'QUALIFICATION');   // call on every result change
 *   publisher.publishFull();                            // "Sync now" button
 */

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const DEFAULTS = {
  debounceMs: 2000,        // collapse edits; max 1 push / phase / 2 s
  timeoutMs: 10000,        // per-request timeout
  retryBaseMs: 5000,       // first retry after 5 s
  retryMaxMs: 120000,      // cap backoff at 2 min
  maxAttemptsBeforeWarn: 5 // emit 'stalled' after this many consecutive failures
};

class Publisher extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl           e.g. https://results.example.fi
   * @param {string} opts.apiKey            per-competition key from KX-Web
   * @param {() => object} opts.buildCompetition  returns CompetitionSync payload
   * @param {(eventId: string, phase: string) => object} opts.buildPhase  returns PhaseSync payload
   * @param {() => object} opts.buildFull   returns FullSync payload
   * @param {Partial<typeof DEFAULTS>} [opts.tuning]
   */
  constructor(opts) {
    super();
    if (!opts?.baseUrl || !opts?.apiKey) {
      throw new Error('Publisher requires baseUrl and apiKey');
    }
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.buildCompetition = opts.buildCompetition;
    this.buildPhase = opts.buildPhase;
    this.buildFull = opts.buildFull;
    this.tuning = { ...DEFAULTS, ...(opts.tuning || {}) };

    /** @type {Map<string, {endpoint: string, build: () => object, timer: NodeJS.Timeout|null}>} */
    this.pending = new Map();      // debounce timers, key = target id
    /** @type {Map<string, {endpoint: string, body: string, attempts: number}>} */
    this.queue = new Map();        // retry queue, latest snapshot per target only
    /** @type {Map<string, string>} */
    this.lastAckedHash = new Map();// target -> payload_hash acknowledged by server

    this.running = false;
    this.retryTimer = null;
    this.retryDelay = this.tuning.retryBaseMs;
  }

  start() { this.running = true; }

  async stop() {
    this.running = false;
    for (const p of this.pending.values()) {
      if (p.timer) clearTimeout(p.timer);
    }
    this.pending.clear();
    if (this.retryTimer) clearTimeout(this.retryTimer);
  }

  // ------------------------------------------------------------------
  // Public API — call these from kx-server
  // ------------------------------------------------------------------

  /** Competition metadata or event list changed. */
  publishCompetition() {
    this._schedule('competition', '/api/v1/competition', () => this.buildCompetition());
  }

  /**
   * A result/start list of a phase changed (gate judge tap, Chief of
   * Scoring edit, progression applied, status change ...).
   * Safe to call on EVERY change — debouncing handles the rate.
   * @param {string} eventId
   * @param {string} phase  TIME_TRIAL | QUALIFICATION | QUARTER_FINAL | SEMI_FINAL | FINAL | OFFICIAL_RESULT
   */
  publishPhase(eventId, phase) {
    const key = `phase:${eventId}:${phase}`;
    this._schedule(key, '/api/v1/phase', () => this.buildPhase(eventId, phase));
  }

  /** "Sync now" — full re-sync, also the disaster-recovery path. Immediate, no debounce. */
  async publishFull() {
    // A full sync supersedes everything queued
    for (const p of this.pending.values()) {
      if (p.timer) clearTimeout(p.timer);
    }
    this.pending.clear();
    this.queue.clear();
    return this._send('full', '/api/v1/full', JSON.stringify(this.buildFull()));
  }

  /** Hide a phase (or the competition) on the website. Immediate. */
  async unpublish({ eventCode, phase, scope = 'phase' }) {
    const body = JSON.stringify(
      scope === 'competition' ? { scope } : { scope, event_code: eventCode, phase }
    );
    return this._send(`unpublish:${eventCode ?? 'all'}:${phase ?? ''}`, '/api/v1/unpublish', body);
  }

  /** For the Chief of Scoring UI: sync status summary. */
  status() {
    return {
      running: this.running,
      pendingTargets: [...this.pending.keys()],
      queuedTargets: [...this.queue.entries()].map(([k, v]) => ({ target: k, attempts: v.attempts })),
      nextRetryInMs: this.retryTimer ? this.retryDelay : null
    };
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  _schedule(key, endpoint, build) {
    if (!this.running) return;
    const existing = this.pending.get(key);
    if (existing) {
      // Already scheduled within the debounce window: the build function
      // reads current DB state at fire time, so nothing else to do.
      return;
    }
    const timer = setTimeout(() => {
      this.pending.delete(key);
      let body;
      try {
        body = JSON.stringify(build());
      } catch (err) {
        this.emit('error', { target: key, stage: 'build', error: err });
        return;
      }
      this._send(key, endpoint, body).catch(() => { /* queued for retry */ });
    }, this.tuning.debounceMs);
    timer.unref?.();
    this.pending.set(key, { endpoint, build, timer });
  }

  async _send(key, endpoint, body) {
    const hash = sha256(body);
    if (this.lastAckedHash.get(key) === hash) {
      this.emit('skipped', { target: key, reason: 'unchanged' });
      return { ok: true, skipped: true };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.tuning.timeoutMs);
    timeout.unref?.();

    try {
      const res = await fetch(this.baseUrl + endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body,
        signal: controller.signal
      });

      if (res.status === 401) {
        // Wrong key: retrying is pointless. Surface loudly to the UI.
        this.queue.delete(key);
        const err = new Error('KX-Web rejected the API key (401). Check competition settings.');
        this.emit('auth-error', err);
        throw err;
      }
      if (res.status === 422 || res.status === 404) {
        // Payload/route problem: retrying the same body won't help either.
        // 404 on /phase usually means events were never pushed -> push competition first.
        this.queue.delete(key);
        const detail = await safeText(res);
        if (res.status === 404 && endpoint === '/api/v1/phase') {
          this.emit('needs-competition-sync', { target: key });
          this.publishCompetition();
          this._enqueue(key, endpoint, body); // retry the phase after competition push
          return { ok: false, requeued: true };
        }
        const err = new Error(`KX-Web ${res.status}: ${detail}`);
        this.emit('error', { target: key, stage: 'send', error: err });
        throw err;
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`); // 429/5xx -> retry path below
      }

      const data = await res.json();
      this.lastAckedHash.set(key, data.payload_hash ?? hash);
      this.queue.delete(key);
      this._resetBackoff();
      this.emit('published', { target: key, updated: data.updated });
      return data;
    } catch (err) {
      if (!this.queue.has(key) || err.name === 'AbortError' || err.cause || /HTTP (429|5\d\d)/.test(String(err.message))) {
        this._enqueue(key, endpoint, body);
      }
      this.emit('retrying', { target: key, error: String(err.message) });
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  _enqueue(key, endpoint, body) {
    const prev = this.queue.get(key);
    // Keep only the latest snapshot per target; preserve attempt count
    this.queue.set(key, { endpoint, body, attempts: (prev?.attempts ?? 0) });
    this._armRetry();
  }

  _armRetry() {
    if (this.retryTimer || !this.running) return;
    this.retryTimer = setTimeout(() => this._flushQueue(), this.retryDelay);
    this.retryTimer.unref?.();
  }

  async _flushQueue() {
    this.retryTimer = null;
    if (!this.running || this.queue.size === 0) return;

    let anyFailure = false;
    for (const [key, item] of [...this.queue.entries()]) {
      item.attempts += 1;
      try {
        // Rebuild fresh state when possible so retries carry the newest data
        const fresh = this._rebuild(key);
        await this._send(key, item.endpoint, fresh ?? item.body);
      } catch {
        anyFailure = true;
        if (item.attempts >= this.tuning.maxAttemptsBeforeWarn) {
          this.emit('stalled', { target: key, attempts: item.attempts });
        }
      }
    }

    if (anyFailure && this.queue.size > 0) {
      this.retryDelay = Math.min(this.retryDelay * 2, this.tuning.retryMaxMs);
      this._armRetry();
    } else {
      this._resetBackoff();
    }
  }

  /** Rebuild the freshest payload for a queued target, or null to reuse the stored body. */
  _rebuild(key) {
    try {
      if (key === 'competition') return JSON.stringify(this.buildCompetition());
      if (key === 'full') return JSON.stringify(this.buildFull());
      const m = key.match(/^phase:(.+):([A-Z_]+)$/);
      if (m) return JSON.stringify(this.buildPhase(m[1], m[2]));
    } catch {
      /* fall through */
    }
    return null;
  }

  _resetBackoff() {
    this.retryDelay = this.tuning.retryBaseMs;
    if (this.queue.size > 0) this._armRetry();
  }
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

async function safeText(res) {
  try { return (await res.text()).slice(0, 300); } catch { return ''; }
}

module.exports = { Publisher };
