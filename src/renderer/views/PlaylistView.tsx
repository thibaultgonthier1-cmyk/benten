import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  CircleAlert,
  Clock3,
  Disc3,
  Ellipsis,
  GripVertical,
  ListEnd,
  ListMinus,
  ListMusic,
  ListStart,
  Music,
  Pause,
  Pencil,
  Play,
  Shuffle,
  Trash2,
} from "lucide-react";
import type { PlaylistRow, TrackRow } from "../../shared/types";
import { coverColorCache, useCoverColors } from "../lib/useCoverColors";
import {
  artistShowsPause,
  canResume,
  dropIndex,
  moveItem,
  mosaicArtKeys,
  playlistEntryKeys,
  playlistSummary,
  sameTrackList,
  staggerMs,
} from "../lib/viewModels";
import { playerStore, usePlayer } from "../state/player";
import { playlistsStore, usePlaylists } from "../state/playlists";
import { uiStore } from "../state/ui";
import type { RouteViewActions } from "../shell/RouteView";
import { dur, ease } from "../theme/ds/motion";
import { Button } from "../ui/Button";
import { IconButton, ICON_STROKE } from "../ui/IconButton";
import { openMenu } from "../ui/menuStore";
import { PlaylistMosaic } from "../ui/PlaylistMosaic";
import { Skeleton } from "../ui/Skeleton";
import { quoted, toast } from "../ui/toastStore";
import { TrackRowItem } from "../ui/TrackRowItem";
import { useMotion } from "../ui/useMotion";
import { EmptyState } from "./common";
import { HeroCompactBar, useCompactOnScroll, useHeroEnter, useTopTint } from "./hero";
import { anchorBelow, anchorFromEvent, playlistMenuItem, useViewMenus } from "./menus";
import { askDeletePlaylist, consumeRename } from "./playlistActions";
import { playlistAlbum, playPlaylist, shufflePlaylist } from "./playlistPlay";
import { playlistLayoutId } from "./PlaylistsView";
import "./views.css";
import "./playlists.css";

export interface PlaylistViewProps {
  id: number;
  scrollRef: React.RefObject<HTMLElement>;
  actions: RouteViewActions;
}

/** Teinte d'une playlist sans pochette : l'accent de marque. */
const ACCENT_TINT = "var(--accent)";
/** Durée de la cascade d'entrée des lignes (s, avant `m.d`). */
const ROW_IN_SEC = 0.34;

/**
 * Page playlist : en-tête mosaïque (la mosaïque de la tuile y voyage, puis zoome légèrement) teinté
 * par la couleur de sa première pochette (dégradé vers #000 à 60 %), nom RENOMMABLE EN PLACE (clic
 * sur le titre : Entrée / perte du focus enregistrent, Échap annule), « n titres · durée »,
 * Lecture (mélange coupé) / Aléatoire (mélange activé) / ⋯ (Lire ensuite, Ajouter à la file,
 * Ajouter à une playlist ▸, Renommer, Supprimer… via Dialog).
 *
 * Titres dans l'ordre de la playlist (ordre d'ajout), en cascade à l'ouverture. Réordonner au
 * GLISSER (trait d'insertion, `playlists.reorder`) ou Alt+↑/↓ ; retirer par le menu ou Suppr — un
 * toast « Annuler » remet le titre à sa place. Playlist vide : indication (glisser / clic droit).
 */
export function PlaylistView({ id, scrollRef, actions }: PlaylistViewProps): JSX.Element {
  const row = usePlaylists((s) => s.rows.find((r) => r.id === id) ?? null);
  const loaded = usePlaylists((s) => s.loaded);

  useEffect(() => {
    if (!playlistsStore.getState().loaded) void playlistsStore.getState().refresh();
  }, []);

  if (!row) {
    if (!loaded) return <PlaylistSkeleton />;
    return (
      <EmptyState
        icon={ListMusic}
        title="Playlist introuvable"
        text="Elle a peut-être été supprimée."
        action={
          <Button variant="ghost" onClick={() => uiStore.getState().replace({ name: "playlists" })}>
            Voir les playlists
          </Button>
        }
      />
    );
  }
  return <PlaylistPage key={id} row={row} scrollRef={scrollRef} actions={actions} />;
}

function PlaylistPage({
  row,
  scrollRef,
  actions,
}: {
  row: PlaylistRow;
  scrollRef: React.RefObject<HTMLElement>;
  actions: RouteViewActions;
}): JSX.Element {
  const id = row.id;
  const m = useMotion();
  const menus = useViewMenus(actions);
  const rev = usePlaylists((s) => s.rev.get(id) ?? 0);
  const storeArt = usePlaylists((s) => s.art.get(id));
  const [tracks, setTracks] = useState<TrackRow[] | null>(null);
  const [entering, setEntering] = useState(false);
  const firstLoad = useRef(true);

  // Titres : relus à l'ouverture et à chaque mutation (ajout depuis la barre latérale, etc.).
  useEffect(() => {
    let alive = true;
    void playlistsStore
      .getState()
      .tracksOf(id)
      .then((t) => {
        if (!alive) return;
        setTracks(t);
        if (firstLoad.current) {
          firstLoad.current = false;
          if (m.enabled && t.length > 0) setEntering(true);
        }
      });
    return () => {
      alive = false;
    };
  }, [id, rev]);
  useEffect(() => {
    if (!entering) return;
    const ms = staggerMs(99) + Math.round(m.d(ROW_IN_SEC) * 1000) + 80;
    const t = setTimeout(() => setEntering(false), ms);
    return () => clearTimeout(t);
  }, [entering]);

  const list = tracks ?? [];
  const keys = useMemo(() => playlistEntryKeys(list), [list]);
  const art = tracks ? mosaicArtKeys(tracks) : (storeArt ?? []);
  const seed = `playlist:${id}`;
  // Abonnement : l'en-tête se re-teinte quand la couleur de la 1re pochette est extraite.
  useCoverColors(art[0] ?? null, seed);
  const resolved = art[0] ? coverColorCache.peek(art[0]) : null;
  const tint = art[0] ? (resolved?.vibrant ?? null) : ACCENT_TINT;

  useTopTint(scrollRef, tint);
  const actionsRef = useRef<HTMLDivElement>(null);
  const compact = useCompactOnScroll(scrollRef, actionsRef);
  const enter = useHeroEnter();

  // --- Lecture ---------------------------------------------------------------------------------
  const isThisQueue = usePlayer((s) => tracks !== null && sameTrackList(s.queue, tracks));
  const isPlaying = usePlayer((s) => tracks !== null && artistShowsPause(s.queue, s.status === "playing", tracks));
  const playingIndex = usePlayer((s) => (isThisQueue ? s.currentIndex : -1));
  const currentId = usePlayer((s) => s.currentTrack?.id ?? null);

  const pulseRef = useRef<HTMLDivElement>(null);
  const pulse = (): void => {
    if (!m.enabled) return;
    pulseRef.current?.animate(
      [{ transform: "scale(1)" }, { transform: "scale(1.045)", offset: 0.4 }, { transform: "scale(1)" }],
      { duration: Math.round(m.d(dur.slow) * 1000), easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
    );
  };
  const playPause = (): void => {
    if (!tracks || tracks.length === 0) return;
    if (!isPlaying) pulse();
    playPlaylist(row.name, tracks, actions);
  };
  const shuffle = (): void => {
    if (!tracks || tracks.length === 0) return;
    pulse();
    shufflePlaylist(row.name, tracks, actions);
  };

  const tracksRef = useRef(list);
  tracksRef.current = list;
  const playAt = useCallback(
    (track: TrackRow, index: number): void => {
      const p = playerStore.getState();
      const current = isThisQueue ? p.currentIndex === index : p.currentTrack?.id === track.id;
      if (current && canResume(p.status)) actions.togglePlay();
      else actions.playAlbum(playlistAlbum(row.name, tracksRef.current), index);
    },
    [actions, isThisQueue, row.name],
  );

  // --- Sélection / focus (clés d'entrée : un titre peut figurer deux fois) ----------------------
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const lastIndex = useRef(-1);
  const keysRef = useRef(keys);
  keysRef.current = keys;
  const onRowSelect = useCallback((_t: TrackRow, index: number): void => {
    lastIndex.current = index;
    setSelectedKey(keysRef.current[index] ?? null);
  }, []);
  const onRowFocus = useCallback((t: TrackRow): void => {
    const el = document.activeElement?.closest<HTMLElement>("[data-pl-key]");
    setFocusedKey(el?.dataset.plKey ?? String(t.id));
  }, []);
  const playingKey = playingIndex >= 0 ? keys[playingIndex] : null;
  const tabStop =
    [focusedKey, selectedKey, playingKey].find((k) => k && keys.includes(k)) ?? keys[0] ?? null;

  const focusKey = (key: string): void => {
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-pl-key="${CSS.escape(key)}"] [data-track-row]`)?.focus();
    });
  };

  // --- Mutations (optimistes, puis store → révision → relecture) --------------------------------
  const reload = (): void => {
    void playlistsStore
      .getState()
      .tracksOf(id)
      .then((t) => setTracks(t));
  };

  const reorderTo = (from: number, to: number): void => {
    if (!tracks || from === to || to < 0 || to >= tracks.length) return;
    setTracks(moveItem(tracks, from, to));
    void playlistsStore
      .getState()
      .reorder(id, from, to)
      .then((ok) => {
        if (!ok) {
          toast("Impossible de réordonner la playlist", { icon: CircleAlert });
          reload();
        }
      });
  };

  const removeAt = (index: number): void => {
    const t = tracks?.[index];
    if (!tracks || !t) return;
    setTracks(tracks.filter((_, i) => i !== index));
    void playlistsStore
      .getState()
      .removeAt(id, index)
      .then((ok) => {
        if (!ok) {
          toast(`Impossible de retirer ${quoted(t.title)}`, { icon: CircleAlert });
          reload();
          return;
        }
        toast(`${quoted(t.title)} retiré de ${quoted(row.name)}`, {
          icon: ListMinus,
          durationMs: 5000,
          action: { label: "Annuler", onClick: () => void playlistsStore.getState().restoreAt(id, t.id, index) },
        });
      });
  };

  const onRowMenu = useCallback(
    (track: TrackRow, e: React.MouseEvent<HTMLElement>): void => {
      const index = lastIndex.current;
      void menus.openTrackMenu(track, anchorFromEvent(e), (t) => playAt(t, index), {
        extra: [
          { label: "Retirer de la playlist", icon: ListMinus, danger: true, onSelect: () => removeAt(index) },
        ],
      });
    },
    // `removeAt` lit l'état courant au moment du choix.
    [menus, playAt, tracks],
  );

  // --- Renommer en place ------------------------------------------------------------------------
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(row.name);
  const [shownName, setShownName] = useState(row.name);
  const committing = useRef(false);
  useEffect(() => {
    if (!editing) setShownName(row.name);
  }, [row.name, editing]);
  useEffect(() => {
    if (consumeRename(id)) startEdit();
  }, []);

  function startEdit(): void {
    setDraft(shownName);
    committing.current = false;
    setEditing(true);
  }
  const cancelEdit = (): void => {
    committing.current = true;
    setEditing(false);
  };
  const commitEdit = (): void => {
    if (committing.current) return;
    committing.current = true;
    setEditing(false);
    const name = draft.trim();
    if (!name || name === row.name) return;
    setShownName(name);
    void playlistsStore
      .getState()
      .rename(id, name)
      .then((ok) => {
        if (!ok) {
          setShownName(row.name);
          toast(`Impossible de renommer ${quoted(row.name)}`, { icon: CircleAlert });
        }
      });
  };

  // --- Réordonner au glisser ---------------------------------------------------------------------
  const dragFrom = useRef<number | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<{ over: number; after: boolean; y: number } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const endDrag = (): void => {
    dragFrom.current = null;
    setDragging(null);
    setDropAt(null);
  };
  const onListDragOver = (e: React.DragEvent<HTMLDivElement>): void => {
    const from = dragFrom.current;
    if (from === null || !tracks) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const rowEl = (e.target as HTMLElement).closest<HTMLElement>("[data-pl-index]");
    let over: number;
    let after: boolean;
    let y: number;
    if (rowEl) {
      over = Number(rowEl.dataset.plIndex);
      const r = rowEl.getBoundingClientRect();
      after = e.clientY > r.top + r.height / 2;
      y = rowEl.offsetTop + (after ? rowEl.offsetHeight : 0);
    } else {
      over = tracks.length - 1;
      after = true;
      const last = listRef.current?.querySelector<HTMLElement>(`[data-pl-index="${over}"]`);
      y = last ? last.offsetTop + last.offsetHeight : 0;
    }
    setDropAt((prev) => (prev && prev.over === over && prev.after === after ? prev : { over, after, y }));
  };
  const onListDrop = (e: React.DragEvent<HTMLDivElement>): void => {
    const from = dragFrom.current;
    if (from === null || !dropAt) return endDrag();
    e.preventDefault();
    const to = dropIndex(from, dropAt.over, dropAt.after);
    const key = keys[from];
    endDrag();
    if (to !== from) {
      reorderTo(from, to);
      if (key) setSelectedKey(key);
    }
  };
  const dropMoves = dragging !== null && dropAt !== null && dropIndex(dragging, dropAt.over, dropAt.after) !== dragging;

  // Clavier de la liste (après celui de la ligne) : Alt+↑/↓ déplace, Suppr retire.
  const onListKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const host = (e.target as HTMLElement).closest<HTMLElement>("[data-pl-index]");
    if (!host || !(e.target as HTMLElement).matches("[data-track-row]")) return;
    const index = Number(host.dataset.plIndex);
    const key = keys[index];
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown") && !e.ctrlKey && !e.shiftKey) {
      e.preventDefault();
      const to = index + (e.key === "ArrowUp" ? -1 : 1);
      if (key && to >= 0 && to < list.length) {
        reorderTo(index, to);
        setSelectedKey(key);
        focusKey(key);
      } else if (key) focusKey(key);
    } else if ((e.key === "Delete" || e.key === "Backspace") && !e.altKey && !e.ctrlKey) {
      e.preventDefault();
      const nextKey = keys[index + 1] ?? keys[index - 1] ?? null;
      removeAt(index);
      if (nextKey) focusKey(nextKey);
    }
  };

  // --- Menu « ⋯ » -------------------------------------------------------------------------------
  const openMore = async (e: React.MouseEvent<HTMLElement>): Promise<void> => {
    const a = anchorBelow(e);
    const empty = list.length === 0;
    const addTo = await playlistMenuItem(list, a, { disabled: empty });
    openMenu(
      a.x,
      a.y,
      [
        {
          label: "Lire ensuite",
          icon: ListStart,
          disabled: empty,
          onSelect: () => {
            playerStore.getState().playNext(list);
            toast(`${quoted(row.name)} sera lue ensuite`, { icon: ListStart });
          },
        },
        {
          label: "Ajouter à la file",
          icon: ListEnd,
          disabled: empty,
          onSelect: () => {
            playerStore.getState().addToQueue(list);
            toast(`${quoted(row.name)} ajoutée à la file`, { icon: ListEnd });
          },
        },
        addTo,
        "separator",
        { label: "Renommer", icon: Pencil, onSelect: startEdit },
        { label: "Supprimer la playlist…", icon: Trash2, danger: true, onSelect: () => askDeletePlaylist(row) },
      ],
      { focusFirst: a.focusFirst },
    );
  };

  const summary = tracks ? playlistSummary(tracks) : `${row.trackCount} ${row.trackCount > 1 ? "titres" : "titre"}`;
  const heroStyle = { "--hero": tint ?? "#1c1c20", "--plv-in": `${m.d(ROW_IN_SEC)}s` } as React.CSSProperties;
  const empty = tracks !== null && tracks.length === 0;

  return (
    <div className="album-view playlist-view" style={heroStyle}>
      <HeroCompactBar
        visible={compact}
        playing={isPlaying}
        onPlay={playPause}
        disabled={list.length === 0}
        title={shownName}
        sub={summary}
        artKey={art[0] ?? null}
        seed={seed}
      />

      <section className="album-hero plv-hero" aria-label={`Playlist ${shownName}`}>
        {tint && <div key={tint} className="album-hero__bg" aria-hidden="true" />}
        <motion.div
          className="album-hero__cover plv-cover"
          layoutId={m.enabled ? playlistLayoutId(id) : undefined}
          transition={{ layout: { duration: m.d(dur.slow), ease: ease.out } }}
          style={{ borderRadius: 14 }}
        >
          <motion.div
            className="plv-cover__zoom"
            initial={m.enabled ? { scale: 0.93 } : false}
            animate={{ scale: 1 }}
            transition={m.enabled ? { type: "spring", stiffness: 200, damping: 22, delay: m.d(0.05) } : { duration: 0 }}
          >
            <div ref={pulseRef} className="plv-cover__pulse">
              <PlaylistMosaic artKeys={art} seed={seed} iconSize={64} />
            </div>
          </motion.div>
        </motion.div>
        <motion.div className="album-hero__meta" {...enter(0)}>
          <div className="album-hero__kind">Playlist</div>
          {editing ? (
            <input
              className="album-hero__title plv-title-input"
              aria-label="Nom de la playlist"
              value={draft}
              maxLength={120}
              spellCheck={false}
              autoFocus
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitEdit}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitEdit();
                } else if (e.key === "Escape") {
                  // Consommée ici : le raccourci global « fermer » ne s'y ajoute pas.
                  e.preventDefault();
                  cancelEdit();
                }
              }}
            />
          ) : (
            <h1 className="album-hero__title plv-title">
              <button type="button" className="plv-title__btn" title="Renommer" onClick={startEdit}>
                {shownName}
                <Pencil className="plv-title__pen" size={18} strokeWidth={ICON_STROKE} aria-hidden />
              </button>
            </h1>
          )}
          <p className="album-hero__sub num">{summary}</p>
        </motion.div>
      </section>

      <motion.div className="album-actions" ref={actionsRef} {...enter(1)}>
        <Button variant="primary" icon={isPlaying ? Pause : Play} onClick={playPause} disabled={list.length === 0}>
          {isPlaying ? "Pause" : "Lecture"}
        </Button>
        <Button variant="ghost" icon={Shuffle} onClick={shuffle} disabled={list.length === 0}>
          Aléatoire
        </Button>
        <IconButton
          label="Plus d'actions"
          icon={Ellipsis}
          variant="solid"
          size={40}
          aria-haspopup="menu"
          onClick={(e) => void openMore(e)}
        />
      </motion.div>

      {tracks === null ? (
        <RowsSkeleton count={Math.min(8, Math.max(3, row.trackCount))} />
      ) : empty ? (
        <EmptyPlaylist name={shownName} />
      ) : (
        <motion.div className="album-tracks" {...enter(2)}>
          <div className="track-head" aria-hidden="true">
            <span className="track-head__num">#</span>
            <span>Titre</span>
            <span>Artiste</span>
            <span>Album</span>
            <span />
            <span className="track-head__dur">
              <Clock3 size={14} strokeWidth={ICON_STROKE} />
            </span>
          </div>
          <div
            ref={listRef}
            className={`track-list plv-list${dragging !== null ? " is-reordering" : ""}`}
            role="list"
            data-track-list=""
            aria-label={`Titres de ${shownName}`}
            aria-describedby="plv-reorder-hint"
            // Sur le conteneur NATIF : `onDragStart` d'un `motion.div` est le geste de framer-motion,
            // pas l'événement HTML5 de glisser.
            onDragStart={(e) => {
              const host = (e.target as HTMLElement).closest<HTMLElement>("[data-pl-index]");
              if (!host) return;
              const i = Number(host.dataset.plIndex);
              dragFrom.current = i;
              setDragging(i);
            }}
            onDragEnd={endDrag}
            onDragOver={onListDragOver}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropAt(null);
            }}
            onDrop={onListDrop}
            onKeyDown={onListKeyDown}
          >
            <AnimatePresence initial={false} mode="popLayout">
              {list.map((t, i) => {
                const key = keys[i]!;
                const playing = isThisQueue ? i === playingIndex : t.id === currentId;
                return (
                  <motion.div
                    key={key}
                    layout={m.enabled ? "position" : false}
                    exit={m.enabled ? { opacity: 0, x: -16, transition: { duration: m.d(dur.fast) } } : undefined}
                    transition={{ layout: m.enabled ? m.spring : { duration: 0 } }}
                    className={`plv-row${entering ? " is-entering" : ""}${dragging === i ? " is-dragging" : ""}`}
                    style={entering ? ({ "--d": `${staggerMs(i)}ms` } as React.CSSProperties) : undefined}
                    data-pl-index={i}
                    data-pl-key={key}
                    role="presentation"
                  >
                    <span className="plv-grip" aria-hidden="true">
                      <GripVertical size={14} strokeWidth={ICON_STROKE} />
                    </span>
                    <TrackRowItem
                      track={t}
                      index={i}
                      playing={playing}
                      selected={key === selectedKey}
                      tabbable={key === tabStop}
                      onFocusRow={onRowFocus}
                      onPlay={playAt}
                      onSelect={onRowSelect}
                      onContextMenu={onRowMenu}
                    />
                  </motion.div>
                );
              })}
            </AnimatePresence>
            {dropMoves && dropAt && (
              <span className="plv-drop-line" style={{ transform: `translateY(${dropAt.y - 1}px)` }} aria-hidden="true" />
            )}
          </div>
          <p id="plv-reorder-hint" className="plv-foot num">
            {list.length > 1
              ? "Glisse un titre pour changer l'ordre — Alt+↑/↓ au clavier, Suppr pour le retirer."
              : "Glisse des titres sur cette playlist, dans la barre latérale, pour la compléter."}
          </p>
        </motion.div>
      )}
    </div>
  );
}

/** Playlist vide : indication illustrée (glisser vers la barre latérale, ou clic droit). */
function EmptyPlaylist({ name }: { name: string }): JSX.Element {
  const m = useMotion();
  return (
    <motion.div
      className="plv-empty"
      initial={m.enabled ? { opacity: 0, y: 10 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: m.d(dur.slow), ease: ease.out, delay: m.d(0.15) }}
    >
      <div className="plv-empty__art" aria-hidden="true">
        <span className="plv-empty__ghost">
          <i />
          <b />
        </span>
        <span className="plv-empty__ghost is-2">
          <i />
          <b />
        </span>
        <span className="plv-empty__ghost is-3">
          <i />
          <b />
        </span>
        <span className="plv-empty__cursor">
          <GripVertical size={16} strokeWidth={ICON_STROKE} />
        </span>
      </div>
      <div className="plv-empty__text">
        <h2>Cette playlist attend ses premiers titres</h2>
        <p>
          Glisse des titres ou des albums sur <b>{quoted(name)}</b> dans la barre latérale, ou fais un clic droit
          sur un titre › <b>Ajouter à une playlist</b>.
        </p>
        <div className="plv-empty__actions">
          <Button variant="ghost" size="s" icon={Music} onClick={() => uiStore.getState().navigate({ name: "tracks" })}>
            Parcourir les titres
          </Button>
          <Button variant="ghost" size="s" icon={Disc3} onClick={() => uiStore.getState().navigate({ name: "albums" })}>
            Parcourir les albums
          </Button>
        </div>
      </div>
    </motion.div>
  );
}

function RowsSkeleton({ count }: { count: number }): JSX.Element {
  return (
    <div className="tracks-skel" aria-busy="true" aria-label="Chargement">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="tracks-skel__row">
          <Skeleton w={18} h={10} radius={5} />
          <Skeleton w={`${48 + ((i * 37) % 30)}%`} h={12} radius={6} />
          <Skeleton w="60%" h={10} radius={5} />
          <Skeleton w="54%" h={10} radius={5} />
          <Skeleton w={34} h={10} radius={5} />
        </div>
      ))}
    </div>
  );
}

/** Squelette de la page (liste des playlists pas encore chargée). */
function PlaylistSkeleton(): JSX.Element {
  return (
    <div className="album-view" aria-busy="true" aria-label="Chargement">
      <section className="album-hero">
        <div className="album-hero__cover">
          <Skeleton h="100%" radius={14} />
        </div>
        <div className="album-hero__meta">
          <Skeleton w={70} h={10} radius={5} />
          <Skeleton w={320} h={40} radius={10} style={{ marginTop: 12 }} />
          <Skeleton w={160} h={14} radius={7} style={{ marginTop: 14 }} />
        </div>
      </section>
    </div>
  );
}
