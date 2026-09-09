/**
 * Bridges Vercel's Node function signature to Web-standard handlers.
 *
 * The MCP SDK's WebStandardStreamableHTTPServerTransport takes a `Request` and
 * returns a `Response` — the Cloudflare Worker shape. Vercel's Node runtime
 * (@vercel/node) instead invokes `(req: IncomingMessage, res: ServerResponse)`.
 * Exporting a web-signature handler directly does NOT work: Vercel calls it
 * with (req, res), so a handler that only returns a Response never writes
 * anything and the invocation hangs until it hits FUNCTION_INVOCATION_TIMEOUT,
 * while any `req.headers.get(...)` call throws (plain object, not Headers).
 *
 * We deliberately stay on the Node runtime rather than switching to Edge, even
 * though Edge speaks Web-standard natively: `mcp-wayback-machine/utils/cache`
 * pulls in node:fs for its DiskCacheBackend, which Edge cannot load — the
 * import alone would fail regardless of whether that backend is used.
 *
 * Filename is underscore-prefixed so Vercel does not route it as a function.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

export type WebHandler = (request: Request) => Response | Promise<Response>;

/**
 * Recover the raw request body.
 *
 * @vercel/node parses JSON and urlencoded bodies before the handler runs and
 * exposes them on `req.body`, which can leave the underlying stream already
 * consumed. So prefer the parsed value and only fall back to draining the
 * stream, otherwise the body can come back empty and every JSON-RPC call fails
 * to parse.
 */
async function readBody(req: IncomingMessage): Promise<string | undefined> {
	const method = (req.method ?? "GET").toUpperCase();
	if (method === "GET" || method === "HEAD") {
		return undefined;
	}

	const parsed: unknown = (req as IncomingMessage & { body?: unknown }).body;
	if (typeof parsed === "string") {
		return parsed;
	}
	if (Buffer.isBuffer(parsed)) {
		return parsed.toString("utf8");
	}
	if (parsed !== undefined && parsed !== null) {
		return JSON.stringify(parsed);
	}

	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
	}
	if (chunks.length === 0) {
		return undefined;
	}
	return Buffer.concat(chunks).toString("utf8");
}

function toWebRequest(req: IncomingMessage, body: string | undefined): Request {
	const forwardedProto = req.headers["x-forwarded-proto"];
	const forwardedHost = req.headers["x-forwarded-host"];
	const proto =
		(Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto) ??
		"https";
	const host =
		(Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost) ??
		req.headers.host ??
		"localhost";

	const headers = new Headers();
	for (const [key, value] of Object.entries(req.headers)) {
		if (value === undefined) {
			continue;
		}
		if (Array.isArray(value)) {
			for (const entry of value) {
				headers.append(key, entry);
			}
		} else {
			headers.set(key, value);
		}
	}

	return new Request(new URL(req.url ?? "/", `${proto}://${host}`), {
		method: req.method ?? "GET",
		headers,
		body,
	});
}

async function sendWebResponse(
	res: ServerResponse,
	response: Response,
): Promise<void> {
	res.statusCode = response.status;
	response.headers.forEach((value, key) => {
		// content-length is recomputed from the buffer below; a stale value from
		// the Response would truncate or stall the reply.
		if (key.toLowerCase() !== "content-length") {
			res.setHeader(key, value);
		}
	});

	if (response.body === null) {
		res.end();
		return;
	}

	const buffer = Buffer.from(await response.arrayBuffer());
	res.setHeader("content-length", String(buffer.byteLength));
	res.end(buffer);
}

/** Wrap a Web-standard handler so Vercel's Node runtime can invoke it. */
export function withNode(handler: WebHandler) {
	return async function nodeHandler(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		try {
			const body = await readBody(req);
			const response = await handler(toWebRequest(req, body));
			await sendWebResponse(res, response);
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Internal server error";
			if (!res.headersSent) {
				res.statusCode = 500;
				res.setHeader("content-type", "application/json");
				res.setHeader("access-control-allow-origin", "*");
			}
			res.end(
				JSON.stringify({
					jsonrpc: "2.0",
					error: { code: -32603, message },
					id: null,
				}),
			);
		}
	};
}
