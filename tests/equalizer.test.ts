import { describe, expect, it } from "vitest";
import { fractionToGain, gainToFraction, EQ_FREQUENCIES } from "../src/renderer/components/EqualizerPanel";

/**
 * T17B — conversion entre décibels et position du chevalet. Une erreur ici décalerait toute la
 * courbe par rapport au son réel, sans que rien ne plante.
 */
describe("égaliseur / position des chevalets", () => {
  it("0 dB tombe exactement au milieu", () => {
    expect(gainToFraction(0)).toBe(0.5);
    expect(fractionToGain(0.5)).toBe(0);
  });

  it("les extrêmes sont les bornes du moteur (−12 / +12 dB)", () => {
    expect(gainToFraction(-12)).toBe(0);
    expect(gainToFraction(12)).toBe(1);
    expect(fractionToGain(0)).toBe(-12);
    expect(fractionToGain(1)).toBe(12);
  });

  it("borne au-delà des extrêmes au lieu de sortir du cadre", () => {
    expect(gainToFraction(-40)).toBe(0);
    expect(gainToFraction(40)).toBe(1);
    expect(fractionToGain(-3)).toBe(-12);
    expect(fractionToGain(4)).toBe(12);
  });

  it("arrondit au demi-décibel (la précision affichée)", () => {
    expect(fractionToGain(0.6)).toBeCloseTo(2.5, 5);
    expect(fractionToGain(0.5417)).toBeCloseTo(1, 1);
  });

  it("couvre bien 10 bandes, du grave à l'aigu", () => {
    expect(EQ_FREQUENCIES).toHaveLength(10);
    expect(EQ_FREQUENCIES[0]).toBe(31);
    expect(EQ_FREQUENCIES[9]).toBe(16000);
    expect([...EQ_FREQUENCIES].sort((a, b) => a - b)).toEqual([...EQ_FREQUENCIES]);
  });
});
