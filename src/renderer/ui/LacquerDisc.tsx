import { memo, useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { assetUrl } from "../assets/manifest";
import { createDiscSpin } from "../lib/discSpin";
import { artUrl } from "../lib/library";
import { startFrameLoop } from "./frameLoop";
import { useMotionLevel } from "./useMotion";
import "./signature.css";

/**
 * Disque laqué — remplace le « vinyle » derrière la pochette (DA « Biwa & Or »).
 *
 * Laque noire décorée de vagues seigaiha en or (maki-e), dessinées en code : un motif SVG
 * d'éventails d'anneaux concentriques, rangées décalées, chaque rangée recouvrant la précédente.
 * Pastille centrale d'or portant la pochette en médaillon. Un reflet spéculaire FIXE (teinté par
 * `tint`, la couleur de pochette) se pose en « screen » sur le disque qui tourne dessous : les
 * vagues captent la lumière en passant. Rotation 33⅓ tr/min, montée et DÉCÉLÉRATION douces quand
 * `playing` bascule (jamais d'arrêt brutal), écrite en `transform` par une boucle rAF (calque
 * composité : aucun re-rendu React par frame). Point de branchement : `tex.seigaihaDisc`.
 * Réduit : immobile.
 */

export interface LacquerDiscProps {
  /** Clé de pochette (médaillon central) ; `null` : pastille d'or pleine. */
  artKey?: string | null;
  /** Couleur CSS du reflet (couleur dynamique de pochette) ; défaut : or clair. */
  tint?: string;
  playing: boolean;
  /** Diamètre (px). */
  size?: number;
  className?: string;
}

/** Rayon d'un éventail seigaiha (unités du viewBox 200). */
const FAN_R = 9;
const TILE_W = FAN_R * 2;
const TILE_H = FAN_R;
const RINGS = [0.92, 0.7, 0.48, 0.26];

/** Centres d'éventails couvrant une tuile (voisins inclus), triés de haut en bas. */
const FAN_CENTERS: ReadonlyArray<readonly [number, number]> = (() => {
  const out: Array<readonly [number, number]> = [];
  for (let row = -1; row <= 3; row++) {
    const y = row * (TILE_H / 2);
    const odd = row % 2 !== 0;
    for (let col = -1; col <= 2; col++) {
      const x = col * TILE_W + (odd ? TILE_W / 2 : 0);
      out.push([x, y]);
    }
  }
  return out.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
})();

function LacquerDiscImpl({ artKey = null, tint, playing, size = 240, className }: LacquerDiscProps): JSX.Element {
  const level = useMotionLevel();
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const id = (s: string): string => `ld-${s}-${uid}`;
  const spinRef = useRef<HTMLDivElement>(null);
  const spin = useRef(createDiscSpin()).current;
  const stopLoop = useRef<(() => void) | null>(null);

  const tex = assetUrl("tex.seigaihaDisc");
  const [texFailed, setTexFailed] = useState(false);
  const cover = artUrl(artKey, 256);
  const [coverFailed, setCoverFailed] = useState<string | null>(null);
  const showCover = cover !== null && coverFailed !== cover;

  useEffect(() => {
    const el = spinRef.current;
    if (!level.rotate) {
      // Réduit : arrêt immédiat, angle conservé, aucune boucle.
      stopLoop.current?.();
      stopLoop.current = null;
      spin.stop();
      return;
    }
    spin.setPlaying(playing);
    if (stopLoop.current || spin.idle() || !el) return;
    // La rotation est une décoration : la simuler à la fréquence de l'écran (240 Hz sur certains
    // moniteurs) écrivait `transform` 240 fois par seconde pour un mouvement que l'œil lit à 60.
    // On plafonne l'ÉCRITURE à 60 Hz, la physique continue à son pas réel.
    let sinceWrite = 0;
    stopLoop.current = startFrameLoop("lacquer-disc", (dt) => {
      spin.step(dt);
      sinceWrite += dt;
      if (sinceWrite >= 1 / 60) {
        sinceWrite = 0;
        el.style.transform = `rotate(${spin.angle().toFixed(3)}deg)`;
      }
      if (spin.idle()) {
        stopLoop.current = null;
        return false;
      }
      return true;
    });
  }, [playing, level.rotate, spin]);

  useEffect(
    () => () => {
      stopLoop.current?.();
      stopLoop.current = null;
    },
    [],
  );

  const style = { width: size, height: size, ...(tint ? { "--disc-tint": tint } : null) } as CSSProperties;
  const useTex = tex !== null && !texFailed;

  return (
    <div
      className={`lacquer-disc${level.rotate ? "" : " is-still"}${className ? ` ${className}` : ""}`}
      style={style}
      aria-hidden="true"
      data-playing={playing ? "true" : "false"}
    >
      <div ref={spinRef} className="lacquer-disc__spin">
        <svg className="lacquer-disc__svg" viewBox="0 0 200 200" focusable="false">
          <defs>
            <radialGradient id={id("lac")} cx="0.5" cy="0.5" r="0.5">
              <stop offset="0" stopColor="#17120d" />
              <stop offset="0.55" stopColor="#0a0807" />
              <stop offset="1" stopColor="#030303" />
            </radialGradient>
            {!useTex && (
              <pattern id={id("sei")} width={TILE_W} height={TILE_H} patternUnits="userSpaceOnUse">
                {FAN_CENTERS.map(([cx, cy]) => (
                  <g key={`${cx},${cy}`}>
                    <circle cx={cx} cy={cy} r={FAN_R} fill="#090706" />
                    {RINGS.map((k) => (
                      <circle key={k} cx={cx} cy={cy} r={FAN_R * k} className="lacquer-disc__wave" />
                    ))}
                  </g>
                ))}
              </pattern>
            )}
            <radialGradient id={id("fade")} cx="0.5" cy="0.5" r="0.5">
              <stop offset="0.34" stopColor="#000" />
              <stop offset="0.4" stopColor="#fff" stopOpacity="0.85" />
              <stop offset="0.8" stopColor="#fff" />
              <stop offset="0.95" stopColor="#fff" stopOpacity="0.55" />
            </radialGradient>
            <mask id={id("mask")}>
              <circle cx="100" cy="100" r="96" fill={`url(#${id("fade")})`} />
            </mask>
            <radialGradient id={id("gold")} cx="0.38" cy="0.3" r="0.8">
              <stop offset="0" stopColor="#f6e2a4" />
              <stop offset="0.4" stopColor="#dcb65e" />
              <stop offset="0.8" stopColor="#b48634" />
              <stop offset="1" stopColor="#8a6420" />
            </radialGradient>
            <radialGradient id={id("vig")} cx="0.5" cy="0.5" r="0.5">
              <stop offset="0.6" stopColor="#000" stopOpacity="0" />
              <stop offset="1" stopColor="#000" stopOpacity="0.55" />
            </radialGradient>
            <clipPath id={id("label")}>
              <circle cx="100" cy="100" r="27.5" />
            </clipPath>
          </defs>

          {/* Laque */}
          <circle cx="100" cy="100" r="100" fill={`url(#${id("lac")})`} />
          {/* Seigaiha (texture ou dessin en code) */}
          <g mask={`url(#${id("mask")})`}>
            {useTex ? (
              <image
                href={tex}
                x="0"
                y="0"
                width="200"
                height="200"
                preserveAspectRatio="xMidYMid slice"
                onError={() => setTexFailed(true)}
              />
            ) : (
              <rect x="0" y="0" width="200" height="200" fill={`url(#${id("sei")})`} />
            )}
          </g>
          {/* Profondeur de la laque vers le bord */}
          <circle cx="100" cy="100" r="100" fill={`url(#${id("vig")})`} />
          {/* Filets d'or (maki-e) : bord et cerclage de la pastille */}
          <circle cx="100" cy="100" r="98.2" className="lacquer-disc__rim-line" />
          <circle cx="100" cy="100" r="95.6" className="lacquer-disc__rim-line lacquer-disc__rim-line--fine" />
          <circle cx="100" cy="100" r="37.5" className="lacquer-disc__rim-line lacquer-disc__rim-line--fine" />
          {/* Pastille d'or */}
          <g className="lacquer-disc__label">
            <circle cx="100" cy="100" r="33" fill={`url(#${id("gold")})`} />
            <circle cx="100" cy="100" r="32.4" className="lacquer-disc__label-edge" />
            <circle cx="100" cy="100" r="29" className="lacquer-disc__label-groove" />
            {showCover ? (
              <image
                href={cover}
                x="72.5"
                y="72.5"
                width="55"
                height="55"
                preserveAspectRatio="xMidYMid slice"
                clipPath={`url(#${id("label")})`}
                onError={() => setCoverFailed(cover)}
              />
            ) : (
              <circle cx="100" cy="100" r="20" className="lacquer-disc__label-inner" />
            )}
            <circle cx="100" cy="100" r="27.5" className="lacquer-disc__label-ring" />
            <circle cx="100" cy="100" r="3.1" className="lacquer-disc__hole" />
          </g>
        </svg>
      </div>
      <div className="lacquer-disc__specular" />
      <div className="lacquer-disc__sheen" />
    </div>
  );
}

export const LacquerDisc = memo(LacquerDiscImpl);

