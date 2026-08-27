// Noticing that this service went cold with nobody deploying, and warming it.
//
// Most services invalidate on a commit: the version is a constant, editing it
// is the whole signal, and CI can diff the file. This one resolves part of its
// cache key at request time — the vector snapshot is a pointer in R2, a paint
// style's revision is a content hash of a document on a shelf — so it can go
// cold with nothing pushed and no file to diff.
//
// Which makes the watcher a cron, and the cron belongs here rather than in CI.
// A GitHub schedule switches itself off after sixty quiet days, and a snapshot
// may not move for months; a watch that stopped looks exactly like an
// invalidation that never happened, which is the one failure mode nothing else
// here would catch.
//
// The planning is not written here. `plan` is the same compiled function
// `okibi plan` runs, so what this decides to warm is what a person reviewing a
// plan in CI would have decided. A second planner would order the tiles
// slightly differently and warm somewhere slightly wrong, and the result would
// still look exactly like a plan.
//
// See https://github.com/reearth/okibi, spec/planner.md.

import { invalidationsBetween, plan } from "@reearth/okibi";
import pricing from "@reearth/okibi/pricing/cloudflare-2026-08.json";

import manifest from "../okibi.manifest.json";
import { okibiEpochs } from "./okibi_epochs.js";

/** Where okibi's own objects live, kept away from anything cached. */
const STATE_KEY = "okibi/epochs.json";
const DIGEST_PREFIX = "okibi/digests";
const PLAN_PREFIX = "okibi/plans";

/**
 * How much demand to plan from.
 *
 * The planner's half-life is seven days, so a week is where the weight is.
 * Reading more would be reading evidence that counts for less than an eighth.
 */
const DAYS = 7;

/**
 * What one unattended run may spend.
 *
 * Nobody reads this plan before it runs, which is the difference between here
 * and a pull request. A budget is what stands in for the reader.
 */
const BUDGET_USD = 5;

export interface Watched {
  /** Nothing had been recorded, so this run only remembered. */
  first: boolean;
  invalidations: number;
  queued: number;
}

export async function watch(env: Env, now: string): Promise<Watched> {
  const after = { service: "papers", tilesets: await okibiEpochs(env) };

  const stored = await env.R2.get(STATE_KEY);
  if (!stored) {
    // Nothing was cached under epochs nobody recorded, so there is nothing to
    // warm — only something to remember for next time.
    await env.R2.put(STATE_KEY, JSON.stringify(after));
    console.log("okibi: no epochs recorded yet, so recording without planning");
    return { first: true, invalidations: 0, queued: 0 };
  }

  const before = await stored.json();
  const events = invalidationsBetween(before, after, now, null);
  if (events.length === 0) {
    return { first: false, invalidations: 0, queued: 0 };
  }

  const digests = await readDigests(env, now);
  let queued = 0;

  for (const invalidation of events) {
    const warm = plan({
      digests,
      invalidation,
      manifests: [manifest],
      pricing,
      epochs: after,
      options: { budgetUsd: BUDGET_USD },
    });

    console.log("okibi: an epoch moved", {
      tileset: invalidation.tileset,
      axis: invalidation.axis,
      from: invalidation.epoch_from,
      to: invalidation.epoch_to,
      entries: warm.stats.total,
      coverage: warm.stats.coverage_of_demand,
      usd: warm.estimate.warm.usd,
    });

    // The plan is what the estimate was read off, and the measurement it will
    // be checked against arrives in tomorrow's digest. Keeping one of the pair
    // makes neither worth much.
    await env.R2.put(`${PLAN_PREFIX}/${now}-${invalidation.tileset}.json`, JSON.stringify(warm));

    queued += await handOver(env, warm);
  }

  // Only now. Recording the change as seen before it has been handed over
  // would mean a failure here is never retried: nothing would ever warm what
  // was already marked as noticed.
  await env.R2.put(STATE_KEY, JSON.stringify(after));

  return { first: false, invalidations: events.length, queued };
}

/**
 * Hand the plan to the executor.
 *
 * Not warmed from here. Warming is hours of waiting on IO and this is a cron
 * tick with a wall-clock budget; the executor is a queue that outlasts both.
 * With no executor configured the plan is still kept, so the run is a record
 * of what should have been warmed rather than nothing at all.
 */
async function handOver(env: Env, warm: unknown): Promise<number> {
  if (!env.OKIBI_EXECUTOR_URL || !env.OKIBI_EXECUTOR_TOKEN) {
    console.warn("okibi: no executor configured, so the plan was kept and not run");
    return 0;
  }

  const response = await fetch(`${env.OKIBI_EXECUTOR_URL}/plans`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OKIBI_EXECUTOR_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(warm),
  });

  if (!response.ok) {
    throw new Error(`the executor answered ${response.status}: ${await response.text()}`);
  }

  const { queued } = (await response.json()) as { queued: number };
  console.log(`okibi: handed ${queued} entries to the executor`);
  return queued;
}

/**
 * The last week of digests, from this service's own bucket.
 *
 * A missing day is not an error. The digest cron may not have run yet, or the
 * service may not have existed that long, and planning from six days is a
 * smaller plan rather than a wrong one.
 */
async function readDigests(env: Env, now: string): Promise<unknown[]> {
  const day = Date.parse(now);
  const records: unknown[] = [];

  for (let back = 1; back <= DAYS; back++) {
    const date = new Date(day - back * 86_400_000).toISOString().slice(0, 10);
    const object = await env.R2.get(`${DIGEST_PREFIX}/${date}.jsonl`);
    if (!object) continue;

    for (const line of (await object.text()).split("\n")) {
      if (line.trim()) records.push(JSON.parse(line));
    }
  }

  if (records.length === 0) {
    console.warn("okibi: no digests to plan from, so the plan will be empty");
  }
  return records;
}
