import { describe, expect, it, vi } from "vitest";
import { createSleepTimer, FADE_SECONDS, type SleepTimerDeps } from "../src/renderer/runtime/sleepTimer";

/**
 * T17 — minuteur de sommeil : fondu, pause, puis **restauration** du volume. Sans la restauration,
 * l'app se réveillerait muette et l'utilisateur croirait à une panne.
 */

interface Harness {
  deps: SleepTimerDeps;
  advance(ms: number): void;
  volume(): number;
  paused(): number;
  fades(): { to: number; seconds: number }[];
  endTrack(): void;
}

function harness(startVolume = 0.8): Harness {
  let clock = 0;
  let volume = startVolume;
  let pauses = 0;
  const fades: { to: number; seconds: number }[] = [];
  const timers = new Map<number, { at: number; fn: () => void }>();
  let nextId = 1;
  const trackListeners = new Set<() => void>();

  const deps: SleepTimerDeps = {
    now: () => clock,
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: clock + ms, fn });
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id as number);
    },
    fade: (to, seconds) => fades.push({ to, seconds }),
    pause: () => {
      pauses += 1;
    },
    getVolume: () => volume,
    setVolume: (v) => {
      volume = v;
    },
    onTrackEnd: (cb) => {
      trackListeners.add(cb);
      return () => trackListeners.delete(cb);
    },
  };

  return {
    deps,
    advance(ms) {
      clock += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= clock) {
          timers.delete(id);
          timer.fn();
        }
      }
    },
    volume: () => volume,
    paused: () => pauses,
    fades: () => fades,
    endTrack() {
      for (const cb of [...trackListeners]) cb();
    },
  };
}

describe("sleepTimer", () => {
  it("à l'échéance : fondu de 8 s vers 0, pause, puis volume d'origine restauré", () => {
    const h = harness(0.8);
    const timer = createSleepTimer(h.deps);
    timer.start(15);
    expect(timer.remainingSec()).toBe(15 * 60);

    h.advance(15 * 60 * 1000);
    expect(h.fades()).toEqual([{ to: 0, seconds: FADE_SECONDS }]);
    expect(h.paused()).toBe(0); // la pause vient APRÈS le fondu

    h.advance(FADE_SECONDS * 1000);
    expect(h.paused()).toBe(1);
    expect(h.volume()).toBe(0.8);
    expect(timer.mode()).toBe("off");
  });

  it("annulé avant l'échéance : rien ne se passe", () => {
    const h = harness();
    const timer = createSleepTimer(h.deps);
    timer.start(30);
    h.advance(10 * 60 * 1000);
    timer.cancel();
    h.advance(60 * 60 * 1000);
    expect(h.fades()).toEqual([]);
    expect(h.paused()).toBe(0);
    expect(timer.remainingSec()).toBeNull();
  });

  it("« fin du titre » : pause au premier changement de piste, une seule fois", () => {
    const h = harness(0.5);
    const timer = createSleepTimer(h.deps);
    timer.startEndOfTrack();
    expect(timer.mode()).toBe("end-of-track");

    h.endTrack();
    h.advance(FADE_SECONDS * 1000);
    expect(h.paused()).toBe(1);
    expect(h.volume()).toBe(0.5);

    h.endTrack();
    h.advance(FADE_SECONDS * 1000);
    expect(h.paused()).toBe(1); // pas de seconde pause
  });

  it("remainingSec décroît, puis devient null une fois le minuteur désarmé", () => {
    const h = harness();
    const timer = createSleepTimer(h.deps);
    timer.start(15);
    h.advance(60 * 1000);
    expect(timer.remainingSec()).toBe(14 * 60);
    // Une seconde avant l'échéance, il reste 1 s (jamais de valeur négative).
    h.advance(14 * 60 * 1000 - 1000);
    expect(timer.remainingSec()).toBe(1);
    // À l'échéance, le minuteur se désarme : plus de compte à rebours à afficher.
    h.advance(2000);
    expect(timer.remainingSec()).toBeNull();
    expect(timer.mode()).toBe("off");
  });

  it("start remplace un minuteur déjà armé", () => {
    const h = harness();
    const timer = createSleepTimer(h.deps);
    timer.start(15);
    h.advance(60 * 1000);
    timer.start(60);
    expect(timer.remainingSec()).toBe(60 * 60);
    h.advance(15 * 60 * 1000);
    expect(h.fades()).toEqual([]); // l'ancien minuteur a bien été désarmé
  });
});

