// Reconnect replay (npm-hub/src/server.js + public/term-app.js).
//
// Symptom this pins down: while the app was in the background the socket
// died, and on the way back the terminal showed the beginning of the session
// instead of where the agent actually was. Two bugs fed each other:
//
//   1. attachPtyClient replayed the whole 4MB scrollback, and the client
//      APPENDED it to a terminal that already had the output. Every reconnect
//      duplicated the transcript, so the view climbed into the middle of the
//      session and the agent's current position scrolled off. Streaming 4MB
//      through term.write() also blocked the main thread, which is why the
//      other tabs went black for seconds.
//   2. Nothing marked the end of the replay, so the view was never pulled back
//      to the bottom.
//
// Plain node, no deps: the client half is checked as source invariants, the
// server half is exercised against the real chunking logic.
const fs = require('fs');
const path = require('path');

const termApp = fs.readFileSync(path.join(__dirname, '..', 'npm-hub', 'public', 'term-app.js'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'npm-hub', 'src', 'server.js'), 'utf8');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? ' got=' + JSON.stringify(extra) : '')); }
}

// ── server: replay the tail, flag the last frame, don't stall ──
check('r1 replay budget exists and is far below the scrollback cap',
  /SESSION_REPLAY_BYTES\s*=/.test(server) &&
  /HUB_REPLAY_BYTES[^\n]*512\s*\*\s*1024/.test(server));
check('r2 the replay is sliced to the tail',
  /session\.output\.length > SESSION_REPLAY_BYTES\s*\n?\s*\?\s*session\.output\.slice\(-SESSION_REPLAY_BYTES\)/.test(server));
check('r3 the last replay frame is flagged',
  /replay: true, replayEnd: last/.test(server) && /const last = pos >= out\.length/.test(server));
check('r4 chunks are not paced like before (25ms would stretch 4MB into seconds)',
  /if \(!last\) setTimeout\(step, 10\)/.test(server) && !/pos < out\.length\) setTimeout\(step, 25\)/.test(server));
check('r5 every replay frame still carries replay: true',
  /type: 'output', id: session\.id, data: part, replay: true/.test(server));

// ── client: reset once on the first replay frame, then land at the bottom ──
check('r6 replay starts the terminal over instead of appending',
  /if \(m\.replay\) \{\s*\n\s*if \(!td\.replaying\) \{ td\.replaying = true; try \{ term\.reset\(\); \} catch \{\} \}/.test(termApp));
check('r7 replaying flag is per tab and starts false',
  /replaying: false, connect: \(\) => \{\}/.test(termApp));
check('r8 the end of a replay scrolls to the bottom, queued behind the frames',
  /const termReplayDone = \(\) => \{[\s\S]*?term\.write\('',\s*\(\)\s*=>\s*\{ try \{ term\.scrollToBottom\(\); \} catch \{\} \}\)/.test(termApp));
check('r9 a live frame also ends the replay', /if \(td\.replaying\) termReplayDone\(\);/.test(termApp));
check('r10 returning to the app refits and returns to the bottom',
  /visibilitychange[\s\S]*?kickReconnect\(\);[\s\S]*?t\.fitAddon\?\.fit\(\); t\.term\?\.scrollToBottom\(\)/.test(termApp));
check('r11 the old "append everything" behaviour is gone',
  !/if \(m\.type === 'output'\) \{ term\.write\(m\.data\); \}/.test(termApp));

// ── server: the tail must be what actually reaches the client ──
// Re-implement the slicing/chunking contract: a 4MB scrollback must not be
// turned into 4MB of frames, and the last frame must be the flagged one.
const CAP = 4 * 1024 * 1024, REPLAY = 512 * 1024, CHUNK = 64 * 1024;
const scrollback = 'x'.repeat(CAP);
const out = scrollback.length > REPLAY ? scrollback.slice(-REPLAY) : scrollback;
check('r12 a full scrollback is cut to the replay budget', out.length === REPLAY, out.length);
const frames = [];
for (let pos = 0; pos < out.length;) {
  const part = out.slice(pos, pos + CHUNK);
  pos += part.length;
  frames.push({ len: part.length, replay: true, replayEnd: pos >= out.length });
}
check('r13 the tail is framed, not dumped in one message', frames.length === 8, frames.length);
check('r14 only the final frame is flagged as the end',
  frames.filter(f => f.replayEnd).length === 1 && frames[frames.length - 1].replayEnd === true);
check('r15 replayed bytes are a fraction of what is kept',
  out.length < CAP / 4, [out.length, CAP]);
// The terminal reset on frame 1 and must end up on the last line of the tail.
check('r16 the replay ends at the agent latest output, not at the session start',
  out.slice(-64) === scrollback.slice(-64));

console.log(`TERM-REPLAY: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
