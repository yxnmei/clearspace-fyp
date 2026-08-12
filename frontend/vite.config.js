import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Frontend origin here must match backend/app/config.py's frontend_origin
// (CORS) — kept at the Vite default (5173) on both sides deliberately.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.js",
  },
});
