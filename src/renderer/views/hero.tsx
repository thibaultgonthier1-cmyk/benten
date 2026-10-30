import type React from "react";
import { useEffect, useId, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Pause, Play } from "lucide-react";
import { dur, ease } from "../theme/ds/motion";
import { CoverArt } from "../ui/CoverArt";
import { useMotion } from "../ui/useMotion";

/**
 * Pièces communes des en-têtes teintés (page album, page artiste) : teinte publiée sous la barre
 * du haut, barre compacte au défilement, entrée en cascade du contenu.
 */

/** Défilement (px) sur lequel la teinte de la barre du haut s'éteint. */
const TINT_FADE_PX = 220;

/**
 * La couleur de l'en-tête passe sous la barre du haut (aucune arête nette) : la page publie sa
 * teinte sur `.shell-main` (`--top-tint`, `data-tint`) et l'éteint en défilant (opacité
 * `--top-tint-o`, mise à jour au plus une fois par frame) ; tout est retiré en quittant la page.
 */
/**
 * Teinte d'en-tête sûre (point (m) de la revue DA).
 *
 * Une pochette très claire produit une teinte claire : le dégradé du haut devient alors laiteux et
 * le titre ivoire perd son contraste. Dans ce cas on ne teinte PAS (retour au laque de la page) —
 * c'est la règle « en-tête neutre plutôt qu'or ».
 */
export function safeTint(color: string | null | undefined): string | null {
  if (!color) return null;
  const rgb = parseColor(color);
  if (!rgb) return null;
  const [r, g, b] = rgb.map((v) => v / 255) as [number, number, number];
  const lin = (c: number): number => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  // Au-delà de 0,42 la teinte éclaircit trop le haut de page.
  return luminance > 0.42 ? null : color;
}

function parseColor(value: string): [number, number, number] | null {
  const text = value.trim().toLowerCase();
  const hex = text.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (hex) {
    const raw = hex[1]!;
    const full = raw.length === 3 ? raw.split("").map((c) => c + c).join("") : raw;
    return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
  }
  const rgb = text.match(/^rgba?\(([^)]+)\)$/);
  if (rgb) {
    const parts = rgb[1]!.split(",").map((p) => Number(p.trim()));
    if (parts.length >= 3 && parts.slice(0, 3).every((n) => Number.isFinite(n))) {
      return [parts[0]!, parts[1]!, parts[2]!];
    }
  }
  return null;
}
export function useTopTint(scrollRef: React.RefObject<HTMLElement>, tint: string | null): void {
  const tintOwner = useId();
  useEffect(() => {
    const scroller = scrollRef.current;
    const main = scroller?.parentElement;
    if (!scroller || !main || !tint) return;
    main.style.setProperty("--top-tint", tint);
    // Jeton de propriété : la page sortante (démontée APRÈS l'entrée de la suivante, mode
    // popLayout) ne retire pas la teinte posée par une autre page.
    main.dataset.tint = tintOwner;
    let raf = 0;
    const update = (): void => {
      raf = 0;
      main.style.setProperty("--top-tint-o", Math.max(0, 1 - scroller.scrollTop / TINT_FADE_PX).toFixed(3));
    };
    const onScroll = (): void => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
      if (main.dataset.tint !== tintOwner) return;
      delete main.dataset.tint;
      main.style.removeProperty("--top-tint");
      main.style.removeProperty("--top-tint-o");
    };
  }, [tint, tintOwner, scrollRef]);
}

/** Barre compacte : visible dès que `target` (la rangée de boutons) passe sous la barre du haut. */
export function useCompactOnScroll(
  scrollRef: React.RefObject<HTMLElement>,
  targetRef: React.RefObject<HTMLElement>,
): boolean {
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const root = scrollRef.current;
    const target = targetRef.current;
    if (!root || !target) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return;
        const above = entry.boundingClientRect.bottom < (entry.rootBounds?.top ?? 0) + 72;
        setCompact(!entry.isIntersecting && above);
      },
      { root, rootMargin: "-72px 0px 0px 0px", threshold: 0 },
    );
    io.observe(target);
    return () => io.disconnect();
  }, [scrollRef, targetRef]);
  return compact;
}

/** Props d'entrée en cascade (rang `i`) du contenu d'un en-tête ; vides en mouvement coupé. */
export function useHeroEnter(): (i: number) => Record<string, unknown> {
  const m = useMotion();
  return (i: number) =>
    m.enabled
      ? {
          initial: { opacity: 0, y: 10 },
          animate: { opacity: 1, y: 0 },
          transition: { duration: m.d(dur.slow), ease: ease.out, delay: m.d(0.08 + i * 0.05) },
        }
      : {};
}

/** Barre compacte collée en haut au défilement : lecture, vignette (ronde pour un artiste), titre. */
export function HeroCompactBar({
  visible,
  playing,
  onPlay,
  disabled,
  title,
  sub,
  artKey,
  seed,
  round = false,
}: {
  visible: boolean;
  playing: boolean;
  onPlay(): void;
  disabled?: boolean;
  title: string;
  sub?: string;
  artKey: string | null;
  seed: string;
  round?: boolean;
}): JSX.Element {
  const m = useMotion();
  return (
    <div className="album-compact-anchor">
      <AnimatePresence>
        {visible && (
          <motion.div
            className="album-compact"
            initial={m.enabled ? { opacity: 0, y: -8 } : false}
            animate={{ opacity: 1, y: 0 }}
            exit={m.enabled ? { opacity: 0, y: -8 } : { opacity: 0 }}
            transition={{ duration: m.d(dur.base), ease: ease.out }}
          >
            <button
              type="button"
              className="album-compact__play"
              aria-label={playing ? "Pause" : `Lire ${title}`}
              onClick={onPlay}
              disabled={disabled}
            >
              {playing ? (
                <Pause size={18} strokeWidth={0} fill="currentColor" aria-hidden />
              ) : (
                <Play size={18} strokeWidth={0} fill="currentColor" aria-hidden />
              )}
            </button>
            <span className={`album-compact__thumb${round ? " is-round" : ""}`}>
              <CoverArt artKey={artKey} seed={seed} />
            </span>
            <span className="album-compact__title" title={title}>
              {title}
            </span>
            {sub && <span className="album-compact__artist">{sub}</span>}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

