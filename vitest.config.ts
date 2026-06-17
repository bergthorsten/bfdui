import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  test: {
    dir: "./src/tests/unit",
    globals: true,
    environment: "jsdom",
    setupFiles: "./src/tests/unit/setup.ts",
    css: true,
    reporters: ["verbose"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: [
        "src/domain/**/*.ts",
        "src/ipc/**/*.ts",
        "src/lib/**/*.ts",
        "src/services/**/*.ts",
      ],
      exclude: ["src/routeTree.gen.ts", "src/tests/**", "src/**/*.d.ts"],
      thresholds: {
        "src/services/argo.ts": {
          branches: 40,
          functions: 40,
          lines: 40,
          statements: 40,
        },
        "src/lib/**": {
          branches: 40,
          functions: 40,
          lines: 40,
          statements: 40,
        },
      },
    },
  },
});
