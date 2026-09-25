// Plain-node test for the handoff state machine (npm-hub/src/handoff.js):
// the relay between one runner and the next. No network, no express - the rules
// are the whole point, so they are checked against a fake clock.
const path = require('path');
const H = require(path.join(__dirname, '..', 'npm-hub', 'src', 'handoff.js'));

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? ' got=' + JSON.stringify(extra) : '')); }
}
const MIN = 60000;

// h1: the defaults protect the runner without surprising anyone: hand over 30
// minutes before the 6h cap, after 45 idle minutes, with a 3 minute warning.
const def = H.normalizePolicy({});
check('h1 default policy', def.maxAgeMin === 330 && def.idleMin === 45 && def.countdownSec === 180, def);
check('h1 policy is clamped', H.normalizePolicy({ maxAgeMin: -5, idleMin: 99999, countdownSec: 3 }).maxAgeMin === 0 &&
  H.normalizePolicy({ maxAgeMin: -5, idleMin: 99999, countdownSec: 3 }).idleMin === 720 &&
  H.normalizePolicy({ maxAgeMin: -5, idleMin: 99999, countdownSec: 3 }).countdownSec === 30);

// h2: nothing happens while the user is within both limits.
let t = 1000 * MIN;
const mk = (policy, startedAt) => H.createHandoff({ startedAtMs: startedAt, policy, now: () => t });
let h = mk({ maxAgeMin: 100, idleMin: 30 }, t);
check('h2 quiet before the limits', h.tick() === null && h.state === 'idle');
h.noteActivity(t);
t += 10 * MIN;
check('h2 activity keeps it alive', h.tick() === null, h.status());

// h3: idle too long -> save first, never a shutdown straight away.
t += 25 * MIN; // 35 min since the last activity
const save = h.tick();
check('h3 idle triggers a save', save && save.type === 'save' && save.reason === 'idle', save);
check('h3 state is saving', h.state === 'saving');
check('h3 a save is requested again', h.tick() === null);

// h4: a FAILED save must not lead to a shutdown - the runner stays alive and
// the error is reported, with a retry later.
const failed = h.saveFail(new Error('push failed'), t);
check('h4 save failure is visible', failed.state === 'failed' && /push failed/.test(failed.lastError), failed);
check('h4 no dispatch after a failed save', h.tick() === null);
check('h4 nothing happens before the retry', (t += 2 * MIN, h.tick() === null));
t += 4 * MIN; // past retryMin
const retry = h.tick();
check('h4 the save is retried', retry && retry.type === 'save' && retry.attempt === 2, retry);

// h5: a good save arms the countdown, and the countdown is a warning, not a
// silent kill.
h.saveOk(t);
check('h5 countdown armed', h.state === 'countdown' && h.status().leftSec === 180, h.status());
t += 179000;
check('h5 still counting', h.tick() === null && h.status().leftSec === 1);
t += 2000;
const dispatch = h.tick();
check('h5 countdown zero dispatches', dispatch && dispatch.type === 'dispatch', dispatch);
check('h5 state is dispatching', h.state === 'dispatching');

// h6: "Продолжить" cancels the countdown and the runner keeps running.
h = mk({ maxAgeMin: 10, idleMin: 0 }, t);
h.request('manual', t);
h.saveOk(t);
const cancelled = h.continueWork(t + 5000);
check('h6 continue cancels', cancelled.cancelled && h.state === 'idle' && h.status().cancelledBy === 'user', h.status());
t += 60 * MIN;
const afterContinue = h.tick();
check('h6 no dispatch after continue', afterContinue === null || afterContinue.type === 'save', afterContinue);

// h7: real activity also cancels - nobody gets shut off mid-task.
h = mk({ maxAgeMin: 10, idleMin: 0 }, t);
h.request('manual', t);
h.saveOk(t);
h.noteActivity(t + 1000);
check('h7 activity cancels the countdown', h.state === 'idle' && h.status().cancelledBy === 'activity', h.status());

// h8: the age limit fires even while the user is active.
t = 0;
h = H.createHandoff({ startedAtMs: 0, policy: { maxAgeMin: 60, idleMin: 600 }, now: () => t });
t = 59 * MIN;
h.noteActivity(t);
check('h8 nothing at 59 min', h.tick() === null);
t = 60 * MIN;
const ageSave = h.tick();
check('h8 age limit fires', ageSave && ageSave.reason === 'age', ageSave);

// h9: a failed dispatch keeps the runner alive too.
h.saveOk(t);
t += 180000;
h.tick(); // -> dispatching
h.dispatchFail(new Error('no token'), t);
check('h9 failed dispatch stays alive', h.state === 'failed' && /no token/.test(h.status().lastError), h.status());
check('h9 no stop after a failed dispatch', h.tick() === null);

// h10: the old runner only stops once the NEW runner has published itself.
t += 6 * MIN; // past retryMin -> re-save
h.tick();
h.saveOk(t);
t += 180000;
h.tick();
h.dispatchOk({ runId: '999', url: 'https://next.example' }, t);
check('h10 waiting for the successor', h.state === 'standby' && h.status().successor.runId === '999', h.status());
t += 11 * MIN;
check('h10 no stop while waiting', h.tick() === null);
t += 2 * MIN; // past standbyMin
h.tick();
check('h10 a missing successor keeps the runner', h.state === 'failed' && /не поднялся/.test(h.status().lastError), h.status());

t += 6 * MIN;
h.tick();
h.saveOk(t);
t += 180000;
h.tick();
h.dispatchOk({ runId: '1001', url: 'https://next2.example' }, t);
h.successorSeen('1001', 'https://next2.example', t);
check('h11 successor seen means stop', h.state === 'stopping', h.status());

// h12: turning the limits off while a countdown runs cancels it.
h = mk({ maxAgeMin: 10, idleMin: 5 }, 0);
h.request('manual', 0);
h.saveOk(0);
check('h12 countdown running', h.state === 'countdown');
h.setPolicy({ maxAgeMin: 0, idleMin: 0 });
check('h12 disabling the policy cancels', h.state === 'idle' && h.status().cancelledBy === 'policy', h.status());
check('h12 disabled means no work', h.isEnabled() === false && h.tick() === null);

// h13: the UI needs an absolute deadline to render a countdown.
h = mk({ maxAgeMin: 100, idleMin: 30 }, t);
h.request('manual', t);
h.saveOk(t);
const st = h.status(t + 5000);
check('h13 deadline is absolute', st.deadlineAt === t + 180000 && st.leftSec === 175, st);

console.log(`HANDOFF: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
