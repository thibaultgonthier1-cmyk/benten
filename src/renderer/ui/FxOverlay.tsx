import { memo, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { assetUrl, type AssetId } from "../assets/manifest";
import { createFxScheduler, type FxKind, type FxTicket } from "../lib/fxScheduler";
import type { MotionLevel } from "../lib/motionLevel";
import { currentMotionLevel, useMotionLevel } from "./useMotion";
import "./signature.css";

/**
 * Couche des effets superposés DA « Biwa & Or » (onde de pincement, voile d'encre, éclats d'or,
 * ondes sur l'eau). Hôte en portail plein écran, sans pointeur : un effet ne bloque jamais
 * l'interaction. Toutes les demandes passent par l'ordonnanceur (au plus 2 vivants, le plus
 * ancien lâché). Chaque effet se retire seul à `ended` ou au plus tard après 700 ms.
 *
 * Vidéo : rendue sur fond noir OPAQUE, composée en `mix-blend-mode: screen` (le noir disparaît,
 * l'or s'ajoute à la lumière). Url absente (DA2) ou fichier illisible : repli CSS dessiné en code.
 * Réduit : aucune demande n'aboutit et rien n'est monté (zéro <video>).
 */

/** Durée de vie maximale d'un effet (ms) — filet de sécurité si `ended` ne vient pas. */
export const FX_MAX_MS = 700;

const FX_ASSET: Readonly<Record<FxKind, AssetId>> = {
  pluck: "fx.pluck",
  inkVeil: "fx.inkVeil",
  goldFlakes: "fx.goldFlakes",
  ripple: "fx.ripple",
};

/** Ordonnanceur partagé de l'application. */
export const fxScheduler = createFxScheduler(2);

let hostCount = 0;
/** `true` si un `<FxOverlay>` est monté (sinon les composants jouent leur repli local). */
export function fxHostMounted(): boolean {
  return hostCount > 0;
}

/**
 * Demande un effet au point `at` (viewport). Passe par l'ordonnanceur ; `null` si le niveau de
 * mouvement l'interdit (Réduit ; éclats d'or hors Complet).
 */
export function requestFx(
  kind: FxKind,
  at: { x: number; y: number },
  opts: { size?: number; level?: MotionLevel } = {},
): FxTicket | null {
  const level = opts.level ?? currentMotionLevel();
  if (kind === "goldFlakes" && !level.flakes) return null;
  return fxScheduler.request(kind, at, level.fx, opts.size);
}

/** Hôte : à monter une fois (portail dans `document.body`). */
export function FxOverlay(): JSX.Element | null {
  const tickets = useSyncExternalStore(fxScheduler.subscribe, fxScheduler.active, fxScheduler.active);
  const level = useMotionLevel();

  useEffect(() => {
    hostCount++;
    return () => {
      hostCount--;
    };
  }, []);

  // Passage en Réduit pendant un effet : tout est retiré immédiatement.
  useEffect(() => {
    if (level.fx !== "none") return;
    for (const t of fxScheduler.active()) fxScheduler.release(t.id);
  }, [level, tickets]);

  if (typeof document === "undefined") return null;
  return createPortal(<FxLayer tickets={tickets} level={level} onDone={fxScheduler.release} />, document.body);
}

export interface FxLayerProps {
  tickets: readonly FxTicket[];
  level: MotionLevel;
  onDone(id: number): void;
}

/** Rendu pur des effets vivants (testable sans DOM). */
export function FxLayer({ tickets, level, onDone }: FxLayerProps): JSX.Element {
  return (
    <div className="fx-overlay" aria-hidden="true">
      {level.fx !== "none" && tickets.map((t) => <FxItem key={t.id} ticket={t} onDone={onDone} />)}
    </div>
  );
}

/** Taille par défaut (px) : côté (pluck, éclats) ou largeur (onde 2:1). */
const DEFAULT_SIZE: Readonly<Record<FxKind, number>> = { pluck: 200, goldFlakes: 260, ripple: 320, inkVeil: 0 };

function geometry(t: FxTicket): CSSProperties {
  if (t.kind === "inkVeil") return { left: 0, top: 0, width: "100%", height: "100%" };
  const w = t.size ?? DEFAULT_SIZE[t.kind];
  const h = t.kind === "ripple" ? w / 2 : w;
  return { left: t.at.x - w / 2, top: t.at.y - h / 2, width: w, height: h };
}

const FxItem = memo(function FxItem({ ticket, onDone }: { ticket: FxTicket; onDone(id: number): void }): JSX.Element {
  const url = assetUrl(FX_ASSET[ticket.kind]);
  const [failed, setFailed] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const { id } = ticket;

  useEffect(() => {
    const timer = setTimeout(() => onDone(id), FX_MAX_MS);
    return () => clearTimeout(timer);
  }, [id, onDone]);

  // Lecture explicite (en plus d'autoplay) : une promesse rejetée bascule sur le repli, sans bruit.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = true;
    v.play()?.catch(() => setFailed(true));
  }, [url, failed]);

  const style = geometry(ticket);
  const dim = ticket.dim ? " is-dim" : "";
  if (url && !failed) {
    return (
      <video
        ref={videoRef}
        className={`fx-video fx-video--${ticket.kind}${dim}`}
        src={url}
        muted
        playsInline
        autoPlay
        preload="auto"
        disablePictureInPicture
        onEnded={() => onDone(id)}
        onError={() => setFailed(true)}
        style={{ ...style, mixBlendMode: "screen" }}
      />
    );
  }
  return <FxFallback ticket={ticket} style={style} className={dim} />;
});

/** Pseudo-aléa déterministe (mulberry32) : mêmes éclats pour un même ticket (rendu stable). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FLAKES = 14;

function FxFallback({ ticket, style, className }: { ticket: FxTicket; style: CSSProperties; className: string }): JSX.Element {
  const cls = `fx-fallback fx-fallback--${ticket.kind}${className}`;
  switch (ticket.kind) {
    case "pluck":
      return (
        <div className={cls} style={style}>
          <i className="fx-glow" />
          <i className="fx-ring" />
          <i className="fx-ring fx-ring--2" />
          <i className="fx-ring fx-ring--3" />
        </div>
      );
    case "ripple":
      return (
        <div className={cls} style={style}>
          <i className="fx-ring" />
          <i className="fx-ring fx-ring--2" />
          <i className="fx-ring fx-ring--3" />
        </div>
      );
    case "goldFlakes": {
      const rand = rng(ticket.id * 7919);
      const side = ticket.size ?? DEFAULT_SIZE.goldFlakes;
      return (
        <div className={cls} style={style}>
          {Array.from({ length: FLAKES }, (_, i) => {
            const angle = (i / FLAKES) * Math.PI * 2 + rand() * 0.6;
            const dist = 0.22 + rand() * 0.24; // fraction du côté
            const s = 5 + rand() * 7;
            const v = {
              "--dx": `${(Math.cos(angle) * dist * side).toFixed(1)}px`,
              "--dy": `${(Math.sin(angle) * dist * side - side * 0.06).toFixed(1)}px`,
              "--rot": `${Math.round((rand() - 0.5) * 540)}deg`,
              "--delay": `${Math.round(rand() * 70)}ms`,
              "--s": `${s.toFixed(1)}px`,
            } as CSSProperties;
            return <i key={i} className={`fx-flake fx-flake--${i % 3}`} style={v} />;
          })}
        </div>
      );
    }
    case "inkVeil": {
      const v = { ...style, "--ink-x": `${ticket.at.x}px`, "--ink-y": `${ticket.at.y}px` } as CSSProperties;
      return <div className={cls} style={v} />;
    }
  }
}
