import { describe, expect, it } from "vitest";
import { canTempoMatch, tempoMatchRatio } from "../src/renderer/audio/beats";

/**
 * Accord de tempo : on ne touche à la vitesse que pour de petits écarts, parce que `playbackRate`
 * déforme aussi la hauteur. Au-delà de 6 %, mieux vaut laisser la piste à son tempo.
 */
describe("tempoMatchRatio", () => {
  it("ne touche à rien quand les tempos sont identiques", () => {
    expect(tempoMatchRatio(120, 120)).toBe(1);
  });

  it("accélère l'entrante plus lente pour coller au tempo sortant", () => {
    // 120 / 114 = 1,0526 -> l'entrante doit jouer 5,3 % plus vite
    expect(tempoMatchRatio(120, 114)).toBeCloseTo(1.053, 3);
  });

  it("ralentit l'entrante plus rapide", () => {
    expect(tempoMatchRatio(100, 104)).toBeCloseTo(0.962, 3);
  });

  it("refuse au-delà de 6 % d'écart", () => {
    expect(tempoMatchRatio(120, 90)).toBe(1); // 1,33 : trop loin
    expect(canTempoMatch(120, 90)).toBe(false);
  });

  it("accepte à la limite", () => {
    expect(canTempoMatch(120, 113.5)).toBe(true);
  });

  it("ne devine rien sans tempo connu", () => {
    expect(tempoMatchRatio(null, 120)).toBe(1);
    expect(tempoMatchRatio(120, null)).toBe(1);
    expect(tempoMatchRatio(0, 120)).toBe(1);
  });
});
