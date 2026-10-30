import { describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import { bindErrorToasts } from "../src/renderer/state/errorToasts";

/** Échecs de lecture (bibliothèque, playlists) : un toast à l'entrée en erreur, pas à chaque essai. */

describe("bindErrorToasts", () => {
  it("toast quand la bibliothèque ou la liste des playlists passe en erreur, une fois par série", () => {
    const library = createStore(() => ({ loadError: false }));
    const playlists = createStore(() => ({ error: false }));
    const toast = vi.fn();
    const off = bindErrorToasts({ library, playlists, toast });

    library.setState({ loadError: true });
    library.setState({ loadError: true });
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0]![0]).toMatch(/bibliothèque/);

    playlists.setState({ error: true });
    expect(toast).toHaveBeenCalledTimes(2);
    expect(toast.mock.calls[1]![0]).toMatch(/playlists/);

    playlists.setState({ error: false });
    playlists.setState({ error: true });
    expect(toast).toHaveBeenCalledTimes(3);

    off();
    library.setState({ loadError: false });
    library.setState({ loadError: true });
    expect(toast).toHaveBeenCalledTimes(3);
  });
});
