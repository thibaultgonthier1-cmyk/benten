import { useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { dur } from "../theme/ds/motion";
import { FLIGHT_SIZE, FlightVisual } from "./FlightVisual";
import { playlistFx, usePlaylistFx, type Flight } from "./playlistFx";
import { useMotion, useMotionLevel } from "./useMotion";
import { requestFx } from "./FxOverlay";
import "./fly.css";

/** Taille de départ de l'objet volant (px), fixée par son visuel. */
const START = FLIGHT_SIZE;
/** Images clés de la trajectoire (arc échantillonné). */
const STEPS = 14;
/** Essais (frames) pour trouver l'entrée cible (une playlist créée à l'instant n'est pas encore rendue). */
const FIND_TRIES = 40;

/**
 * Couche des pochettes en vol vers la barre latérale (ajout à une playlist) : une miniature part du
 * point d'origine (menu, dialogue, dépôt), décrit un arc en rétrécissant (~450 ms) et se pose sur la
 * vignette de la playlist (`[data-playlist-target]`), qui fait alors « pop » et dont le compteur
 * roule (`playlistFx.land`). Transform/opacity seulement (WAAPI). Mouvement réduit : atterrissage
 * immédiat (pas de vol). Ce qui vole est dessiné par `<FlightVisual>` (point d'échange unique).
 */
export function FlyLayer(): JSX.Element | null {
  const flights = usePlaylistFx((s) => s.flights);
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="fly-layer" aria-hidden="true">
      {flights.map((f) => (
        <FlyingCover key={f.id} flight={f} />
      ))}
    </div>,
    document.body,
  );
}

const easeInOut = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const easeIn = (t: number): number => t * t;

function FlyingCover({ flight }: { flight: Flight }): JSX.Element {
  const m = useMotion();
  const level = useMotionLevel();
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const land = (): void => playlistFx.getState().land(flight.id);
    if (!m.enabled) {
      land();
      return;
    }
    // Éclats de feuille d'or au départ du vol (Complet seulement ; `requestFx` renvoie null sinon).
    if (level.flakes) requestFx("goldFlakes", flight.from, { level });
    let raf = 0;
    let tries = 0;
    let anim: Animation | null = null;

    const start = (): void => {
      const target = document.querySelector<HTMLElement>(`[data-playlist-target="${flight.playlistId}"]`);
      const el = ref.current;
      if (!target || !el) {
        if (++tries < FIND_TRIES) raf = requestAnimationFrame(start);
        else land();
        return;
      }
      target.scrollIntoView({ block: "nearest" });
      const r = target.getBoundingClientRect();
      const x0 = flight.from.x - START / 2;
      const y0 = flight.from.y - START / 2;
      const x1 = r.left + r.width / 2 - START / 2;
      const y1 = r.top + r.height / 2 - START / 2;
      const endScale = Math.max(0.2, Math.min(r.width, r.height) / START);
      // Arc : point de contrôle au-dessus du segment, levée proportionnelle à la distance.
      const dist = Math.hypot(x1 - x0, y1 - y0);
      const lift = Math.min(140, dist * 0.35);
      const cx = (x0 + x1) / 2;
      const cy = Math.min(y0, y1) - lift;
      const frames: Keyframe[] = [];
      for (let i = 0; i <= STEPS; i++) {
        const t = i / STEPS;
        const p = easeInOut(t);
        const x = (1 - p) ** 2 * x0 + 2 * (1 - p) * p * cx + p ** 2 * x1;
        const y = (1 - p) ** 2 * y0 + 2 * (1 - p) * p * cy + p ** 2 * y1;
        // Petite apparition (0.86 → 1) puis réduction jusqu'à la vignette.
        const grow = Math.min(1, t / 0.12);
        const scale = t < 0.12 ? 0.86 + 0.14 * grow : 1 + (endScale - 1) * easeIn((t - 0.12) / 0.88);
        const opacity = t < 0.12 ? grow : t > 0.9 ? 1 - (t - 0.9) * 4 : 1;
        frames.push({ transform: `translate(${x}px, ${y}px) scale(${scale})`, opacity, offset: t });
      }
      anim = el.animate(frames, { duration: Math.round(m.d(dur.slow) * 1000), easing: "linear", fill: "forwards" });
      anim.onfinish = land;
    };
    start();

    return () => {
      cancelAnimationFrame(raf);
      if (anim) {
        anim.onfinish = null;
        anim.cancel();
      }
    };
  }, []);

  return (
    <div ref={ref} className="fly-cover" style={{ width: START, height: START }}>
      <FlightVisual flight={flight} />
    </div>
  );
}

