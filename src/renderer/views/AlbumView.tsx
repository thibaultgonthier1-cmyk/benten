import type React from "react";
import { useCallback, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Clock3, Disc3, Ellipsis, Heart, Pause, Play, Shuffle } from "lucide-react";
import type { TrackRow } from "../../shared/types";
import type { Album } from "../lib/library";
import { canResume, discGroups, summaryLine } from "../lib/viewModels";
import { coverColorCache, useCoverColors } from "../lib/useCoverColors";
import { useLibrary } from "../state/library";
import { playerStore, usePlayer } from "../state/player";
import { uiStore } from "../state/ui";
import type { RouteViewActions } from "../shell/RouteView";
import { dur, ease } from "../theme/ds/motion";
import { coverLayoutId } from "../ui/AlbumTile";
import { Button } from "../ui/Button";
import { CoverArt } from "../ui/CoverArt";
import { IconButton, ICON_STROKE } from "../ui/IconButton";
import { Skeleton } from "../ui/Skeleton";
import { TrackRowItem } from "../ui/TrackRowItem";
import { useMotion } from "../ui/useMotion";
import { quoted, toast } from "../ui/toastStore";
import { EmptyState } from "./common";
import { HeroCompactBar, useCompactOnScroll, useHeroEnter, useTopTint } from "./hero";
import { anchorBelow, anchorFromEvent, useViewMenus } from "./menus";
import "./views.css";

export interface AlbumViewProps {
  id: number;
  scrollRef: React.RefObject<HTMLElement>;
  actions: RouteViewActions;
}

/**
 * Page album : grande pochette (232 px, arrivée de la tuile par élément partagé `layoutId`),
 * titre mincho, artiste cliquable, « 12 titres · 42 min · FLAC · 24-bit/44.1 kHz », dégradé de la
 * couleur `vibrant` de la pochette vers le noir (le fond reste #000 sous l'en-tête). Boutons
 * Lecture / Aléatoire / Favori / ⋯ ; une barre compacte prend le relais au défilement ; titres
 * groupés par disque.
 */
export function AlbumView({ id, scrollRef, actions }: AlbumViewProps): JSX.Element {
  const album = useLibrary((s) => s.albums.find((a) => a.id === id));
  const loading = useLibrary((s) => s.loading);

  if (!album) {
    return loading ? <AlbumSkeleton /> : (
      <EmptyState icon={Disc3} title="Album introuvable" text="Cet album n'est plus dans la bibliothèque." />
    );
  }
  return <AlbumPage key={album.id} album={album} scrollRef={scrollRef} actions={actions} />;
}

function AlbumPage({
  album,
  scrollRef,
  actions,
}: {
  album: Album;
  scrollRef: React.RefObject<HTMLElement>;
  actions: RouteViewActions;
}): JSX.Element {
  const m = useMotion();
  const menus = useViewMenus(actions);
  const seed = `${album.id}:${album.title}`;
  const colors = useCoverColors(album.artKey, seed);
  // Couleur seulement quand elle est connue (extraite, ou repli d'une pochette absente) : jamais
  // le repli génératif transitoire d'une vraie pochette (faux ton qui « saute » ensuite).
  const resolved = album.artKey ? coverColorCache.peek(album.artKey) : colors;
  const isCurrent = usePlayer((s) => s.currentTrack?.albumId === album.id);
  const currentTrackId = usePlayer((s) => s.currentTrack?.id ?? null);
  const isPlaying = usePlayer((s) => s.status === "playing") && isCurrent;
  const isFav = usePlayer((s) => album.tracks.some((t) => s.favoriteIds.has(t.id)));
  const [selected, setSelected] = useState<number | null>(null);
  // Tabulation itinérante : un seul arrêt de tabulation pour toute la liste (dernière ligne
  // focalisée, sinon la sélection, le titre en cours ou la première ligne) ; ↑/↓ circulent.
  const [focusedRow, setFocusedRow] = useState<number | null>(null);
  const actionsRef = useRef<HTMLDivElement>(null);

  const groups = useMemo(() => discGroups(album.tracks), [album.tracks]);
  const indexOf = useMemo(() => new Map(album.tracks.map((t, i) => [t.id, i])), [album.tracks]);
  const multiDisc = groups.length > 1;

  // Teinte sous la barre du haut (cf. `useTopTint`) ; barre compacte au défilement.
  useTopTint(scrollRef, resolved?.vibrant ?? null);
  const compact = useCompactOnScroll(scrollRef, actionsRef);

  // « Lecture » d'en-tête : lecture DANS L'ORDRE (le mélange est coupé, comme Apple Music) ;
  // « Aléatoire » l'active.
  const playPause = useCallback((): void => {
    if (isCurrent && canResume(playerStore.getState().status)) actions.togglePlay();
    else actions.playAlbumInOrder(album);
  }, [isCurrent, actions, album]);

  const playTrack = useCallback(
    (track: TrackRow): void => {
      const i = indexOf.get(track.id) ?? 0;
      const p = playerStore.getState();
      if (p.currentTrack?.id === track.id && canResume(p.status)) actions.togglePlay();
      else actions.playAlbum(album, i);
    },
    [actions, album, indexOf],
  );
  const onRowPlay = useCallback((track: TrackRow) => playTrack(track), [playTrack]);
  const onRowSelect = useCallback((track: TrackRow) => setSelected(track.id), []);
  const onRowFocus = useCallback((track: TrackRow) => setFocusedRow(track.id), []);
  const tabStopId =
    [focusedRow, selected, currentTrackId].find((id) => id !== null && indexOf.has(id)) ??
    album.tracks[0]?.id ??
    null;
  const onRowMenu = useCallback(
    (track: TrackRow, e: React.MouseEvent<HTMLElement>): void => {
      void menus.openTrackMenu(track, anchorFromEvent(e), (t) => actions.playAlbum(album, indexOf.get(t.id) ?? 0), {
        hideAlbumLink: true,
      });
    },
    [menus, actions, album, indexOf],
  );

  const toggleAlbumFavorite = (): void => {
    const fav = playerStore.getState().favoriteIds;
    const targets = isFav ? album.tracks.filter((t) => fav.has(t.id)) : album.tracks.filter((t) => !fav.has(t.id));
    for (const t of targets) playerStore.getState().toggleFavorite(t.id);
    toast(isFav ? `${quoted(album.title)} retiré des favoris` : `${quoted(album.title)} ajouté aux favoris`, {
      icon: Heart,
    });
  };

  const enter = useHeroEnter();

  const heroStyle = resolved ? ({ "--hero": resolved.vibrant } as React.CSSProperties) : undefined;
  const empty = album.tracks.length === 0;

  return (
    <div className="album-view" style={heroStyle}>
      <HeroCompactBar
        visible={compact}
        playing={isPlaying}
        onPlay={playPause}
        disabled={album.tracks.length === 0}
        title={album.title}
        sub={album.artist || undefined}
        artKey={album.artKey}
        seed={seed}
      />

      <section className="album-hero" aria-label={`Album ${album.title}`}>
        {resolved && <div key={resolved.vibrant} className="album-hero__bg" aria-hidden="true" />}
        <motion.div
          className="album-hero__cover"
          layoutId={m.enabled ? coverLayoutId(album.id) : undefined}
          transition={{ layout: { duration: m.d(dur.slow), ease: ease.out } }}
          style={{ borderRadius: 14 }}
        >
          <CoverArt artKey={album.artKey} seed={seed} alt={album.title} placeholder={resolved?.dominant} />
        </motion.div>
        <motion.div className="album-hero__meta" {...enter(0)}>
          <div className="album-hero__kind">Album</div>
          <h1 className="album-hero__title" title={album.title}>
            {album.title}
          </h1>
          {album.artist ? (
            <button
              type="button"
              className="album-hero__artist"
              onClick={() => uiStore.getState().navigate({ name: "artist", artist: album.artist })}
            >
              {album.artist}
            </button>
          ) : (
            <span className="album-hero__artist is-empty">Artiste inconnu</span>
          )}
          <p className="album-hero__sub num">{summaryLine(album)}</p>
        </motion.div>
      </section>

      <motion.div className="album-actions" ref={actionsRef} {...enter(1)}>
        <Button variant="primary" icon={isPlaying ? Pause : Play} onClick={playPause} disabled={empty}>
          {isPlaying ? "Pause" : "Lecture"}
        </Button>
        <Button variant="ghost" icon={Shuffle} onClick={() => actions.shuffleAlbum(album)} disabled={empty}>
          Aléatoire
        </Button>
        <IconButton
          label={isFav ? "Retirer des favoris" : "Ajouter aux favoris"}
          icon={Heart}
          variant="solid"
          size={40}
          active={isFav}
          className={isFav ? "album-actions__fav is-on" : "album-actions__fav"}
          onClick={toggleAlbumFavorite}
          disabled={empty}
        />
        <IconButton
          label="Plus d'actions"
          icon={Ellipsis}
          variant="solid"
          size={40}
          aria-haspopup="menu"
          onClick={(e) => void menus.openAlbumMenu(album, anchorBelow(e))}
        />
      </motion.div>

      <motion.div className="album-tracks" {...enter(2)}>
        <div className="track-head no-album" aria-hidden="true">
          <span className="track-head__num">#</span>
          <span>Titre</span>
          <span>Artiste</span>
          <span />
          <span className="track-head__dur">
            <Clock3 size={14} strokeWidth={ICON_STROKE} />
          </span>
        </div>
        <div className="track-list" role="list" data-track-list="" aria-label={`Titres de ${album.title}`}>
          {groups.map((g) => (
            <div key={g.disc ?? "none"} className="disc-group" role="presentation">
              {multiDisc && (
                <div className="disc-head" role="presentation">
                  <Disc3 size={16} strokeWidth={ICON_STROKE} aria-hidden />
                  <span>{g.disc === null ? "Autres titres" : `Disque ${g.disc}`}</span>
                </div>
              )}
              {g.tracks.map((t, i) => (
                <TrackRowItem
                  key={t.id}
                  track={t}
                  index={i}
                  number={t.trackNo ?? i + 1}
                  tabbable={t.id === tabStopId}
                  onFocusRow={onRowFocus}
                  playing={t.id === currentTrackId}
                  selected={t.id === selected}
                  onPlay={onRowPlay}
                  onSelect={onRowSelect}
                  onContextMenu={onRowMenu}
                  showAlbum={false}
                />
              ))}
            </div>
          ))}
        </div>
      </motion.div>
    </div>
  );
}

/** Squelette de la page album (bibliothèque en cours de chargement). */
function AlbumSkeleton(): JSX.Element {
  return (
    <div className="album-view" aria-busy="true" aria-label="Chargement">
      <section className="album-hero">
        <div className="album-hero__cover">
          <Skeleton h="100%" radius={14} />
        </div>
        <div className="album-hero__meta">
          <Skeleton w={60} h={10} radius={5} />
          <Skeleton w={320} h={40} radius={10} style={{ marginTop: 12 }} />
          <Skeleton w={160} h={14} radius={7} style={{ marginTop: 14 }} />
        </div>
      </section>
    </div>
  );
}
