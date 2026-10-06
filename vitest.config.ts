import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		// Workers-runtime tests run under vitest.workers.config.ts.
		exclude: ["**/node_modules/**", "test/cloudflare/**"],
		testTimeout: 20_000,
	},
});
