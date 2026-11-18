// The one place a PMTiles archive handle is built.
//
// Each handle lives at module scope for the life of its isolate, so
// anything it remembers outlives the request that put it there. The
// library's default cache stores a header or directory read as a
// promise before it settles and keeps it if it rejects, so one failed
// read fails every later request for that archive until the isolate
// goes away. `ResolvedValueCache` is the cache pmtiles ships for
// Workers, and it stores only values that arrived.

import { FetchSource, PMTiles, ResolvedValueCache, type Source } from "pmtiles";

/** `FetchSource` for a Worker. After one ETag mismatch the library sets
 *  `mustReload` for good and sends `cache: "reload"` on every later
 *  read, to get past a browser cache. A Worker has no such cache and
 *  rejects that mode with a `TypeError`, so an archive replaced in place
 *  would fail every read from then on. The flag is read before the
 *  first `await` in `getBytes`, so no other request can see it set. */
export class WorkerFetchSource extends FetchSource {
  override async getBytes(...args: Parameters<FetchSource["getBytes"]>) {
    this.mustReload = false;
    return super.getBytes(...args);
  }
}

export function openArchive(source: Source): PMTiles {
  return new PMTiles(source, new ResolvedValueCache());
}
