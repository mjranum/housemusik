// Ambient sound generated live with the Web Audio API: no recordings needed,
// it never loops audibly, and every room can run its own copy without sync.

const NOISE_SECONDS = 6;

function makeNoise(ctx, color) {
  const len = ctx.sampleRate * NOISE_SECONDS;
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      if (color === 'brown') {
        last = (last + 0.02 * white) / 1.02;
        d[i] = last * 3.5;
      } else {
        d[i] = white;
      }
    }
  }
  return buf;
}

function lfo(ctx, freq, depth, target) {
  const osc = ctx.createOscillator();
  osc.frequency.value = freq;
  const g = ctx.createGain();
  g.gain.value = depth;
  osc.connect(g).connect(target);
  osc.start();
  return osc;
}

export class Ambient {
  constructor(ctx, destination) {
    this.ctx = ctx;
    this.dest = destination;
    this.current = null; // { scene, out, stop }
    this.buffers = {};
  }

  _noise(color) {
    if (!this.buffers[color]) this.buffers[color] = makeNoise(this.ctx, color);
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffers[color];
    src.loop = true;
    // Start at a random point so rooms are not phase-locked copies.
    src.start(0, Math.random() * NOISE_SECONDS);
    return src;
  }

  get scene() {
    return this.current ? this.current.scene : null;
  }

  play(scene) {
    if (this.scene === scene) return;
    this.stop();
    const ctx = this.ctx;
    const out = ctx.createGain();
    out.gain.value = 0;
    out.connect(this.dest);
    const nodes = [];
    const timers = [];
    const build = SCENES[scene];
    if (!build) return;
    build.call(this, ctx, out, nodes, timers);
    out.gain.setTargetAtTime(1, ctx.currentTime, 0.8); // fade in
    this.current = {
      scene,
      stop: () => {
        timers.forEach(clearInterval);
        out.gain.cancelScheduledValues(ctx.currentTime);
        out.gain.setTargetAtTime(0, ctx.currentTime, 0.4); // fade out
        setTimeout(() => {
          nodes.forEach((n) => { try { n.stop(); } catch { /* not a source */ } });
          out.disconnect();
        }, 2500);
      },
    };
  }

  stop() {
    if (this.current) this.current.stop();
    this.current = null;
  }
}

const SCENES = {
  brown(ctx, out, nodes) {
    const src = this._noise('brown');
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;
    const g = ctx.createGain();
    g.gain.value = 0.8;
    src.connect(lp).connect(g).connect(out);
    nodes.push(src);
  },

  rain(ctx, out, nodes, timers) {
    // Steady hiss of distant rain...
    const src = this._noise('white');
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 500;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 7000;
    const g = ctx.createGain();
    g.gain.value = 0.18;
    src.connect(hp).connect(lp).connect(g).connect(out);
    nodes.push(src);
    // ...plus individual drops: tiny filtered noise bursts at random pitches.
    const drops = this._noise('white');
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 6;
    const env = ctx.createGain();
    env.gain.value = 0;
    drops.connect(bp).connect(env).connect(out);
    nodes.push(drops);
    timers.push(setInterval(() => {
      const t = ctx.currentTime + Math.random() * 0.05;
      bp.frequency.setValueAtTime(1800 + Math.random() * 4000, t);
      env.gain.setValueAtTime(0.25 + Math.random() * 0.35, t);
      env.gain.setTargetAtTime(0, t + 0.002, 0.012);
    }, 45));
  },

  ocean(ctx, out, nodes) {
    const src = this._noise('brown');
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 700;
    const swell = ctx.createGain();
    swell.gain.value = 0.55;
    src.connect(lp).connect(swell).connect(out);
    // One slow wave cycle every ~11 seconds moves both loudness and brightness.
    nodes.push(src, lfo(ctx, 0.09, 0.45, swell.gain), lfo(ctx, 0.09, 450, lp.frequency));
  },

  wind(ctx, out, nodes) {
    const src = this._noise('white');
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 500;
    bp.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.value = 0.35;
    src.connect(bp).connect(g).connect(out);
    nodes.push(src, lfo(ctx, 0.05, 300, bp.frequency), lfo(ctx, 0.13, 0.2, g.gain),
      lfo(ctx, 0.031, 0.12, g.gain));
  },

  drone(ctx, out, nodes) {
    // A slow, detuned open fifth chord with gentle tremolo.
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1200;
    const g = ctx.createGain();
    g.gain.value = 0.12;
    lp.connect(g).connect(out);
    for (const [f, type] of [[55, 'sine'], [82.4, 'triangle'], [110.3, 'sine'], [164.6, 'triangle'], [220.6, 'sine']]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      o.detune.value = (Math.random() - 0.5) * 12;
      const og = ctx.createGain();
      og.gain.value = 0.5;
      o.connect(og).connect(lp);
      o.start();
      nodes.push(o, lfo(ctx, 0.07 + Math.random() * 0.1, 0.25, og.gain));
    }
    nodes.push(lfo(ctx, 0.02, 500, lp.frequency));
  },
};
