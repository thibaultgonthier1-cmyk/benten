import type { AudioEngine } from "../audio/engine";
import type { PlayerStore } from "../state/player";
import type { Album } from "../lib/library";

/**
 * Commandes de transport exposees a l'UI. Elles pilotent le moteur (source de verite du son) et
 * posent un etat optimiste dans le store ; `statechange` reconcilie ensuite (voir player.ts).
 */
export interface PlayerControls {
  /** Charge et joue un album depuis `index`. */
  playAlbum(album: Album, index?: number): void;
  /** Lecture/pause selon l'etat courant. */
  toggle(): void;
  next(): void;
  prev(): void;
  /** Positionne la tete de lecture a une fraction [0..1] de la duree. */
  seekFraction(fraction: number): void;
}

export function createControls(engine: AudioEngine, store: PlayerStore): PlayerControls {
  return {
    playAlbum(album, index = 0) {
      store.getState().setQueue(album.tracks, index);
      void engine.setQueue(album.tracks, index).then(() => engine.play());
    },
    toggle() {
      if (store.getState().status === "playing") engine.pause();
      else engine.play();
    },
    next() {
      store.getState().next();
      void engine.next();
    },
    prev() {
      store.getState().prev();
      void engine.prev();
    },
    seekFraction(fraction) {
      const { durationSec, currentTrack } = store.getState();
      const dur = durationSec || currentTrack?.durationSec || 0;
      const target = Math.max(0, Math.min(1, fraction)) * dur;
      store.getState().setPosition(target);
      engine.seek(target);
    },
  };
}
