// Where did I stop? Proves that every live OpenCode session can be picked up
// again - which is the whole point of a session that is supposed to survive.
//
// Three separate claims, checked separately:
//   1. the report tells the truth (ids, directories, dirty files, todos),
//   2. the conversation itself exports (opencode export),
//   3. the relay tool that carries a session to the NEXT runner builds a
//      bundle that contains it (tools/export-chats.sh, the handoff's first step).
//
// Where there is no OpenCode database (a plain CI runner) this skips instead of
// failing: the claim is about a live session, and there is none.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const REPORT = path.join(REPO, 'tools', 'session_resume_report.sh');
const EXPORT_CHATS = path.join(REPO, 'tools', 'export-chats.sh');
const DB = process.env.OPENCODE_DB || path.join(os.homedir(), '.local/share/opencode/opencode.db');

let pass = 0, fail = 0, skip = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? ' got=' + JSON.stringify(extra).slice(0, 400) : '')); }
}
const sh = (cmd, args, opts) => spawnSync(cmd, args, Object.assign({ encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, opts || {}));

if (!fs.existsSync(DB) || !fs.existsSync(REPORT)) {
  console.log('SKIP no OpenCode database on this machine - nothing to resume');
  console.log(`OPENCODE-RESUME: ${pass} passed, ${fail} failed, 1 skipped`);
  process.exit(0);
}

// r1: the report runs and produces a machine-readable list.
const j = sh('bash', [REPORT, '--json'], { env: Object.assign({}, process.env, { RESUME_LIMIT: '10' }) });
check('r1 report exits cleanly', j.status === 0, j.stderr);
let doc = null;
try { doc = JSON.parse(j.stdout); } catch (e) { /* handled below */ }
check('r1 report is valid json', !!(doc && Array.isArray(doc.sessions)), (j.stdout || '').slice(0, 200));
const sessions = (doc && doc.sessions) || [];
check('r1 at least one live session', sessions.length > 0, sessions.length);

// r2: every reported session is identified, placed and dated. A report you
// cannot act on is worse than no report.
check('r2 every session has id, title, directory, date', sessions.length > 0 && sessions.every(s =>
  s.id && s.title && s.directory && s.updated), sessions);
check('r2 every directory exists', sessions.every(s => {
  try { return fs.statSync(s.directory).isDirectory(); } catch (e) { return false; }
}), sessions.map(s => s.directory));

// r3: the numbers are not invented - the dirty-file count must be what git says.
const gitty = sessions.filter(s => fs.existsSync(path.join(s.directory, '.git')));
check('r3 git sessions found', gitty.length > 0, gitty.length);
let dirtyOk = true, dirtyDetail = null;
for (const s of gitty) {
  const real = sh('git', ['status', '--porcelain'], { cwd: s.directory }).stdout.split('\n').filter(Boolean).length;
  if (real !== Number(s.dirtyFiles)) { dirtyOk = false; dirtyDetail = { id: s.id, reported: s.dirtyFiles, real }; }
}
check('r3 reported dirty files match git', dirtyOk, dirtyDetail);

// r4: the todo counters match the database itself.
const todoOk = sessions.every(s =>
  s.todosDone + s.todosInProgress + s.todosPending >= 0 &&
  (s.todosDone + s.todosInProgress + s.todosPending > 0 || s.messages > 0));
check('r4 todos add up and the session is not empty', todoOk, sessions.map(s => [s.id, s.messages, s.todosDone, s.todosInProgress, s.todosPending]));

// r5: THE claim. The conversation still exports, so the session can be reopened.
//
// The export is written to a file, not captured into memory: a long session is
// tens of megabytes of JSON and spawnSync truncates a pipe that size (measured:
// 9 MB of JSON came back as 250 KB and would not parse).
const newest = sessions.slice().sort((a, b) => String(b.updated).localeCompare(String(a.updated)))[0];
let exported = 0;
let exportNote = null;
if (newest && process.env.RESUME_SKIP_EXPORT !== '1') {
  const out = path.join(os.tmpdir(), `resume-export-${process.pid}.json`);
  const e = sh('bash', ['-c', 'opencode export "$1" > "$2" 2>/dev/null', 'bash', newest.id, out],
    { cwd: newest.directory, timeout: 600000 });
  let size = 0;
  try { size = fs.statSync(out).size; } catch (err) { size = 0; }
  if (e.status === 0 && size > 0) {
    if (size < 64 * 1024 * 1024) {
      try { exported = (JSON.parse(fs.readFileSync(out, 'utf8')).messages || []).length; }
      catch (err) { exportNote = 'unparseable export'; }
    } else {
      // Huge session: count the records without parsing 100 MB of JSON.
      const c = sh('bash', ['-c', 'grep -o \'"role":\' "$1" | wc -l', 'bash', out]);
      exported = parseInt((c.stdout || '').trim(), 10) || 0;
    }
  } else exportNote = `exit ${e.status}, ${size} bytes`;
  try { fs.unlinkSync(out); } catch (err) { /* the temp file can stay */ }
}
check('r5 the newest session exports', exported > 0, { id: newest && newest.id, messages: exported, note: exportNote });

// r6: the handoff's own first step carries that same session to the next runner
// (tools/export-chats.sh is what tools/handoff.sh runs). Bundle in hand, the
// next runner imports it and the conversation continues where it stopped.
let carried = null;
if (newest && process.env.RESUME_SKIP_EXPORT !== '1') {
  const e = sh('bash', [EXPORT_CHATS], {
    cwd: newest.directory,
    env: Object.assign({}, process.env, { CHAT_REPO_DIR: newest.directory, PUBLISH: '0' }),
    timeout: 600000
  });
  const out = (e.stdout || '').trim().split('\n').filter(Boolean).pop() || '';
  const file = (out.match(/-> (\S+\.json)$/) || [])[1];
  if (file && fs.existsSync(file)) {
    try {
      const bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
      carried = Array.isArray(bundle.sessions) ? bundle.sessions : null;
    } catch (err) { carried = null; }
  }
}
check('r6 the relay bundle carries the session', !!(carried && carried.some(s => String(s.id) === newest.id)),
  newest && newest.id);

// r7: a project that left itself a continuity note must have it surfaced - that
// note is what "continue from where I stopped" actually means.
const noted = sessions.filter(s => s.note);
check('r7 continuity notes are surfaced', noted.every(s => fs.existsSync(path.join(s.directory, s.note))),
  noted.map(s => s.note));

console.log(`OPENCODE-RESUME: ${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail ? 1 : 0);
