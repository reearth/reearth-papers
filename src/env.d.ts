// Secrets are not surfaced by `wrangler types` (only vars / bindings
// declared in wrangler.toml are). Augment the generated `Env` interface
// with the secret keys we read.
//
// Set via:
//   wrangler secret put INTERNAL_TOKEN  (shared with the mirror worker;
//                                        appended as `?token=` to the
//                                        style URL passed to the
//                                        renderer container)
interface Env {
  INTERNAL_TOKEN: string;
  // Shared with okibi's executor. A request carrying it is okibi warming a
  // tile rather than somebody wanting one, and is kept out of the demand it
  // would otherwise become. Unset means nothing is treated as warm, which
  // over-counts demand rather than letting anyone edit the ledger.
  //
  //   wrangler secret put OKIBI_WARM_SECRET
  OKIBI_WARM_SECRET?: string;
}
