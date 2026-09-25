'use strict';
// ─── Эстафетная передача сессии (handoff) ───────────────────────────────────
// WHAT
//   A GitHub-hosted runner dies at its cap (6h) with everything on its disk
//   gone. This module is the brain of the relay: it watches the two limits the
//   user set (session age and idle time), saves first, warns with a countdown,
//   and only then lets the next runner take over. It never touches the disk or
//   the network itself - the server performs the actions it returns - so every
//   rule below is unit-testable without a runner.
//
// THE ORDER MATTERS (measured the hard way)
//   1. a limit fires                        -> state 'saving'
//   2. the durable save must SUCCEED        -> 'countdown' (3 minutes)
//      a failed save leaves the runner ALIVE: no push, no shutdown, retry later
//   3. during the countdown "Продолжить" (or any real activity) cancels it
//   4. countdown zero                       -> 'dispatching'
//   5. the new runner must actually publish itself; if it never does the old
//      runner stays alive instead of leaving the user with no session at all
//   6. successor seen                       -> 'stopping'
//
// POLICY (persisted globally, see /api/handoff/policy)
//   maxAgeMin    0 = never; otherwise hand off N minutes after the run started
//   idleMin      0 = never; otherwise hand off after N minutes without activity
//   countdownSec how long the user has to press "Продолжить"

const DEFAULTS = {
  maxAgeMin: 330,      // 30 min before the 6h cap kills the runner
  idleMin: 45,         // nothing at all for 45 min -> hand the work over
  countdownSec: 180,   // 3 minutes, as asked for
  standbyMin: 12,      // wait this long for the successor to show up
  retryMin: 5          // after a failed save, try again in this many minutes
};

const LIMITS = {
  maxAgeMin: { min: 0, max: 720 },
  idleMin: { min: 0, max: 720 },
  countdownSec: { min: 30, max: 1800 },
  standbyMin: { min: 1, max: 60 },
  retryMin: { min: 1, max: 120 }
};

const asInt = (v, fallback) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
};

function normalizePolicy(input) {
  const src = (input && typeof input === 'object') ? input : {};
  const out = {};
  for (const key of Object.keys(DEFAULTS)) {
    const lim = LIMITS[key];
    let n = asInt(src[key], DEFAULTS[key]);
    if (n < lim.min) n = lim.min;
    if (n > lim.max) n = lim.max;
    out[key] = n;
  }
  return out;
}

const IDLE = 'idle';
const SAVING = 'saving';
const COUNTDOWN = 'countdown';
const DISPATCHING = 'dispatching';
const STANDBY = 'standby';
const STOPPING = 'stopping';
const FAILED = 'failed';

function createHandoff(options) {
  const opts = options || {};
  const now = () => (typeof opts.now === 'function' ? opts.now() : Date.now());
  const startedAtMs = asInt(opts.startedAtMs, 0) || now();
  let policy = normalizePolicy(opts.policy);
  let state = IDLE;
  let reason = '';          // 'age' | 'idle' | 'manual' | ''
  let activityAt = now();
  let saveStartedAt = 0;
  let savedAt = 0;
  let deadlineAt = 0;       // countdown zero
  let successorAt = 0;      // give up waiting for the new runner
  let retryAt = 0;
  let lastError = '';
  let cancelledBy = '';
  let successor = null;     // { runId, url } once dispatch succeeded
  let attempts = 0;

  const policyOn = () => policy.maxAgeMin > 0 || policy.idleMin > 0;

  // A limit fired, or the user pressed the button. Only ever leaves 'idle'.
  const begin = (why, ts) => {
    if (state !== IDLE && state !== FAILED) return null;
    if (state === FAILED && ts < retryAt) return null;
    state = SAVING;
    reason = why;
    lastError = '';
    cancelledBy = '';
    retryAt = 0;
    saveStartedAt = ts;
    attempts++;
    return { type: 'save', reason: why, attempt: attempts };
  };

  const api = {
    get state() { return state; },
    get policy() { return { ...policy }; },
    isEnabled: () => policyOn(),
    setPolicy(input) {
      policy = normalizePolicy(input);
      // Turning both limits off while a handoff is pending must stop it.
      if (!policyOn() && state !== IDLE && state !== STOPPING) {
        state = IDLE;
        reason = '';
        deadlineAt = 0;
        successorAt = 0;
        lastError = '';
        cancelledBy = 'policy';
      }
      return api.policy;
    },
    // Any real work by the user: typing in a terminal, uploading, installing.
    // It resets the idle clock and cancels a running countdown - a user who is
    // clearly still working must not be shut off mid-task.
    noteActivity(ts) {
      const t = asInt(ts, now());
      activityAt = t;
      if (state === COUNTDOWN || state === FAILED) {
        state = IDLE;
        reason = '';
        deadlineAt = 0;
        retryAt = 0;
        cancelledBy = 'activity';
      }
      return api.status(t);
    },
    // "Продолжить" from the UI.
    continueWork(ts) {
      const t = asInt(ts, now());
      activityAt = t;
      if (state === COUNTDOWN || state === FAILED) {
        state = IDLE;
        reason = '';
        deadlineAt = 0;
        retryAt = 0;
        cancelledBy = 'user';
        return { cancelled: true, status: api.status(t) };
      }
      return { cancelled: false, status: api.status(t) };
    },
    // "Передать сессию сейчас" from the UI.
    request(why, ts) {
      const t = asInt(ts, now());
      const action = begin(why || 'manual', t);
      return action || { type: null, status: api.status(t) };
    },
    // The durable save finished. Failure keeps the runner alive on purpose.
    saveOk(ts) {
      const t = asInt(ts, now());
      if (state !== SAVING) return api.status(t);
      state = COUNTDOWN;
      savedAt = t;
      lastError = '';
      deadlineAt = t + policy.countdownSec * 1000;
      return api.status(t);
    },
    saveFail(error, ts) {
      const t = asInt(ts, now());
      state = FAILED;
      lastError = String((error && error.message) || error || 'сохранение не удалось');
      retryAt = t + policy.retryMin * 60000;
      return api.status(t);
    },
    // The replacement run was launched.
    dispatchOk(info, ts) {
      const t = asInt(ts, now());
      if (state !== DISPATCHING) return api.status(t);
      state = STANDBY;
      lastError = '';
      successor = {
        runId: String((info && info.runId) || ''),
        url: String((info && info.url) || '')
      };
      successorAt = t + policy.standbyMin * 60000;
      return api.status(t);
    },
    dispatchFail(error, ts) {
      const t = asInt(ts, now());
      state = FAILED;
      lastError = 'запуск следующего раннера не удался: ' + String((error && error.message) || error || 'неизвестно');
      retryAt = t + policy.retryMin * 60000;
      return api.status(t);
    },
    // The new runner published itself: the old one may finally go away.
    successorSeen(runId, url, ts) {
      const t = asInt(ts, now());
      if (state !== STANDBY) return api.status(t);
      successor = { runId: String(runId || (successor && successor.runId) || ''), url: String(url || (successor && successor.url) || '') };
      state = STOPPING;
      lastError = '';
      return api.status(t);
    },
    tick(ts) {
      const t = asInt(ts, now());
      if (state === IDLE) {
        if (!policyOn()) return null;
        const ageMin = (t - startedAtMs) / 60000;
        if (policy.maxAgeMin > 0 && ageMin >= policy.maxAgeMin) return begin('age', t);
        if (policy.idleMin > 0 && (t - activityAt) / 60000 >= policy.idleMin) return begin('idle', t);
        return null;
      }
      if (state === FAILED) {
        if (policyOn() && t >= retryAt) return begin(reason || 'retry', t);
        return null;
      }
      if (state === COUNTDOWN) {
        if (t >= deadlineAt) {
          state = DISPATCHING;
          return { type: 'dispatch', reason, deadlineAt };
        }
        return null;
      }
      if (state === STANDBY) {
        if (t >= successorAt) {
          state = FAILED;
          lastError = 'новый раннер не поднялся за ' + policy.standbyMin + ' мин — остаёмся на этом';
          retryAt = t + policy.retryMin * 60000;
          return { type: 'publish' };
        }
        return null;
      }
      return null;
    },
    status(ts) {
      const t = asInt(ts, now());
      const leftSec = state === COUNTDOWN
        ? Math.max(0, Math.round((deadlineAt - t) / 1000))
        : state === DISPATCHING || state === STOPPING ? 0
          : state === SAVING ? null
            : state === STANDBY ? Math.max(0, Math.round((successorAt - t) / 1000)) : null;
      return {
        state,
        reason,
        enabled: policyOn(),
        policy: { ...policy },
        ageMin: Math.max(0, Math.round((t - startedAtMs) / 60000)),
        idleMin: policy.idleMin > 0 ? Math.max(0, Math.round((t - activityAt) / 60000)) : 0,
        deadlineAt: deadlineAt || null,
        leftSec,
        retryAt: state === FAILED ? retryAt || null : null,
        saveStartedAt: saveStartedAt || null,
        savedAt: savedAt || null,
        successorAt: successor ? successorAt || null : null,
        successor: successor ? { ...successor } : null,
        lastError: lastError || '',
        cancelledBy: cancelledBy || '',
        attempts
      };
    }
  };
  return api;
}

module.exports = { createHandoff, normalizePolicy, DEFAULTS, LIMITS, STATES: { IDLE, SAVING, COUNTDOWN, DISPATCHING, STANDBY, STOPPING, FAILED } };
