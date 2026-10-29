/**
 * Instance unique + echec fatal au demarrage (process Main).
 *
 * Instance unique : la build de dev (`benten`) et l'exe (`Benten`) partagent le MEME dossier
 * %APPDATA% sous Windows (insensible a la casse). Deux processus ecrivant la meme base SQLite est
 * une cause plausible de corruption : un second lancement rend donc la main a la fenetre existante
 * et quitte sans jamais ouvrir la base.
 */

/** Sous-ensemble d'`app` utilise ici (injectable pour les tests). */
export interface InstanceApp {
  requestSingleInstanceLock(): boolean;
  quit(): void;
  // `any[]` : meme signature qu'`EventEmitter.on`.
  on(event: string, listener: (...args: any[]) => void): unknown;
}

/**
 * Prend le verrou d'instance unique. Non obtenu : `app.quit()` et `false` (l'appelant ne doit RIEN
 * initialiser). Obtenu : `true`, et `onSecondInstance` est rappele a chaque lancement ulterieur.
 */
export function enforceSingleInstance(app: InstanceApp, onSecondInstance: () => void): boolean {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return false;
  }
  app.on("second-instance", () => {
    try {
      onSecondInstance();
    } catch {
      /* best-effort */
    }
  });
  return true;
}

/** Fenetre minimale a ramener au premier plan. */
export interface FocusableWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

/** Restaure (si reduite), affiche et donne le focus a la fenetre existante. */
export function focusWindow(win: FocusableWindow | null | undefined): void {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/**
 * Echec fatal au demarrage (base illisible ET irrecuperable, disque plein...) : message clair en
 * francais avec le chemin du journal, puis `app.exit(1)` — jamais de processus zombie sans fenetre.
 */
export function reportFatalStartup(
  deps: { app: { exit(code: number): void }; dialog: { showErrorBox(title: string, content: string): void } },
  err: unknown,
  logPath: string,
): void {
  const detail = err instanceof Error ? err.message : String(err);
  try {
    deps.dialog.showErrorBox(
      "Benten ne peut pas démarrer",
      "La base de la bibliothèque n'a pas pu être ouverte ni réparée automatiquement.\n\n" +
        `Détail : ${detail}\n\n` +
        "Vos fichiers musicaux ne sont pas touchés. Les fichiers de la base, s'ils ont été déplacés, " +
        "sont conservés dans le dossier de données de Benten (db-corrupted-…, db-preopen-…).\n\n" +
        `Journal : ${logPath}`,
    );
  } catch {
    /* pas d'affichage possible : on sort quand meme */
  }
  deps.app.exit(1);
}
