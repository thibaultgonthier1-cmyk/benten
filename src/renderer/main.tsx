import React, { useEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { MotionConfig } from "framer-motion";
// Design system Phase 3 : chargé AVANT l'ancien theme/tokens.css (importé par App).
import "./theme/ds/base.css";
import "./theme/ds/tokens.css";
import { App } from "./App";
import { settingsStore, useSettings } from "./state/settings";
import { reducedMotionFor } from "./theme/ds/motion";
import { applyPalette } from "./theme/palettes";
import "./theme/palettes.css";

// Préchauffe les polices embarquées : @fontsource découpe le japonais en tranches `unicode-range`
// chargées à la demande ; on charge d'emblée les tranches de base (latin + kana, ~30 Ko locaux par
// graisse) des graisses usuelles pour éviter un saut de police au premier titre en kana.
const WARM_FONTS = [
  '400 16px "Zen Kaku Gothic New"',
  '500 16px "Zen Kaku Gothic New"',
  '700 16px "Zen Kaku Gothic New"',
  '500 16px "Shippori Mincho"',
  '600 16px "Shippori Mincho"',
];
for (const font of WARM_FONTS) {
  document.fonts?.load(font).catch(() => {
    /* préchauffage best-effort : le chargement à la demande reste en place. */
  });
}


/**
 * Mouvement global piloté par le réglage d'intensité (réactif) : « Réduit » coupe les animations
 * framer-motion partout (`always`) ; sinon framer suit `prefers-reduced-motion` (`user`).
 * `data-motion` sur <html> permet aussi au CSS (shimmer, transitions) de suivre le réglage.
 * NB : tout composant animé doit AUSSI respecter `useMotion()` (activation/durées via motionFor).
 */
function MotionRoot({ children }: { children: ReactNode }): JSX.Element {
  const intensity = useSettings((s) => s.motionIntensity);
  useEffect(() => {
    document.documentElement.dataset.motion = intensity;
  }, [intensity]);
  return <MotionConfig reducedMotion={reducedMotionFor(intensity)}>{children}</MotionConfig>;
}

// Premier rendu RETENU jusqu'aux réglages persistés (quelques ms, écran noir) : framer-motion lit
// `reducedMotion` au montage de chaque élément, l'intensité doit donc être connue avant. `load()`
// ne lève jamais (défauts conservés en cas d'échec).
void settingsStore
  .getState()
  .load()
  .finally(() => {
    // La palette est appliquée AVANT le premier rendu : sinon l'interface apparaît en or
// puis bascule, ce qui produit un clignotement de couleur au lancement.
applyPalette(settingsStore.getState().palette);

createRoot(document.getElementById("root") as HTMLElement).render(
      <React.StrictMode>
        <MotionRoot>
          <App />
        </MotionRoot>
      </React.StrictMode>,
    );
  });


