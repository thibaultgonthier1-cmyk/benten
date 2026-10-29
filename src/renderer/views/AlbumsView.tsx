import type React from "react";
import { useCallback, useMemo } from "react";
import { ArrowDownWideNarrow, Check, ChevronDown, Disc3, Heart, SlidersHorizontal } from "lucide-react";
import type { Album } from "../lib/library";
import { ALBUM_SORTS, arrangeAlbums, canResume } from "../lib/viewModels";
import { useLibrary } from "../state/library";
import { playerStore, usePlayer } from "../state/player";
import { uiStore, useUi } from "../state/ui";
import type { RouteViewActions } from "../shell/RouteView";
import { openMenu } from "../ui/menuStore";
import { Button } from "../ui/Button";
import { ICON_STROKE } from "../ui/IconButton";
import { AlbumGrid } from "./AlbumGrid";
import { EmptyState, GridSkeleton, PageHeader } from "./common";
import { anchorBelow, anchorFromEvent, useViewMenus } from "./menus";
import "./views.css";

export type AlbumsVariant = "albums" | "favorites" | "home";

export interface AlbumsViewProps {
  scrollRef: React.RefObject<HTMLElement>;
  actions: RouteViewActions;
  /** `favorites` : même vue filtrée aux albums favoris ; `home` : en-tête d'accueil (Tâche 11). */
  variant?: AlbumsVariant;
}

/**
 * Écran Albums : en-tête (titre mincho + compte), sélecteur de tri compact (Ajouté / Titre /
 * Artiste) et filtre « Sans perte », puis la grille virtualisée. Les Favoris sont la même vue
 * filtrée (route `favorites`). Le bouton lecture d'une tuile lit l'album (ou bascule
 * lecture/pause si c'est l'album en cours) ; le clic ouvre la page album.
 */
export function AlbumsView({ scrollRef, actions, variant = "albums" }: AlbumsViewProps): JSX.Element {
  const albums = useLibrary((s) => s.albums);
  const trackCount = useLibrary((s) => s.tracks.length);
  const loading = useLibrary((s) => s.loading);
  const favoriteIds = usePlayer((s) => s.favoriteIds);
  const prefs = useUi((s) => s.albumsView);
  const menus = useViewMenus(actions);
  const favoritesOnly = variant === "favorites";

  const shown = useMemo(
    () => arrangeAlbums(albums, { ...prefs, favoritesOnly }, favoriteIds),
    [albums, prefs, favoritesOnly, favoriteIds],
  );

  // Callbacks STABLES (tuiles mémoïsées) : l'état courant est lu au clic, pas en dépendance.
  const onPlay = useCallback(
    (album: Album): void => {
      const p = playerStore.getState();
      if (p.currentTrack?.albumId === album.id && canResume(p.status)) actions.togglePlay();
      else actions.playAlbumInOrder(album);
    },
    [actions],
  );
  const onContextMenu = useCallback(
    (album: Album, e: React.MouseEvent<HTMLElement>): void => {
      void menus.openAlbumMenu(album, anchorFromEvent(e));
    },
    [menus],
  );

  const openSortMenu = (e: React.MouseEvent<HTMLElement>): void => {
    const a = anchorBelow(e);
    openMenu(
      a.x,
      a.y,
      ALBUM_SORTS.map((o) => ({
        label: o.label,
        icon: o.value === prefs.sort ? Check : undefined,
        onSelect: () => uiStore.getState().setAlbumsView({ sort: o.value }),
      })),
      { focusFirst: a.focusFirst },
    );
  };

  const sortLabel = ALBUM_SORTS.find((o) => o.value === prefs.sort)?.label ?? "";
  const count = loading && albums.length === 0 ? null : `${shown.length} ${shown.length > 1 ? "albums" : "album"}`;
  const header =
    variant === "home"
      ? { eyebrow: "今宵 · ce soir", title: "Ta bibliothèque, en local", sub: loading ? null : `${trackCount} titres · ${albums.length} albums` }
      : { eyebrow: undefined, title: favoritesOnly ? "Favoris" : "Albums", sub: count };

  const toolbar = (
    <div className="view-tools" role="group" aria-label="Tri et filtre">
      <button
        type="button"
        className="view-chip"
        aria-haspopup="menu"
        aria-label={`Trier par : ${sortLabel}`}
        onClick={openSortMenu}
      >
        <ArrowDownWideNarrow size={15} strokeWidth={ICON_STROKE} aria-hidden />
        <span>{sortLabel}</span>
        <ChevronDown className="view-chip__chev" size={14} strokeWidth={ICON_STROKE} aria-hidden />
      </button>
      <button
        type="button"
        className={`view-chip${prefs.losslessOnly ? " is-on" : ""}`}
        aria-pressed={prefs.losslessOnly}
        onClick={() => uiStore.getState().setAlbumsView({ losslessOnly: !prefs.losslessOnly })}
      >
        Sans perte
      </button>
    </div>
  );

  let body: JSX.Element;
  if (loading && albums.length === 0) {
    body = <GridSkeleton />;
  } else if (shown.length === 0) {
    body = prefs.losslessOnly ? (
      <EmptyState
        icon={SlidersHorizontal}
        title="Aucun album sans perte"
        text={favoritesOnly ? "Aucun de tes favoris n'est en qualité sans perte." : "Aucun album de la bibliothèque n'est en qualité sans perte."}
        action={
          <Button variant="ghost" size="s" onClick={() => uiStore.getState().setAlbumsView({ losslessOnly: false })}>
            Retirer le filtre
          </Button>
        }
      />
    ) : favoritesOnly ? (
      <EmptyState
        icon={Heart}
        title="Aucun favori"
        text="Touche le cœur d'un titre pour retrouver son album ici."
      />
    ) : (
      <EmptyState icon={Disc3} title="Aucun album" text="Ajoute un dossier de musique depuis l'accueil pour remplir ta bibliothèque." />
    );
  } else {
    body = (
      <AlbumGrid
        albums={shown}
        scrollRef={scrollRef}
        onPlay={onPlay}
        onContextMenu={onContextMenu}
        memoryKey={variant}
      />
    );
  }

  return (
    <div className="albums-view">
      <PageHeader eyebrow={header.eyebrow} title={header.title} sub={header.sub} aside={toolbar} />
      {body}
    </div>
  );
}
