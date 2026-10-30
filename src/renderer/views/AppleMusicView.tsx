import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Cookie, Download, Link2, Loader2, Music4, TriangleAlert } from "lucide-react";
import type { ApplePreview, AppleProgressView, AppleStatusView } from "../../shared/types";
import { Button } from "../ui/Button";
import { GoldMedallion } from "../ui/GoldMedallion";
import "./apple.css";

/**
 * Écran Apple Music.
 *
 * Trois temps, comme le pipeline de Prism :
 *  1. **cookies** — on colle l'export Netscape de l'extension ; ils restent sur la machine ;
 *  2. **aperçu** — un lien de playlist est résolu et **comparé à la bibliothèque** : chaque titre
 *     est marqué « déjà là » ou « à télécharger » ;
 *  3. **téléchargement** — seuls les manquants partent, l'avancement est poussé par le Main et les
 *     fichiers arrivent dans `Musique/Benten/Apple`, puis dans la bibliothèque.
 */

const EMPTY_STATUS: AppleStatusView = {
  cookies: false,
  cookiesUpdatedAt: null,
  cookieEntries: 0,
  gamdl: false,
  gamdlVersion: null,
};

export function AppleMusicView(): JSX.Element {
  const [status, setStatus] = useState<AppleStatusView>(EMPTY_STATUS);
  const [cookieText, setCookieText] = useState("");
  const [cookieOpen, setCookieOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [preview, setPreview] = useState<ApplePreview | null>(null);
  const [progress, setProgress] = useState<AppleProgressView | null>(null);
  const [busy, setBusy] = useState<"cookies" | "preview" | "download" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const api = typeof window !== "undefined" ? window.benten?.apple : undefined;
  const missingUrls = useMemo(
    () => (preview?.items ?? []).filter((item) => !item.inLibrary).map((item) => item.url),
    [preview],
  );

  useEffect(() => {
    if (!api) return undefined;
    void api.status().then((next) => {
      setStatus(next);
      setCookieOpen(!next.cookies);
    });
    return api.onProgress((next) => setProgress(next));
  }, [api]);

  const saveCookies = useCallback(async () => {
    if (!api || cookieText.trim().length === 0) return;
    setBusy("cookies");
    setError(null);
    try {
      setStatus(await api.saveCookies(cookieText));
      setCookieText("");
      setCookieOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Cookies refusés");
    } finally {
      setBusy(null);
    }
  }, [api, cookieText]);

  const analyse = useCallback(async () => {
    if (!api || url.trim().length === 0) return;
    setBusy("preview");
    setError(null);
    setPreview(null);
    try {
      setPreview(await api.preview(url.trim()));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Analyse impossible");
    } finally {
      setBusy(null);
    }
  }, [api, url]);

  const download = useCallback(async () => {
    if (!api || missingUrls.length === 0) return;
    setBusy("download");
    setError(null);
    try {
      const result = await api.start(missingUrls);
      setProgress(result);
      // On rafraîchit l'aperçu : les titres téléchargés passent en « déjà là ».
      if (preview) setPreview(await api.preview(url.trim()));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Téléchargement impossible");
    } finally {
      setBusy(null);
    }
  }, [api, missingUrls, preview, url]);

  const found = preview ? preview.total - preview.missing : 0;
  const percent = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div className="view apple-view">
      <header className="ab-head">
        <span className="ab-eyebrow">Apple Music</span>
        <h1>Importer depuis Apple Music</h1>
        <p>
          Colle un lien de playlist : les titres absents de ta bibliothèque sont téléchargés en local, puis rangés
          dans <code>Musique\Benten\Apple</code>.
        </p>
      </header>

      <section className="ab-status">
        <span className={"ab-pill" + (status.cookies ? " is-ok" : " is-off")}>
          <Cookie size={13} strokeWidth={1.75} aria-hidden />
          {status.cookies ? `cookies · ${status.cookieEntries} entrées` : "cookies absents"}
        </span>
        <span className={"ab-pill" + (status.gamdl ? " is-ok" : " is-off")}>
          <Music4 size={13} strokeWidth={1.75} aria-hidden />
          {status.gamdl ? status.gamdlVersion ?? "gamdl prêt" : "gamdl introuvable"}
        </span>
        <button className="ab-link" type="button" onClick={() => setCookieOpen((open) => !open)}>
          {status.cookies ? "Mettre à jour les cookies" : "Coller mes cookies"}
        </button>
      </section>

      {cookieOpen && (
        <section className="ab-cookies">
          <label className="ab-label" htmlFor="ab-cookie-text">
            Export Netscape (<code>cookies.txt</code>) de l'extension, pour music.apple.com
          </label>
          <textarea
            id="ab-cookie-text"
            className="ab-textarea"
            value={cookieText}
            spellCheck={false}
            placeholder="# Netscape HTTP Cookie File&#10;.music.apple.com&#9;TRUE&#9;/&#9;TRUE&#9;0&#9;media-user-token&#9;…"
            onChange={(e) => setCookieText(e.target.value)}
          />
          <div className="ab-row">
            <Button variant="primary" size="s" disabled={cookieText.trim().length === 0 || busy === "cookies"} onClick={() => void saveCookies()}>
              {busy === "cookies" ? "Enregistrement…" : "Enregistrer les cookies"}
            </Button>
            <span className="ab-note">Ils restent sur cette machine et ne servent qu'à gamdl.</span>
          </div>
        </section>
      )}

      <section className="ab-form">
        <Link2 size={16} strokeWidth={1.75} aria-hidden className="ab-form__icon" />
        <input
          className="ab-input"
          value={url}
          spellCheck={false}
          placeholder="https://music.apple.com/fr/playlist/…"
          aria-label="Lien de playlist ou d'album Apple Music"
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void analyse();
          }}
        />
        <Button variant="ghost" size="s" disabled={url.trim().length === 0 || busy === "preview"} onClick={() => void analyse()}>
          {busy === "preview" ? "Analyse…" : "Analyser"}
        </Button>
      </section>

      {error && (
        <p className="ab-error">
          <TriangleAlert size={13} strokeWidth={1.75} aria-hidden /> {error}
        </p>
      )}

      {preview && !preview.ok && (
        <p className="ab-error">
          <TriangleAlert size={13} strokeWidth={1.75} aria-hidden /> {preview.reason || "Playlist illisible"}
        </p>
      )}

      {preview?.ok && (
        <>
          <div className="ab-summary">
            <div className="ab-summary__copy">
              <strong>{preview.name || "Playlist"}</strong>
              <small>
                {preview.total} titres · {found} déjà dans ta bibliothèque · {preview.missing} à télécharger
              </small>
            </div>
            {preview.missing > 0 ? (
              <Button variant="primary" size="s" icon={Download} disabled={busy === "download"} onClick={() => void download()}>
                {busy === "download" ? "Téléchargement…" : `Télécharger ${preview.missing} titre${preview.missing > 1 ? "s" : ""}`}
              </Button>
            ) : (
              <span className="ab-pill is-ok">
                <Check size={13} strokeWidth={2} aria-hidden /> tout est déjà là
              </span>
            )}
          </div>

          {progress && (progress.running || progress.error) && (
            <div className="ab-progress">
              <div className="ab-progress__bar">
                <i style={{ width: `${percent}%` }} />
              </div>
              <span className="ab-progress__text">
                {progress.error
                  ? progress.error
                  : `${progress.done} / ${progress.total} · ${progress.workers} processus`}
              </span>
            </div>
          )}

          <ul className="ab-list">
            {preview.items.map((item, index) => (
              <li key={`${item.url}-${index}`} className={item.inLibrary ? "is-present" : "is-missing"}>
                <span className="ab-item__mark" aria-hidden>
                  {item.inLibrary ? <Check size={13} strokeWidth={2} /> : <Loader2 size={13} strokeWidth={1.75} />}
                </span>
                <span className="ab-item__copy">
                  <strong>{item.title}</strong>
                  <small>
                    {item.artist} · {item.album}
                  </small>
                </span>
                <span className="ab-item__state">{item.inLibrary ? "dans ta bibliothèque" : "à télécharger"}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {!preview && !busy && (
        <div className="ab-hint">
          <GoldMedallion playing={false} size="sm" onToggle={() => undefined} title="Lecture" />
          <span>Colle un lien, puis « Analyser » : rien n'est téléchargé avant que tu le demandes.</span>
        </div>
      )}
    </div>
  );
}

