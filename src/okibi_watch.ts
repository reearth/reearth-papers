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
  let allHandedOver = true;

  for (const invalidation of events) {
    const warm: { entries: { url: string }[]; stats: Record<string, number> } & Record<
      string,
      // The plan document, which this only reads a few fields of and passes
      // on whole.
      // biome-ignore lint/suspicious/noExplicitAny: the shape is the spec's
      any
    > = plan({
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

    // Before handing it over, because nobody is going to read it. A plan whose
    // URLs do not exist looks exactly like one whose URLs do — ordered
    // entries, a coverage, a price — and the only place that shows is the
    // origin.
    const { wrong, answered } = await sample(warm.entries, env.OKIBI_WARM_SECRET);
    if (wrong.length > 0) {
      console.warn("okibi: not handing over a plan whose URLs do not exist", {
        tileset: invalidation.tileset,
        wrong,
      });
      allHandedOver = false;
      continue;
    }

    // Nothing answered, which is what happens whenever the URLs are this
    // worker's own: a Worker asking for its own hostname goes out to the edge
    // and comes back 522. So this is not a plan that passed, it is a plan
    // nothing could check, and saying otherwise would make a check that
    // cannot fail look like one that did not.
    //
    // Handed over anyway, because the executor asks for every one of these
    // URLs from outside and says what they answered — `okibi: warmed a batch`
    // carries the statuses. Refusing here would trade a plan that reports its
    // own failure for one that never runs.
    if (answered === 0) {
      console.warn("okibi: handing over a plan nothing here could verify", {
        tileset: invalidation.tileset,
        entries: warm.stats.total,
        why: "a Worker cannot ask its own origin; read the executor's statuses",
      });
    }

    queued += await handOver(env, warm);
  }

  // Only once everything has been handed over. Recording the change as seen
  // before that would mean a failure is never retried: nothing would ever warm
  // what was already marked as noticed.
  //
  // A refused plan counts as not handed over, and deliberately so. Its URLs
  // are wrong because of what okibi knows, not because the epoch did not move
  // — a digest written before the ids carried their format extension, say —
  // and the next digest fixes it. Remembering the move now would mean the run
  // that could have warmed it never happens.
  if (allHandedOver) {
    await env.R2.put(STATE_KEY, JSON.stringify(after));
  } else {
    console.warn("okibi: leaving the move unrecorded, so the next tick tries again");
  }

  return { first: false, invalidations: events.length, queued };
}

/** How many of a plan's URLs to ask about before running the rest. */
const SAMPLE = 3;

interface Sampled {
  /** URLs the origin said are not there. The plan's fault. */
  wrong: string[];
  /** How many of the asks came back as an answer about the URL at all. */
  answered: number;
}

/**
 * Ask the origin whether a few of the plan's URLs exist.
 *
 * Spread through the plan rather than taken from its head: the head is the
 * hottest cell, and a template that happens to work there can be wrong three
 * zoom levels down.
 *
 * A 4xx is the plan being wrong — a template, an id or an epoch that rebuilds
 * somewhere that is not there. A 5xx or a refused connection is not an answer
 * about the URL, and is counted separately rather than read as a pass: a check
 * that cannot fail is not a check.
 *
 * It usually cannot answer from here, and that is the point of counting.
 * A Worker asking for its own hostname goes back out to the edge and comes
 * back 522, so every ask this makes about `papers.reearth.land` is a timeout
 * rather than a verdict. Which means this cannot be the whole of the check —
 * see where it is used.
 *
 * The warm header goes on, because a verification counted as demand is demand
 * okibi invented.
 */
async function sample(
  entries: { url: string }[],
  secret: string | undefined,
): Promise<Sampled> {
  const wrong: string[] = [];
  let answered = 0;
  const stride = Math.max(1, Math.ceil(entries.length / SAMPLE));

  for (let i = 0; i < entries.length && wrong.length < SAMPLE; i += stride) {
    const url = entries[i]?.url;
    if (!url) continue;
    try {
      const response = await fetch(url, {
        method: "HEAD",
        headers: secret ? { "X-Okibi-Warm": secret } : {},
      });
      if (response.status >= 500) continue;
      answered++;
      if (response.status >= 400) wrong.push(`${response.status} ${url}`);
    } catch {
      // Not an answer about the URL either.
    }
  }
  return { wrong, answered };
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
