import { useCallback, useEffect, useRef, useState } from "react";
import type { PlaylistRow, TrackRow } from "../../shared/types";
import { artUrl, formatTime } from "../lib/library";

/**
 * Vue Playlists (DA Benten) : liste des playlists, création / renommage / suppression, ouverture
 * d'une playlist (affiche ses pistes ordonnées) et lecture (remplit la file via `onPlay`, qui
 * réutilise le chemin `controls.playAlbum` d'App). Les pistes d'une playlist ouverte se retirent et
 * se réordonnent (haut/bas) — chaque mutation passe par l'IPC `playlists:*` puis recharge l'état.
 *
 * Accès défensif à `window.benten.playlists` : `undefined` hors fenêtre Electron (tests), où la vue
 * se rend alors vide sans jeter.
 */
export interface PlaylistsProps {
  /** Lance la lecture d'une liste de pistes depuis `index` (remplit la file + ouvre la lecture). */
  onPlay: (tracks: readonly TrackRow[], index?: number) => void;
  /** Demande de création (bouton + de la barre latérale) : focalise le champ « nouvelle playlist ». */
  createFocusRequested?: boolean;
  /** Appelé une fois le champ focalisé (consomme la demande). */
  onCreateFocused?: () => void;
}

/** API playlists exposée par le preload, ou `undefined` hors fenêtre (tests node). */
function playlistsApi(): typeof window.benten.playlists | undefined {
  return typeof window !== "undefined" ? window.benten?.playlists : undefined;
}

export function Playlists({
  onPlay,
  createFocusRequested = false,
  onCreateFocused,
}: PlaylistsProps): JSX.Element {
  const createInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!createFocusRequested) return;
    createInputRef.current?.focus();
    onCreateFocused?.();
  }, [createFocusRequested, onCreateFocused]);

  const [playlists, setPlaylists] = useState<PlaylistRow[]>([]);
  const [openId, setOpenId] = useState<number | null>(null);
  const [tracks, setTracks] = useState<TrackRow[]>([]);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  // Renommage INLINE (Electron Chromium n'implemente pas window.prompt) : la ligne editee devient
  // un <input> ; Entree valide, Echap annule.
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");

  const reloadList = useCallback(async (): Promise<void> => {
    const api = playlistsApi();
    if (!api) return;
    setPlaylists(await api.list());
  }, []);

  const reloadTracks = useCallback(async (id: number): Promise<void> => {
    const api = playlistsApi();
    if (!api) return;
    setTracks(await api.tracks(id));
  }, []);

  useEffect(() => {
    void reloadList();
  }, [reloadList]);

  const open = useCallback(
    async (id: number): Promise<void> => {
      setOpenId(id);
      await reloadTracks(id);
    },
    [reloadTracks],
  );

  const create = useCallback(async (): Promise<void> => {
    const api = playlistsApi();
    const name = newName.trim();
    if (!api || !name || busy) return;
    setBusy(true);
    try {
      const id = await api.create(name);
      setNewName("");
      await reloadList();
      await open(id);
    } finally {
      setBusy(false);
    }
  }, [newName, busy, reloadList, open]);

  const startRename = useCallback((p: PlaylistRow): void => {
    setEditingId(p.id);
    setEditName(p.name);
  }, []);

  const cancelRename = useCallback((): void => {
    setEditingId(null);
    setEditName("");
  }, []);

  const commitRename = useCallback(async (): Promise<void> => {
    const api = playlistsApi();
    const id = editingId;
    if (id == null) return;
    const next = editName.trim();
    const current = playlists.find((p) => p.id === id);
    setEditingId(null);
    setEditName("");
    // Rien a faire si vide ou inchange (ou hors fenetre) : on a deja referme l'edition.
    if (!api || !next || next === current?.name) return;
    await api.rename(id, next);
    await reloadList();
  }, [editingId, editName, playlists, reloadList]);

  const remove = useCallback(
    async (p: PlaylistRow): Promise<void> => {
      const api = playlistsApi();
      if (!api) return;
      if (!window.confirm(`Supprimer « ${p.name} » ?`)) return;
      await api.remove(p.id);
      if (openId === p.id) {
        setOpenId(null);
        setTracks([]);
      }
      await reloadList();
    },
    [openId, reloadList],
  );

  const playPlaylist = useCallback(
    async (p: PlaylistRow): Promise<void> => {
      const api = playlistsApi();
      if (!api) return;
      const rows = await api.tracks(p.id);
      if (rows.length > 0) onPlay(rows, 0);
    },
    [onPlay],
  );

  const removeTrack = useCallback(
    async (position: number): Promise<void> => {
      const api = playlistsApi();
      if (!api || openId == null) return;
      await api.removeTrack(openId, position);
      await reloadTracks(openId);
      await reloadList();
    },
    [openId, reloadTracks, reloadList],
  );

  const move = useCallback(
    async (from: number, to: number): Promise<void> => {
      const api = playlistsApi();
      if (!api || openId == null || to < 0 || to >= tracks.length) return;
      await api.reorder(openId, from, to);
      await reloadTracks(openId);
      await reloadList();
    },
    [openId, tracks.length, reloadTracks, reloadList],
  );

  const opened = openId != null ? playlists.find((p) => p.id === openId) : undefined;

  return (
    <section className="section">
      <div className="section-head">
        <h2>Playlists</h2>
        <span className="count">{`${playlists.length} playlists`}</span>
      </div>

      <div className="scan-row pl-create">
        <input
          ref={createInputRef}
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="Nom de la nouvelle playlist"
          spellCheck={false}
          disabled={busy}
          onKeyDown={(e) => {
            if (e.key === "Enter") void create();
          }}
        />
        <button className="btn" type="button" onClick={() => void create()} disabled={busy || !newName.trim()}>
          Créer
        </button>
      </div>

      {playlists.length === 0 ? (
        <div className="scan-note">Aucune playlist pour l'instant. Crée-en une ci-dessus.</div>
      ) : (
        <ul className="pl-list">
          {playlists.map((p) => {
            const editing = p.id === editingId;
            return (
              <li
                key={p.id}
                className={"pl-row" + (p.id === openId ? " open" : "") + (editing ? " editing" : "")}
              >
                {editing ? (
                  <input
                    className="pl-rename-input"
                    value={editName}
                    autoFocus
                    spellCheck={false}
                    aria-label="Nouveau nom de la playlist"
                    onChange={(e) => setEditName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void commitRename();
                      else if (e.key === "Escape") cancelRename();
                    }}
                  />
                ) : (
                  <button className="pl-main" type="button" onClick={() => void open(p.id)}>
                    <span className="pl-name">{p.name}</span>
                    <span className="pl-count">{p.trackCount} pistes</span>
                  </button>
                )}
                <div className="pl-actions">
                  {editing ? (
                    <>
                      <button className="pl-btn accent" type="button" onClick={() => void commitRename()} title="Valider">
                        OK
                      </button>
                      <button className="pl-btn" type="button" onClick={cancelRename} title="Annuler">
                        Annuler
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        className="pl-btn"
                        type="button"
                        onClick={() => void playPlaylist(p)}
                        disabled={p.trackCount === 0}
                        aria-label={`Lire ${p.name}`}
                        title="Lire"
                      >
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <path d="M8 5v14l11-7z" />
                        </svg>
                      </button>
                      <button className="pl-btn" type="button" onClick={() => startRename(p)} title="Renommer">
                        Renommer
                      </button>
                      <button className="pl-btn danger" type="button" onClick={() => void remove(p)} title="Supprimer">
                        Supprimer
                      </button>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {opened && (
        <div className="pl-detail">
          <div className="section-head">
            <h2>{opened.name}</h2>
            <span className="count">{`${tracks.length} pistes`}</span>
          </div>
          {tracks.length === 0 ? (
            <div className="scan-note">Cette playlist est vide.</div>
          ) : (
            <ul className="pl-tracks">
              {tracks.map((t, i) => (
                <li key={`${t.id}-${i}`} className="pl-track">
                  <button
                    className="pl-track-play"
                    type="button"
                    onClick={() => onPlay(tracks, i)}
                    title="Lire depuis cette piste"
                  >
                    <span className="pl-track-no">{i + 1}</span>
                    {artUrl(t.artKey, 64) ? (
                      <img className="pl-track-art" src={artUrl(t.artKey, 64)!} alt="" />
                    ) : (
                      <span className="pl-track-art placeholder" aria-hidden="true" />
                    )}
                    <span className="pl-track-meta">
                      <span className="pl-track-title">{t.title}</span>
                      <span className="pl-track-artist">{t.artist}</span>
                    </span>
                    <span className="pl-track-dur">{formatTime(t.durationSec)}</span>
                  </button>
                  <div className="pl-track-actions">
                    <button
                      className="pl-btn"
                      type="button"
                      onClick={() => void move(i, i - 1)}
                      disabled={i === 0}
                      aria-label="Monter"
                      title="Monter"
                    >
                      ↑
                    </button>
                    <button
                      className="pl-btn"
                      type="button"
                      onClick={() => void move(i, i + 1)}
                      disabled={i === tracks.length - 1}
                      aria-label="Descendre"
                      title="Descendre"
                    >
                      ↓
                    </button>
                    <button
                      className="pl-btn danger"
                      type="button"
                      onClick={() => void removeTrack(i)}
                      aria-label="Retirer"
                      title="Retirer"
                    >
                      ✕
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
