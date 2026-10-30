import { useEffect, useRef, useState } from "react";
import { assetUrl, type AssetId } from "../assets/manifest";
import { useUi, type RouteName } from "../state/ui";
import { useMotion } from "../ui/useMotion";
import "./backdrop.css";

/**
 * Fond animé par catégorie.
 *
 * Chaque vue a son ambiance : l'accueil respire avec Benzaiten, les titres avec le torii au bord
 * de l'eau, les playlists avec la pose de biwa… Quand on change de catégorie, l'ancienne image
 * reste en place et s'efface pendant que la nouvelle apparaît — c'est un FONDU ENCHAÎNÉ de fonds,
 * pas un remplacement sec.
 *
 * Coût maîtrisé : deux couches image au maximum, transitions sur `opacity` et `transform`
 * uniquement (composited), aucun `filter: blur()`. En mouvement réduit, pas de dérive lente et un
 * fondu instantané.
 */

/**
 * Fond de chaque catégorie. Les vues les plus regardées reçoivent la SCÈNE 3D (Blender) ; les
 * autres gardent une illustration fixe — une vidéo par vue coûterait trop de décodage pour un
 * écran qu'on traverse.
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

export function ViewBackdrop(): JSX.Element | null {
  const route = useUi((s) => s.route.name);
  const m = useMotion();
  const [layers, setLayers] = useState<Layer[]>([]);
  const counter = useRef(0);

  useEffect(() => {
    const isScene = SCENE_ROUTES.has(route);
    const url = isScene ? assetUrl("scene.torii") : (() => {
      const id = BACKDROP_FOR[route];
      return id ? assetUrl(id) : null;
    })();
    if (!url) {
      setLayers([]);
      return;
    }
    counter.current += 1;
    const next: Layer = { id: counter.current, url, video: isScene };
    // On garde l'ancienne couche le temps du fondu (elle s'efface), puis on la retire.
    setLayers((previous) => [...previous.slice(-1), next]);
    const timer = window.setTimeout(() => {
      setLayers((previous) => previous.filter((layer) => layer.id === next.id));
    }, m.enabled ? 900 : 0);
    return () => window.clearTimeout(timer);
  }, [route, m.enabled]);

  if (layers.length === 0) return null;

  return (
    <div className="view-backdrop-layer" aria-hidden="true">
      {layers.map((layer, index) =>
        layer.video ? (
          <video
            key={layer.id}
            className="view-backdrop-frame view-backdrop-video"
            data-current={index === layers.length - 1 ? "true" : "false"}
            src={layer.url}
            autoPlay
            muted
            loop
            playsInline
            preload="auto"
            aria-hidden="true"
          />
        ) : (
          <div
            key={layer.id}
            className="view-backdrop-frame"
            data-current={index === layers.length - 1 ? "true" : "false"}
            style={{ backgroundImage: `url("${layer.url}")` }}
          />
        ),
      )}
    </div>
  );
}

