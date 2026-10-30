import { useEffect, useRef, useState } from "react";
import { assetUrl } from "../assets/manifest";
import { settingsStore, useSettings } from "../state/settings";
import { useMotionLevel } from "../ui/useMotion";
import "./intro.css";

/**
 * Écran de lancement « or » (T14).
 *
 * Joue la vidéo approuvée (v3), **sans son**, une fois par lancement, et disparaît
 * d'elle-même à la fin. Un clic, une touche ou Échap passe immédiatement.
 *
 * Le plan impose : aucune dépendance au son, et rien qui bloque l'entrée dans l'app.
 * En mouvement réduit — ou si le réglage « afficher l'intro » est coupé — l'écran
 * n'apparaît pas du tout : `shouldPlayIntro` le décide, et c'est testé.
 */

/** Durée maximale d'affichage (s) : filet de sécurité si `ended` ne vient pas. */
const MAX_MS = 8000;

export function shouldPlayIntro(options: { showIntro: boolean; reduced: boolean; hasAsset: boolean }): boolean {
  if (!options.showIntro) return false;
  if (!options.hasAsset) return false;
  return !options.reduced;
}

export function Intro({ onDone }: { onDone(): void }): JSX.Element | null {
  const showIntro = useSettings((s) => s.showIntro);
  const level = useMotionLevel();
  const src = assetUrl("intro.gold");
  const [gone, setGone] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  const play = shouldPlayIntro({ showIntro, reduced: level.fx === "none", hasAsset: Boolean(src) });

  useEffect(() => {
    if (!play) {
      setGone(true);
      onDone();
    }
    // Une seule décision au montage : le réglage ne doit pas relancer l'intro en cours de route.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!play) return;
    const finish = (): void => {
      setGone(true);
      onDone();
    };
    const timer = window.setTimeout(finish, MAX_MS);
    // Tentative de lecture explicite : certains environnements ignorent `autoPlay`.
    videoRef.current?.play().catch(() => undefined);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" || e.key === " " || e.key === "Enter") finish();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [play]);

  if (!play || gone || !src) return null;

  return (
    <div
      className="intro"
      role="presentation"
      onClick={() => {
        setGone(true);
        onDone();
      }}
    >
      <video
        ref={videoRef}
        className="intro__video"
        src={src}
        autoPlay
        muted
        playsInline
        preload="auto"
        aria-hidden="true"
        onEnded={() => {
          setGone(true);
          onDone();
        }}
      />
      <button
        className="intro__skip"
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setGone(true);
          onDone();
        }}
      >
        Passer
      </button>
    </div>
  );
}

/** Remet l'intro à zéro pour la prochaine session (utilisé par les tests et le rejeu). */
export function forceIntroOnNextLaunch(): void {
  settingsStore.getState().setShowIntro(true);
}
