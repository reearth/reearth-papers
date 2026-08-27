// What okibi can see of this service's current cache keys.
//
// Most services put their epochs in `okibi.epochs.json` and are done: a
// deploy is the only thing that moves a cache key, so a commit is the whole
// signal. This one resolves part of its key at request time — the vector
// snapshot it draws from is a pointer in R2, and a paint style's revision is
// a content hash of a document on a shelf — so it can go cold with nothing
// pushed and no file to diff. This endpoint is how that becomes visible.
//
// It is public on purpose. Everything here is already derivable from what the
// service serves: the snapshot date is in `/catalog.json`, a style's revision
// is in its own TileJSON. Authenticating it would hide nothing and would
// create a door somebody later puts something genuinely secret behind.
//
// Which is a constraint rather than an observation: epoch strings have to stay
// publishable. If one ever needs to carry something that is not — a licensed
// dataset name, a customer identifier — that is a sign to rename the epoch,
// not to add a token.

import { STYLE_VERSION } from "./cache.js";
import { ezuRecipeVersion } from "./ezu.js";
import { PAINT_RUNTIME_VERSION, paintStyles } from "./paint_styles.js";
import { readMirrorPointer } from "./pmtiles.js";
import { THEMES } from "./style.js";

interface Epoch {
  source?: string;
  algo?: string;
  param?: string;
}

/**
 * The epochs every tileset is currently serving under.
 *
 * Spelled the same way the demand events spell them, because okibi joins the
 * two: what this reports is compared against what the ledger recorded, and a
 * second spelling would make a change look like a change that already
 * happened.
 */
export async function okibiEpochs(env: Env): Promise<Record<string, Epoch>> {
  const { date } = await readMirrorPointer(env);
  const tilesets: Record<string, Epoch> = {};

  for (const theme of THEMES) {
    tilesets[theme] = {
      source: date,
      algo: `style-${STYLE_VERSION}`,
      param: `r${ezuRecipeVersion(theme)}`,
    };
  }

  for (const style of await paintStyles(env)) {
    // The parameterless picture. A style's parameters are part of its key and
    // there are unboundedly many of them; what an invalidation moves is the
    // style, and every parameterisation of it moves with it.
    tilesets[style.name] = {
      source: `${date}/${style.sourceVersion || "-"}`,
      algo: `paint-r${PAINT_RUNTIME_VERSION}`,
      param: style.rev,
    };
  }

  return tilesets;
}

export async function handleOkibiEpochs(env: Env): Promise<Response> {
  // The mirrored rasters are not here. Their epochs are constants in this
  // repository, so they cannot move without a deploy — which means a commit
  // is already the signal for them, and this endpoint is for the changes no
  // commit causes. They belong in `okibi.epochs.json`, which is still empty.
  const tilesets = await okibiEpochs(env);

  return Response.json(
    { service: "papers", tilesets },
    {
      headers: {
        // Polled every few hours, and the answer changes far less often.
        "cache-control": "public, max-age=300",
        "access-control-allow-origin": "*",
      },
    },
  );
}
