// Worker entry for the Protomaps PMTiles mirror.
//
// Two surfaces:
//   - `scheduled` (cron): kicks off a Workflow run on the configured
//     monthly trigger.
//   - `fetch`: tiny HTTP API. `POST /runs` starts a run and
//     `GET /runs/{id}` reports status (both Bearer-token gated by
//     `MIRROR_TOKEN`). `GET /style.json` and `GET /protomaps/{z}/{x}/{y}.mvt`
//     serve the renderer container's style + tile data — gated by
//     `INTERNAL_TOKEN` passed as `?token=...` so the loopback proxy in
//     the container preserves it without needing custom header logic.

import { PmtilesMirrorWorkflow } from "./workflow.js";
import { handleVectorTile } from "./pmtiles.js";
import { handleStyle } from "./style.js";

export { PmtilesMirrorWorkflow };

const VECTOR_RE = /^\/protomaps\/(\d+)\/(\d+)\/(\d+)\.mvt$/;

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(startRun(env, {}));
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean);

    // Style + vector tile passthrough served from this worker's
    // workers.dev hostname. Workers Containers can't fetch their own
    // worker's custom domain (self-loop is dropped), so the renderer
    // container has to source `/style.json` and `/protomaps/...` from a
    // *different* worker — which is us. The style generator picks up
    // the request origin and embeds it in the tile URLs, so both
    // resources end up on the same hostname.
    //
    // These endpoints are gated by `INTERNAL_TOKEN` (query-string form)
    // so a third party who discovers the workers.dev hostname can't
    // freeload tiles / style at our expense.
    if (url.pathname === "/style.json") {
      if (!internalAuthorized(url, env)) return new Response("unauthorized", { status: 401 });
      return handleStyle(url, env);
    }
    const v = url.pathname.match(VECTOR_RE);
    if (v) {
      if (!internalAuthorized(url, env)) return new Response("unauthorized", { status: 401 });
      return handleVectorTile(
        { z: Number(v[1]), x: Number(v[2]), y: Number(v[3]) },
        env,
      );
    }

    if (req.method === "POST" && parts[0] === "runs" && parts.length === 1) {
      if (!opsAuthorized(req, env)) return json({ error: "unauthorized" }, 401);
      const body = await readJson(req).catch(() => ({}));
      const params = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
      const instance = await startRun(env, params);
      return json({ id: instance.id, status: await instance.status() }, 202);
    }

    if (req.method === "GET" && parts[0] === "runs" && parts.length === 2) {
      if (!opsAuthorized(req, env)) return json({ error: "unauthorized" }, 401);
      const id = parts[1] ?? "";
      const instance = await env.PMTILES_MIRROR.get(id);
      return json({ id, status: await instance.status() });
    }

    return json({ error: "not found" }, 404);
  },
};

async function startRun(env: Env, params: Record<string, unknown>) {
  const date = typeof params.date === "string" ? params.date : undefined;
  const instance = await env.PMTILES_MIRROR.create({ params: { date } });
  console.log(JSON.stringify({ event: "mirror_scheduled", id: instance.id }));
  return instance;
}

function opsAuthorized(req: Request, env: Env): boolean {
  if (!env.MIRROR_TOKEN) return false;
  const header = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${env.MIRROR_TOKEN}`;
  return constantTimeEqual(header, expected);
}

function internalAuthorized(url: URL, env: Env): boolean {
  if (!env.INTERNAL_TOKEN) return false;
  const supplied = url.searchParams.get("token") ?? "";
  return constantTimeEqual(supplied, env.INTERNAL_TOKEN);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function readJson(req: Request): Promise<unknown> {
  const text = await req.text();
  if (!text) return {};
  return JSON.parse(text);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
