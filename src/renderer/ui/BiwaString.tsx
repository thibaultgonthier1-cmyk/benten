import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { formatTime } from "../lib/library";
import {
  createScrubGesture,
  deflect,
  fractionFromPointer,
  quadYAtX,
  rmsFromTimeDomain,
  stepSpring,
  vibrationAmplitude,
  type SpringState,
} from "../lib/stringPhysics";
import { startFrameLoop } from "./frameLoop";
import { useMotionLevel } from "./useMotion";
import "./signature.css";

/**
 * Corde de biwa — barre de lecture (et, en variante fine, volume) de la DA « Biwa & Or ».
 *
 * SVG : la partie jouée brille d'un dégradé d'or, le reste est une corde sombre. Survol : une
 * poignée d'or grandit et une bulle de temps suit le pointeur. Glisser : la corde se tord sous le
 * pointeur (deux courbes quadratiques jointes au doigt, tangente continue) ; relâcher : elle revient
 * par `stepSpring` en oscillant puis s'amortit. En lecture, elle frémit selon l'énergie du son,
 * lue en LECTURE SEULE sur l'analyser du moteur (`getByteTimeDomainData` dans un tampon réutilisé).
 *
 * Aucune mise à jour d'état React par frame : une seule boucle rAF (qui ne tourne que s'il y a
 * quelque chose à animer) écrit `d`, les clips, la poignée et la bulle via des refs. Le rect est
 * relu à chaque mouvement (exact en HiDPI et au redimensionnement). Un changement de `trackKey`
 * pendant le glisser l'annule sans recherche. Réduit : aucune animation (ni flexion, ni vibration,
 * ni ressort) — la poignée suit le pointeur, l'information reste visible.
 */

export type AnalyserSource = AnalyserNode | (() => AnalyserNode | null | undefined) | null | undefined;

export interface BiwaStringProps {
  /** Position jouée [0..1]. */
  value: number;
  /** Fraction mise en mémoire tampon [0..1] (facultatif). */
  buffered?: number;
  /** Recherche demandée (fin du glisser, clic, clavier). */
  onSeek(fraction: number): void;
  onScrubStart?(): void;
  onScrubEnd?(): void;
  /** Variante fine (volume). */
  thin?: boolean;
  /** Analyser du moteur (ou accesseur, relu à chaque frame : survit à une reconstruction du graphe). */
  analyser?: AnalyserSource;
  playing: boolean;
  /** Identité de la piste : un changement pendant le glisser annule le geste (aucune recherche). */
  trackKey: string | number | null;
  /** Durée (s) : bulle et valeurs ARIA en temps, flèches ±5 s. Sans durée : pourcentage. */
  duration?: number;
  /** Libellé accessible. */
  label?: string;
  /** Pas clavier (fraction) ; par défaut 5 s (ou 5 % sans durée). */
  step?: number;
  /** Texte de la bulle pour une fraction (par défaut temps ou pourcentage). */
  formatValue?(fraction: number): string;
  className?: string;
}

/** Hauteur de la zone sensible (px). */
const HEIGHT = 28;
const HEIGHT_THIN = 18;
/** Appui du doigt (px) : même un clic « pince » légèrement la corde, qui revient en vibrant. */
const PRESS_PX = 3;
/** Impulsion (px/s) donnée à la corde par une recherche au clavier. */
const KEY_PLUCK_VELOCITY = 70;
/** Seuils de repos du ressort. */
const REST_OFFSET = 0.04;
const REST_VELOCITY = 0.6;
/** Fréquences visuelles du frémissement (Hz) : fondamental + partiel inharmonique discret. */
const VIB_F1 = 6.2;
const VIB_F2 = 10.9;
/** Maintien de la fraction recherchée en attendant que `value` la rattrape (ms). */
const PENDING_MS = 650;

const clamp01 = (v: number): number => (v > 0 ? (v < 1 ? v : 1) : 0);

function resolveAnalyser(src: AnalyserSource): AnalyserNode | null {
  if (!src) return null;
  try {
    return (typeof src === "function" ? src() : src) ?? null;
  } catch {
    return null;
  }
}

function BiwaStringImpl({
  value,
  buffered,
  onSeek,
  onScrubStart,
  onScrubEnd,
  thin = false,
  analyser,
  playing,
  trackKey,
  duration,
  label,
  step,
  formatValue,
  className,
}: BiwaStringProps): JSX.Element {
  const level = useMotionLevel();
  const still = level.fx === "none";
  const H = thin ? HEIGHT_THIN : HEIGHT;
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const ids = {
    grad: `bs-g-${uid}`,
    glow: `bs-gl-${uid}`,
    played: `bs-p-${uid}`,
    buf: `bs-b-${uid}`,
    knob: `bs-k-${uid}`,
  };

  const rootRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<SVGPathElement>(null);
  const bufRef = useRef<SVGPathElement>(null);
  const glowRef = useRef<SVGPathElement>(null);
  const playedRef = useRef<SVGPathElement>(null);
  const playedClipRef = useRef<SVGRectElement>(null);
  const bufClipRef = useRef<SVGRectElement>(null);
  const gradRef = useRef<SVGLinearGradientElement>(null);
  const glowGradRef = useRef<SVGLinearGradientElement>(null);
  const handleRef = useRef<SVGGElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const bubbleTextRef = useRef<HTMLSpanElement>(null);

  // État d'animation : refs uniquement (jamais de setState par frame).
  const sim = useRef({
    width: 0,
    value: clamp01(value),
    buffered: clamp01(buffered ?? 0),
    anchorX: 0,
    spring: { offset: 0, velocity: 0 } as SpringState,
    target: 0,
    bending: false,
    env: 0,
    phase1: 0,
    phase2: 0,
    pending: null as { fraction: number; until: number } | null,
    pointerId: -1,
  });
  const gesture = useRef(createScrubGesture()).current;
  const stopLoop = useRef<(() => void) | null>(null);

  // Props lues par la boucle (sans la redémarrer à chaque rendu).
  const live = useRef({ playing, analyser, level, still, H, duration, formatValue, trackKey });
  live.current = { playing, analyser, level, still, H, duration, formatValue, trackKey };
  const callbacks = useRef({ onSeek, onScrubStart, onScrubEnd });
  callbacks.current = { onSeek, onScrubStart, onScrubEnd };
  const timeBuf = useRef<Uint8Array<ArrayBuffer> | null>(null);

  const displayFraction = (now: number): number => {
    const s = sim.current;
    if (gesture.dragging()) return gesture.fraction();
    const p = s.pending;
    if (p) {
      if (now < p.until && Math.abs(s.value - p.fraction) > 0.004) return p.fraction;
      s.pending = null;
    }
    return s.value;
  };

  /** Écrit la géométrie courante dans le SVG (via refs). */
  const draw = useCallback((now: number): void => {
    const s = sim.current;
    const W = s.width;
    if (!(W > 0)) return;
    const { H: h } = live.current;
    const cy = h / 2;
    const px = displayFraction(now) * W;
    let d: string;
    let hy = cy;
    const off = s.spring.offset;
    if (s.bending) {
      const ax = Math.min(W, Math.max(0, s.anchorX));
      const y = cy + off;
      const c1x = ax * 0.55;
      const c2x = ax + (W - ax) * 0.45;
      d = `M0 ${cy} Q${c1x.toFixed(2)} ${y.toFixed(2)} ${ax.toFixed(2)} ${y.toFixed(2)} Q${c2x.toFixed(2)} ${y.toFixed(2)} ${W} ${cy}`;
      hy =
        px <= ax
          ? quadYAtX(px, [0, cy], [c1x, y], [ax, y])
          : quadYAtX(px, [ax, y], [c2x, y], [W, cy]);
    } else if (s.env > 0.01) {
      // Frémissement : fondamental + 2e partiel, cubique à abscisse linéaire (y exact en t = x/W).
      const a1 = s.env * Math.sin(s.phase1);
      const a2 = s.env * 0.28 * Math.sin(s.phase2);
      const k1 = a1 / 0.75;
      const k2 = a2 / 0.2887;
      const y1 = cy + k1 + k2;
      const y2 = cy + k1 - k2;
      d = `M0 ${cy} C${(W / 3).toFixed(2)} ${y1.toFixed(2)} ${((2 * W) / 3).toFixed(2)} ${y2.toFixed(2)} ${W} ${cy}`;
      const t = px / W;
      hy = cy + 3 * t * (1 - t) * (1 - t) * (k1 + k2) + 3 * t * t * (1 - t) * (k1 - k2);
    } else {
      d = `M0 ${cy} L${W} ${cy}`;
    }
    for (const el of [baseRef.current, bufRef.current, glowRef.current, playedRef.current]) el?.setAttribute("d", d);
    playedClipRef.current?.setAttribute("width", String(Math.max(0, px + 8)));
    const bx = clamp01(s.buffered) * W;
    const bufClip = bufClipRef.current;
    if (bufClip) {
      bufClip.setAttribute("x", String(px));
      bufClip.setAttribute("width", String(Math.max(0, bx - px)));
    }
    gradRef.current?.setAttribute("x2", String(Math.max(1, px)));
    glowGradRef.current?.setAttribute("x2", String(Math.max(1, px)));
    handleRef.current?.setAttribute("transform", `translate(${px.toFixed(2)} ${hy.toFixed(2)})`);
  }, []);

  /** Bulle de temps : position + texte (via refs). */
  const showBubble = (fraction: number, visible: boolean): void => {
    const b = bubbleRef.current;
    const t = bubbleTextRef.current;
    if (!b || !t) return;
    if (!visible) {
      b.classList.remove("is-visible");
      return;
    }
    const W = sim.current.width;
    const { duration: dur, formatValue: fmt } = live.current;
    t.textContent = fmt ? fmt(fraction) : dur && dur > 0 ? formatTime(fraction * dur) : `${Math.round(fraction * 100)}`;
    b.style.transform = `translate3d(${(fraction * W).toFixed(1)}px,0,0)`;
    b.classList.add("is-visible");
  };

  /** Une frame de simulation ; renvoie `true` tant qu'il reste quelque chose à animer. */
  const frame = useCallback(
    (dt: number, now: number): boolean => {
      const s = sim.current;
      const { playing: isPlaying, analyser: src, level: lvl, still: isStill } = live.current;
      if (isStill) {
        s.bending = false;
        s.env = 0;
        s.spring = { offset: 0, velocity: 0 };
        draw(now);
        return false;
      }
      const dragging = gesture.dragging();
      // Flexion : pendant le glisser, ressort vers la cible (suivi souple) ; après, retour vers 0.
      if (s.bending) {
        const target = dragging ? s.target : 0;
        const rel = stepSpring({ offset: s.spring.offset - target, velocity: s.spring.velocity }, dt);
        s.spring = { offset: rel.offset + target, velocity: rel.velocity };
        if (!dragging && Math.abs(s.spring.offset) < REST_OFFSET && Math.abs(s.spring.velocity) < REST_VELOCITY) {
          s.spring = { offset: 0, velocity: 0 };
          s.bending = false;
        }
      }
      // Frémissement : RMS lu en lecture seule, enveloppe attaque rapide / relâche lente.
      let wantVib = 0;
      const node = isPlaying && lvl.vibration > 0 ? resolveAnalyser(src) : null;
      if (node) {
        const n = node.fftSize;
        let buf = timeBuf.current;
        if (!buf || buf.length !== n) buf = timeBuf.current = new Uint8Array(new ArrayBuffer(n));
        node.getByteTimeDomainData(buf);
        wantVib = vibrationAmplitude(rmsFromTimeDomain(buf), true, lvl.vibration);
      }
      const k = wantVib > s.env ? 1 - Math.exp(-dt / 0.06) : 1 - Math.exp(-dt / 0.25);
      s.env += (wantVib - s.env) * k;
      if (s.env < 0.005 && wantVib === 0) s.env = 0;
      s.phase1 = (s.phase1 + dt * VIB_F1 * Math.PI * 2) % (Math.PI * 2);
      s.phase2 = (s.phase2 + dt * VIB_F2 * Math.PI * 2) % (Math.PI * 2);
      draw(now);
      const pendingAlive = s.pending !== null;
      return dragging || s.bending || s.env > 0 || node !== null || pendingAlive;
    },
    [draw, gesture],
  );

  const ensureLoop = useCallback((): void => {
    if (stopLoop.current || live.current.still) return;
    const stop = startFrameLoop(thin ? "biwa-string:thin" : "biwa-string", (dt, now) => {
      const keep = frame(dt, now);
      if (!keep) stopLoop.current = null;
      return keep;
    });
    stopLoop.current = stop;
  }, [frame, thin]);

  // Mesure de la largeur (et suivi des redimensionnements).
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    sim.current.width = el.getBoundingClientRect().width;
    draw(performance.now());
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (w !== sim.current.width) {
        sim.current.width = w;
        draw(performance.now());
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [draw, H]);

  // Valeur / tampon : dessin immédiat (la boucle, si elle tourne, redessine aussi).
  useLayoutEffect(() => {
    sim.current.value = clamp01(value);
    sim.current.buffered = clamp01(buffered ?? 0);
    draw(performance.now());
  }, [value, buffered, draw]);

  // Lecture / analyser / niveau : (re)démarre la boucle si elle a quelque chose à animer.
  useEffect(() => {
    if (still) {
      stopLoop.current?.();
      stopLoop.current = null;
      const s = sim.current;
      s.bending = false;
      s.env = 0;
      s.spring = { offset: 0, velocity: 0 };
      draw(performance.now());
      return;
    }
    if (playing && level.vibration > 0 && analyser) ensureLoop();
  }, [playing, analyser, level, still, ensureLoop, draw]);

  // Changement de piste pendant le glisser : annulation SANS recherche, la corde revient en place.
  useEffect(() => {
    if (!gesture.trackChanged(trackKey)) return;
    const s = sim.current;
    s.pending = null;
    const el = rootRef.current;
    if (el && s.pointerId >= 0 && el.hasPointerCapture?.(s.pointerId)) el.releasePointerCapture(s.pointerId);
    s.pointerId = -1;
    el?.classList.remove("is-dragging");
    showBubble(0, false);
    callbacks.current.onScrubEnd?.();
    draw(performance.now());
    ensureLoop();
  }, [trackKey]);

  useEffect(
    () => () => {
      stopLoop.current?.();
      stopLoop.current = null;
    },
    [],
  );

  const setTarget = (e: PointerEvent<HTMLDivElement>, rect: DOMRect): void => {
    const s = sim.current;
    const shape = deflect(e.clientX, e.clientY + PRESS_PX, rect, live.current.H / 2);
    s.anchorX = shape.anchorX;
    s.target = shape.offsetY;
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0 || gesture.dragging()) return;
    const el = e.currentTarget;
    const rect = el.getBoundingClientRect();
    sim.current.width = rect.width;
    const f = fractionFromPointer(e.clientX, rect);
    gesture.begin(live.current.trackKey, f);
    sim.current.pointerId = e.pointerId;
    el.setPointerCapture?.(e.pointerId);
    el.classList.add("is-dragging");
    el.focus({ preventScroll: true });
    if (!live.current.still) {
      setTarget(e, rect);
      sim.current.bending = true;
    }
    showBubble(f, true);
    callbacks.current.onScrubStart?.();
    draw(performance.now());
    ensureLoop();
    e.preventDefault();
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect(); // relu à chaque mouvement (HiDPI, resize)
    const f = fractionFromPointer(e.clientX, rect);
    if (gesture.dragging()) {
      sim.current.width = rect.width;
      gesture.move(f);
      if (!live.current.still) setTarget(e, rect);
      showBubble(f, true);
      if (live.current.still) draw(performance.now());
      return;
    }
    if (e.pointerType === "mouse") showBubble(f, true);
  };

  const finish = (e: PointerEvent<HTMLDivElement>, commit: boolean): void => {
    const s = sim.current;
    if (!gesture.dragging()) return;
    const f = commit ? gesture.end() : (gesture.cancel(), null);
    const el = e.currentTarget;
    if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
    s.pointerId = -1;
    el.classList.remove("is-dragging");
    if (f !== null) {
      s.pending = { fraction: f, until: performance.now() + PENDING_MS };
      callbacks.current.onSeek(f);
    }
    if (e.pointerType !== "mouse" || !commit) showBubble(0, false);
    callbacks.current.onScrubEnd?.();
    draw(performance.now());
    ensureLoop();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (gesture.dragging()) return;
    const dur = live.current.duration;
    const inc = step ?? (dur && dur > 0 ? 5 / dur : 0.05);
    const cur = sim.current.value;
    let next: number | null = null;
    switch (e.key) {
      case "ArrowRight":
      case "ArrowUp":
        next = cur + inc;
        break;
      case "ArrowLeft":
      case "ArrowDown":
        next = cur - inc;
        break;
      case "PageUp":
        next = cur + inc * 4;
        break;
      case "PageDown":
        next = cur - inc * 4;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    const f = clamp01(next);
    const s = sim.current;
    s.pending = { fraction: f, until: performance.now() + PENDING_MS };
    callbacks.current.onSeek(f);
    if (!live.current.still && s.width > 0) {
      // Petit pincement au point de recherche : la corde vibre puis s'amortit.
      s.anchorX = f * s.width;
      s.bending = true;
      s.spring = { offset: s.spring.offset, velocity: s.spring.velocity + KEY_PLUCK_VELOCITY * (thin ? 0.6 : 1) };
      ensureLoop();
    }
    draw(performance.now());
  };

  const v = clamp01(value);
  const hasDur = duration !== undefined && duration > 0;
  const now = hasDur ? Math.round(v * duration) : Math.round(v * 100);
  const valueText = hasDur ? `${formatTime(v * duration)} sur ${formatTime(duration)}` : `${Math.round(v * 100)} %`;
  const knobR = thin ? 4.5 : 6.5;

  return (
    <div
      ref={rootRef}
      className={`biwa${thin ? " biwa--thin" : ""}${still ? " is-still" : ""}${className ? ` ${className}` : ""}`}
      style={{ height: H }}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-orientation="horizontal"
      aria-valuemin={0}
      aria-valuemax={hasDur ? Math.round(duration) : 100}
      aria-valuenow={now}
      aria-valuetext={valueText}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => finish(e, true)}
      onPointerCancel={(e) => finish(e, false)}
      onLostPointerCapture={(e) => finish(e, false)}
      onPointerLeave={(e) => {
        if (!gesture.dragging() && e.pointerType === "mouse") showBubble(0, false);
      }}
      onKeyDown={onKeyDown}
    >
      <svg className="biwa__svg" width="100%" height={H} aria-hidden="true" focusable="false">
        <defs>
          <linearGradient ref={gradRef} id={ids.grad} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#8a6420" />
            <stop offset="0.55" stopColor="#d4aa50" />
            <stop offset="0.92" stopColor="#f0d38a" />
            <stop offset="1" stopColor="#fff2cc" />
          </linearGradient>
          <linearGradient ref={glowGradRef} id={ids.glow} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#d4aa50" stopOpacity="0" />
            <stop offset="0.6" stopColor="#d4aa50" stopOpacity="0.35" />
            <stop offset="1" stopColor="#f0d38a" stopOpacity="1" />
          </linearGradient>
          <radialGradient id={ids.knob} cx="0.4" cy="0.32" r="0.75">
            <stop offset="0" stopColor="#fbecc0" />
            <stop offset="0.45" stopColor="#e2bd68" />
            <stop offset="1" stopColor="#9c7428" />
          </radialGradient>
          <clipPath id={ids.played}>
            <rect ref={playedClipRef} x={-8} y={-40} width={0} height={H + 80} />
          </clipPath>
          <clipPath id={ids.buf}>
            <rect ref={bufClipRef} x={0} y={-40} width={0} height={H + 80} />
          </clipPath>
        </defs>
        <path ref={baseRef} className="biwa__base" />
        <path ref={bufRef} className="biwa__buffer" clipPath={`url(#${ids.buf})`} />
        <path ref={glowRef} className="biwa__glow" clipPath={`url(#${ids.played})`} stroke={`url(#${ids.glow})`} />
        <path ref={playedRef} className="biwa__played" clipPath={`url(#${ids.played})`} stroke={`url(#${ids.grad})`} />
        <g ref={handleRef}>
          <circle className="biwa__bead" r={thin ? 1.3 : 1.7} />
          <g className="biwa__handle">
            <circle className="biwa__halo" r={knobR + 5} />
            <circle className="biwa__knob" r={knobR} fill={`url(#${ids.knob})`} />
            <circle className="biwa__knob-hi" r={knobR - 1.4} />
          </g>
        </g>
      </svg>
      <div ref={bubbleRef} className="biwa__bubble" aria-hidden="true">
        <span ref={bubbleTextRef} />
      </div>
    </div>
  );
}

export const BiwaString = memo(BiwaStringImpl);
