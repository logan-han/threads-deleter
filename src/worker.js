'use strict';

const config = require('./config.js');
const defaultStore = require('./store.js');
const defaultThreads = require('./threads.js');

const DAY_MS = 24 * 60 * 60 * 1000;

const matchesFilters = (job, post) => {
  if (job.cutoffIso) {
    // A post with no timestamp cannot be proven older than the cutoff, so it is
    // never a candidate.
    if (!post.timestamp) return false;
    if (new Date(post.timestamp).getTime() >= new Date(job.cutoffIso).getTime()) return false;
  }

  if (job.keyword) {
    const text = String(post.text || '').toLowerCase();
    if (!text.includes(String(job.keyword).toLowerCase())) return false;
  }

  return true;
};

// Long-lived tokens last 60 days and are refreshable once 24h old. Refresh
// inside the configured window so an idle job never expires mid-run.
const ensureFreshToken = async (job, { threads, store, now }) => {
  const expiresAt = Number(job.tokenExpiresAt || 0);
  const issuedAt = Number(job.tokenIssuedAt || 0);
  const daysLeft = (expiresAt - now) / DAY_MS;

  if (!expiresAt || daysLeft > config.refreshWhenDaysLeft) return job.accessToken;
  if (now - issuedAt < DAY_MS) return job.accessToken;

  const refreshed = await threads.refreshLongLived(job.accessToken);
  const patch = {
    accessToken: refreshed.access_token,
    tokenIssuedAt: now,
    tokenExpiresAt: now + Number(refreshed.expires_in || 0) * 1000,
  };
  await store.updateJob(job.userId, patch);
  return patch.accessToken;
};

// Which collections a job covers. Older jobs stored none, so default to posts.
const targetsOf = (job) => {
  const targets = Array.isArray(job.targets) ? job.targets.filter((t) => t === 'posts' || t === 'replies') : [];
  return targets.length ? targets : ['posts'];
};

const collectCandidates = async (job, token, wanted, { threads }) => {
  const skip = new Set(job.skipIds || []);
  const candidates = [];
  const until = job.cutoffIso
    ? Math.floor(new Date(job.cutoffIso).getTime() / 1000)
    : undefined;

  let scanned = 0;
  let pages = 0;
  let exhausted = true;
  const unreadable = [];

  // Walk each collection in turn; a run stops as soon as it has enough.
  for (const source of targetsOf(job)) {
    let after;

    while (candidates.length < wanted && pages < config.maxPagesPerRun) {
      let page;
      try {
        page = await threads.listMedia({
          userId: job.userId,
          token,
          source,
          limit: config.pageSize,
          until,
          after,
        });
      } catch (error) {
        // One collection being off-limits must not sink the whole run: report
        // it and carry on with whatever else was asked for.
        if (error.isPermission) {
          unreadable.push(source);
          break;
        }
        throw error;
      }

      pages += 1;
      const items = page.data || [];
      scanned += items.length;

      for (const item of items) {
        if (skip.has(item.id)) continue;
        if (!matchesFilters(job, item)) continue;
        candidates.push({ ...item, source });
      }

      after = page.paging && page.paging.cursors && page.paging.cursors.after;
      if (items.length === 0 || !after) break;
    }

    // Anything left behind in this collection means there is more to do later.
    if (after && candidates.length >= wanted) exhausted = false;
    if (pages >= config.maxPagesPerRun) exhausted = false;
  }

  return { candidates: candidates.slice(0, wanted), scanned, pages, exhausted, unreadable };
};

const runJob = async (job, overrides = {}) => {
  const deps = {
    threads: overrides.threads || defaultThreads,
    store: overrides.store || defaultStore,
    now: overrides.now || Date.now(),
  };
  const { threads, store, now } = deps;

  const token = await ensureFreshToken(job, deps);
  const quota = await threads.getDeleteQuota(job.userId, token);

  // A preview only reads. Gating it on the delete allowance meant a brand new
  // dry run, started on a day whose allowance was already spent, reported
  // itself as a stalled live job and never produced the preview it promised.
  if (!job.dryRun && quota.remaining <= 0) {
    await store.updateJob(job.userId, {
      lastRunAt: now,
      lastMessage: `Today's allowance is spent (${quota.used} of ${quota.total}). Deleting resumes as it frees up over the next 24 hours.`,
      quotaUsed: quota.used,
      quotaTotal: quota.total,
    });
    return { deleted: 0, skipped: 0, scanned: 0, reason: 'quota-exhausted' };
  }

  // A live pass takes what is left of the allowance. A preview spends none of
  // it and exists to size the backlog, so capping it at the delete cap made it
  // report the cap back: 100 matches, one day's work, whatever the real total.
  // It scans until the page budget runs out instead.
  const wanted = job.dryRun
    ? Infinity
    : Math.min(quota.remaining, config.perRunDeleteCap);
  const { candidates, scanned, exhausted, unreadable } = await collectCandidates(job, token, wanted, deps);
  const missing = unreadable.length
    ? ` Could not read your ${unreadable.join(' or ')}: the app is missing permission for that, so reconnect to grant it.`
    : '';

  if (job.dryRun) {
    await store.updateJob(job.userId, {
      state: store.STATES.previewed,
      lastRunAt: now,
      quotaUsed: quota.used,
      quotaTotal: quota.total,
      scannedCount: Number(job.scannedCount || 0) + scanned,
      preview: candidates.slice(0, config.previewSampleSize).map((item) => ({
        id: item.id,
        source: item.source,
        timestamp: item.timestamp || null,
        text: (item.text || '').slice(0, 140),
        permalink: item.permalink || null,
      })),
      previewCount: candidates.length,
      previewPartial: !exhausted,
      lastMessage: exhausted
        ? `Preview: ${candidates.length} matched out of ${scanned} scanned. This preview deleted nothing.${missing}`
        : `Preview: ${candidates.length} matched in the ${scanned} checked, and the scan stopped at its page limit, `
          + `so there is more further back. This preview deleted nothing.${missing}`,
    });
    return { deleted: 0, skipped: 0, scanned, reason: 'dry-run' };
  }

  if (candidates.length === 0 && exhausted) {
    await store.updateJob(job.userId, {
      state: store.STATES.done,
      lastRunAt: now,
      scannedCount: Number(job.scannedCount || 0) + scanned,
      lastMessage: `Nothing left that matches this job.${missing}`,
    });
    return { deleted: 0, skipped: 0, scanned, reason: 'complete' };
  }

  const skipIds = [...(job.skipIds || [])];
  let deleted = 0;
  let skipped = 0;
  let rateLimited = false;
  let interrupted = false;
  let lastError = null;

  for (const post of candidates) {
    try {
      await threads.deletePost(post.id, token);
      deleted += 1;
    } catch (error) {
      if (error.isRateLimit) {
        rateLimited = true;
        lastError = error.message;
        break;
      }

      if (error.isPermanent) {
        // Undeletable posts stay at the top of the listing, so remember them or
        // the job re-reads the same page on every run and never progresses.
        skipped += 1;
        skipIds.push(post.id);
        lastError = error.message;
        continue;
      }

      lastError = error.message;
      interrupted = true;
      break;
    }
  }

  // A pass that reached the end of every collection has seen everything there
  // is; without this the job stays "working through it" until a later pass
  // happens to find nothing. A collection it could not read does not count as
  // seen, and a pass an error cut short left some of what it saw, so neither
  // may look like completion.
  const finished = exhausted && !rateLimited && !interrupted && unreadable.length === 0;

  const patch = {
    state: finished ? store.STATES.done : job.state,
    lastRunAt: now,
    deletedCount: Number(job.deletedCount || 0) + deleted,
    skippedCount: Number(job.skippedCount || 0) + skipped,
    scannedCount: Number(job.scannedCount || 0) + scanned,
    quotaUsed: quota.used + deleted,
    quotaTotal: quota.total,
    skipIds: skipIds.slice(-config.maxSkipIds),
    lastError: lastError || null,
  };

  const total = Number(job.deletedCount || 0) + deleted;

  if (rateLimited) {
    patch.lastMessage = `Stopped early: Threads reported a rate limit after ${deleted} this run.`;
  } else if (finished) {
    patch.lastMessage = deleted > 0
      ? `Removed the last ${deleted}. Nothing else matches, so this job is done.`
      : 'Nothing else matches, so this job is done.';
  } else if (deleted === 0 && skipped > 0) {
    patch.lastMessage = `${skipped} could not be deleted and were left alone.`;
  } else {
    patch.lastMessage = `Deleted ${deleted} this run, ${total} in total. More to go.`;
  }

  await store.updateJob(job.userId, patch);

  return { deleted, skipped, scanned, reason: rateLimited ? 'rate-limited' : 'ok' };
};

// An event carrying a userId runs just that job, which is how a fresh
// connection gets a result immediately.
const handler = async (event) => {
  const only = event && event.userId ? String(event.userId) : null;
  const jobs = only
    ? [await defaultStore.getJob(only)].filter(Boolean)
    : await defaultStore.listActiveJobs();
  const results = [];

  for (const job of jobs) {
    try {
      const result = await runJob(job);
      results.push({ userId: job.userId, ...result });
    } catch (error) {
      results.push({ userId: job.userId, error: error.message });
      await defaultStore.updateJob(job.userId, {
        state: error.isPermanent ? defaultStore.STATES.error : defaultStore.STATES.active,
        lastRunAt: Date.now(),
        lastError: error.message,
        lastMessage: `Run failed: ${error.message}`,
      });
    }
  }

  console.log(JSON.stringify({ msg: 'worker run complete', jobs: jobs.length, results }));
  return { jobs: jobs.length, results };
};

module.exports = { collectCandidates, ensureFreshToken, handler, matchesFilters, runJob, targetsOf };
