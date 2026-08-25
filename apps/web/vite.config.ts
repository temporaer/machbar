import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Base './' ensures built asset URLs are relative so the app works when
// served from an arbitrary sub-path behind an Ingress (not only from '/').
export default defineConfig({
  base: "./",
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        // Overridable so a local apps/api instance running on a
        // non-default port can still be proxied to during development.
        target: process.env.VITE_API_PROXY_TARGET ?? "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
});
