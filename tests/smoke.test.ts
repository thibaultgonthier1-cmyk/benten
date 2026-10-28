import { describe, it, expect } from "vitest";

describe("smoke", () => {
  it("charge la config partagée sans erreur", async () => {
    const { CHANNELS } = await import("../src/shared/channels");
    expect(CHANNELS.LIBRARY_QUERY).toBeTypeOf("string");
  });
});
