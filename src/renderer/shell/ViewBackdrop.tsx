import { useEffect, useRef, useState } from "react";
import { assetUrl, type AssetId } from "../assets/manifest";
import { usePlayer } from "../state/player";
import { useUi, type RouteName } from "../state/ui";
import { useMotion } from "../ui/useMotion";
import { requestFx } from "../ui/FxOverlay";
import "./backdrop.css";

/**
 * Fond réactif.
 *
 * Trois choses le font vivre, et aucune ne dépend d'une vidéo longue :
 *
 *  1. **Il suit la lecture.** La scène 3D se fige quand tu mets en pause et reprend quand tu
 *     relances ; le fond baisse légèrement en pause. Le décor « écoute » l'app.
 *  2. **Il suit le défilement.** Un léger décalage par rapport au contenu (parallaxe) donne du
 *     relief : transform seulement, une mise à jour par frame au maximum.
 *  3. **Il réagit au changement de piste.** Une onde dorée traverse le fond au moment où le
 *     morceau change — c'est l'effet `fx.ripple` déjà produit, pas une nouvelle vidéo.
 *
 * En mouvement réduit : ni parallaxe ni onde, et la vidéo reste simplement posée.
 */

/**
 * Fond de chaque catégorie. Les vues les plus regardées reçoivent une SCÈNE ANIMÉE ; les autres
 * gardent une illustration fixe — une vidéo par vue coûterait trop de décodage pour un écran qu'on
 * traverse.
 */
const SCENE_ROUTES: ReadonlySet<RouteName> = new Set<RouteName>(["home", "tracks", "albums"]);

const BACKDROP_FOR: Readonly<Record<RouteName, AssetId | null>> = Object.freeze({
  home: "ill.onboarding",
  tracks: "ill.noResults",
  albums: "ill.emptyLibrary",
  album: "ill.emptyLibrary",
  artists: "ill.emptyPlaylist",
  artist: "ill.emptyPlaylist",
  playlists: "ill.emptyPlaylist",
  playlist: "ill.emptyPlaylist",
  favorites: "ill.onboarding",
  search: "ill.noResults",
  downloads: "ill.noResults",
  apple: "ill.onboarding",
  settings: "ill.noResults",
});

interface Layer {
  id: number;
  url: string;
  video: boolean;
}

/** Amplitude de la parallaxe : 8 % du défilement, plafonnée. */
const PARALLAX_RATE = 0.16;
const PARALLAX_MAX = 90;

export function ViewBackdrop(): JSX.Element | null {
  const route = useUi((s) => s.route.name);
  const playing = usePlayer((s) => s.status === "playing");
  const trackId = usePlayer((s) => s.currentTrack?.id ?? null);
  const m = useMotion();
  const [layers, setLayers] = useState<Layer[]>([]);
  const [shift, setShift] = useState(0);
  // Décalage piloté par la souris : le décor réagit au curseur, pas seulement au défilement.
  const [pointer, setPointer] = useState({ x: 0, y: 0 });
  const counter = useRef(0);
  const lastTrack = useRef<number | null>(null);

  // --- Changement de catégorie : fondu enchaîné ------------------------------------------------
  useEffect(() => {
    const isScene = SCENE_ROUTES.has(route);
    const url = isScene
      ? assetUrl("scene.torii")
      : (() => {
          const id = BACKDROP_FOR[route];
          return id ? assetUrl(id) : null;
        })();
    if (!url) {
      setLayers([]);
      return;
    }
    counter.current += 1;
    const next: Layer = { id: counter.current, url, video: isScene };
    setLayers((previous) => [...previous.slice(-1), next]);
    const timer = window.setTimeout(
      () => setLayers((previous) => previous.filter((layer) => layer.id === next.id)),
      m.enabled ? 900 : 0,
    );
    return () => window.clearTimeout(timer);
  }, [route, m.enabled]);

  // --- Défilement : parallaxe ---------------------------------------------------------------
  useEffect(() => {
    if (!m.enabled) {
      setShift(0);
      return undefined;
    }
    const scroller = document.querySelector<HTMLElement>(".shell-scroll");
    if (!scroller) return undefined;
    let raf = 0;
    const onScroll = (): void => {
      if (raf) return; // une seule mise à jour par frame, même si l'événement pleut
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        setShift(Math.min(PARALLAX_MAX, scroller.scrollTop * PARALLAX_RATE));
      });
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [m.enabled]);

  // --- Souris : le fond suit le curseur (parallaxe inverse, très légère) ----------------------
  useEffect(() => {
    if (!m.enabled) {
      setPointer({ x: 0, y: 0 });
      return undefined;
    }
    let raf = 0;
    const onMove = (event: PointerEvent): void => {
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        // Normalisé dans [-1,1] depuis le centre, puis réduit : 14 px de course au maximum.
        const x = (event.clientX / window.innerWidth - 0.5) * 2;
        const y = (event.clientY / window.innerHeight - 0.5) * 2;
        setPointer({ x: Math.round(-x * 34), y: Math.round(-y * 22) });
      });
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [m.enabled]);

  // --- Changement de piste : onde dorée ------------------------------------------------------
  useEffect(() => {
    if (trackId === null) return;
    const previous = lastTrack.current;
    lastTrack.current = trackId;
    if (previous === null || previous === trackId || !m.enabled) return; // premier morceau : rien
    requestFx("ripple", { x: window.innerWidth / 2, y: Math.round(window.innerHeight * 0.22) }, { size: 520 });
  }, [trackId, m.enabled]);

  // La scène se fige en pause : le décor suit l'état de l'app.
  useEffect(() => {
    const video = document.querySelector<HTMLVideoElement>(".view-backdrop-video[data-current='true']");
    if (!video) return;
    if (playing) void video.play().catch(() => undefined);
    else video.pause();
  }, [playing, layers]);

  if (layers.length === 0) return null;

  return (
    <div className="view-backdrop-layer" aria-hidden="true" data-playing={playing ? "true" : "false"}>
      {layers.map((layer, index) => {
        const current = index === layers.length - 1;
        // Composition des deux mouvements : défilement (vertical) + souris (les deux axes).
        const style = {
          transform: `translate3d(${pointer.x}px, ${-shift + pointer.y}px, 0)`,
        };
        return layer.video ? (
          <video
            key={layer.id}
            className="view-backdrop-frame view-backdrop-video"
            data-current={current ? "true" : "false"}
            style={style}
            src={layer.url}
            autoPlay
            muted
            loop
            playsInline
            preload="auto"
          />
        ) : (
          <div
            key={layer.id}
            className="view-backdrop-frame"
            data-current={current ? "true" : "false"}
            style={{ ...style, backgroundImage: `url("${layer.url}")` }}
          />
        );
      })}
    </div>
  );
}


