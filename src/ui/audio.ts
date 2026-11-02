/**
 * Browser-side audio (ED-14): decode once per asset for the waveform and beat
 * detection, and play audio layers in sync with the playhead.
 */
import { useEffect, useState } from "react";
import { detectBeats, waveformPeaks, type BeatResult } from "../core/beats";
import { valueAt } from "../core/interpolate";
import type { Asset, AudioLayer, Composition, Project } from "../core/types";
import { assetUrl } from "./api";

type Decoded = { mono: Float32Array; sampleRate: number; duration: number; peaks: Float32Array };
const cache = new Map<string, Promise<Decoded>>();

export function decodeAsset(a: Asset): Promise<Decoded> {
  let p = cache.get(a.id);
  if (!p) {
    p = (async () => {
      const buf = await (await fetch(assetUrl(a))).arrayBuffer();
      const ctx = new OfflineAudioContext(1, 1, 44100);
      const audio = await ctx.decodeAudioData(buf);
      const mono = new Float32Array(audio.length);
      for (let c = 0; c < audio.numberOfChannels; c++) {
        const d = audio.getChannelData(c);
        for (let i = 0; i < d.length; i++) mono[i] += d[i] / audio.numberOfChannels;
      }
      // ~100 peaks per second is plenty for the timeline.
      return { mono, sampleRate: audio.sampleRate, duration: audio.duration, peaks: waveformPeaks(mono, Math.max(1, Math.round(audio.duration * 100))) };
    })();
    p.catch(() => cache.delete(a.id));
    cache.set(a.id, p);
  }
  return p;
}

/** Waveform peaks for an asset (100 per second), or null while decoding. */
export function usePeaks(a: Asset | undefined): Float32Array | null {
  const [peaks, setPeaks] = useState<Float32Array | null>(null);
  useEffect(() => {
    let live = true;
    setPeaks(null);
    if (a) decodeAsset(a).then((d) => live && setPeaks(d.peaks)).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [a?.id]);
  return peaks;
}

export async function beatsFor(a: Asset): Promise<BeatResult> {
  const d = await decodeAsset(a);
  return detectBeats(d.mono, d.sampleRate);
}

/** Start the comp's audio layers at time t; returns a stop function. */
export function playAudio(project: Project, comp: Composition, t: number): () => void {
  const els: HTMLAudioElement[] = [];
  const timers: number[] = [];
  for (const l of comp.layers) {
    if (l.type !== "audio" || !l.visible) continue;
    const a = project.assets.find((x) => x.id === (l as AudioLayer).assetId);
    if (!a || t >= l.outPoint) continue;
    const el = new Audio(assetUrl(a));
    el.volume = Math.max(0, Math.min(1, valueAt((l as AudioLayer).volume, Math.max(t, l.inPoint)) / 100));
    const start = () => {
      el.currentTime = Math.max(0, Math.max(t, l.inPoint) - l.inPoint + l.mediaOffset);
      el.play().catch(() => undefined);
    };
    if (t >= l.inPoint) start();
    else timers.push(window.setTimeout(start, (l.inPoint - t) * 1000));
    timers.push(window.setTimeout(() => el.pause(), (l.outPoint - Math.max(t, l.inPoint)) * 1000 + Math.max(0, l.inPoint - t) * 1000));
    els.push(el);
  }
  return () => {
    timers.forEach(clearTimeout);
    els.forEach((e) => (e.pause(), (e.src = "")));
  };
}
