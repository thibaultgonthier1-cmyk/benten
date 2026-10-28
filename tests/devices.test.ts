import { describe, expect, it } from "vitest";
import { defaultOutputDevice } from "../src/main/audio/devices";

describe("defaultOutputDevice", () => {
  it("renvoie un objet avec un nom non vide, sans jamais lever", () => {
    let dev!: ReturnType<typeof defaultOutputDevice>;
    expect(() => {
      dev = defaultOutputDevice();
    }).not.toThrow();
    expect(dev).toBeTypeOf("object");
    expect(typeof dev.name).toBe("string");
    expect(dev.name.trim().length).toBeGreaterThan(0);
  });

  it("renvoie un sampleRate positif quand il est present (sinon absent)", () => {
    const dev = defaultOutputDevice();
    if (dev.sampleRate !== undefined) {
      expect(typeof dev.sampleRate).toBe("number");
      expect(dev.sampleRate).toBeGreaterThan(0);
    }
  });

  it("reste stable sur plusieurs appels (jamais d'exception)", () => {
    for (let i = 0; i < 3; i++) {
      expect(() => defaultOutputDevice()).not.toThrow();
      expect(defaultOutputDevice().name.trim().length).toBeGreaterThan(0);
    }
  });
});
