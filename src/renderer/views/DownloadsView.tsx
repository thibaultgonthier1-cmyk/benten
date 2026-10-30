import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Download, Link2, Loader2, TriangleAlert } from "lucide-react";
import type { YoutubeJobView, YoutubePlaylistPreview, YoutubeStatusView } from "../../shared/types";
import { parseYoutubePlaylistUrl, validateYoutubeUrl } from "../../shared/youtube";
import { Button } from "../ui/Button";
import { useMotion } from "../ui/useMotion";
import "./downloads.css";

/**
 * Écran Téléchargements (T15) : coller un lien YouTube, le convertir en MP3, suivre l'avancement.
 *
 * La validation est la même fonction que celle du Main (`validateYoutubeUrl`) : le champ dit
 * « lien invalide » avant tout appel, et le Main revalide de toute façon — une seule règle.
 *
 * Le MP3 atterrit dans `Musique\Benten\YouTube`, dossier déjà ajouté comme source : la veille
 * l'indexe, et le titre apparaît dans la bibliothèque sans autre geste.
 */

const STAGE_LABEL: Record<YoutubeJobView["stage"], string> = {
  queue: "En attente",
  download: "Téléchargement",
  convert: "Conversion MP3",
};

const STATE_LABEL: Record<YoutubeJobView["state"], string> = {
  queued: "En attente",
  downloading: "Téléchargement",
  converting: "Conversion",
  done: "Terminé",
  error: "Échec",
};

export function DownloadsView(): JSX.Element {
  const [raw, setRaw] = useState("");
  const [jobs, setJobs] = useState<readonly YoutubeJobView[]>([]);
  const [status, setStatus] = useState<YoutubeStatusView>({ installed: false, version: null });
  const [busy, setBusy] = useState(false);
  const [playlist, setPlaylist] = useState<YoutubePlaylistPreview | null>(null);
  const [playlistBusy, setPlaylistBusy] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [cookieOpen, setCookieOpen] = useState(false);
  const [cookieText, setCookieText] = useState("");
  const [cookieNote, setCookieNote] = useState<string | null>(null);
  const m = useMotion();

  const api = typeof window !== "undefined" ? window.benten?.youtube : undefined;
  const valid = useMemo(() => validateYoutubeUrl(raw), [raw]);
  const playlistLink = useMemo(() => parseYoutubePlaylistUrl(raw), [raw]);
  const touched = raw.trim().length > 0;

  useEffect(() => {
    if (!api) return;
    void api.jobs().then(setJobs);
    void api.status().then(setStatus);
    return api.onProgress((job) => {
      setJobs((previous) => {
        const index = previous.findIndex((item) => item.id === job.id);
        if (index === -1) return [...previous, job];
        const next = [...previous];
        next[index] = job;
        return next;
      });
    });
  }, [api]);

  const submit = useCallback(async () => {
    if (!api || !valid || busy) return;
    setBusy(true);
    try {
      const job = await api.enqueue(valid);
      if (job) {
        setJobs((previous) => (previous.some((item) => item.id === job.id) ? previous : [...previous, job]));
        setRaw("");
      }
    } finally {
      setBusy(false);
    }
  }, [api, valid, busy]);

  const analysePlaylist = useCallback(async () => {
    if (!api || !playlistLink) return;
    setPlaylistBusy(true);
    setLinkError(null);
    setPlaylist(null);
    try {
      setPlaylist(await api.playlistPreview(raw.trim()));
    } catch (e) {
      setLinkError(e instanceof Error ? e.message : "Analyse impossible");
    } finally {
      setPlaylistBusy(false);
    }
  }, [api, playlistLink, raw]);

  const downloadMissing = useCallback(async () => {
    if (!api || !playlist) return;
    const urls = playlist.items.filter((item) => !item.inLibrary).map((item) => item.url);
    if (urls.length === 0) return;
    setPlaylistBusy(true);
    try {
      await api.playlistStart(urls);
    } finally {
      setPlaylistBusy(false);
    }
  }, [api, playlist]);
  const saveCookies = useCallback(async () => {
    if (!api || cookieText.trim().length === 0) return;
    try {
      const result = await api.saveCookies(cookieText);
      setCookieNote(`Cookies enregistrés (${result.entries} entrées) — relance l'analyse.`);
      setCookieText("");
      setCookieOpen(false);
      const next = await api.status();
      setStatus(next);
    } catch (e) {
      setCookieNote(e instanceof Error ? e.message : "Cookies refusés");
    }
  }, [api, cookieText]);

  const install = useCallback(async () => {
    if (!api) return;
    setBusy(true);
    try {
      setStatus(await api.update());
    } finally {
      setBusy(false);
    }
  }, [api]);

  return (
    <div className="view downloads-view">
      <header className="dl-head">
        <span className="dl-eyebrow">YouTube</span>
        <h1>Téléchargements</h1>
        <p>
          Colle un lien : le morceau est converti en MP3, rangé dans <code>Musique\Benten\YouTube</code> et ajouté à la
          bibliothèque.
        </p>
      </header>

      <div className="dl-form">
        <Link2 size={16} strokeWidth={1.75} aria-hidden className="dl-form__icon" />
        <input
          className={"dl-input" + (touched && !valid ? " is-invalid" : "")}
          value={raw}
          placeholder="https://www.youtube.com/watch?v=…"
          spellCheck={false}
          aria-label="Lien YouTube"
          aria-invalid={touched && !valid}
          onChange={(e) => setRaw(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
          }}
        />
        {playlistLink ? (
          <Button variant="primary" size="s" disabled={playlistBusy} onClick={() => void analysePlaylist()}>
            {playlistBusy ? "Analyse…" : "Analyser la playlist"}
          </Button>
        ) : (
          <Button variant="primary" size="s" disabled={!valid || busy} onClick={() => void submit()}>
            {busy ? "…" : "Télécharger"}
          </Button>
        )}
      </div>
      {touched && !valid && !playlistLink && (
        <p className="dl-hint dl-hint--bad">
          <TriangleAlert size={13} strokeWidth={1.75} aria-hidden /> Lien invalide — seuls les liens YouTube en https
          sont acceptés.
        </p>
      )}

      <div className="dl-status">
        <span className={status.installed ? "dl-dot is-on" : "dl-dot"} aria-hidden />
        {status.installed ? (
          <span>yt-dlp installé{status.version ? ` · ${status.version}` : ""}</span>
        ) : (
          <>
            <span>yt-dlp pas encore installé</span>
            <Button variant="ghost" size="s" disabled={busy} onClick={() => void install()}>
              Installer
            </Button>
          </>
        )}
      </div>

      {linkError && <p className="dl-hint dl-hint--bad">{linkError}</p>}
      {cookieNote && <p className="dl-hint">{cookieNote}</p>}

      <p className="dl-cookies-line">
        {status.cookies ? "Cookies YouTube enregistrés — les playlists privées sont lisibles." : "Playlist privée ?"}
        {" "}
        <button className="dl-link" type="button" onClick={() => setCookieOpen((open) => !open)}>
          {status.cookies ? "Mettre à jour" : "Ajouter mes cookies YouTube"}
        </button>
      </p>

      {cookieOpen && (
        <div className="dl-cookies">
          <textarea
            className="dl-textarea"
            value={cookieText}
            spellCheck={false}
            placeholder="# Netscape HTTP Cookie File&#10;.youtube.com&#9;TRUE&#9;/&#9;TRUE&#9;0&#9;SID&#9;…"
            onChange={(e) => setCookieText(e.target.value)}
          />
          <Button variant="primary" size="s" disabled={cookieText.trim().length === 0} onClick={() => void saveCookies()}>
            Enregistrer les cookies
          </Button>
        </div>
      )}

      {playlist?.ok && (
        <>
          <div className="dl-playlist">
            <span className="dl-playlist__copy">
              <strong>Playlist YouTube</strong>
              <small>
                {playlist.total} titres · {playlist.total - playlist.missing} déjà dans ta bibliothèque ·{" "}
                {playlist.missing} à télécharger
              </small>
            </span>
            {playlist.missing > 0 ? (
              <Button variant="primary" size="s" disabled={playlistBusy} onClick={() => void downloadMissing()}>
                {playlistBusy ? "Envoi…" : `Télécharger ${playlist.missing} manquant${playlist.missing > 1 ? "s" : ""}`}
              </Button>
            ) : (
              <span className="dl-playlist__done">tout est déjà là</span>
            )}
          </div>

          <ul className="dl-list">
            {playlist.items.slice(0, 200).map((item, index) => (
              <li key={`${item.url}-${index}`} className={"dl-job" + (item.inLibrary ? " is-done" : "")}>
                <span className="dl-job__icon" aria-hidden>
                  {item.inLibrary ? <Check size={15} strokeWidth={2} /> : <Download size={15} strokeWidth={1.75} />}
                </span>
                <span className="dl-job__copy">
                  <strong>{item.title}</strong>
                  <small>{item.artist || "artiste inconnu"}</small>
                </span>
                <span className="dl-job__pct">{item.inLibrary ? "déjà là" : "à venir"}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <ul className="dl-list">
        {jobs.length === 0 && playlist === null && <li className="dl-empty">Aucun téléchargement pour le moment.</li>}
        {jobs.map((job) => (
          <li key={job.id} className={"dl-job is-" + job.state}>
            <span className="dl-job__icon" aria-hidden>
              {job.state === "done" ? (
                <Download size={15} strokeWidth={1.75} />
              ) : job.state === "error" ? (
                <TriangleAlert size={15} strokeWidth={1.75} />
              ) : (
                <Loader2 size={15} strokeWidth={1.75} className={m.enabled ? "is-spinning" : undefined} />
              )}
            </span>
            <span className="dl-job__copy">
              <strong>{job.filePath ? job.filePath.split(/[\\/]/).pop() : job.url}</strong>
              <small>
                {STATE_LABEL[job.state]} · {STAGE_LABEL[job.stage]}
                {job.error ? ` — ${job.error}` : ""}
              </small>
            </span>
            <span className="dl-job__bar" aria-hidden>
              <i style={{ width: `${Math.max(0, Math.min(100, job.percent))}%` }} />
            </span>
            <span className="dl-job__pct">{Math.round(job.percent)} %</span>
          </li>
        ))}
      </ul>
    </div>
  );
}






