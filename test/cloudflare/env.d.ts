/// <reference types="@cloudflare/vitest-pool-workers/types" />

declare namespace Cloudflare {
	interface Env {
		MEMORY: DurableObjectNamespace<import("../../src/cloudflare/index.js").MemoryObjectRpc>;
		MEMORY_CLIENT: DurableObjectNamespace<import("../../src/cloudflare/index.js").MemoryObjectRpc>;
		MEMORY_FLAKY: DurableObjectNamespace<import("../../src/cloudflare/index.js").MemoryObjectRpc>;
	}
}
