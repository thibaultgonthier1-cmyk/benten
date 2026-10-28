import { useCallback, useEffect, useState } from "react";
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
}

/** API playlists exposée par le preload, ou `undefined` hors fenêtre (tests node). */
function playlistsApi(): typeof window.benten.playlists | undefined {
  return typeof window !== "undefined" ? window.benten?.playlists : undefined;
}

export function Playlists({ onPlay }: PlaylistsProps): JSX.Element {
  const [playlists, setPlaylists] = useState<PlaylistRow[]>([]);
  const [openId, setOpenId] = useState<number | null>(null);
  const [tracks, setTracks] = useState<TrackRow[]>([]);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);

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

  const rename = useCallback(
    async (p: PlaylistRow): Promise<void> => {
      const api = playlistsApi();
      if (!api) return;
      const next = window.prompt("Renommer la playlist", p.name)?.trim();
      if (!next || next === p.name) return;
      await api.rename(p.id, next);
      await reloadList();
    },
    [reloadList],
  );

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
          Creer
        </button>
      </div>

      {playlists.length === 0 ? (
        <div className="scan-note">Aucune playlist pour l'instant. Cree-en une ci-dessus.</div>
      ) : (
        <ul className="pl-list">
          {playlists.map((p) => (
            <li key={p.id} className={"pl-row" + (p.id === openId ? " open" : "")}>
              <button className="pl-main" type="button" onClick={() => void open(p.id)}>
                <span className="pl-name">{p.name}</span>
                <span className="pl-count">{p.trackCount} pistes</span>
              </button>
              <div className="pl-actions">
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
                <button className="pl-btn" type="button" onClick={() => void rename(p)} title="Renommer">
                  Renommer
                </button>
                <button className="pl-btn danger" type="button" onClick={() => void remove(p)} title="Supprimer">
                  Supprimer
                </button>
              </div>
            </li>
          ))}
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
