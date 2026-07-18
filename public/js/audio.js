// Pure WebAudio synthesis — zero audio files. Remote shots are delayed by
// distance/340 s with distance-shaped gain and lowpass: distant fights become
// audible geography and range information.
export class GameAudio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.muffle = null;
    this.volume = 0.7;
    this.heartbeatTimer = null;
  }

  ensure() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    this.ctx = new Ctx();
    this.muffle = this.ctx.createBiquadFilter();
    this.muffle.type = 'lowpass';
    this.muffle.frequency.value = 20000;
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;
    // Glue compressor: lets distant cracks run hotter without own-shot clipping.
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 6;
    comp.attack.value = 0.002;
    comp.release.value = 0.12;
    this.muffle.connect(this.master);
    this.master.connect(comp);
    comp.connect(this.ctx.destination);
    this.startAmbience();
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  }

  _noiseBuffer(seconds) {
    const len = Math.floor(this.ctx.sampleRate * seconds);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  _out(pan = 0) {
    if (pan === 0) return this.muffle;
    const p = this.ctx.createStereoPanner();
    p.pan.value = pan;
    p.connect(this.muffle);
    return p;
  }

  startAmbience() {
    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuffer(2);
    src.loop = true;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 220;
    const g = this.ctx.createGain();
    g.gain.value = 0.025;
    src.connect(f).connect(g).connect(this.muffle);
    src.start();
    // Slow wind swell
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoG = this.ctx.createGain();
    lfoG.gain.value = 0.012;
    lfo.connect(lfoG).connect(g.gain);
    lfo.start();
    this._scheduleGust();
  }

  // Wind gusts: every 8-15 s a 2-3 s bandpassed swell so the dusk range
  // breathes between fights. Quiet on purpose — texture, not signal.
  _scheduleGust() {
    setTimeout(() => { this._gust(); this._scheduleGust(); }, 8000 + Math.random() * 7000);
  }

  _gust() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const dur = 2 + Math.random();
    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuffer(dur);
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 300 + Math.random() * 500;
    f.Q.value = 0.8;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.001, t);
    g.gain.exponentialRampToValueAtTime(0.04, t + dur * 0.4);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(this._out((Math.random() * 2 - 1) * 0.6));
    src.start(t);
  }

  // Own shot: noise burst -> lowpass sweep + 60 Hz thump + slap-back echo.
  ownShot() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuffer(0.4);
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(8000, t);
    f.frequency.exponentialRampToValueAtTime(400, t + 0.15);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.9, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    src.connect(f).connect(g).connect(this.muffle);
    src.start(t);

    const thump = this.ctx.createOscillator();
    thump.frequency.value = 60;
    const tg = this.ctx.createGain();
    tg.gain.setValueAtTime(0.7, t);
    tg.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
    thump.connect(tg).connect(this.muffle);
    thump.start(t); thump.stop(t + 0.25);

    // Slap-back canyon echo
    const echo = this.ctx.createBufferSource();
    echo.buffer = src.buffer;
    const eg = this.ctx.createGain();
    eg.gain.setValueAtTime(0.12, t + 0.28);
    eg.gain.exponentialRampToValueAtTime(0.001, t + 0.7);
    const ef = this.ctx.createBiquadFilter();
    ef.type = 'lowpass'; ef.frequency.value = 900;
    echo.connect(ef).connect(eg).connect(this.muffle);
    echo.start(t + 0.28);
  }

  // Remote shot: arrives distance/340 s late, quieter and duller with range.
  remoteShot(dist, pan = 0) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + dist / 340;
    // Distant fights must stay audible geography: ~0.2 gain at 150 m.
    const gain = Math.min(0.7, 2.4 / Math.sqrt(Math.max(12, dist)));
    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuffer(0.3);
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = Math.max(300, 6000 - dist * 28);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    src.connect(f).connect(g).connect(this._out(pan));
    src.start(t);
  }

  // Whiz-by crack: a shot ray passed within 2 m — 100 ms bandpassed chirp panned by side.
  whiz(pan) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuffer(0.12);
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.setValueAtTime(4200, t);
    f.frequency.exponentialRampToValueAtTime(1400, t + 0.1);
    f.Q.value = 2.5;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.11);
    src.connect(f).connect(g).connect(this._out(pan));
    src.start(t);
  }

  hitmark() { this._blip(2000, 0.06, 0.25, 'square'); }

  headshot() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.frequency.setValueAtTime(1320, t);
    o.frequency.exponentialRampToValueAtTime(1760, t + 0.12);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    o.connect(g).connect(this.muffle);
    o.start(t); o.stop(t + 0.3);
  }

  // Kill-confirm sting: in a one-shot game a kill must not sound like a body hit.
  killConfirm() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    for (const [freq, at, dur] of [[660, 0, 0.07], [990, 0.08, 0.14]]) {
      const o = this.ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = freq;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.35, t + at);
      g.gain.exponentialRampToValueAtTime(0.001, t + at + dur);
      o.connect(g).connect(this.muffle);
      o.start(t + at); o.stop(t + at + dur + 0.02);
    }
  }

  // Medal sting: a fifth up from killConfirm (C5 -> G5) so streak callouts
  // read as reward, not as another kill.
  medal() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    for (const [freq, at, dur] of [[523, 0, 0.09], [784, 0.1, 0.18]]) {
      const o = this.ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = freq;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.3, t + at);
      g.gain.exponentialRampToValueAtTime(0.001, t + at + dur);
      o.connect(g).connect(this.muffle);
      o.start(t + at); o.stop(t + at + dur + 0.02);
    }
  }

  // Final-minute accent: low 55->110 Hz saw swell under a soft noise wash —
  // one dread note, then back to the ambience.
  finalMinute() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(55, t);
    o.frequency.exponentialRampToValueAtTime(110, t + 1.2);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.001, t);
    g.gain.exponentialRampToValueAtTime(0.35, t + 1.0);
    g.gain.exponentialRampToValueAtTime(0.001, t + 1.4);
    o.connect(g).connect(this.muffle);
    o.start(t); o.stop(t + 1.4);

    const wash = this.ctx.createBufferSource();
    wash.buffer = this._noiseBuffer(1.4);
    const wf = this.ctx.createBiquadFilter();
    wf.type = 'lowpass'; wf.frequency.value = 500;
    const wg = this.ctx.createGain();
    wg.gain.setValueAtTime(0.001, t);
    wg.gain.exponentialRampToValueAtTime(0.08, t + 1.0);
    wg.gain.exponentialRampToValueAtTime(0.001, t + 1.4);
    wash.connect(wf).connect(wg).connect(this.muffle);
    wash.start(t);
  }

  // Dry tick for the last-5-seconds countdown.
  countdownTick() { this._blip(1500, 0.03, 0.25, 'square'); }

  bolt() {
    this._blip(320, 0.04, 0.2, 'square');
    setTimeout(() => this._blip(240, 0.05, 0.2, 'square'), 120);
  }

  reload() {
    this._blip(180, 0.06, 0.18, 'square');
    setTimeout(() => this._blip(150, 0.05, 0.15, 'square'), 500);
    setTimeout(() => this._blip(300, 0.05, 0.2, 'square'), 1900);
  }

  _blip(freq, dur, vol, type = 'sine') {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.muffle);
    o.start(t); o.stop(t + dur + 0.02);
  }

  // Heartbeat (55 Hz sine pairs at 1.2 Hz) during breath-hold and forced exhale.
  setHeartbeat(on) {
    if (on && !this.heartbeatTimer && this.ctx) {
      const beat = () => {
        this._blip(55, 0.1, 0.5);
        setTimeout(() => this._blip(55, 0.09, 0.35), 180);
      };
      beat();
      this.heartbeatTimer = setInterval(beat, 833);
    } else if (!on && this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  breathIn() { this._sweepNoise(600, 1400, 0.5, 0.06); }
  breathOut() { this._sweepNoise(1200, 400, 0.7, 0.09); }

  _sweepNoise(f0, f1, dur, vol) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuffer(dur);
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(this.muffle);
    src.start(t);
  }

  death() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.frequency.setValueAtTime(120, t);
    o.frequency.exponentialRampToValueAtTime(35, t + 0.5);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.6, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
    o.connect(g).connect(this.muffle);
    o.start(t); o.stop(t + 0.6);
    // Master-bus muffle during the death cam.
    this.muffle.frequency.setValueAtTime(700, t);
  }

  unmuffle() {
    if (this.ctx) this.muffle.frequency.setValueAtTime(20000, this.ctx.currentTime);
  }
}
