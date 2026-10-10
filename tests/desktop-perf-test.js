// The screen tab was a machine for breaking itself. Measured on a live hub
// (2026-10-10): 22 «починка экрана» in five hours, every one of them
// «нет x11vnc:5901» - while x11vnc was alive and listening. The health probe
// lied (one TCP connect, 1.5 s, against a -threads server busy encoding for
// the connected client), and the repair it triggered pkill'ed x11vnc, which
// dropped the very session the user was watching. Behind that, three more
// documented complaints of the same tab: sound that breaks up, a screen that
// turns blue and then lags while the mouse moves, and a hub that crashes.
//
// These cases pin the fixes: a probe that retries, a confirmation before the
// destructive repair, back-pressure in the WS↔TCP relay, a coalesced pointer
// stream, and the reduced sound bits the tab now asks for.
const fs = require('fs');
const path = require('path');

const keep = fs.readFileSync(path.join(__dirname, '..', 'npm-hub', 'src', 'vnc-keepalive.js'), 'utf8');
const desk = fs.readFileSync(path.join(__dirname, '..', 'npm-hub', 'public', 'desktop-app.js'), 'utf8');
const audio = fs.readFileSync(path.join(__dirname, '..', 'npm-hub', 'public', 'remote-audio.js'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'npm-hub', 'src', 'server.js'), 'utf8');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? ' got=' + JSON.stringify(extra) : '')); }
}

// ── the health probe that lied ──
// One connect with a 1.5 s timeout declared a busy x11vnc dead. The signature
// (retries + attempts) and the retry loop itself must stay.
check('p1 port probe retries', /const portOpen = \(port, timeout = 2500, attempts = 2\)/.test(keep)
  && /--left <= 0/.test(keep) && /setTimeout\(tryOnce, 300\)/.test(keep),
  'portOpen signature/loop');

// ── no destructive repair on a single bad reading ──
check('p2 repair is confirmed before it kills x11vnc', keep.includes('One fresh confirmation before the destructive repair')
  && /again\.every\(Boolean\)/.test(keep) && /await repair\(repoRootRef, why\)/.test(keep),
  'confirm block in tick');

// ── the relay that held the whole burst in memory ──
check('p3 desktop relay has back-pressure', keep.includes('MAX_BUFFERED')
  && /tcp\.pause\(\)/.test(keep) && /tcp\.resume\(\)/.test(keep)
  && /ws\.bufferedAmount > MAX_BUFFERED/.test(keep)
  && /setInterval\(maybeResume, 250\)/.test(keep),
  'pause/resume in registerProxy');

// ── the pointer stream that drowned the server ──
// A mouse emits 100+ pointermoves per second; each used to become its own VNC
// message. Now the deltas are coalesced into one send per 16 ms frame.
check('p4 virtual mouse coalesces moves', desk.includes('pendingDx = 0, pendingDy = 0, flushTimer = 0')
  && /if \(!flushTimer\) flushTimer = setTimeout\(flush, 16\);/.test(desk)
  && desk.includes('if (flushTimer) { clearTimeout(flushTimer); flushTimer = 0; }')
  && desk.includes('vMouseMove(dx, dy);'),
  'flush/queue in vMouseInitPad');

// ── sound bits: 16 kHz mono instead of 48 kHz stereo ──
check('p5 audio client asks for the light profile', audio.includes('const wantRate = canOpus ? 16000 : 22050;')
  && /channels: 1,/.test(audio)
  && audio.includes("'&rate=' + encodeURIComponent(wantRate)"),
  'wantRate/channels');

// The OpusHead description must name the negotiated rate: 48 kHz written over
// a 16 kHz stream is what made the decoder fall back to raw PCM.
check('p6 opus description carries the real rate', audio.includes('function opusHead(channels, rate)')
  && /dv\.setUint32\(12, rate \|\| 48000, true\)/.test(audio)
  && audio.includes('sampleRate: state.rate,')
  && audio.includes('description: opusHead(state.channels, state.rate),'),
  'opusHead + decoder config');

check('p7 server defaults to 16 kHz mono', server.includes("const def = Number(process.env.HUB_AUDIO_RATE) || 16000;")
  && server.includes("const def = Number(process.env.HUB_AUDIO_CHANNELS) || 1;")
  && server.includes('channels === 1 ? 16000 : 32000')
  && server.includes('let channels = 1;'),
  'server audio defaults');

// The ws URL the client builds must ask for what the server now defaults to.
check('p8 audio socket asks for the negotiated codec/rate', audio.includes("'/ws/audio?codec='")
  && audio.includes("'&channels=' + state.channels +")
  && audio.includes("'&rate=' + encodeURIComponent(wantRate)"),
  'ws url');

// ── behavioral: the probe must survive a busy server ──
// The exact shape of the production bug: a server that answers the FIRST
// connect a beat too late. The old one-probe portOpen answered false and the
// repair killed a healthy x11vnc; the retrying one must answer true.
const net = require('net');
const from = keep.indexOf('const portOpen =');
const to = keep.indexOf('const httpOk');
if (from < 0 || to <= from) {
  check('p0 portOpen block found in vnc-keepalive.js', false, 'markers moved?');
} else {
  const portOpen = new Function('net', keep.slice(from, to) + '\n;return portOpen;')(net);

  const freePort = () => new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });

  (async () => {
    // p9: a port that only starts answering DURING the probe window still
    // counts as up. This is what a busy runner looks like to a one-shot
    // probe: the first connect is refused, the retry (300 ms later) finds the
    // listener. The old one-attempt code answered false and the repair
    // killed a healthy x11vnc.
    const p1port = await freePort();
    const late = net.createServer(() => {});
    setTimeout(() => late.listen(p1port, '127.0.0.1'), 150);
    const r1 = await portOpen(p1port, 2500, 2);
    late.close();
    check('p9 a port that starts answering inside the window is still up', r1 === true, r1);

    // p10: a live listener is answered without waiting for a second probe.
    const p2port = await freePort();
    const srv = net.createServer((S) => S.end());
    await new Promise((r) => srv.listen(p2port, '127.0.0.1', r));
    const t0 = Date.now();
    const r2 = await portOpen(p2port, 2500, 2);
    const dt = Date.now() - t0;
    srv.close();
    check('p10 a live listener answers at once', r2 === true && dt < 1500, { r2, dt });

    // p11: a port with nothing behind it is still reported down.
    const p3port = await freePort();
    const r3 = await portOpen(p3port, 2500, 2);
    check('p11 a dead port is reported down', r3 === false, r3);

    console.log(`DESKTOP-PERF: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  })();
}
