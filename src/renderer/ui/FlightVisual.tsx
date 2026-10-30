import { CoverArt } from "./CoverArt";
import type { Flight } from "./playlistFx";

/**
 * Visuel d'un objet en vol vers la barre latérale (ajout à une playlist) — POINT D'ÉCHANGE UNIQUE.
 *
 * `<FlyLayer>` ne fait que DÉPLACER ce visuel (arc, réduction, fondu) ; tout ce qui se voit est ici
 * et dans `.fly-visual` (fly.css). La direction artistique « Biwa & Or » remplacera la miniature de
 * pochette par des paillettes de feuille d'or : seul ce composant (et sa CSS) change.
 *
 * Contrat : remplit une boîte carrée de `FLIGHT_SIZE` px (le parent porte la transformation),
 * couleurs par les jetons du thème uniquement.
 */
export const FLIGHT_SIZE = 64;

export function FlightVisual({ flight }: { flight: Flight }): JSX.Element {
  return (
    <span className="fly-visual">
      <CoverArt artKey={flight.artKey} seed={flight.seed} />
    </span>
  );
}
