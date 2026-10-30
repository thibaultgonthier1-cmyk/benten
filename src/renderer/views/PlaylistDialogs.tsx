import { useEffect, useRef, useState } from "react";
import { CircleAlert, ListPlus, Trash2 } from "lucide-react";
import { uniquePlaylistName } from "../lib/viewModels";
import { playlistsStore } from "../state/playlists";
import { uiStore } from "../state/ui";
import { CoverArt } from "../ui/CoverArt";
import { Dialog } from "../ui/Dialog";
import { quoted, toast } from "../ui/toastStore";
import {
  addToPlaylist,
  closeNewPlaylist,
  playlistRequests,
  useNewPlaylistDialog,
  usePlaylistRequests,
} from "./playlistActions";

const DEFAULT_NAME = "Nouvelle playlist";

/** Hôtes des dialogues de playlist (montés une fois dans le Shell). */
export function PlaylistDialogs(): JSX.Element {
  return (
    <>
      <NewPlaylistDialog />
      <DeletePlaylistDialog />
    </>
  );
}

/**
 * Dialogue « Nouvelle playlist » (sous-menu « Ajouter à une playlist ▸ Nouvelle playlist… »,
 * bouton + de la barre latérale, tuile de la grille). Nom pré-rempli et sélectionné (« Nouvelle
 * playlist », « … 2 » s'il est pris). Valider crée la playlist puis :
 *  - avec des titres : les y ajoute (la pochette vole du dialogue vers la barre latérale) ;
 *  - sans : ouvre la nouvelle playlist.
 */
function NewPlaylistDialog(): JSX.Element {
  const request = useNewPlaylistDialog((s) => s.request);
  const seq = useNewPlaylistDialog((s) => s.seq);
  const [name, setName] = useState(DEFAULT_NAME);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  // Chaque ouverture repart d'un nom libre.
  useEffect(() => {
    if (!request) return;
    setBusy(false);
    setName(uniquePlaylistName(DEFAULT_NAME, playlistsStore.getState().rows.map((r) => r.name)));
  }, [seq]);

  // Pendant l'animation de sortie, la carte garde son contenu.
  const lastRequest = useRef(request);
  if (request) lastRequest.current = request;
  const tracks = lastRequest.current?.tracks ?? [];
  const trimmed = name.trim();

  const confirm = async (): Promise<void> => {
    if (!request || !trimmed || busy) return;
    setBusy(true);
    const r = cardRef.current?.getBoundingClientRect();
    const origin = request.origin ?? (r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : undefined);
    const id = await playlistsStore.getState().create(trimmed);
    if (id === null) {
      setBusy(false);
      toast(`Impossible de créer ${quoted(trimmed)}`, { icon: CircleAlert });
      return;
    }
    closeNewPlaylist();
    if (tracks.length === 0) {
      uiStore.getState().navigate({ name: "playlist", id });
      return;
    }
    const added = await addToPlaylist({ id, name: trimmed }, tracks, { origin, allowDuplicates: true, silent: true });
    if (added > 0) {
      toast(`${quoted(trimmed)} créée · ${added} ${added > 1 ? "titres" : "titre"}`, {
        icon: ListPlus,
        action: { label: "Afficher", onClick: () => uiStore.getState().navigate({ name: "playlist", id }) },
      });
    }
  };

  const covers = distinctCovers(tracks);
  const lead = tracks[0];
  const what =
    tracks.length === 0
      ? null
      : tracks.length === 1
        ? lead!.title
        : sameAlbum(tracks)
          ? lead!.album
          : `${tracks.length} titres`;

  return (
    <Dialog
      open={request !== null}
      eyebrow="新しい · playlist"
      title="Nouvelle playlist"
      onClose={closeNewPlaylist}
      initialFocus={inputRef}
      cardRef={cardRef}
      actions={[
        { label: "Annuler", onClick: closeNewPlaylist },
        {
          label: tracks.length > 0 ? "Créer et ajouter" : "Créer",
          variant: "primary",
          submit: true,
          disabled: !trimmed || busy,
          onClick: () => void confirm(),
        },
      ]}
    >
      <label className="dlg-field">
        <span className="dlg-field__label">Nom</span>
        <input
          ref={inputRef}
          className="dlg-input"
          value={name}
          maxLength={120}
          spellCheck={false}
          autoComplete="off"
          placeholder="Nom de la playlist"
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      {what !== null && (
        <div className="dlg-preview">
          <span className="dlg-preview__covers" aria-hidden="true">
            {covers.map((c) => (
              <span key={c.seed} className="dlg-preview__cover">
                <CoverArt artKey={c.artKey} seed={c.seed} />
              </span>
            ))}
          </span>
          <span className="dlg-preview__text">
            <b title={what}>{what}</b>
            {tracks.length > 1 ? `${tracks.length} titres seront ajoutés` : "sera ajouté à la playlist"}
          </span>
        </div>
      )}
    </Dialog>
  );
}

/** Jusqu'à 3 pochettes distinctes (aperçu en éventail). */
function distinctCovers(tracks: readonly { artKey: string | null; albumId: number; album: string }[]) {
  const out: { artKey: string | null; seed: string }[] = [];
  const seen = new Set<string>();
  for (const t of tracks) {
    const key = t.artKey ?? `gen:${t.albumId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ artKey: t.artKey, seed: `${t.albumId}:${t.album}` });
    if (out.length === 3) break;
  }
  return out;
}

function sameAlbum(tracks: readonly { albumId: number }[]): boolean {
  return tracks.every((t) => t.albumId === tracks[0]!.albumId);
}

/** « Supprimer « nom » ? » : guillemets et « ? » insécables (jamais seuls en bout de ligne). */
function deleteTitle(name: string): string {
  const q = quoted(name, 40).replace(/^« /, "«\u00a0").replace(/ »$/, "\u00a0»");
  return `Supprimer ${q}\u00a0?`;
}

/**
 * Confirmation de suppression d'une playlist (remplace `window.confirm`). Le focus va d'abord sur
 * « Annuler » (action destructive jamais par défaut). Supprimer : la page de la playlist, si elle
 * est ouverte, est remplacée par la grille Playlists (pas d'entrée d'historique vers une page vide).
 */
function DeletePlaylistDialog(): JSX.Element {
  const target = usePlaylistRequests((s) => s.deleting);
  const [busy, setBusy] = useState(false);
  // Pendant l'animation de sortie, la carte garde le nom affiché.
  const shown = useRef(target);
  if (target) shown.current = target;
  const close = (): void => playlistRequests.setState({ deleting: null });

  useEffect(() => {
    if (target) setBusy(false);
  }, [target]);

  const confirm = async (): Promise<void> => {
    if (!target || busy) return;
    setBusy(true);
    const ok = await playlistsStore.getState().remove(target.id);
    close();
    if (!ok) {
      toast(`Impossible de supprimer ${quoted(target.name)}`, { icon: CircleAlert });
      return;
    }
    const ui = uiStore.getState();
    if (ui.route.name === "playlist" && ui.route.id === target.id) ui.replace({ name: "playlists" });
    toast(`${quoted(target.name)} supprimée`, { icon: Trash2 });
  };

  return (
    <Dialog
      open={target !== null}
      title={shown.current ? deleteTitle(shown.current.name) : ""}
      description="La playlist disparaît ; ses titres restent dans ta bibliothèque."
      onClose={close}
      actions={[
        { label: "Annuler", onClick: close, autoFocus: true },
        { label: "Supprimer", variant: "primary", icon: Trash2, disabled: busy, onClick: () => void confirm() },
      ]}
    />
  );
}
