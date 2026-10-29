import { useRef } from "react";
import { usePlayer, playerStore } from "../state/player";
import { artUrl, formatTime } from "../lib/library";
import { useFocusTrap } from "../lib/focusTrap";
import { jumpWithOrigin } from "../runtime/transportJournal";

/**
 * Panneau « File d'attente » (DA Benten, feuille modale focus-trapped — meme ossature que la feuille
 * qualite). Montre la file : pistes PASSEES grisees, piste COURANTE surlignee (or), pistes A
 * VENIR. Actions par ligne : jouer (clic sur la ligne -> `jumpTo`, saut anti-clic), retirer (✕),
 * monter / descendre. Les mutations futures passent par le store, qui pilote le moteur SANS couper
 * la lecture courante (`updateQueue({keepCurrent:true})`).
 *
 * S'ouvre depuis le mini-lecteur / la vue lecture (`setQueueOpen(true)`). Fermee, `.sheet-wrap`
 * passe en `display:none` : rien de focusable hors-ecran.
 */
export function QueuePanel(): JSX.Element {
  const open = usePlayer((s) => s.queueOpen);
  const queue = usePlayer((s) => s.queue);
  const currentIndex = usePlayer((s) => s.currentIndex);
  const ref = useRef<HTMLDivElement>(null);

  const close = (): void => playerStore.getState().setQueueOpen(false);
  useFocusTrap(ref, { active: open, onEscape: close });

  // Consigné dans le journal audio (origine « ui ») puis exécuté tel quel.
  const jump = (i: number): void => jumpWithOrigin(playerStore, i, "ui");

  return (
    <div className={"sheet-wrap queue-wrap" + (open ? " open" : "")} aria-hidden={!open}>
      <button
        className="sheet-scrim"
        type="button"
        aria-label="Fermer la file d'attente"
        tabIndex={open ? 0 : -1}
        onClick={close}
      />
      <div
        ref={ref}
        className="sheet queue-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="File d'attente"
      >
        <button
          className="sheet-close"
          type="button"
          aria-label="Fermer"
          tabIndex={open ? 0 : -1}
          onClick={close}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>

        <h3>File d'attente</h3>
        <p className="sub">
          {queue.length === 0 ? "aucune piste" : `${queue.length} pistes`}
        </p>

        {queue.length === 0 ? (
          <div className="scan-note">La file est vide. Lance un album ou une playlist.</div>
        ) : (
          <ul className="q-list">
            {queue.map((t, i) => {
              const state = i < currentIndex ? "past" : i === currentIndex ? "current" : "up";
              const art = artUrl(t.artKey, 64);
              return (
                <li key={`${t.id}-${i}`} className={"q-item " + state}>
                  <button
                    className="q-play"
                    type="button"
                    onClick={() => jump(i)}
                    aria-current={state === "current" ? "true" : undefined}
                    title={state === "current" ? "En lecture" : "Lire cette piste"}
                  >
                    <span className="q-no" aria-hidden="true">
                      {state === "current" ? "♪" : i + 1}
                    </span>
                    {art ? (
                      <img className="q-art" src={art} alt="" />
                    ) : (
                      <span className="q-art placeholder" aria-hidden="true" />
                    )}
                    <span className="q-meta">
                      <span className="q-title">{t.title}</span>
                      <span className="q-artist">{t.artist}</span>
                    </span>
                    <span className="q-dur">{formatTime(t.durationSec)}</span>
                  </button>
                  <div className="q-actions">
                    <button
                      className="pl-btn"
                      type="button"
                      onClick={() => playerStore.getState().moveInQueue(i, i - 1)}
                      disabled={i === 0}
                      aria-label={`Monter ${t.title}`}
                      title="Monter"
                    >
                      ↑
                    </button>
                    <button
                      className="pl-btn"
                      type="button"
                      onClick={() => playerStore.getState().moveInQueue(i, i + 1)}
                      disabled={i === queue.length - 1}
                      aria-label={`Descendre ${t.title}`}
                      title="Descendre"
                    >
                      ↓
                    </button>
                    <button
                      className="pl-btn danger"
                      type="button"
                      onClick={() => playerStore.getState().removeFromQueue(i)}
                      aria-label={`Retirer ${t.title} de la file`}
                      title="Retirer"
                    >
                      ✕
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
