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
// minutes before the 6h cap, after 45 idle minutes, with a 3 minute warning -
// but only when the user ticked "автопередача". The switch is off by default:
// a hub nobody is using must not keep buying itself successors.
const def = H.normalizePolicy({});
check('h1 default policy', def.maxAgeMin === 330 && def.idleMin === 45 && def.countdownSec === 180, def);
check('h1 automatic relay is off by default', def.auto === 0 && H.createHandoff({}).isEnabled() === false, def);
check('h1 policy is clamped', H.normalizePolicy({ maxAgeMin: -5, idleMin: 99999, countdownSec: 3 }).maxAgeMin === 0 &&
  H.normalizePolicy({ maxAgeMin: -5, idleMin: 99999, countdownSec: 3 }).idleMin === 720 &&
  H.normalizePolicy({ maxAgeMin: -5, idleMin: 99999, countdownSec: 3 }).countdownSec === 30);

// h2: nothing happens while the user is within both limits.
let t = 1000 * MIN;
const mk = (policy, startedAt) => H.createHandoff({ startedAtMs: startedAt, policy, now: () => t });
let h = mk({ auto: true, maxAgeMin: 100, idleMin: 30 }, t);
check('h2 quiet before the limits', h.tick() === null && h.state === 'idle');
h.noteActivity(t);
t += 10 * MIN;
check('h2 activity keeps it alive', h.tick() === null, h.status());

// h3: the age limit fires for a session someone is actually using - and it
// saves first, never a shutdown straight away.
h = mk({ auto: true, maxAgeMin: 100, idleMin: 30 }, t - 100 * MIN);
h.noteActivity(t);
t += 5 * MIN; // still inside the 30 min activity window
const save = h.tick();
check('h3 age triggers a save', save && save.type === 'save' && save.reason === 'age', save);
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
h = mk({ auto: true, maxAgeMin: 10, idleMin: 0 }, t);
h.request('manual', t);
h.saveOk(t);
const cancelled = h.continueWork(t + 5000);
check('h6 continue cancels', cancelled.cancelled && h.state === 'idle' && h.status().cancelledBy === 'user', h.status());
t += 60 * MIN;
const afterContinue = h.tick();
check('h6 no dispatch after continue', afterContinue === null || afterContinue.type === 'save', afterContinue);

// h7: real activity also cancels - nobody gets shut off mid-task.
h = mk({ auto: true, maxAgeMin: 10, idleMin: 0 }, t);
h.request('manual', t);
h.saveOk(t);
h.noteActivity(t + 1000);
check('h7 activity cancels the countdown', h.state === 'idle' && h.status().cancelledBy === 'activity', h.status());

// h8: the age limit fires even while the user is active.
t = 0;
h = H.createHandoff({ startedAtMs: 0, policy: { auto: true, maxAgeMin: 60, idleMin: 600 }, now: () => t });
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
h = mk({ auto: true, maxAgeMin: 10, idleMin: 5 }, 0);
h.request('manual', 0);
h.saveOk(0);
check('h12 countdown running', h.state === 'countdown');
h.setPolicy({ auto: false, maxAgeMin: 10, idleMin: 5 });
check('h12 disabling the policy cancels', h.state === 'idle' && h.status().cancelledBy === 'policy', h.status());
check('h12 disabled means no work', h.isEnabled() === false && h.tick() === null);

// h13: the UI needs an absolute deadline to render a countdown.
h = mk({ auto: true, maxAgeMin: 100, idleMin: 30 }, t);
h.request('manual', t);
h.saveOk(t);
const st = h.status(t + 5000);
check('h13 deadline is absolute', st.deadlineAt === t + 180000 && st.leftSec === 175, st);

// h14: THE POINT OF THE WHOLE CHANGE. With the switch off, a hub nobody is
// using never dispatches a successor - not when it goes idle, not when it
// grows old. Measured 2026-10-02: idleMin 45 meant a forgotten hub handed
// itself to a fresh runner every 45 minutes, all day, with nobody pressing
// anything (44 dispatches in three days).
t = 0;
h = H.createHandoff({ startedAtMs: 0, policy: { auto: false, maxAgeMin: 330, idleMin: 45 }, now: () => t });
t = 8 * 60 * MIN; // eight hours old, eight hours idle
check('h14 old and idle, auto off: nothing', h.tick() === null && h.state === 'idle', h.status());
check('h14 status says the relay is off', h.isEnabled() === false && h.status().auto === false, h.status());
t = 24 * 60 * MIN;
check('h14 still nothing a whole day later', h.tick() === null, h.status());

// h15: a policy saved before the switch existed normalises to OFF, so the old
// idle relay cannot be resurrected by the file on session-state.
const legacy = H.normalizePolicy({ maxAgeMin: 330, idleMin: 45, countdownSec: 180, standbyMin: 12, retryMin: 5 });
check('h15 legacy policy has no auto', legacy.auto === 0, legacy);
t = 0;
h = H.createHandoff({ startedAtMs: 0, policy: legacy, now: () => t });
t = 400 * MIN;
check('h15 legacy policy stays quiet', h.tick() === null && h.isEnabled() === false, h.status());

// h16: with the switch ON, a session in use still gets rescued before the 6h
// cap - the feature exists, it just has to be asked for.
t = 0;
h = H.createHandoff({ startedAtMs: 0, policy: { auto: true, maxAgeMin: 330, idleMin: 45 }, now: () => t });
t = 340 * MIN;
h.noteActivity(t);
const autoSave = h.tick();
check('h16 auto on + in use hands over', autoSave && autoSave.reason === 'age', autoSave);

// h17: with the switch ON but nobody working, there is nothing to rescue: the
// runner is left to the 6h cap instead of paying for a successor that would
// only do the same again.
t = 0;
h = H.createHandoff({ startedAtMs: 0, policy: { auto: true, maxAgeMin: 330, idleMin: 45 }, now: () => t });
t = 340 * MIN; // old, but activity was at 0
check('h17 auto on but idle: no successor', h.tick() === null && h.state === 'idle', h.status());

// h18: the button keeps working with the switch off - that is the whole point
// of "nothing happens without a press".
t = 0;
h = H.createHandoff({ startedAtMs: 0, policy: {}, now: () => t });
const manual = h.request('manual', t);
check('h18 manual handover works', manual && manual.type === 'save' && manual.reason === 'manual', manual);
h.saveOk(t);
t += 180000;
check('h18 manual handover dispatches', (h.tick() || {}).type === 'dispatch', h.status());

// h19: un-ticking mid-countdown stops the pending handover.
t = 0;
h = H.createHandoff({ startedAtMs: 0, policy: { auto: true, maxAgeMin: 10, idleMin: 45 }, now: () => t });
h.request('manual', t);
h.saveOk(t);
h.setPolicy({ auto: false, maxAgeMin: 10, idleMin: 45 });
check('h19 auto off cancels a pending handover', h.state === 'idle' && h.status().cancelledBy === 'policy', h.status());
t += 200000;
check('h19 nothing is dispatched after that', h.tick() === null);

console.log(`HANDOFF: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
