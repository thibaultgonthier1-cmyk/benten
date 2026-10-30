// Typage minimal de `import.meta.env` pour le renderer (Vite/electron-vite injecte ces drapeaux au
// build). `tsconfig` ne tire que `@types/node`, donc on declare ici le strict necessaire au pont de
// test DEV-ONLY (`import.meta.env.DEV`), sans dependre de `vite/client`. `DEV` est `true` en dev et
// `false` dans un build de production -> le pont `window.__benten` n'est JAMAIS attache en prod.
interface ImportMetaEnv {
  readonly DEV: boolean;
  readonly PROD: boolean;
  readonly MODE: string;
}
/** Sous-ensemble de l'API HMR de Vite (`import.meta.hot`, absent en production et en tests). */
interface ViteHotContext {
  readonly data: Record<string, unknown>;
  dispose(cb: (data: Record<string, unknown>) => void): void;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
  readonly hot?: ViteHotContext;
}
