import { useEffect } from "react";
import { PALETTES } from "../theme/palettes";
import { settingsStore, useSettings } from "../state/settings";
import "../theme/palettes.css";

/**
 * Choix de la palette d'accent.
 *
 * Le thème or reste le défaut, mais ce n'est plus le seul : chaque palette ne change QUE l'accent
 * et ses dérivés (boutons, anneaux, soulignements). Les surfaces, le texte et les traits sont
 * communs — c'est ce qui garantit qu'aucune palette ne dégrade la lisibilité.
 */
export function PalettePicker(): JSX.Element {
  const palette = useSettings((s) => s.palette);

  useEffect(() => {
    // Au montage, on s'assure que le document porte bien la palette enregistrée.
    document.documentElement.dataset.palette = palette;
  }, [palette]);

  return (
    <section className="settings-block">
      <h3>Couleur d'accent</h3>
      <p className="settings-hint">
        Change l'accent de toute l'interface — boutons, anneaux, soulignements. Le reste du thème
        (laque, encre, ivoire) ne bouge pas.
      </p>
      <div className="palette-grid" role="group" aria-label="Palette d'accent">
        {PALETTES.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className="palette-chip"
            aria-pressed={palette === entry.id}
            title={entry.hint}
            onClick={() => settingsStore.getState().setPalette(entry.id)}
          >
            <span className="palette-chip__dot" style={{ background: entry.swatch }} aria-hidden />
            <span>{entry.label}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
