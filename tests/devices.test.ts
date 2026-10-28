import { describe, expect, it } from "vitest";
import { defaultOutputDevice, listOutputDevices } from "../src/main/audio/devices";

describe("defaultOutputDevice", () => {
  it("renvoie un objet avec un nom non vide, sans jamais rejeter", async () => {
    const dev = await defaultOutputDevice();
    expect(dev).toBeTypeOf("object");
    expect(typeof dev.name).toBe("string");
    expect(dev.name.trim().length).toBeGreaterThan(0);
  });

  it("renvoie un sampleRate positif quand il est present (sinon absent)", async () => {
    const dev = await defaultOutputDevice();
    if (dev.sampleRate !== undefined) {
      expect(typeof dev.sampleRate).toBe("number");
      expect(dev.sampleRate).toBeGreaterThan(0);
    }
  });

  it("reste stable sur plusieurs appels (jamais de rejet)", async () => {
    for (let i = 0; i < 3; i++) {
      const dev = await defaultOutputDevice();
      expect(dev.name.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("listOutputDevices", () => {
  it("renvoie un tableau NON VIDE de peripheriques nommes, sans jamais rejeter", async () => {
    const list = await listOutputDevices();
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBeGreaterThan(0); // repli nomme au minimum
    for (const dev of list) {
      expect(typeof dev.name).toBe("string");
      expect(dev.name.trim().length).toBeGreaterThan(0);
      if (dev.sampleRate !== undefined) {
        expect(dev.sampleRate).toBeGreaterThan(0);
      }
    }
  });

  it("reste stable sur plusieurs appels (jamais de rejet, jamais vide)", async () => {
    for (let i = 0; i < 3; i++) {
      const list = await listOutputDevices();
      expect(list.length).toBeGreaterThan(0);
    }
  });
});
