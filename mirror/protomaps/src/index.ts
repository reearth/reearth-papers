// Worker entry for the Protomaps PMTiles mirror.
//
// Two surfaces:
//   - `scheduled` (cron): kicks off a Workflow run on the configured
//     monthly trigger.
//   - `fetch`: tiny HTTP API for manual ops. `POST /runs` starts a run
//     (bearer-token gated), `GET /runs/{id}` reports status,
//     `GET /latest` reads the pointer file.

import { PmtilesMirrorWorkflow } from "./workflow.js";
import { handleVectorTile } from "./pmtiles.js";
import { handleStyle } from "./style.js";

export { PmtilesMirrorWorkflow };

const VECTOR_RE = /^\/v\/(\d+)\/(\d+)\/(\d+)\.mvt$/;

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
    // container has to source `/style.json` and `/v/...` from a
    // *different* worker — which is us. The style generator picks up
    // the request origin and embeds it in the tile URLs, so both
    // resources end up on the same hostname.
    if (url.pathname === "/style.json") {
      return handleStyle(url, req);
    }
    const v = url.pathname.match(VECTOR_RE);
    if (v) {
      return handleVectorTile(
        { z: Number(v[1]), x: Number(v[2]), y: Number(v[3]) },
        env,
      );
    }

    // GET /latest — pointer file for the most recent successful mirror.
    // Unauthenticated by design: read-only and the bucket itself isn't
    // public, so this is the only way for the tile worker to discover
    // the current archive key without an R2 binding of its own.
    if (req.method === "GET" && parts[0] === "latest" && parts.length === 1) {
      const obj = await env.R2.get(`${env.MIRROR_PREFIX}/latest.json`);
      if (!obj) return json({ error: "no mirror yet" }, 404);
      return new Response(obj.body, {
        headers: { "content-type": "application/json" },
      });
    }

    if (req.method === "POST" && parts[0] === "runs" && parts.length === 1) {
      if (!authorized(req, env)) return json({ error: "unauthorized" }, 401);
      const body = await readJson(req).catch(() => ({}));
      const params = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
      const instance = await startRun(env, params);
      return json({ id: instance.id, status: await instance.status() }, 202);
    }

    if (req.method === "GET" && parts[0] === "runs" && parts.length === 2) {
      if (!authorized(req, env)) return json({ error: "unauthorized" }, 401);
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

function authorized(req: Request, env: Env): boolean {
  if (!env.MIRROR_TOKEN) return false;
  const header = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${env.MIRROR_TOKEN}`;
  // Constant-time-ish comparison. The token is short, the worker is
  // isolated, and this isn't a high-value attack surface.
  if (header.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < header.length; i++) diff |= header.charCodeAt(i) ^ expected.charCodeAt(i);
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
