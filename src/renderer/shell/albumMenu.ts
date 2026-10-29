import { Heart, HeartOff, ListEnd, ListPlus, ListStart, Play } from "lucide-react";
import type { Album } from "../lib/library";
import type { MenuItem } from "../ui/menuStore";
import { quoted, toast } from "../ui/toastStore";

/** Actions existantes consommées par le menu d'une tuile d'album (fournies par l'App / le store). */
export interface AlbumMenuActions {
  playAlbum(album: Album): void;
  albumPlayNext(album: Album): void;
  albumAddToQueue(album: Album): void;
  /** Ouvre la feuille « Ajouter à une playlist » existante. */
  albumAddToPlaylist(album: Album): void;
  toggleFavorite(trackId: number): void;
}

/**
 * Menu contextuel d'une tuile d'album (clic droit dans la grille). Uniquement des actions qui
 * existent déjà : lire, lire ensuite, ajouter à la file, ajouter à une playlist (feuille existante),
 * favori. Les actions silencieuses (file, favori) confirment par un toast.
 *
 * Favori d'album : un album est « favori » dès qu'une de ses pistes l'est (même règle que le filtre
 * Favoris). « Ajouter » marque les pistes qui ne le sont pas ; « Retirer » démarque celles qui le sont.
 */
export function albumMenuItems(
  album: Album,
  actions: AlbumMenuActions,
  favoriteIds: ReadonlySet<number>,
): MenuItem[] {
  const empty = album.tracks.length === 0;
  const favTracks = album.tracks.filter((t) => favoriteIds.has(t.id));
  const isFav = favTracks.length > 0;
  const name = quoted(album.title);

  return [
    { label: "Lire", icon: Play, disabled: empty, onSelect: () => actions.playAlbum(album) },
    {
      label: "Lire ensuite",
      icon: ListStart,
      disabled: empty,
      onSelect: () => {
        actions.albumPlayNext(album);
        toast(`${name} sera lu ensuite`, { icon: ListStart });
      },
    },
    {
      label: "Ajouter à la file",
      icon: ListEnd,
      disabled: empty,
      onSelect: () => {
        actions.albumAddToQueue(album);
        toast(`${name} ajouté à la file`, { icon: ListEnd });
      },
    },
    "separator",
    {
      label: "Ajouter à une playlist…",
      icon: ListPlus,
      disabled: empty,
      onSelect: () => actions.albumAddToPlaylist(album),
    },
    {
      label: isFav ? "Retirer des favoris" : "Ajouter aux favoris",
      icon: isFav ? HeartOff : Heart,
      disabled: empty,
      onSelect: () => {
        const targets = isFav ? favTracks : album.tracks.filter((t) => !favoriteIds.has(t.id));
        for (const t of targets) actions.toggleFavorite(t.id);
        toast(isFav ? `${name} retiré des favoris` : `${name} ajouté aux favoris`, {
          icon: isFav ? HeartOff : Heart,
        });
      },
    },
  ];
}
