import { describe, it, expect } from "vitest";
import { parseArgs, withTimeout } from "../scripts/cdp-smoke.mjs";

describe("cdp-smoke parseArgs", () => {
  it("parse le port et l'expr avec le timeout par défaut", () => {
    expect(parseArgs(["--port", "9222", "--expr", "x"])).toEqual({
      port: 9222,
      timeout: 20000,
      expr: "x",
    });
  });

  it("parse un timeout explicite", () => {
    expect(parseArgs(["--port", "9333", "--timeout", "5000", "--expr", "y"])).toEqual({
      port: 9333,
      timeout: 5000,
      expr: "y",
    });
  });

  it("applique les valeurs par défaut (port 9222, timeout 20000)", () => {
    const args = parseArgs([]);
    expect(args.port).toBe(9222);
    expect(args.timeout).toBe(20000);
    expect(args.expr).toBeUndefined();
    expect(args.screenshot).toBeUndefined();
  });

  it("parse --screenshot <file.png>", () => {
    expect(parseArgs(["--screenshot", "a.png"]).screenshot).toBe("a.png");
    expect(parseArgs(["--expr", "x", "--screenshot", "design/screens/t1.png"])).toEqual({
      port: 9222,
      timeout: 20000,
      expr: "x",
      screenshot: "design/screens/t1.png",
    });
  });
});

describe("cdp-smoke withTimeout", () => {
  it("résout si la promesse se règle avant le délai", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 1000)).resolves.toBe("ok");
  });

  it("rejette après le délai imparti", async () => {
    const never = new Promise<string>((resolve) => {
      setTimeout(() => resolve("tard"), 1000);
    });
    await expect(withTimeout(never, 10)).rejects.toThrow(/timeout/i);
  });
});
