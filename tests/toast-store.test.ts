import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createToastStore,
  toast,
  toastStore,
  TOAST_DEFAULT_MS,
  TOAST_MAX,
} from "../src/renderer/ui/toastStore";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  toastStore.getState().clear();
  vi.useRealTimers();
});

const messages = (s = toastStore) => s.getState().toasts.map((t) => t.message);

describe("toast store", () => {
  it("défauts : 2600 ms, 3 toasts au plus", () => {
    expect(TOAST_DEFAULT_MS).toBe(2600);
    expect(TOAST_MAX).toBe(3);
  });

  it("4 toasts → 3 visibles, le plus récent l'emporte (le plus ancien sort)", () => {
    toast("un");
    toast("deux");
    toast("trois");
    toast("quatre");
    expect(messages()).toEqual(["deux", "trois", "quatre"]);
  });

  it("disparaît après 2600 ms", () => {
    toast("Ajouté à la file");
    vi.advanceTimersByTime(2599);
    expect(messages()).toEqual(["Ajouté à la file"]);
    vi.advanceTimersByTime(1);
    expect(messages()).toEqual([]);
  });

  it("durée personnalisée, ids uniques, renvoie l'id", () => {
    const a = toast("a", { durationMs: 500 });
    const b = toast("b");
    expect(a).not.toBe(b);
    vi.advanceTimersByTime(500);
    expect(messages()).toEqual(["b"]);
  });

  it("le toast évincé par le 4e n'a plus de minuteur actif (aucune fuite)", () => {
    const s = createToastStore();
    s.getState().push("1");
    s.getState().push("2");
    s.getState().push("3");
    s.getState().push("4");
    expect(vi.getTimerCount()).toBe(3);
  });

  it("dismiss retire immédiatement ; l'action est conservée", () => {
    const onClick = vi.fn();
    const id = toast("Supprimé", { action: { label: "Annuler", onClick } });
    const t = toastStore.getState().toasts[0]!;
    expect(t.action?.label).toBe("Annuler");
    toastStore.getState().dismiss(id);
    expect(messages()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("pause (survol) suspend l'expiration ; resume repart du temps restant", () => {
    const id = toast("x");
    vi.advanceTimersByTime(2000);
    toastStore.getState().pause(id);
    vi.advanceTimersByTime(10_000);
    expect(messages()).toEqual(["x"]);
    toastStore.getState().resume(id);
    vi.advanceTimersByTime(599);
    expect(messages()).toEqual(["x"]);
    vi.advanceTimersByTime(1);
    expect(messages()).toEqual([]);
  });
});
