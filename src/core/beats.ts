/**
 * Audio analysis for audio layers (ED-14): waveform peaks for the timeline and
 * beat detection for beat markers. Pure functions on mono PCM, so they run in
 * the browser (after WebAudio decodes the file) and in tests.
 */

/** Peak absolute amplitude per bucket, 0–1. */
export function waveformPeaks(samples: Float32Array, buckets: number): Float32Array {
  const out = new Float32Array(Math.max(1, buckets));
  const per = samples.length / out.length;
  for (let b = 0; b < out.length; b++) {
    let m = 0;
    const end = Math.min(samples.length, Math.floor((b + 1) * per));
    for (let i = Math.floor(b * per); i < end; i++) {
      const v = Math.abs(samples[i]);
      if (v > m) m = v;
    }
    out[b] = Math.min(1, m);
  }
  return out;
}

export interface BeatResult {
  /** Seconds (media time) of the regular beat grid, when a tempo was found. */
  beats: number[];
  /** Seconds of individual hits (kicks, claps, note starts). */
  onsets: number[];
  bpm: number | null;
}

/**
 * Onsets from the rise in short-time energy; tempo from the autocorrelation
 * of that onset curve (60–200 BPM); beats as the best-aligned grid.
 */
export function detectBeats(samples: Float32Array, sampleRate: number, opts: { minBpm?: number; maxBpm?: number } = {}): BeatResult {
  const hop = 512;
  const win = 1024;
  const n = Math.max(0, Math.floor((samples.length - win) / hop));
  if (n < 8) return { beats: [], onsets: [], bpm: null };
  const energy = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let s = 0;
    const o = f * hop;
    for (let i = 0; i < win; i++) s += samples[o + i] * samples[o + i];
    energy[f] = Math.log1p(1000 * Math.sqrt(s / win));
  }
  const onset = new Float32Array(n);
  for (let f = 1; f < n; f++) onset[f] = Math.max(0, energy[f] - energy[f - 1]);
  const dt = hop / sampleRate;
  // A rise in frame f means the sound started near the END of that frame's window.
  const lead = win / sampleRate;

  // Peak picking against a moving average.
  const w = Math.max(2, Math.round(0.1 / dt));
  const minGap = Math.round(0.1 / dt);
  const onsets: number[] = [];
  let mean = 0;
  for (let f = 0; f < n; f++) mean += onset[f];
  mean /= n;
  let last = -Infinity;
  for (let f = 1; f < n - 1; f++) {
    let local = 0;
    let cnt = 0;
    for (let k = Math.max(0, f - w); k <= Math.min(n - 1, f + w); k++, cnt++) local += onset[k];
    local /= cnt;
    const isPeak = onset[f] >= onset[f - 1] && onset[f] > onset[f + 1];
    if (isPeak && onset[f] > local * 1.5 + mean * 0.5 && f - last >= minGap) {
      onsets.push(+(f * dt + lead).toFixed(4));
      last = f;
    }
  }

  // Tempo by autocorrelation.
  const minBpm = opts.minBpm ?? 60;
  const maxBpm = opts.maxBpm ?? 200;
  const lagMin = Math.max(1, Math.floor(60 / maxBpm / dt));
  const lagMax = Math.min(n - 1, Math.ceil(60 / minBpm / dt));
  let bestLag = 0;
  let best = 0;
  let total = 0;
  for (let f = 0; f < n; f++) total += onset[f] * onset[f];
  for (let lag = lagMin; lag <= lagMax; lag++) {
    let s = 0;
    for (let f = lag; f < n; f++) s += onset[f] * onset[f - lag];
    // Mild preference for tempos near 120 BPM to avoid half/double picks.
    const bpm = 60 / (lag * dt);
    const weight = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 1.0, 2));
    if (s * weight > best) {
      best = s * weight;
      bestLag = lag;
    }
  }
  if (!bestLag || total === 0 || best / total < 0.05) return { beats: [], onsets, bpm: null };
  // Refine the period with parabolic interpolation around the best lag.
  const ac = (lag: number) => {
    let s = 0;
    for (let f = lag; f < n; f++) s += onset[f] * onset[f - lag];
    return s;
  };
  const a = ac(bestLag - 1);
  const b = ac(bestLag);
  const c = ac(bestLag + 1);
  const shift = a - 2 * b + c !== 0 ? (0.5 * (a - c)) / (a - 2 * b + c) : 0;
  const period = (bestLag + Math.max(-0.5, Math.min(0.5, shift))) * dt;

  // Phase: the grid offset that lands on the most onset energy.
  const steps = 64;
  let bestPhase = 0;
  let bestScore = -1;
  for (let k = 0; k < steps; k++) {
    const phase = (period * k) / steps;
    let s = 0;
    for (let t = phase; t < n * dt; t += period) {
      const f = Math.round(t / dt);
      s += Math.max(onset[f] ?? 0, onset[f - 1] ?? 0, onset[f + 1] ?? 0);
    }
    if (s > bestScore) {
      bestScore = s;
      bestPhase = phase;
    }
  }
  const beats: number[] = [];
  const duration = samples.length / sampleRate;
  for (let t = bestPhase + lead; t < duration; t += period) beats.push(+t.toFixed(4));
  return { beats, onsets, bpm: Math.round((60 / period) * 10) / 10 };
}
