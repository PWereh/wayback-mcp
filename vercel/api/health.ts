/**
 * Cheap liveness probe. Does not call the Internet Archive, so a 200 here
 * proves the function deployed and booted — it says nothing about whether IA
 * is currently rate-limiting us. Also reports whether bearer auth is armed,
 * which is the thing most likely to be misconfigured.
 *
 * Routed through the Node bridge: Vercel's Node runtime invokes (req, res), so
 * a bare web-signature export would hang instead of replying.
 */

import { withNode } from "./_node-adapter.ts";

export function handleHealthRequest(): Response {
	const authRequired =
		process.env.MCP_AUTH_TOKEN !== undefined &&
		process.env.MCP_AUTH_TOKEN !== "";

	return new Response(
		JSON.stringify(
			{
				status: "ok",
				service: "wayback-mcp",
				transport: "streamable-http",
				endpoint: "/mcp",
				upstream: "mcp-wayback-machine@3.7.1",
				authRequired,
				iaCredentials:
					process.env.WAYBACK_ACCESS_KEY !== undefined &&
					process.env.WAYBACK_ACCESS_KEY !== ""
						? "configured"
						: "anonymous",
			},
			null,
			2,
		),
		{
			status: 200,
			headers: {
				"content-type": "application/json",
				"cache-control": "no-store",
				"Access-Control-Allow-Origin": "*",
			},
		},
	);
}

export default withNode(handleHealthRequest);
