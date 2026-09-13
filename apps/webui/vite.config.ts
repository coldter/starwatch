import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The worker serves this app from `dist/` (Alchemy `assets` prop, runWorkerFirst: ["/api/*"]).
// In dev, Vite proxies /api to the locally running worker (`pnpm --filter @starwatch/worker dev`).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: "dist",
    sourcemap: true
  }
});
