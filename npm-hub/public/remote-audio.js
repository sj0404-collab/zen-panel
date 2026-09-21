/* ===== REMOTE VIDEO AUDIO (shared by mobile-app.js and desktop-app.js) =====
 * VNC carries only pixels. The remote Chromium audio is captured from
 * PulseAudio by /ws/audio. The server now sends Opus (one 20 ms frame per
 * binary WebSocket message) instead of raw PCM, which cuts the stream from
 * ~700 kbps to ~25-50 kbps and, more importantly, lets us schedule decoded
 * chunks on the audio clock.
 *
 * Why the old player stuttered ("voice lags, then a few ms of sharp silence"):
 * createScriptProcessor refilled its output buffer on the main thread and
 * zero-filled it whenever its queue ran dry, and the 350 ms trim dropped whole
 * chunks on jitter — both produced hard dropouts. Here every chunk is decoded
 * (WebCodecs AudioDecoder) and scheduled with an AudioBufferSourceNode at an
 * adaptive lead, so playback is continuous and a late packet costs at most a
 * tiny gap. Browsers without WebCodecs fall back to the server's PCM stream.
 */
(function () {
  'use strict';
  if (window.RemoteAudio) return;

  let current = null;
  // Set when WebCodecs Opus decode is unavailable/broken, so the next connect
  // asks the server for raw PCM instead. Reset on page reload.
  let forcePcm = false;

  function badge(text, on) {
    const el = document.getElementById('pulse-status');
    if (!el) return;
    el.textContent = text;
    el.title = on ? 'Звук видео идёт на телефон. Нажмите, чтобы выключить.' : 'Включить звук видео';
    el.className = 'tag ' + (on ? 'tag-on' : 'tag-off');
  }

  // OpusHead identification header (mapping family 0). WebCodecs wants it as
  // the AudioDecoderConfig.description for codec 'opus'.
  function opusHead(channels) {
    const b = new Uint8Array(19);
    const magic = 'OpusHead';
    for (let i = 0; i < 8; i++) b[i] = magic.charCodeAt(i);
    const dv = new DataView(b.buffer);
    b[8] = 1;                 // version
    b[9] = channels;          // channel count
    dv.setUint16(10, 0, true);    // pre-skip
    dv.setUint32(12, 48000, true); // input sample rate
    dv.setInt16(16, 0, true);     // output gain
    b[18] = 0;                // channel mapping family
    return b;
  }

  function start() {
    try {
      if (current) {
        const rs = current.ws ? current.ws.readyState : 3;
        if (rs <= 1) { current.ctx.resume().catch(() => {}); return current; }
        // A closing/closed socket from a reconnect: tear the old player down
        // first, otherwise its already-scheduled buffers keep playing under the
        // new stream — heard as an echo.
        stop();
      }
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC || !window.WebSocket) return null;

      const canOpus = !forcePcm &&
        typeof window.AudioDecoder === 'function' &&
        typeof window.EncodedAudioChunk === 'function';
      const wantRate = canOpus ? 48000 : 22050;
      let ctx;
      try { ctx = new AC({ sampleRate: wantRate }); } catch { ctx = new AC(); }

      const state = {
        ctx,
        ws: null,
        close: false,
        codec: canOpus ? 'opus' : 'pcm',
        channels: 2,
        rate: wantRate,
        decoder: null,
        ready: false,
        preReady: [],
        pendingPcm: null,
        ts: 0,
        nextTime: 0,
        lead: 0.08,
        stable: 0,
        dropped: 0,
        sources: new Set(),
        decoded: 0,
        decodeErrors: 0,
      };
      current = state;

      // Give up on WebCodecs and reconnect for raw PCM. Used only when the
      // decoder cannot even be configured, or never produces a single frame.
      let fellBack = false;
      const fallbackToPcm = () => {
        if (fellBack) return;
        fellBack = true;
        forcePcm = true;
        try { ws.close(); } catch {}
        setTimeout(() => { try { start(); } catch {} }, 400);
      };

      // Schedule one decoded chunk (or a raw PCM fallback chunk) on the audio
      // clock. The lead absorbs network jitter; it grows on starvation and
      // decays after long stable stretches, so latency stays low without ever
      // zero-filling the output like the old ScriptProcessor did.
      //
      // Hard rule: never schedule over audio that is already queued. If a stall
      // (hidden tab, GC, a burst of decoded frames) leaves more than MAX_LEAD
      // in flight, the delayed chunks are DROPPED and we resync to the live
      // edge. The previous code moved nextTime backwards while the old buffers
      // were still pending, so two copies played at once — that was the echo.
      const MAX_LEAD = 0.35;
      const schedule = (buffer) => {
        if (state.close) return;
        const now = ctx.currentTime;
        if (state.nextTime - now > MAX_LEAD) { state.dropped++; state.stable = 0; return; }
        let t = state.nextTime;
        if (t < now + 0.005) {
          t = now + state.lead;
          state.stable = 0;
          state.lead = Math.min(state.lead * 1.5, 0.25);
        } else if (++state.stable > 150) {
          state.stable = 0;
          state.lead = Math.max(0.05, state.lead * 0.97);
        }
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(ctx.destination);
        src.onended = () => state.sources.delete(src);
        state.sources.add(src);
        try { src.start(t); } catch { state.sources.delete(src); return; }
        state.nextTime = t + buffer.duration;
      };

      const playPcm = (bytes) => {
        const chs = state.channels;
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const n = bytes.byteLength / 2;
        const buf = ctx.createBuffer(chs, Math.max(1, (n / chs) | 0), state.rate || ctx.sampleRate);
        for (let c = 0; c < chs; c++) {
          const ch = buf.getChannelData(c);
          for (let i = 0; i < ch.length; i++) ch[i] = view.getInt16((i * chs + c) * 2, true) / 32768;
        }
        schedule(buf);
      };

      const onDecoded = (audioData) => {
        try {
          state.decoded++;
          const chs = audioData.numberOfChannels || 1;
          const len = audioData.numberOfFrames;
          const buf = ctx.createBuffer(chs, len, audioData.sampleRate || 48000);
          for (let c = 0; c < chs; c++) {
            try { audioData.copyTo(buf.getChannelData(c), { planeIndex: c, format: 'f32-planar' }); }
            catch { try { audioData.copyTo(buf.getChannelData(c), { planeIndex: c }); } catch {} }
          }
          schedule(buf);
        } catch {} finally { try { audioData.close(); } catch {} }
      };

      const startDecoder = () => {
        if (state.codec !== 'opus' || state.decoder) return true;
        if (typeof window.AudioDecoder !== 'function') return false;
        try {
          const dec = new AudioDecoder({
            output: onDecoded,
            error: (e) => {
              state.decodeErrors++;
              console.warn('remote-audio: opus decode', (e && e.message) || e);
              // A few bad packets can happen; failing before any output means
              // the browser cannot really decode Opus -> use the PCM stream.
              if (!state.decoded && state.decodeErrors >= 3) fallbackToPcm();
            },
          });
          dec.configure({
            codec: 'opus',
            sampleRate: 48000,
            numberOfChannels: state.channels,
            description: opusHead(state.channels),
          });
          state.decoder = dec;
          return true;
        } catch (e) {
          console.warn('remote-audio: AudioDecoder unavailable', (e && e.message) || e);
          state.decoder = null;
          return false;
        }
      };

      const feed = (bytes) => {
        if (state.codec === 'opus') {
          if (!state.ready || !state.decoder) { state.preReady.push(bytes); return; }
          try {
            state.ts += 20000; // µs (informational for Opus)
            state.decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: state.ts, data: bytes }));
          } catch { /* drop a malformed frame rather than stalling */ }
          return;
        }
        const frame = state.channels * 2;
        const prev = state.pendingPcm;
        const all = new Uint8Array((prev ? prev.length : 0) + bytes.length);
        if (prev) all.set(prev);
        all.set(bytes, prev ? prev.length : 0);
        const usable = all.length - (all.length % frame);
        state.pendingPcm = all.slice(usable);
        if (usable) playPcm(new Uint8Array(all.buffer, all.byteOffset, usable));
      };

      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(proto + '//' + location.host + '/ws/audio?codec=' +
        encodeURIComponent(state.codec) + '&channels=' + state.channels +
        '&rate=' + encodeURIComponent(wantRate));
      state.ws = ws;
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => { ctx.resume().catch(() => {}); badge('🔊 подключение', false); };
      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
          try {
            const msg = JSON.parse(ev.data);
            if (msg.type === 'ready') {
              state.channels = msg.channels || state.channels;
              state.rate = msg.rate || wantRate;
              if (msg.codec) state.codec = msg.codec;
              if (state.codec === 'opus' && !startDecoder()) {
                // WebCodecs vanished between check and use: reconnect as PCM.
                fallbackToPcm();
                return;
              }
              state.ready = true;
              const q = state.preReady; state.preReady = [];
              for (const d of q) feed(d);
              badge('🔊 видео', true);
            } else if (msg.type === 'error') {
              badge('🔇 ' + (msg.error || 'нет потока'), false);
            }
          } catch {}
          return;
        }
        feed(new Uint8Array(ev.data));
      };
      ws.onerror = () => badge('🔇 нет потока', false);
      ws.onclose = () => {
        try { if (state.decoder) state.decoder.close(); } catch {}
        for (const s of state.sources) { try { s.onended = null; s.stop(); } catch {} }
        state.sources.clear();
        state.preReady = [];
        state.pendingPcm = null;
        if (current === state) { current = null; badge('🔇 звук', false); }
      };
      ctx.resume().catch(() => {});
      return state;
    } catch { return null; }
  }

  function stop() {
    const a = current;
    current = null;
    if (!a) return;
    a.close = true;
    try { a.ws && a.ws.close(); } catch {}
    for (const s of a.sources) { try { s.onended = null; s.stop(); } catch {} }
    try { a.decoder && a.decoder.close(); } catch {}
    try { a.ctx.close(); } catch {}
    badge('🔇 звук', false);
  }

  const live = () => !!(current && current.ws && current.ws.readyState === 1);
  const toggle = () => { if (live()) stop(); else start(); };

  window.RemoteAudio = {
    start, stop, toggle, live,
    get state() { return current; },
  };
})();
