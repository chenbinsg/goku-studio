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
      "/api": {
        target: process.env.VITE_STUDIO_BACKEND_URL || "http://localhost:8107",
        changeOrigin: true,
      },
    },
  },
});
