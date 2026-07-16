import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    host: "0.0.0.0",
    port: Number(process.env.VITE_STUDIO_PORT || 5107),
    // 允许任意 Host 访问(本地开发用自定义域名,如 studio.local)。
    allowedHosts: true,
    proxy: {
      // ── A1/A2 merge: Studio frontend now talks entirely to the Core backend ──
      // Core serves the full authoring API (app.routers.studio.*) plus the heavy
      // services (workflow engine, embeddings/Qdrant, canonical users/teams) that
      // the old Studio backend delegated here anyway. The Studio backend (8107) is
      // decommissioned — all traffic goes to Core (8106). See docs/A1-merge-plan.md.
      "/icons": {
        target: process.env.VITE_CORE_BACKEND_URL || "http://localhost:8106",
        changeOrigin: true,
      },
      "/api": {
        target: process.env.VITE_CORE_BACKEND_URL || "http://localhost:8106",
        changeOrigin: true,
      },
    },
  },
});
