# wayback-mcp — Vercel deployment

Hosts the Wayback Machine MCP server as a remote **Streamable HTTP** endpoint on
Vercel, so MCP clients can use it over the network instead of spawning a local
stdio process.

## Endpoints

Live at **https://wayback-mcp.vercel.app**

| Path | Purpose |
|------|---------|
| `POST /mcp` | The MCP endpoint (Streamable HTTP, stateless, JSON responses) |
| `GET /` or `GET /health` | Liveness + configuration probe (JSON), no auth required |

`GET /mcp` is left to the transport's SSE stream and does not answer the probe.

## Client configuration

```json
{
  "mcpServers": {
    "wayback-mcp": {
      "type": "http",
      "url": "https://wayback-mcp.vercel.app/mcp",
      "headers": { "Authorization": "Bearer <MCP_AUTH_TOKEN>" }
    }
  }
}
```

## Environment variables

| Variable | Required | Effect |
|----------|----------|--------|
| `MCP_AUTH_TOKEN` | **Strongly recommended** | Requires a matching `Authorization: Bearer` header on every request. Without it the endpoint is an open proxy to the Internet Archive, and `save_url` writes publicly to the archive on any caller's behalf. |
| `WAYBACK_ACCESS_KEY` | No | IA S3 access key — raises SPN2 *save* rate limits only. |
| `WAYBACK_SECRET_KEY` | No | IA S3 secret key. |

Clients may instead send `X-Archive-Access-Key` / `X-Archive-Secret-Key` per
request; those override the environment variables.

## Deploying

The Vercel project is **not linked to GitHub** (linking requires installing the
Vercel GitHub App), so `git push` does not redeploy. From the repository root:

```bash
vercel deploy --prod --yes --scope pwerehs-projects
```

The project's `rootDirectory` is `vercel`, so deploy from the repo root, not
from inside this directory.

## How this differs from the upstream Worker

Upstream ships a Cloudflare Worker entry point (`src/worker.ts`). This directory
is a Vercel adaptation of it, not a replacement:

- **Cache backend.** The Worker uses Cloudflare's Cache API. Vercel has no
  equivalent, so `api/mcp.ts` supplies an in-process `Map` backend. This is
  required, not cosmetic: `CachingFetcher` otherwise defaults to
  `DiskCacheBackend`, and a Vercel function's filesystem is read-only outside
  `/tmp`, so the first cache write would throw.
- **Timeout.** The Worker aborts at 25s (free tier caps at 30s). Here
  `maxDuration` is 60s with an internal abort at 55s, because Wayback CDX
  prefix queries routinely take 30–45s.
- **Invocation signature.** Vercel's Node runtime invokes `(req, res)`, not the
  Worker's `(request: Request) => Response`. `api/mcp.ts` inlines a bridge for
  both directions. Exporting a bare web handler hangs the invocation to
  `FUNCTION_INVOCATION_TIMEOUT`; splitting the bridge into a separate
  `api/_node-adapter.ts` built cleanly but failed every invocation with
  `FUNCTION_INVOCATION_FAILED`, so the function imports only npm packages.
- **Rate limiting is per-instance.** `InMemoryRateLimiter` state lives in one
  warm instance. Vercel may run many concurrently, so the effective outbound
  rate can exceed 15/min under load. Treat it as politeness, not a hard cap.

## Known limitations

- `check_archive_status` is broken in upstream 3.7.1 — its Zod schema expects
  `years` values as objects while IA's sparkline API returns arrays, so every
  call fails. Use `search_archives` instead.
- `get_archived_url` can return `HTTP 429` from the Internet Archive
  independently of CDX. Hosting on Vercel changes the egress IP but adds no
  failover.
- Cold starts add latency to the first request after idle.

## Licence and attribution

Upstream: [`Mearman/mcp-wayback-machine`](https://github.com/Mearman/mcp-wayback-machine)
by Joseph Mearman, licensed **CC BY-NC-SA 4.0**.

This deployment is a derivative work and inherits that licence, which means:

- **NonCommercial** — this endpoint must not be used for commercial purposes.
- **ShareAlike** — modifications must carry the same licence.
- **Attribution** — retain the upstream credit above.
