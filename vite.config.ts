import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { projectStorePlugin } from "./scripts/vite-project-store";

export default defineConfig({
  plugins: [react(), projectStorePlugin()],
  server: { port: 5173, host: "127.0.0.1" },
  test: { environment: "node", include: ["tests/**/*.test.ts"] },
} as any);
