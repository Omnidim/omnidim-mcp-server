import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["tests/**/*.test.ts"],
        coverage: {
            provider: "v8",
            include: ["src/helpers.ts"],
            reporter: ["text", "html"],
            thresholds: {
                lines: 90,
                functions: 100,
                branches: 80,
                statements: 90,
            },
        },
    },
});
