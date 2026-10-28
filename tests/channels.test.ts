import { describe, it, expect } from "vitest";
import { CHANNELS } from "../src/shared/channels";

describe("CHANNELS", () => {
  const entries = Object.entries(CHANNELS);

  it("déclare au moins le canal PING", () => {
    expect(CHANNELS.PING).toBeTypeOf("string");
  });

  it("n'a aucun nom de canal vide", () => {
    for (const [key, name] of entries) {
      expect(name.trim().length, `canal ${key} vide`).toBeGreaterThan(0);
    }
  });

  it("n'a aucun nom de canal en double", () => {
    const names = entries.map(([, name]) => name);
    expect(new Set(names).size).toBe(names.length);
  });
});
