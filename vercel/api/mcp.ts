/**
 * Vercel Function entry point for the Wayback Machine MCP server.
 *
 * Adapted from the upstream Cloudflare Worker entry (src/worker.ts) by
 * Joseph Mearman. Two things differ on Vercel:
 *
 *  1. No Cloudflare Cache API. The upstream Worker wires CacheApiBackend /
 *     CacheApiRateLimiter; those are Workers-only. We substitute an in-process
 *     Map backend. This matters more than it looks: CachingFetcher's DEFAULT
 *     backend is DiskCacheBackend, and a Vercel function's filesystem is
 *     read-only outside /tmp, so leaving the default in place would throw on
 *     the first cache write. The memory backend must be passed explicitly.
 *
 *  2. Longer wall clock. Workers free tier caps at 30s; Vercel functions are
 *     configured here for 60s (see vercel.json) because Wayback CDX prefix
 *     queries routinely take 30-45s. We abort at 55s to leave room to
 *     serialise a response.
 *
 * Caching and rate-limit state live per warm instance, not globally — Vercel
 * may run many concurrent instances, so the effective outbound rate can exceed
 * the per-instance limit under load. It is a politeness measure, not a hard
 * global cap.
 *
 * Environment variables:
 *  - MCP_AUTH_TOKEN     optional bearer token gating every request. STRONGLY
 *                       recommended: without it this endpoint is an open proxy
 *                       to the Internet Archive, and save_url writes publicly.
 *  - WAYBACK_ACCESS_KEY optional IA S3 credentials for higher SPN2 save limits
 *  - WAYBACK_SECRET_KEY optional IA S3 credentials
 *
 * Per-request credential headers X-Archive-Access-Key / X-Archive-Secret-Key
 * override the environment variables, matching upstream behaviour.
 */

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createServer } from "mcp-wayback-machine/server";
import { CachingFetcher } from "mcp-wayback-machine/utils/cache";
import { InMemoryRateLimiter } from "mcp-wayback-machine/utils/rate-limit";
import { StaticTokenAuthProvider } from "mcp-wayback-machine/auth/provider";

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

export default async function handler(request: Request): Promise<Response> {
	if (request.method === "OPTIONS") {
		return withCors(new Response(null, { status: 204 }));
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
		// Stateless: no sessionIdGenerator. Each invocation is independent, which
		// is the only workable model when any request may hit a cold instance.
		enableJsonResponse: true,
	});

	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const server = createServer(createContext(resolveCredentials(request)));
		await server.connect(transport);

		const timeout = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => {
				reject(new Error(`Request timeout after ${String(REQUEST_TIMEOUT_MS)}ms`));
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
