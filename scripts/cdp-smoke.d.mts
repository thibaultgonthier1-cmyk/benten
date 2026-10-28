// Déclarations de types pour les helpers purs exportés par `cdp-smoke.mjs`, afin que le
// test TypeScript puisse les importer sous `tsc --noEmit` sans `allowJs`.

export interface CdpArgs {
  port: number;
  timeout: number;
  expr?: string;
}

export function parseArgs(argv: string[]): CdpArgs;

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T>;
