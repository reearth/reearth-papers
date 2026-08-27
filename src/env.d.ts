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

  // Reads the Analytics Engine SQL API, for the daily digest the cron takes.
  // Absent means no digest is taken and tiles are served exactly as before —
  // the events are still written either way. See `src/okibi-digest.ts`.
  //
  //   wrangler secret put OKIBI_CF_API_TOKEN
  OKIBI_CF_API_TOKEN?: string;

  // The account whose Analytics Engine dataset the digest reads. A secret
  // rather than a var only because this repository is public and an account
  // id is an identifier nobody needs published.
  //
  //   wrangler secret put OKIBI_ACCOUNT_ID
  OKIBI_ACCOUNT_ID?: string;

  // Where okibi's executor takes a warm plan, and what it is called with.
  // Absent means the watch still notices and still keeps the plan; what it
  // does not do is warm, which is the safe half to lose.
  //
  //   wrangler secret put OKIBI_EXECUTOR_TOKEN
  OKIBI_EXECUTOR_URL?: string;
  OKIBI_EXECUTOR_TOKEN?: string;
}
