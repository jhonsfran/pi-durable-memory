import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [cloudflareTest({ wrangler: { configPath: "./test/cloudflare/wrangler.jsonc" } })],
	test: {
		include: ["test/cloudflare/**/*.test.ts"],
		testTimeout: 20_000,
	},
});
