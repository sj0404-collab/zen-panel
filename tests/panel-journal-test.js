// Runner journal in the APK panel (app/src/main/assets/panel/index.html).
//
// What the panel showed before: only runs that were still live, and no
// timeline - so the moment a session finished, the whole record of what
// happened on the runner disappeared, and there was no way to answer "what
// ran after what, and what did those twenty minutes go to".
//
// The journal keeps finished runs, merges every step of every job into one
// list ordered by start time, and names the gaps in between (queue time, a
// self-hosted runner still being claimed) - those gaps are exactly what you
// cannot see in the Actions UI.
//
// Source invariants: the panel is one inlined <script>, and driving it would
// need the full jsdom stack. TESTING.md T-55..T-58 is the live check.
const fs = require('fs');
const path = require('path');

const panel = fs.readFileSync(path.join(__dirname, '..', 'app', 'src', 'main', 'assets', 'panel', 'index.html'), 'utf8');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? ' got=' + JSON.stringify(extra).slice(0, 200) : '')); }
}

// ── the card exists and is reachable from the Actions page ──
check('j1 the journal card is on the Actions page',
  /<div class="page" id="p-act">[\s\S]*?Журнал раннера/.test(panel));
check('j2 it has a timeline container and a collapse button',
  /id="runner-journal"/.test(panel) && /id="runner-journal-btn"/.test(panel) && /onclick="toggleJournal\(\)"/.test(panel));
check('j3 the last-refresh line is there',
  /id="watch-meta"/.test(panel) && /обновлено/.test(panel));

// ── finished runs stay in the journal ──
check('j4 finished runs are kept, not dropped',
  /const done = mine\.filter\(r => r\.status === 'completed'\)\.slice\(0, JOURNAL_DONE_LIMIT\)/.test(panel));
check('j5 the card only hides when there is nothing at all',
  /if \(!live\.length && !done\.length\)/.test(panel) &&
  !/if \(!live\.length\) \{\s*\n\s*card\.style\.display = 'none';\s*\n\s*box\.innerHTML = '';/.test(panel));
check('j6 a finished run shows its conclusion and title',
  /conclusionPill\(r\.conclusion, r\.status\)/.test(panel) && /r\.display_title/.test(panel));

// ── the timeline: what ran after what ──
check('j7 every step of every job is collected',
  /for \(const st of j\.steps \|\| \[\]\) if \(st\.started_at\) events\.push/.test(panel));
check('j8 the timeline is ordered by start time',
  /events\.sort\(\(a, b\) => new Date\(a\.started_at\) - new Date\(b\.started_at\)\)/.test(panel));
check('j9 each row shows clock time, icon, step, job and duration',
  /clockOf\(e\.started_at\)/.test(panel) && /esc\(e\.name\)/.test(panel) && /esc\(e\.job\)/.test(panel) && /fmtSecs\(dur\)/.test(panel));
check('j10 idle gaps are named instead of being invisible',
  /start - prevEnd > 20000/.test(panel) && /простой \$\{fmtSecs/.test(panel));

// ── durations must not lie about finished work ──
check('j11 a finished job is measured to its real end, not to now',
  /function runSecs\(j, r\)/.test(panel) &&
  /j\.completed_at \|\| r\.updated_at \|\| r\.run_started_at/.test(panel) &&
  /j\.status === 'in_progress' \|\| r\.status !== 'completed'/.test(panel));
check('j12 the old now-based elapsed is gone',
  !/const elapsed = j\.started_at\s*\n\s*\? Math\.round\(\(Date\.now\(\) - new Date\(j\.started_at\)\.getTime\(\)\) \/ 1000\) : 0;/.test(panel));

// ── auto-refresh ──
check('j13 it still refreshes on its own',
  /watchTimer = setInterval/.test(panel) && /!watchPaused && page === 'act' && !document\.hidden/.test(panel));
check('j14 pause still stops it and the meta line says so',
  /function toggleWatch\(\)/.test(panel) && /· на паузе/.test(panel) && /автообновление каждые 8 с/.test(panel));
check('j15 the 403 backoff is preserved',
  /function pauseWatchOn403\(e\)/.test(panel) && /pauseWatchOn403\(e\); return;/.test(panel));

// ── the rate limit is not spent on logs that cannot change ──
check('j16 finished runs are fetched once and cached',
  /let runnerJournalDone = new Map\(\)/.test(panel) && /runnerJournalDone\.set\(r\.id, d\)/.test(panel));
check('j17 their steps load on expand, not on every poll',
  /onToggle="loadDoneSteps\(\$\{r\.id\}, this\)"/.test(panel) &&
  /async function loadDoneSteps\(runId, det\)/.test(panel) &&
  /if \(!det \|\| !det\.open \|\| runnerJournalDone\.has\(runId\)\) return;/.test(panel));
check('j18 the number of kept finished runs is bounded',
  /const JOURNAL_DONE_LIMIT = \d+;/.test(panel));

// ── the id clash that was nearly shipped ──
// #journal already belongs to the "Журнал запусков" card (renderRunJournal).
// The timeline must not touch it, or it would overwrite the run diary.
check('j19 the timeline writes to its own #runner-journal',
  /function renderJournal\(events\) \{\s*\r?\n\s*const box = \$\('runner-journal'\);/.test(panel));
check('j20 the run diary keeps #journal',
  /function renderRunJournal\(runs\) \{[\s\S]{0,80}?const box = \$\('journal'\);/.test(panel));
check('j21 #journal is still declared exactly once',
  (panel.match(/id="journal"/g) || []).length === 1 &&
  (panel.match(/id="runner-journal"/g) || []).length === 1);
check('j22 no leftover half-renamed identifiers',
  !/\bjournalOpen\b/.test(panel) && !/\bjournalDone\b/.test(panel));

// ── the workflows worth watching, including the ones that were missing ──
check('j23 NPM Hub and the APK builds are watched',
  /'Build NPM Hub APK'/.test(panel) && /'NPM Hub'/.test(panel) && /'Build Zen Panel APK'/.test(panel) && /'JS syntax'/.test(panel));

// ── TESTING.md keeps its own promises: stable, unique IDs ──
// The journal checks were numbered into a section that already had IDs, and a
// careless shift left two sections sharing T-80..T-83 - a plan whose IDs
// silently point at the wrong test is worse than no plan.
const plan = fs.readFileSync(path.join(__dirname, '..', 'TESTING.md'), 'utf8');
const tIds = [...plan.matchAll(/^\|\s*(T-\d+)\s*\|/gm)].map(m => m[1]);
const fIds = [...plan.matchAll(/^\|\s*(F-\d+)\s*\|/gm)].map(m => m[1]);
check('j24 every check ID is unique',
  new Set(tIds).size === tIds.length,
  tIds.filter((x, i) => tIds.indexOf(x) !== i));
check('j25 check IDs only grow as the plan goes down',
  tIds.every((id, i) => i === 0 || Number(id.slice(2)) > Number(tIds[i - 1].slice(2))));
check('j26 every finding ID is unique', new Set(fIds).size === fIds.length);
check('j27 the journal checks are in the plan',
  /T-57…T-61 \(журнал раннера/.test(plan));
check('j28 the plan mentions the replay checks that matter',
  /T-51…T-54/.test(plan) || /T-50…T-56/.test(plan));

console.log(`PANEL-JOURNAL: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
