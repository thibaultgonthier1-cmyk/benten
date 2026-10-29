import { usePlayer } from "../state/player";
import "./tiles.css";

/**
 * Équaliseur animé du titre / de l'album en cours : quatre barres qui ondulent en `scaleY`
 * (transform uniquement). Arrêté et posé bas dès que le statut n'est pas « playing » (pause,
 * chargement, erreur…) ; statique en mouvement réduit.
 */
export function Equalizer({ className }: { className?: string }): JSX.Element {
  const playing = usePlayer((s) => s.status === "playing");
  return (
    <span className={`eq${playing ? "" : " is-paused"}${className ? ` ${className}` : ""}`} aria-hidden="true">
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}
