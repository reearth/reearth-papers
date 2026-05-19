// Secrets are not surfaced by `wrangler types` (only vars / bindings
// declared in wrangler.toml are). Augment the generated `Env` interface
// with the secret keys we read.
//
// Set via: `wrangler secret put MIRROR_TOKEN`
interface Env {
  MIRROR_TOKEN?: string;
}
