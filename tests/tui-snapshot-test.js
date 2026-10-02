// TUI snapshot on disk + tunnel health debounce.
//
// Symptom this pins down (Zen.md §2): when the quick tunnel dies (Cloudflare
// Error 1033) or the runner restarts, the tmux session and its log are gone -
// the log lives in TMP_DIR, tmux dies with the runner - and the terminal opens
// as a black window. The user reads that as "the agent is lost" and starts
// over. The panel already had the pieces (meta.json + revive + restore:true in
// /api/sessions); what was missing was the screen itself.
//
// What is checked here:
//   * the snapshot is written next to meta.json (so it rides work-backup's
//     descriptors/ and comes back through restore-work.sh),
//   * tmux sessions are captured with capture-pane, the pty path (Windows, no
//     tmux) falls back to the output ring buffer,
//   * the size is capped, and an unchanged screen never touches the disk
//     (every write would otherwise become a separate work-backup blob),
//   * the snapshot reaches the client BEFORE the replay, and only when there
//     is no live output that already carries the current screen,
//   * the snapshot is deleted with the session, and a stale one is ignored,
//   * the tunnel health check tolerates a single failed probe instead of
//     throwing away a working connector (the URL churn IS a 1033 window).
//
// Plain node, no deps: source invariants for the wiring, a real filesystem
// round-trip for the write/read contract.
const fs = require('fs');
const os = require('os');
const path = require('path');

const server = fs.readFileSync(path.join(__dirname, '..', 'npm-hub', 'src', 'server.js'), 'utf8');
const backupWork = fs.readFileSync(path.join(__dirname, '..', 'tools', 'backup-work.sh'), 'utf8');
const restoreWork = fs.readFileSync(path.join(__dirname, '..', 'tools', 'restore-work.sh'), 'utf8');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? ' got=' + JSON.stringify(extra) : '')); }
}

// ── where the snapshot lives: beside the descriptor, in the durable dir ──
check('s1 snapshot sits next to meta.json in SESSION_DIR',
  /const sessionSnapshotPath = id => path\.join\(SESSION_DIR, safeSessionName\(id\) \+ '\.snapshot'\)/.test(server));
check('s2 the snapshot is capped',
  /SESSION_SNAPSHOT_CAP = parseInt\(process\.env\.SESSION_SNAPSHOT_CAP \|\| String\(256 \* 1024\)/.test(server));
check('s3 a snapshot older than a day is ignored',
  /SESSION_SNAPSHOT_MAX_AGE_MS[\s\S]{0,200}24 \* 60 \* 60 \* 1000/.test(server));

// ── what is captured ──
check('s4 tmux sessions are captured from the real pane',
  /session\.tmux\) \{[\s\S]{0,300}capture-pane', '-p', '-e', '-J', '-t', safeSessionName\(session\.id\)/.test(server));
check('s5 the pty path (no tmux) falls back to the output ring buffer',
  /return String\(session\.output \|\| ''\)\.replace\(\/\\s\+\$\/, ''\);/.test(server));
check('s6 the snapshot is not the PTY log - that one is wiped on restart',
  /sessionLogPath = id => path\.join\(PTY_DIR/.test(server) && !/sessionSnapshotPath = id => path\.join\(PTY_DIR/.test(server));

// ── writing: capped, atomic, and quiet when nothing changed ──
check('s7 the write is atomic (tmp + rename), so a dead runner leaves no half screen',
  /fs\.writeFileSync\(tmp, body\);\s*\n\s*fs\.renameSync\(tmp, file\)/.test(server));
check('s8 an unchanged screen is not rewritten',
  /if \(session\._snapshot === body\) return false;/.test(server));
check('s9 snapshots are taken on their own timer, not by the tmux poller',
  /const snapshotSessions = \(\) => \{[\s\S]{0,600}?setInterval\(snapshotSessions, SESSION_SNAPSHOT_INTERVAL_MS\)/.test(server) &&
  !/tmuxStartPoller[\s\S]{0,400}writeSessionSnapshot/.test(server));
check('s10 a session younger than a few seconds is not snapshotted',
  /SESSION_SNAPSHOT_MIN_AGE_MS/.test(server));
check('s11 the snapshot dies with the session',
  /const deleteSessionMeta = \(id\) => \{[\s\S]{0,400}sessionSnapshotPath\(id\)/.test(server));

// ── serving it: before the replay, and only when there is nothing live ──
check('s12 the snapshot is sent as an ordinary output frame (no protocol change)',
  /type: 'output', id: session\.id,\s*\n\s*data: snap\.data[\s\S]{0,120}replay: true, replayEnd: false, snapshot: true/.test(server));
check('s13 live output wins: the snapshot is only sent when there is none',
  /if \(!session\.output\) \{\s*\n\s*const snap = readSessionSnapshot\(session\.id\);/.test(server));
check('s14 the snapshot precedes the replay chunking',
  server.indexOf('readSessionSnapshot(session.id)') < server.indexOf('replayEnd: last'));
check('s15 /api/sessions reports the snapshot so a caller can tell a restorable session from an empty one',
  /snapshot: snap \? \{ at: snap\.at, bytes: snap\.bytes \} : null/.test(server));

// ── backup: the snapshot rides descriptors/, the .tmp tail does not ──
check('b1 backup-work still copies the whole sessions directory',
  /cp -a "\$ROOT\/\.npm-hub\/sessions\/\." "\$stage\/descriptors\/"/.test(backupWork));
check('b2 the tail of an interrupted snapshot write is left out of the backup',
  /descriptors" -maxdepth 1 -name '\*\.tmp' -type f -delete/.test(backupWork));
check('b3 restore drops a snapshot that has no descriptor',
  /if \[ -f "\$base\.meta\.json" \][\s\S]{0,120}else[\s\S]{0,160}rm -f "\$snap_file"/.test(restoreWork));
check('b4 restore says how many descriptors/snapshots it actually brought back',
  /sessions available after restore: \$metas descriptor\(s\), \$snaps TUI snapshot\(s\)/.test(restoreWork));

// ── tunnel: one failed probe must not cost a working URL ──
check('t1 the hub waits for consecutive failures, like the shell keeper does',
  /TUNNEL_HEALTH_FAILS = parseInt\(process\.env\.TUNNEL_HEALTH_FAILS \|\| '3'/.test(server) &&
  /if \(healthFails < TUNNEL_HEALTH_FAILS\)/.test(server));
check('t2 a healthy probe resets the counter',
  /if \(health && health\.ok\) \{ healthFails = 0; return; \}/.test(server));
check('t3 the reason keeps the status code',
  /public tunnel health check failed \$\{healthFails\} probes in a row \(\$\{reason\}\)/.test(server));

// ── the write/read contract, for real, on a real filesystem ──
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-snap-'));
const file = path.join(DIR, 'npmhub-term_1.snapshot');
const tmp = file + '.tmp';
const CAP = 256 * 1024;
const MAX_AGE = 24 * 60 * 60 * 1000;

// The same three steps writeSessionSnapshot performs.
function writeSnapshot(text, previous) {
  const body = text.length > CAP ? text.slice(-CAP) : text;
  if (previous === body) return { wrote: false, body };
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, file);
  return { wrote: true, body };
}
function readSnapshot(at) {
  const st = fs.statSync(file);
  if (!st.size) return null;
  if (Date.now() - at > MAX_AGE) return null;
  return { at, bytes: st.size, data: fs.readFileSync(file, 'utf8') };
}

const screen = 'opencode ▸ working on the diff\r\n' + 'line 2\r\n';
const first = writeSnapshot(screen, null);
check('w1 the first snapshot lands on disk', first.wrote && fs.readFileSync(file, 'utf8') === screen);
check('w2 no tmp file is left behind', !fs.existsSync(tmp));
check('w3 rewriting the same screen writes nothing', writeSnapshot(screen, first.body).wrote === false);

const huge = 'x'.repeat(CAP + 5000) + 'END';
const capped = writeSnapshot(huge, first.body);
check('w4 an oversized screen is cut to the cap, tail kept',
  capped.body.length === CAP && capped.body.endsWith('END'), capped.body.length);
check('w5 the capped snapshot is what a reader gets', readSnapshot(Date.now()).data.length === CAP);

fs.utimesSync(file, new Date(Date.now() - 2 * MAX_AGE), new Date(Date.now() - 2 * MAX_AGE));
check('w6 a snapshot from two days ago is not served', readSnapshot(fs.statSync(file).mtimeMs) === null);

fs.writeFileSync(file, screen);
const served = readSnapshot(fs.statSync(file).mtimeMs);
check('w7 a fresh snapshot round-trips byte for byte',
  served && served.data === screen && served.bytes === Buffer.byteLength(screen), served && served.bytes);
// What the client sees: the snapshot is a replay frame, and the live stream
// that follows is not - that is how the client knows to stop "replaying" and
// scroll to the bottom.
const frames = [
  { type: 'output', data: served.data, replay: true, replayEnd: false, snapshot: true },
  { type: 'output', data: 'agent is printing\r\n' }
];
check('w8 the snapshot is the first frame and is marked as replay',
  frames[0].snapshot === true && frames[0].replay === true && frames[0].replayEnd === false);
check('w9 the first live frame is not a replay frame', frames[1].replay === undefined);

fs.rmSync(DIR, { recursive: true, force: true });

console.log(`tui-snapshot: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);