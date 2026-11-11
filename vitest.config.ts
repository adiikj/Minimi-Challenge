import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "evals/**/*.test.ts"],
    env: { MISTRAL_API_KEY: "test-key", TAVILY_API_KEY: "test-key" },
  },
});
