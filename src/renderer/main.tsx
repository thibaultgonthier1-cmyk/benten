import React from "react";
import { createRoot } from "react-dom/client";
import { MotionConfig } from "framer-motion";
// Design system Phase 3 : chargé AVANT l'ancien theme/tokens.css (importé par App).
import "./theme/ds/base.css";
import "./theme/ds/tokens.css";
import { App } from "./App";
import { settingsStore } from "./state/settings";

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

// Amorce les réglages persistés (intensité du mouvement, intro) ; best-effort, non bloquant.
void settingsStore.getState().load();

createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <MotionConfig reducedMotion="user">
      <App />
    </MotionConfig>
  </React.StrictMode>,
);
