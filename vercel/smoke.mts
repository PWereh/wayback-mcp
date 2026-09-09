// Local smoke test: drives the Vercel handler with synthetic Requests.
// Run: node --experimental-strip-types smoke.mts
import handler from "./api/mcp.ts";
import health from "./api/health.ts";

function post(body: unknown, headers: Record<string, string> = {}) {
	return new Request("https://local.test/mcp", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			...headers,
		},
		body: JSON.stringify(body),
	});
}

async function show(label: string, res: Response) {
	const text = await res.text();
	let pretty = text;
	try {
		const parsed: unknown = JSON.parse(text);
		pretty = JSON.stringify(parsed);
	} catch {
		/* SSE or plain text */
	}
	console.log(`\n[${label}] status=${String(res.status)}`);
	console.log(pretty.slice(0, 700));
}

// 1. health
await show("health", health());

// 2. initialize
await show(
	"initialize",
	await handler(
		post({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: "smoke", version: "1.0" },
			},
		}),
	),
);

// 3. tools/list
await show(
	"tools/list",
	await handler(
		post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
	),
);

// 4. real call — exercises fetch + memory cache backend + rate limiter
await show(
	"tools/call search_archives",
	await handler(
		post({
			jsonrpc: "2.0",
			id: 3,
			method: "tools/call",
			params: {
				name: "search_archives",
				arguments: { url: "https://example.com", limit: 2 },
			},
		}),
	),
);

// 5. CORS preflight
const pre = await handler(
	new Request("https://local.test/mcp", { method: "OPTIONS" }),
);
console.log(
	`\n[preflight] status=${String(pre.status)} allow-origin=${String(pre.headers.get("access-control-allow-origin"))}`,
);

process.exit(0);
