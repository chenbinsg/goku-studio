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
    proxy: {
      // ── Core backend (8106) routes ──────────────────────────────────────
      // These must ALL be listed BEFORE the catch-all "/api" rule.

      // Agent instance management (polling causes log spam when missing)
      "/api/v1/agent-instances": {
        target: process.env.VITE_CORE_BACKEND_URL || "http://localhost:8106",
        changeOrigin: true,
      },
      // Agent policies sub-resource (regex: /api/v1/agents/{id}/policies)
      "^/api/v1/agents/[^/]+/policies": {
        target: process.env.VITE_CORE_BACKEND_URL || "http://localhost:8106",
        changeOrigin: true,
      },
      // Stateful policies
      "/api/v1/stateful-policies": {
        target: process.env.VITE_CORE_BACKEND_URL || "http://localhost:8106",
        changeOrigin: true,
      },
      // Conversations, roles, departments
      "/api/v1/conversations": {
        target: process.env.VITE_CORE_BACKEND_URL || "http://localhost:8106",
        changeOrigin: true,
      },
      "/api/v1/roles": {
        target: process.env.VITE_CORE_BACKEND_URL || "http://localhost:8106",
        changeOrigin: true,
      },
      "/api/v1/departments": {
        target: process.env.VITE_CORE_BACKEND_URL || "http://localhost:8106",
        changeOrigin: true,
      },
      // Agent avatars: /icons static mount and uploaded figures both live on Core
      "/icons": {
        target: process.env.VITE_CORE_BACKEND_URL || "http://localhost:8106",
        changeOrigin: true,
      },
      "/api/v1/uploads": {
        target: process.env.VITE_CORE_BACKEND_URL || "http://localhost:8106",
        changeOrigin: true,
      },
      // Knowledge base (upload/search/CRUD) needs text extraction + embeddings + Qdrant,
      // which only Core has — the Studio backend's knowledge router is a copy missing those
      // services, so route the whole /knowledge surface to Core (same DB / KnowledgeDoc table).
      "/api/v1/knowledge": {
        target: process.env.VITE_CORE_BACKEND_URL || "http://localhost:8106",
        changeOrigin: true,
      },

      // ── Studio backend (8107) catch-all ─────────────────────────────────
      "/api": {
        target: process.env.VITE_STUDIO_BACKEND_URL || "http://localhost:8107",
        changeOrigin: true,
      },
    },
  },
});
