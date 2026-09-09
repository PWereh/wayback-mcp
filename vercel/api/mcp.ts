/**
 * Vercel Function entry point for the Wayback Machine MCP server.
 *
 * Adapted from the upstream Cloudflare Worker entry (src/worker.ts) by
 * Joseph Mearman. Three things differ on Vercel.
 *
 * 1. No Cloudflare Cache API. The upstream Worker wires CacheApiBackend /
 *    CacheApiRateLimiter, which are Workers-only, so we substitute an
 *    in-process Map backend. This matters more than it looks: CachingFetcher's
 *    DEFAULT backend is DiskCacheBackend, and a Vercel function's filesystem is
 *    read-only outside /tmp, so leaving the default in place throws on the
 *    first cache write. The memory backend must be passed explicitly.
 *
 * 2. Invocation signature. @vercel/node calls handlers as
 *    (req: IncomingMessage, res: ServerResponse), not the Web-standard
 *    (request: Request) => Response shape the MCP SDK's
 *    WebStandardStreamableHTTPServerTransport expects. The bridge below
 *    converts both directions. Exporting a bare web handler does not work: it
 *    never writes to `res`, so the invocation hangs to
 *    FUNCTION_INVOCATION_TIMEOUT, and req.headers.get() throws because Node
 *    headers are a plain object.
 *
 *    We stay on the Node runtime rather than switching to Edge, which speaks
 *    Web standards natively, because mcp-wayback-machine/utils/cache imports
 *    node:fs for DiskCacheBackend and Edge cannot load it at all.
 *
 * 3. Longer wall clock. Workers free tier caps at 30s; this is configured for
 *    60s (vercel.json) because Wayback CDX prefix queries routinely take
 *    30-45s. We abort at 55s to leave room to serialise a response.
 *
 * Everything lives in this one file on purpose. An earlier revision factored
 * the Node bridge into api/_node-adapter.ts; the build succeeded but every
 * invocation then failed with FUNCTION_INVOCATION_FAILED, and the same code
 * ran correctly under a real node:http server locally. Rather than depend on
 * how the platform resolves a relative TypeScript import at runtime, this
 * function imports nothing but npm packages. It also serves the health probe,
 * so the deployment is a single function with a single cold start.
 *
 * Caching and rate-limit state live per warm instance, not globally — Vercel
 * may run many concurrently, so the effective outbound rate can exceed the
 * per-instance limit under load. Treat it as politeness, not a hard cap.
 *
 * Environment variables:
 *  - MCP_AUTH_TOKEN     bearer token gating every request. STRONGLY
 *                       recommended: without it this endpoint is an open proxy
 *                       to the Internet Archive, and save_url writes publicly.
 *  - WAYBACK_ACCESS_KEY optional IA S3 credentials for higher SPN2 save limits
 *  - WAYBACK_SECRET_KEY optional IA S3 credentials
 *
 * Per-request headers X-Archive-Access-Key / X-Archive-Secret-Key override the
 * environment credentials, matching upstream behaviour.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createServer } from "mcp-wayback-machine/server";
import { CachingFetcher } from "mcp-wayback-machine/utils/cache";
import { InMemoryRateLimiter } from "mcp-wayback-machine/utils/rate-limit";
import { StaticTokenAuthProvider } from "mcp-wayback-machine/auth/provider";

const UPSTREAM_VERSION = "3.7.1";
const USER_AGENT = "wayback-mcp-vercel";
const HEADER_ACCESS_KEY = "X-Archive-Access-Key";
const HEADER_SECRET_KEY = "X-Archive-Secret-Key";

/** Abort before Vercel's 60s function ceiling so we can still return JSON. */
const REQUEST_TIMEOUT_MS = 55_000;

interface CachedEntry {
	status: number;
	statusText: string;
	headers: Record<string, string>;
	body: string;
	expiry: number;
}

/**
 * In-process cache backend. Replaces the Worker's Cache API backend and,
 * critically, displaces CachingFetcher's read-only-filesystem-hostile disk
 * default. Survives only for the life of a warm instance.
 */
class MemoryCacheBackend {
	private readonly store = new Map<string, CachedEntry>();

	get(key: string): Promise<CachedEntry | undefined> {
		const entry = this.store.get(key);
		if (entry === undefined) {
			return Promise.resolve(undefined);
		}
		if (entry.expiry < Date.now()) {
			this.store.delete(key);
			return Promise.resolve(undefined);
		}
		return Promise.resolve(entry);
	}

	set(key: string, entry: CachedEntry): Promise<void> {
		this.store.set(key, entry);
		return Promise.resolve();
	}

	delete(key: string): Promise<void> {
		this.store.delete(key);
		return Promise.resolve();
	}

	clear(): Promise<void> {
		this.store.clear();
		return Promise.resolve();
	}
}

// Hoisted so warm invocations reuse cache and rate-limit windows.
const backend = new MemoryCacheBackend();
const fetcher = new CachingFetcher({ backend });
const limiter = new InMemoryRateLimiter({ maxRequests: 15, windowMs: 60_000 });

function resolveCredentials(
	request: Request,
): { accessKey: string; secretKey: string } | undefined {
	const headerAccess = request.headers.get(HEADER_ACCESS_KEY);
	const headerSecret = request.headers.get(HEADER_SECRET_KEY);
	if (headerAccess !== null && headerSecret !== null) {
		return { accessKey: headerAccess, secretKey: headerSecret };
	}

	const envAccess = process.env.WAYBACK_ACCESS_KEY;
	const envSecret = process.env.WAYBACK_SECRET_KEY;
	if (
		envAccess !== undefined &&
		envAccess !== "" &&
		envSecret !== undefined &&
		envSecret !== ""
	) {
		return { accessKey: envAccess, secretKey: envSecret };
	}

	return undefined;
}

/** Only attach IA S3 auth to SPN2 save calls, never to read paths. */
function isWaybackSaveUrl(url: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		return false;
	}
	if (parsed.hostname !== "web.archive.org") {
		return false;
	}
	return parsed.pathname === "/save" || parsed.pathname.startsWith("/save/");
}

function createContext(
	credentials: { accessKey: string; secretKey: string } | undefined,
) {
	function buildHeaders(
		url: string,
		overrides?: Record<string, string>,
	): Record<string, string> {
		const headers: Record<string, string> = {
			"User-Agent": USER_AGENT,
			...overrides,
		};
		if (credentials !== undefined && isWaybackSaveUrl(url)) {
			headers.Authorization = `LOW ${credentials.accessKey}:${credentials.secretKey}`;
		}
		return headers;
	}

	return {
		async fetch(
			url: string,
			options?: {
				method?: string;
				headers?: Record<string, string>;
				body?: string;
				timeout?: number;
			},
		): Promise<Response> {
			await limiter.acquire();
			const headers = buildHeaders(url, options?.headers);
			return fetcher.fetch(url, { ...options, headers });
		},

		async fetchJSON<T>(
			url: string,
			schema: { parse: (value: unknown) => T },
		): Promise<T> {
			const response = await this.fetch(url);
			const text = await response.text();
			const parsed: unknown = JSON.parse(text);
			return schema.parse(parsed);
		},
	};
}

const CORS_HEADERS: Record<string, string> = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
	"Access-Control-Allow-Headers":
		"Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version, X-Archive-Access-Key, X-Archive-Secret-Key",
	"Access-Control-Expose-Headers": "Mcp-Session-Id",
	"Access-Control-Max-Age": "86400",
};

function withCors(response: Response): Response {
	const headers = new Headers(response.headers);
	for (const [key, value] of Object.entries(CORS_HEADERS)) {
		headers.set(key, value);
	}
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

function jsonRpcError(message: string, status: number): Response {
	return withCors(
		new Response(
			JSON.stringify({
				jsonrpc: "2.0",
				error: { code: -32603, message },
				id: null,
			}),
			{ status, headers: { "content-type": "application/json" } },
		),
	);
}

/**
 * Liveness probe. Makes no Internet Archive calls, so a 200 proves the function
 * booted — it says nothing about whether IA is currently rate-limiting us.
 * Reports whether bearer auth is armed, the thing most likely misconfigured.
 */
export function handleHealthRequest(): Response {
	const authRequired =
		process.env.MCP_AUTH_TOKEN !== undefined &&
		process.env.MCP_AUTH_TOKEN !== "";

	return withCors(
		new Response(
			JSON.stringify(
				{
					status: "ok",
					service: "wayback-mcp",
					transport: "streamable-http",
					endpoint: "/mcp",
					upstream: `mcp-wayback-machine@${UPSTREAM_VERSION}`,
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
				},
			},
		),
	);
}

/** True for the paths that should answer with the health probe. */
function isHealthPath(request: Request): boolean {
	if (request.method !== "GET") {
		return false;
	}
	// GET /mcp is reserved for the transport's SSE stream, so only the bare
	// root and an explicit /health answer here.
	const path = new URL(request.url).pathname.replace(/\/+$/, "");
	return path === "" || path === "/health" || path === "/api/health";
}

/** Web-standard MCP handler. Exported for tests; production goes via the bridge. */
export async function handleMcpRequest(request: Request): Promise<Response> {
	if (request.method === "OPTIONS") {
		return withCors(new Response(null, { status: 204 }));
	}

	if (isHealthPath(request)) {
		return handleHealthRequest();
	}

	const token = process.env.MCP_AUTH_TOKEN;
	if (token !== undefined && token !== "") {
		const rejection = await new StaticTokenAuthProvider(token).validate(
			request,
		);
		if (rejection !== undefined) {
			return withCors(rejection);
		}
	}

	const transport = new WebStandardStreamableHTTPServerTransport({
		// Stateless: no sessionIdGenerator. Each invocation is independent, the
		// only workable model when any request may hit a cold instance.
		enableJsonResponse: true,
	});

	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const server = createServer(createContext(resolveCredentials(request)));
		await server.connect(transport);

		const timeout = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => {
				reject(
					new Error(`Request timeout after ${String(REQUEST_TIMEOUT_MS)}ms`),
				);
			}, REQUEST_TIMEOUT_MS);
		});

		const response = await Promise.race([
			transport.handleRequest(request),
			timeout,
		]);
		return withCors(response);
	} catch (error) {
		return jsonRpcError(
			error instanceof Error ? error.message : "Internal server error",
			500,
		);
	} finally {
		if (timer !== undefined) {
			clearTimeout(timer);
		}
	}
}

/* -------------------------------------------------------------------------- */
/* Node <-> Web bridge (see header note 2)                                     */
/* -------------------------------------------------------------------------- */

/**
 * Recover the raw request body.
 *
 * @vercel/node parses JSON and urlencoded bodies before the handler runs and
 * exposes them on req.body, which can leave the underlying stream already
 * consumed. Prefer the parsed value and only fall back to draining the stream,
 * otherwise the body can arrive empty and every JSON-RPC call fails to parse.
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
		// content-length is recomputed from the buffer below; a stale value would
		// truncate or stall the reply.
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

export default async function handler(
	req: IncomingMessage,
	res: ServerResponse,
): Promise<void> {
	try {
		const body = await readBody(req);
		const response = await handleMcpRequest(toWebRequest(req, body));
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
}
