import { createMcpHandler } from "agents/mcp/server";
import { createMemoryClient, defineMemoryObject } from "pi-durable-memory/cloudflare";
import type { MemoryObjectRpc } from "pi-durable-memory/cloudflare";
import landingPage from "./landing.html";
import memoryPage from "./memory.html";
import { createMemoryServer } from "./server.js";

interface Env {
	MEMORY: DurableObjectNamespace<MemoryObjectRpc>;
}

export const MemoryObject = defineMemoryObject<Env>({});

const MEMORY_PATH = /^\/m\/([A-Za-z0-9_-]{22})(\/wake\.json|\/zoom\.json|\/destroy)?$/;

const html = (page: string): Response => new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		if (url.pathname === "/") return html(landingPage);
		const [, id, file] = MEMORY_PATH.exec(url.pathname) ?? [];
		if (id === undefined) return new Response("Not found", { status: 404 });
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
