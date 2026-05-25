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
}
