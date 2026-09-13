import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The worker serves this app from `dist/` (Alchemy `assets` prop, runWorkerFirst: ["/api/*"]).
// In dev, `alchemy dev` runs the API in workerd on its default port 1337 and this
// Vite server proxies /api to it (see apps/worker/alchemy.run.ts `Command.Dev`).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:1337",
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: "dist",
    sourcemap: true
  }
});
