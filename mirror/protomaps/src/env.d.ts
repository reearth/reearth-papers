// Secrets are not surfaced by `wrangler types` (only vars / bindings
// declared in wrangler.toml are). Augment the generated `Env` interface
// with the secret keys we read.
//
// Set via:
//   wrangler secret put MIRROR_TOKEN    (operator-facing /runs auth)
//   wrangler secret put INTERNAL_TOKEN  (shared with main worker; gates
//                                        /style.json + /protomaps/...)
interface Env {
  MIRROR_TOKEN?: string;
  INTERNAL_TOKEN: string;
}
