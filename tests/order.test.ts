import { describe, expect, it } from "vitest";
import { buildOrder, nextInOrder, prevInOrder, type RepeatMode } from "../src/renderer/audio/order";

/**
 * `order.ts` — logique PURE de l'ordre de lecture (shuffle) et de la navigation (repeat).
 *
 * `order` est une permutation d'indices dans `queue` ; `pos` est une position DANS `order`.
 * `buildOrder` est deterministe pour une graine donnee (PRNG seede) : la piste `current` est
 * placee en tete (position 0), le reste est melange (Fisher-Yates) apres elle.
 */
describe("order — buildOrder (shuffle deterministe)", () => {
  it("identite quand shuffle est faux", () => {
    expect(buildOrder(5, { shuffle: false })).toEqual([0, 1, 2, 3, 4]);
    expect(buildOrder(1, { shuffle: false })).toEqual([0]);
    expect(buildOrder(0, { shuffle: false })).toEqual([]);
  });

  it("shuffle seede -> permutation deterministe, meme resultat pour la meme graine", () => {
    const a = buildOrder(8, { shuffle: true, seed: 12345, current: 0 });
    const b = buildOrder(8, { shuffle: true, seed: 12345, current: 0 });
    expect(a).toEqual(b); // deterministe
    // C'est bien une permutation de [0..7] (chaque indice exactement une fois).
    expect([...a].sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("place `current` en position 0 et melange le reste apres", () => {
    const o = buildOrder(6, { shuffle: true, seed: 999, current: 3 });
    expect(o[0]).toBe(3); // la piste courante reste courante
    expect([...o].sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4, 5]);
    // Des graines differentes donnent (tres probablement) des ordres differents de la queue.
    const o2 = buildOrder(6, { shuffle: true, seed: 1000, current: 3 });
    expect(o2[0]).toBe(3);
    expect(o).not.toEqual(o2);
  });

  it("melange reellement (pas l'identite) pour une graine donnee", () => {
    const o = buildOrder(8, { shuffle: true, seed: 42, current: 0 });
    expect(o).not.toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("current hors bornes ou absent -> permutation complete sans tete imposee", () => {
    const o = buildOrder(4, { shuffle: true, seed: 7 });
    expect([...o].sort((x, y) => x - y)).toEqual([0, 1, 2, 3]);
  });
});

describe("order — nextInOrder / prevInOrder (repeat)", () => {
  const order = [0, 1, 2];

  it("nextInOrder respecte repeat aux bornes", () => {
    expect(nextInOrder(order, 2, "off")).toBeNull(); // fin de file, pas de repeat
    expect(nextInOrder(order, 2, "all")).toBe(0); // boucle au debut
    expect(nextInOrder(order, 2, "one")).toBe(2); // meme position (loop d'une piste)
    expect(nextInOrder(order, 0, "off")).toBe(1); // milieu : avance normalement
    expect(nextInOrder(order, 1, "all")).toBe(2);
  });

  it("prevInOrder est symetrique", () => {
    expect(prevInOrder(order, 0, "off")).toBeNull(); // debut de file, pas de repeat
    expect(prevInOrder(order, 0, "all")).toBe(2); // boucle a la fin
    expect(prevInOrder(order, 0, "one")).toBe(0); // meme position
    expect(prevInOrder(order, 2, "off")).toBe(1);
    expect(prevInOrder(order, 1, "all")).toBe(0);
  });

  it("order vide -> null quel que soit repeat", () => {
    const modes: RepeatMode[] = ["off", "all", "one"];
    for (const m of modes) {
      expect(nextInOrder([], 0, m)).toBeNull();
      expect(prevInOrder([], 0, m)).toBeNull();
    }
  });
});
