import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {
    resolve: { alias: { "@shared": resolve("src/shared") } },
    build: { rollupOptions: { input: { index: resolve("src/main/index.ts") } } },
  },
  preload: {
    resolve: { alias: { "@shared": resolve("src/shared") } },
    build: { rollupOptions: { input: { index: resolve("src/preload/index.ts") } } },
  },
  renderer: {
    root: resolve("src/renderer"),
    resolve: { alias: { "@shared": resolve("src/shared") } },
    plugins: [react()],
    server: { port: 5173, strictPort: true },
    build: { rollupOptions: { input: { index: resolve("src/renderer/index.html") } } },
  },
});
