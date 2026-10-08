import { createMcpHandler } from "agents/mcp/server";
import { createMemoryClient, defineMemoryObject } from "pi-durable-memory/cloudflare";
import type { MemoryObjectRpc } from "pi-durable-memory/cloudflare";
import landingPage from "./landing.html";
import memoryPage from "./memory.html";
import { createMemoryServer } from "./server.js";

interface Env {
	MEMORY: DurableObjectNamespace<MemoryObjectRpc>;
	RATE_LIMITER: RateLimit;
}

// A real scope keeps the 16,384-byte default. The demo folds at 2,048 bytes, so a short test shows old notes turning into summary lines.
export const MemoryObject = defineMemoryObject<Env>({ limits: { viewBytes: 2048 } });

const MEMORY_PATH = /^\/m\/([A-Za-z0-9_-]{22})(\/wake\.json|\/zoom\.json|\/destroy)?$/;

const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#2563eb"/><path d="M16 9v6M16 15l-6 7M16 15l6 7" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/><circle cx="16" cy="9" r="3.5" fill="#fff"/><circle cx="10" cy="22" r="3.5" fill="#fff"/><circle cx="22" cy="22" r="3.5" fill="#fff"/></svg>`;

const html = (page: string): Response => new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		if (url.pathname === "/") return html(landingPage);
		if (url.pathname === "/favicon.svg") return new Response(FAVICON, { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" } });
		const [, id, file] = MEMORY_PATH.exec(url.pathname) ?? [];
		if (id === undefined) return new Response("Not found", { status: 404 });
		const { success } = await env.RATE_LIMITER.limit({ key: request.headers.get("cf-connecting-ip") ?? "unknown" });
		if (!success) return new Response("Too many requests. Try again in a minute.", { status: 429, headers: { "retry-after": "60" } });
		const memory = createMemoryClient(env.MEMORY)(id);

		if (file === "/wake.json") return Response.json(await memory.wake());
		if (file === "/zoom.json") {
			const range = { startId: Number(url.searchParams.get("startId")), endId: Number(url.searchParams.get("endId")) };
			try {
				return Response.json(await memory.zoom(range));
			} catch (error) {
				// Durable Object RPC delivers a plain Error that keeps only the name and message of the one thrown.
				if (error instanceof Error && error.name === "InvalidRange") return new Response(error.message, { status: 400 });
				throw error;
			}
		}
		if (file === "/destroy") {
			if (request.method !== "POST") return new Response("Use POST", { status: 405, headers: { allow: "POST" } });
			await env.MEMORY.get(env.MEMORY.idFromName(id)).destroy();
			return new Response(null, { status: 204 });
		}
		if (request.method === "GET" && request.headers.get("accept")?.includes("text/html")) return html(memoryPage);
		return createMcpHandler(() => createMemoryServer(memory), { route: url.pathname })(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
