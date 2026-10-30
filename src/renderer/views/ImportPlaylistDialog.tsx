import { useCallback, useState } from "react";
import { Check, FileUp, Loader2, X } from "lucide-react";
import type { ImportPreview, PlaylistRow } from "../../shared/types";
import { usePlaylists } from "../state/playlists";
import { Button } from "../ui/Button";
import "./import.css";

/**
 * T16 — dialogue d'import d'une playlist Apple.
 *
 * Trois temps : choisir un fichier → **aperçu** (ce qui est trouvé, ce qui ne l'est pas, sans rien
 * écrire) → créer la playlist. Rien n'est ajouté avant le clic final : un export à moitié reconnu
 * doit pouvoir être abandonné sans laisser de playlist vide.
 */

export function ImportPlaylistDialog({ onClose }: { onClose(): void }): JSX.Element {
  const [path, setPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // `null` = nouvelle playlist ; sinon on ajoute à celle choisie (titres déjà présents ignorés).
  const [target, setTarget] = useState<number | null>(null);
  const playlistRows = usePlaylists((s) => s.rows) as readonly PlaylistRow[];

  const api = typeof window !== "undefined" ? window.benten?.importer : undefined;

  const choose = useCallback(async () => {
    if (!api) return;
    setError(null);
    setBusy(true);
    try {
      const picked = await api.pickFile();
      if (!picked) return;
      setPath(picked);
      setPreview(await api.preview(picked));
      const base = picked.split(/[\\/]/).pop() ?? "Playlist importée";
      setName(base.replace(/\.[^.]+$/, ""));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import impossible");
    } finally {
      setBusy(false);
    }
  }, [api]);

  const commit = useCallback(async () => {
    if (!api || !preview) return;
    const ids = preview.items.map((item) => item.matchedTrackId).filter((id): id is number => id !== null);
    if (ids.length === 0) {
      setError("Aucun titre trouvé dans la bibliothèque — rien à créer.");
      return;
    }
    setBusy(true);
    try {
      await api.commit({
        name: name.trim() || "Playlist importée",
        trackIds: ids,
        playlistId: target,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Création impossible");
    } finally {
      setBusy(false);
    }
  }, [api, preview, name, onClose]);

  const found = preview ? preview.items.filter((item) => item.matchedTrackId !== null).length : 0;
  const total = preview ? preview.items.length : 0;

  return (
    <div className="import-backdrop" role="presentation" onClick={onClose}>
      <div
        className="import-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Importer une playlist"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="import-head">
          <span className="import-eyebrow">Apple Music</span>
          <h2>Importer une playlist</h2>
          <button className="import-close" type="button" aria-label="Fermer" onClick={onClose}>
            <X size={16} strokeWidth={1.75} aria-hidden />
          </button>
        </header>

        <p className="import-copy">
          Exportez la playlist depuis Apple Music (Fichier → Exporter), puis choisissez le fichier.
          Formats acceptés : <code>.txt</code>, <code>.m3u8</code>, <code>.xml</code>.
        </p>

        <div className="import-pick">
          <Button variant="ghost" size="s" icon={FileUp} disabled={busy} onClick={() => void choose()}>
            {path ? "Changer de fichier" : "Choisir un fichier"}
          </Button>
          {path && <span className="import-path">{path.split(/[\\/]/).pop()}</span>}
          {busy && <Loader2 size={15} strokeWidth={1.75} className="import-spin" aria-hidden />}
        </div>

        {preview && (
          <>
            <div className="import-summary">
              <span className="import-count">
                <Check size={14} strokeWidth={2} aria-hidden /> {found} trouvé{found > 1 ? "s" : ""} sur {total}
              </span>
              {total - found > 0 && <span className="import-missing">{total - found} introuvable(s)</span>}
            </div>

            <ul className="import-list">
              {preview.items.slice(0, 60).map((item, index) => (
                <li key={`${item.title}-${index}`} className={item.matchedTrackId ? "is-found" : "is-missing"}>
                  <span className="import-item__dot" aria-hidden />
                  <span className="import-item__copy">
                    <strong>{item.title}</strong>
                    <small>{item.artist || "artiste inconnu"}</small>
                  </span>
                  <span className="import-item__state">
                    {item.matchedTrackId ? "dans la bibliothèque" : "absent"}
                  </span>
                </li>
              ))}
            </ul>

            <label className="import-name">
              <span>Destination</span>
              <select
                value={target ?? ""}
                onChange={(e) => setTarget(e.target.value === "" ? null : Number(e.target.value))}
              >
                <option value="">Nouvelle playlist…</option>
                {playlistRows.map((row) => (
                  <option key={row.id} value={row.id}>
                    Ajouter à « {row.name} »
                  </option>
                ))}
              </select>
            </label>

            {target === null ? (
              <label className="import-name">
                <span>Nom de la playlist</span>
                <input value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} />
              </label>
            ) : (
              <p className="import-hint-target">
                Les titres déjà présents dans cette playlist seront ignorés — seuls les nouveaux sont ajoutés.
              </p>
            )}
          </>
        )}

        {error && <p className="import-error">{error}</p>}

        <footer className="import-actions">
          <Button variant="ghost" size="s" onClick={onClose}>
            Annuler
          </Button>
          <Button variant="primary" size="s" disabled={!preview || busy || found === 0} onClick={() => void commit()}>
            Créer la playlist
          </Button>
        </footer>
      </div>
    </div>
  );
}


