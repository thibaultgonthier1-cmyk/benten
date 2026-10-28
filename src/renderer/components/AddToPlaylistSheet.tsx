import { useEffect, useRef, useState } from "react";
import type { PlaylistRow } from "../../shared/types";
import { useFocusTrap } from "../lib/focusTrap";

/**
 * Feuille « Ajouter à une playlist » (DA Benten, focus-trapped). Liste les playlists existantes
 * (`window.benten.playlists.list`) et propose « Nouvelle playlist » ; sélectionner une playlist
 * appelle `playlists.add(id, trackIds)`, créer+ajouter enchaîne `create` puis `add`. C'est le point
 * d'entrée qui rend les playlists créées depuis l'UI réellement remplissables (Task 10, replié ici).
 *
 * Accès défensif à `window.benten.playlists` : `undefined` hors fenêtre Electron (tests), où la
 * feuille se rend vide sans jeter. Fermée, `.sheet-wrap` passe en `display:none`.
 */
export interface AddToPlaylistSheetProps {
  open: boolean;
  onClose: () => void;
  /** Ids des pistes à ajouter (album entier ou piste unique). */
  trackIds: readonly number[];
  /** Libellé de ce qu'on ajoute (titre d'album / de piste), pour le sous-titre. */
  label?: string;
}

function playlistsApi(): typeof window.benten.playlists | undefined {
  return typeof window !== "undefined" ? window.benten?.playlists : undefined;
}

export function AddToPlaylistSheet({
  open,
  onClose,
  trackIds,
  label,
}: AddToPlaylistSheetProps): JSX.Element {
  const [lists, setLists] = useState<PlaylistRow[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useFocusTrap(ref, { active: open, onEscape: onClose });

  // Recharge la liste à chaque ouverture (elle a pu changer depuis la vue Playlists).
  useEffect(() => {
    if (!open) return;
    setDone(null);
    setName("");
    let alive = true;
    const api = playlistsApi();
    if (!api) {
      setLists([]);
      return;
    }
    api
      .list()
      .then((l) => {
        if (alive) setLists(l);
      })
      .catch(() => {
        if (alive) setLists([]);
      });
    return () => {
      alive = false;
    };
  }, [open]);

  const addTo = async (id: number, plName: string): Promise<void> => {
    const api = playlistsApi();
    if (!api || busy || trackIds.length === 0) return;
    setBusy(true);
    try {
      await api.add(id, trackIds);
      setDone(`Ajouté à « ${plName} »`);
    } finally {
      setBusy(false);
    }
  };

  const createAndAdd = async (): Promise<void> => {
    const api = playlistsApi();
    const n = name.trim();
    if (!api || !n || busy || trackIds.length === 0) return;
    setBusy(true);
    try {
      const id = await api.create(n);
      await api.add(id, trackIds);
      setName("");
      setDone(`Créée et remplie : « ${n} »`);
    } finally {
      setBusy(false);
    }
  };

  const count = trackIds.length;

  return (
    <div className={"sheet-wrap atp-wrap" + (open ? " open" : "")} aria-hidden={!open}>
      <button
        className="sheet-scrim"
        type="button"
        aria-label="Fermer"
        tabIndex={open ? 0 : -1}
        onClick={onClose}
      />
      <div
        ref={ref}
        className="sheet atp-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Ajouter à une playlist"
      >
        <button
          className="sheet-close"
          type="button"
          aria-label="Fermer"
          tabIndex={open ? 0 : -1}
          onClick={onClose}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>

        <h3>Ajouter à une playlist</h3>
        <p className="sub">
          {label ? `${label} — ` : ""}
          {count <= 1 ? "1 piste" : `${count} pistes`}
        </p>

        <div className="scan-row pl-create atp-create">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Nouvelle playlist…"
            aria-label="Nom de la nouvelle playlist"
            spellCheck={false}
            disabled={busy}
            tabIndex={open ? 0 : -1}
            onKeyDown={(e) => {
              if (e.key === "Enter") void createAndAdd();
            }}
          />
          <button
            className="btn"
            type="button"
            onClick={() => void createAndAdd()}
            disabled={busy || !name.trim()}
            tabIndex={open ? 0 : -1}
          >
            Créer + ajouter
          </button>
        </div>

        {lists.length === 0 ? (
          <div className="scan-note">Aucune playlist pour l'instant. Crée-en une ci-dessus.</div>
        ) : (
          <ul className="atp-list">
            {lists.map((p) => (
              <li key={p.id}>
                <button
                  className="atp-item"
                  type="button"
                  onClick={() => void addTo(p.id, p.name)}
                  disabled={busy}
                  tabIndex={open ? 0 : -1}
                >
                  <span className="atp-name">{p.name}</span>
                  <span className="atp-count">{p.trackCount} pistes</span>
                  <span className="atp-plus" aria-hidden="true">
                    +
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {done && (
          <p className="scan-note atp-done" role="status">
            {done}
          </p>
        )}
      </div>
    </div>
  );
}
