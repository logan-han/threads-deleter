import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const worker = require('../src/worker.js');

const { matchesFilters, runJob } = worker;

const NOW = Date.UTC(2026, 8, 17);
const DAY = 24 * 60 * 60 * 1000;

const post = (id, isoDate, text = '') => ({ id, timestamp: isoDate, text });

const makeDeps = ({ quota = { used: 0, total: 100, remaining: 100 }, pages = [[]], deleteImpl } = {}) => {
  const updates = [];
  let pageIndex = 0;

  return {
    updates,
    now: NOW,
    store: {
      STATES: { active: 'active', paused: 'paused', done: 'done', previewed: 'previewed', error: 'error' },
      updateJob: vi.fn(async (userId, patch) => {
        updates.push({ userId, patch });
        return patch;
      }),
    },
    threads: {
      getDeleteQuota: vi.fn(async () => quota),
      refreshLongLived: vi.fn(async () => ({ access_token: 'refreshed', expires_in: 5183944 })),
      listMedia: vi.fn(async () => pages[Math.min(pageIndex++, pages.length - 1)]),
      deletePost: deleteImpl || vi.fn(async () => ({ success: true })),
    },
  };
};

const baseJob = {
  userId: '100',
  accessToken: 'long-token',
  tokenIssuedAt: NOW - 30 * DAY,
  tokenExpiresAt: NOW + 30 * DAY,
  state: 'active',
  mode: 'all',
};

describe('matchesFilters', () => {
  it('accepts anything in "all" mode', () => {
    expect(matchesFilters({ mode: 'all' }, post('1', '2026-01-01T00:00:00+0000'))).toBe(true);
  });

  it('only accepts posts strictly older than the cutoff', () => {
    const job = { mode: 'older_than', cutoffIso: '2026-01-01T00:00:00.000Z' };
    expect(matchesFilters(job, post('1', '2025-12-31T23:59:00+0000'))).toBe(true);
    expect(matchesFilters(job, post('2', '2026-01-01T00:00:00+0000'))).toBe(false);
    expect(matchesFilters(job, post('3', '2026-02-01T00:00:00+0000'))).toBe(false);
  });

  it('never risks a post with no timestamp when a cutoff is set', () => {
    const job = { mode: 'older_than', cutoffIso: '2026-01-01T00:00:00.000Z' };
    expect(matchesFilters(job, { id: '1' })).toBe(false);
  });

  it('applies the keyword filter case-insensitively', () => {
    const job = { mode: 'all', keyword: 'Melbourne' };
    expect(matchesFilters(job, post('1', '2026-01-01T00:00:00+0000', 'in melbourne today'))).toBe(true);
    expect(matchesFilters(job, post('2', '2026-01-01T00:00:00+0000', 'in sydney today'))).toBe(false);
    expect(matchesFilters(job, post('3', '2026-01-01T00:00:00+0000'))).toBe(false);
  });
});

describe('runJob', () => {
  let deps;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does nothing but record state when the daily quota is spent', async () => {
    deps = makeDeps({ quota: { used: 100, total: 100, remaining: 0 } });
    const result = await runJob(baseJob, deps);

    expect(result).toMatchObject({ deleted: 0, reason: 'quota-exhausted' });
    expect(deps.threads.listMedia).not.toHaveBeenCalled();
    expect(deps.threads.deletePost).not.toHaveBeenCalled();
    expect(deps.updates[0].patch.lastMessage).toMatch(/allowance is spent/i);
  });

  it('counts past the delete cap when previewing, so the backlog is not reported as the cap', async () => {
    const posts = Array.from({ length: 100 }, (_, i) => post(String(i), '2025-01-01T00:00:00+0000'));
    const more = Array.from({ length: 100 }, (_, i) => post(String(100 + i), '2025-01-01T00:00:00+0000'));
    deps = makeDeps({
      quota: { used: 0, total: 100, remaining: 100 },
      pages: [
        { data: posts, paging: { cursors: { after: 'p2' } } },
        { data: more, paging: {} },
      ],
    });
    await runJob({ ...baseJob, dryRun: true }, deps);

    expect(deps.updates[0].patch.previewCount).toBe(200);
    expect(deps.updates[0].patch.previewPartial).toBe(false);
  });

  it('says a preview found a floor, not a total, when it runs out of pages', async () => {
    const full = () => Array.from({ length: 100 }, () => post(String(Math.random()), '2025-01-01T00:00:00+0000'));
    deps = makeDeps({
      quota: { used: 0, total: 100, remaining: 100 },
      pages: Array.from({ length: 12 }, () => ({ data: full(), paging: { cursors: { after: 'next' } } })),
    });
    await runJob({ ...baseJob, dryRun: true }, deps);

    expect(deps.updates[0].patch.previewPartial).toBe(true);
    expect(deps.updates[0].patch.lastMessage).toMatch(/stopped at its page limit/);
  });

  it('still previews when the daily allowance is spent, because a preview deletes nothing', async () => {
    const posts = Array.from({ length: 4 }, (_, i) => post(String(i), '2025-01-01T00:00:00+0000'));
    deps = makeDeps({
      quota: { used: 100, total: 100, remaining: 0 },
      pages: [{ data: posts, paging: {} }],
    });
    const result = await runJob({ ...baseJob, dryRun: true }, deps);

    expect(result).toMatchObject({ deleted: 0, reason: 'dry-run' });
    expect(deps.threads.listMedia).toHaveBeenCalled();
    expect(deps.threads.deletePost).not.toHaveBeenCalled();
    expect(deps.updates[0].patch).toMatchObject({ state: 'previewed', previewCount: 4 });
    expect(deps.updates[0].patch.lastMessage).toMatch(/4 matched/);
  });

  it('deletes up to the remaining quota, not the whole page', async () => {
    const posts = Array.from({ length: 30 }, (_, i) => post(String(i), '2025-01-01T00:00:00+0000'));
    deps = makeDeps({
      quota: { used: 97, total: 100, remaining: 3 },
      pages: [{ data: posts, paging: { cursors: { after: 'next' } } }],
    });

    const result = await runJob(baseJob, deps);

    expect(result.deleted).toBe(3);
    expect(deps.threads.deletePost).toHaveBeenCalledTimes(3);
    expect(deps.updates[0].patch.deletedCount).toBe(3);
    expect(deps.updates[0].patch.quotaUsed).toBe(100);
  });

  it('uses the whole remaining daily quota in one run', async () => {
    const posts = Array.from({ length: 120 }, (_, i) => post(String(i), '2025-01-01T00:00:00+0000'));
    deps = makeDeps({
      quota: { used: 0, total: 100, remaining: 100 },
      pages: [{ data: posts, paging: { cursors: { after: 'next' } } }],
    });

    const result = await runJob(baseJob, deps);

    // The quota is the only limit; no arbitrary smaller batch.
    expect(result.deleted).toBe(100);
  });

  it('previews without deleting in dry-run mode', async () => {
    const posts = [post('1', '2025-01-01T00:00:00+0000'), post('2', '2025-01-02T00:00:00+0000')];
    deps = makeDeps({ pages: [{ data: posts }] });

    const result = await runJob({ ...baseJob, dryRun: true }, deps);

    expect(result).toMatchObject({ deleted: 0, reason: 'dry-run' });
    expect(deps.threads.deletePost).not.toHaveBeenCalled();
    expect(deps.updates[0].patch).toMatchObject({ state: 'previewed', previewCount: 2 });
    expect(deps.updates[0].patch.preview.map((i) => i.id)).toEqual(['1', '2']);
    // The person needs to see what would go, not just how many.
    expect(deps.updates[0].patch.preview[0]).toMatchObject({ id: '1', source: 'posts' });
  });

  it('stores no post text in the preview, only what finds each post again', async () => {
    const posted = { ...post('1', '2025-01-01T00:00:00+0000', 'private words'), permalink: 'https://www.threads.net/x/1' };
    deps = makeDeps({ pages: [{ data: [posted] }] });

    await runJob({ ...baseJob, dryRun: true }, deps);

    expect(deps.updates[0].patch.preview).toEqual([
      { id: '1', source: 'posts', timestamp: '2025-01-01T00:00:00+0000', permalink: 'https://www.threads.net/x/1' },
    ]);
  });

  it('marks the job done when the listing is exhausted with no matches', async () => {
    deps = makeDeps({ pages: [{ data: [] }] });

    const result = await runJob(baseJob, deps);

    expect(result.reason).toBe('complete');
    expect(deps.updates[0].patch.state).toBe('done');
  });

  it('remembers undeletable posts so the job cannot wedge on the same page', async () => {
    const permanent = Object.assign(new Error('Media type is not supported'), {
      isPermanent: true,
      isRateLimit: false,
    });
    deps = makeDeps({
      pages: [{ data: [post('bad', '2025-01-01T00:00:00+0000')] }],
      deleteImpl: vi.fn(async () => {
        throw permanent;
      }),
    });

    const result = await runJob(baseJob, deps);

    expect(result).toMatchObject({ deleted: 0, skipped: 1 });
    expect(deps.updates[0].patch.skipIds).toEqual(['bad']);
  });

  it('does not re-attempt an already skipped post', async () => {
    deps = makeDeps({ pages: [{ data: [post('bad', '2025-01-01T00:00:00+0000')] }] });

    const result = await runJob({ ...baseJob, skipIds: ['bad'] }, deps);

    expect(deps.threads.deletePost).not.toHaveBeenCalled();
    expect(result.reason).toBe('complete');
  });

  it('stops the run when Threads reports a rate limit', async () => {
    const limited = Object.assign(new Error('rate limited'), { isRateLimit: true, isPermanent: false });
    let call = 0;
    deps = makeDeps({
      pages: [{ data: [post('1', '2025-01-01T00:00:00+0000'), post('2', '2025-01-02T00:00:00+0000')] }],
      deleteImpl: vi.fn(async () => {
        call += 1;
        if (call === 2) throw limited;
        return { success: true };
      }),
    });

    const result = await runJob(baseJob, deps);

    expect(result).toMatchObject({ deleted: 1, reason: 'rate-limited' });
    expect(deps.updates[0].patch.lastMessage).toMatch(/rate limit/i);
  });

  it('refreshes a token that is close to expiry', async () => {
    deps = makeDeps({ pages: [{ data: [] }] });
    const job = { ...baseJob, tokenExpiresAt: NOW + 3 * DAY, tokenIssuedAt: NOW - 57 * DAY };

    await runJob(job, deps);

    expect(deps.threads.refreshLongLived).toHaveBeenCalledWith('long-token');
    expect(deps.updates[0].patch.accessToken).toBe('refreshed');
    expect(deps.threads.getDeleteQuota).toHaveBeenCalledWith('100', 'refreshed');
  });

  it('leaves a healthy token alone', async () => {
    deps = makeDeps({ pages: [{ data: [] }] });

    await runJob(baseJob, deps);

    expect(deps.threads.refreshLongLived).not.toHaveBeenCalled();
  });

  it('will not refresh a token younger than 24 hours', async () => {
    deps = makeDeps({ pages: [{ data: [] }] });
    const job = { ...baseJob, tokenExpiresAt: NOW + 2 * DAY, tokenIssuedAt: NOW - 1000 };

    await runJob(job, deps);

    expect(deps.threads.refreshLongLived).not.toHaveBeenCalled();
  });

  it('pages through the listing to find keyword matches', async () => {
    deps = makeDeps({
      pages: [
        { data: [post('1', '2025-01-01T00:00:00+0000', 'nope')], paging: { cursors: { after: 'p2' } } },
        { data: [post('2', '2025-01-02T00:00:00+0000', 'find ME')] },
      ],
    });

    const result = await runJob({ ...baseJob, keyword: 'find me' }, deps);

    expect(deps.threads.listMedia).toHaveBeenCalledTimes(2);
    expect(result.deleted).toBe(1);
    expect(deps.threads.deletePost).toHaveBeenCalledWith('2', 'long-token');
  });

  it('passes the cutoff to the API as a unix "until" filter', async () => {
    deps = makeDeps({ pages: [{ data: [] }] });
    const cutoffIso = '2025-06-01T00:00:00.000Z';

    await runJob({ ...baseJob, mode: 'older_than', cutoffIso }, deps);

    expect(deps.threads.listMedia).toHaveBeenCalledWith(
      expect.objectContaining({ until: Math.floor(Date.parse(cutoffIso) / 1000) })
    );
  });
});

describe('posts and replies are separate collections', () => {
  const pageFor = (source, items, more = false) => ({
    data: items,
    paging: more ? { cursors: { after: 'next' } } : {},
  });

  const sourceAwareDeps = (bySource) => {
    const calls = [];
    return {
      calls,
      now: NOW,
      store: {
        STATES: { active: 'active', paused: 'paused', done: 'done', previewed: 'previewed', error: 'error' },
        updateJob: vi.fn(async () => ({})),
      },
      threads: {
        getDeleteQuota: vi.fn(async () => ({ used: 0, total: 100, remaining: 100 })),
        refreshLongLived: vi.fn(),
        deletePost: vi.fn(async () => ({ success: true })),
        listMedia: vi.fn(async ({ source }) => {
          calls.push(source);
          return pageFor(source, bySource[source] || []);
        }),
      },
    };
  };

  it('reads only posts when replies are not selected', async () => {
    const deps = sourceAwareDeps({ posts: [post('p1', '2025-01-01T00:00:00+0000')] });
    await runJob({ ...baseJob, targets: ['posts'] }, deps);

    expect(deps.calls).toEqual(['posts']);
    expect(deps.threads.deletePost).toHaveBeenCalledWith('p1', 'long-token');
  });

  it('reads only replies when posts are not selected', async () => {
    const deps = sourceAwareDeps({ replies: [post('r1', '2025-01-01T00:00:00+0000')] });
    await runJob({ ...baseJob, targets: ['replies'] }, deps);

    expect(deps.calls).toEqual(['replies']);
    expect(deps.threads.deletePost).toHaveBeenCalledWith('r1', 'long-token');
  });

  it('covers both collections in one run', async () => {
    const deps = sourceAwareDeps({
      posts: [post('p1', '2025-01-01T00:00:00+0000')],
      replies: [post('r1', '2025-01-02T00:00:00+0000')],
    });
    const result = await runJob({ ...baseJob, targets: ['posts', 'replies'] }, deps);

    expect(deps.calls).toEqual(['posts', 'replies']);
    expect(result.deleted).toBe(2);
    expect(result.scanned).toBe(2);
  });

  it('still reads replies when the posts collection is empty', async () => {
    // The case that made this necessary: a history that is nearly all replies.
    const deps = sourceAwareDeps({ posts: [], replies: [post('r1', '2025-01-01T00:00:00+0000')] });
    const result = await runJob({ ...baseJob, targets: ['posts', 'replies'] }, deps);

    expect(deps.calls).toEqual(['posts', 'replies']);
    expect(result.deleted).toBe(1);
  });

  it('defaults an older job with no targets to posts only', async () => {
    const deps = sourceAwareDeps({ posts: [post('p1', '2025-01-01T00:00:00+0000')] });
    await runJob(baseJob, deps);

    expect(deps.calls).toEqual(['posts']);
  });
});

describe('a collection the app cannot read', () => {
  const forbidden = () => Object.assign(new Error('Application does not have permission for this action'), {
    isPermission: true, isPermanent: true, isRateLimit: false,
  });

  const deps = (impl) => ({
    now: NOW,
    store: {
      STATES: { active: 'active', paused: 'paused', done: 'done', previewed: 'previewed', error: 'error' },
      updateJob: vi.fn(async () => ({})),
    },
    threads: {
      getDeleteQuota: vi.fn(async () => ({ used: 0, total: 100, remaining: 100 })),
      refreshLongLived: vi.fn(),
      deletePost: vi.fn(async () => ({ success: true })),
      listMedia: vi.fn(impl),
    },
  });

  it('still processes posts when replies are forbidden', async () => {
    const d = deps(async ({ source }) => {
      if (source === 'replies') throw forbidden();
      return { data: [post('p1', '2025-01-01T00:00:00+0000')] };
    });

    const result = await runJob({ ...baseJob, targets: ['posts', 'replies'] }, d);

    expect(result.deleted).toBe(1);
    // Replies were never readable, so this must not be reported as finished.
    expect(d.store.updateJob.mock.calls[0][1].state).not.toBe('done');
    expect(d.store.updateJob.mock.calls[0][1].lastMessage).toMatch(/Deleted 1/);
  });

  it('says which collection needs reconnecting in a dry run', async () => {
    const d = deps(async ({ source }) => {
      if (source === 'replies') throw forbidden();
      return { data: [] };
    });

    await runJob({ ...baseJob, targets: ['posts', 'replies'], dryRun: true }, d);

    expect(d.store.updateJob.mock.calls[0][1].lastMessage).toMatch(/replies.*reconnect/i);
  });

  it('still raises errors that are not about permissions', async () => {
    const d = deps(async () => {
      throw Object.assign(new Error('upstream exploded'), { isPermission: false });
    });

    await expect(runJob({ ...baseJob, targets: ['posts'] }, d)).rejects.toThrow('upstream exploded');
  });
});

describe('finishing the work', () => {
  it('marks the job done in the very run that clears the backlog', async () => {
    // 60 matches, quota allows 100: the run takes them all and the listing ends.
    const posts = Array.from({ length: 60 }, (_, i) => post(String(i), '2025-01-01T00:00:00+0000'));
    const deps = makeDeps({
      quota: { used: 40, total: 100, remaining: 60 },
      pages: [{ data: posts }],
    });

    const result = await runJob(baseJob, deps);

    expect(result.deleted).toBe(60);
    expect(deps.updates[0].patch.state).toBe('done');
    expect(deps.updates[0].patch.lastMessage).toMatch(/done/i);
  });

  it('stays active when the quota cut the run short', async () => {
    const posts = Array.from({ length: 200 }, (_, i) => post(String(i), '2025-01-01T00:00:00+0000'));
    const deps = makeDeps({
      quota: { used: 0, total: 100, remaining: 100 },
      pages: [{ data: posts, paging: { cursors: { after: 'more' } } }],
    });

    const result = await runJob(baseJob, deps);

    expect(result.deleted).toBe(100);
    expect(deps.updates[0].patch.state).toBe('active');
    expect(deps.updates[0].patch.lastMessage).toMatch(/More to go/);
  });

  it('stays active when a rate limit stopped it early', async () => {
    const limited = Object.assign(new Error('slow down'), { isRateLimit: true, isPermanent: false });
    let n = 0;
    const deps = makeDeps({
      pages: [{ data: [post('1', '2025-01-01T00:00:00+0000'), post('2', '2025-01-02T00:00:00+0000')] }],
      deleteImpl: vi.fn(async () => { n += 1; if (n === 2) throw limited; return { success: true }; }),
    });

    await runJob(baseJob, deps);

    expect(deps.updates[0].patch.state).toBe('active');
  });

  it('counts the running total, not just this run', async () => {
    const posts = Array.from({ length: 200 }, (_, i) => post(String(i), '2025-01-01T00:00:00+0000'));
    const deps = makeDeps({
      quota: { used: 0, total: 100, remaining: 100 },
      pages: [{ data: posts, paging: { cursors: { after: 'more' } } }],
    });

    await runJob({ ...baseJob, deletedCount: 40 }, deps);

    expect(deps.updates[0].patch.lastMessage).toMatch(/140 in total/);
  });

  it('stops at an unexpected failure and leaves that post to be retried, not skipped', async () => {
    let n = 0;
    const deps = makeDeps({
      quota: { used: 97, total: 100, remaining: 3 },
      pages: [{
        data: ['1', '2', '3'].map((id) => post(id, '2025-01-01T00:00:00+0000')),
        paging: { cursors: { after: 'more' } },
      }],
      deleteImpl: vi.fn(async () => {
        n += 1;
        if (n === 2) throw new Error('socket hang up');
        return { success: true };
      }),
    });

    const result = await runJob(baseJob, deps);

    expect(result).toMatchObject({ deleted: 1, skipped: 0, reason: 'ok' });
    expect(deps.threads.deletePost).toHaveBeenCalledTimes(2);
    expect(deps.updates[0].patch).toMatchObject({ state: 'active', lastError: 'socket hang up', skipIds: [] });
  });

  it('stays active when an unexpected failure cut the last page short', async () => {
    let n = 0;
    const deps = makeDeps({
      pages: [{ data: ['1', '2', '3'].map((id) => post(id, '2025-01-01T00:00:00+0000')) }],
      deleteImpl: vi.fn(async () => {
        n += 1;
        if (n === 2) throw new Error('Threads returned 500');
        return { success: true };
      }),
    });

    await runJob(baseJob, deps);

    expect(deps.updates[0].patch.state).toBe('active');
    expect(deps.updates[0].patch.lastMessage).toMatch(/More to go/);
  });

  it('says so when the only posts it reached this pass were undeletable', async () => {
    const permanent = Object.assign(new Error('Media type is not supported'), {
      isPermanent: true,
      isRateLimit: false,
    });
    const deps = makeDeps({
      quota: { used: 99, total: 100, remaining: 1 },
      pages: [{
        data: [post('bad', '2025-01-01T00:00:00+0000'), post('next', '2025-01-02T00:00:00+0000')],
        paging: { cursors: { after: 'more' } },
      }],
      deleteImpl: vi.fn(async () => {
        throw permanent;
      }),
    });

    await runJob(baseJob, deps);

    expect(deps.updates[0].patch).toMatchObject({ state: 'active', skipIds: ['bad'] });
    expect(deps.updates[0].patch.lastMessage).toMatch(/1 could not be deleted/);
  });

  it('keeps going when a pass runs out of pages before finding a match', async () => {
    const deps = makeDeps({
      pages: [{
        data: [post('1', '2025-01-01T00:00:00+0000', 'nothing to see')],
        paging: { cursors: { after: 'more' } },
      }],
    });

    const result = await runJob({ ...baseJob, keyword: 'needle' }, deps);

    expect(deps.threads.listMedia).toHaveBeenCalledTimes(10);
    expect(deps.threads.deletePost).not.toHaveBeenCalled();
    expect(result.reason).toBe('ok');
    expect(deps.updates[0].patch).toMatchObject({ state: 'active', scannedCount: 10 });
    expect(deps.updates[0].patch.lastMessage).toMatch(/More to go/);
  });
});

describe('targetsOf', () => {
  const { targetsOf } = worker;

  it('defaults to posts, because jobs created before replies existed stored nothing', () => {
    expect(targetsOf({})).toEqual(['posts']);
    expect(targetsOf({ targets: [] })).toEqual(['posts']);
    expect(targetsOf({ targets: 'posts' })).toEqual(['posts']);
  });

  it('keeps both collections when both were asked for', () => {
    expect(targetsOf({ targets: ['posts', 'replies'] })).toEqual(['posts', 'replies']);
  });

  it('drops anything that is not a real collection', () => {
    expect(targetsOf({ targets: ['replies', 'stories'] })).toEqual(['replies']);
    expect(targetsOf({ targets: ['stories'] })).toEqual(['posts']);
  });
});

describe('ensureFreshToken', () => {
  const { ensureFreshToken } = worker;

  it('leaves a token alone while it still has plenty of life', async () => {
    const deps = makeDeps();
    const token = await ensureFreshToken(baseJob, deps);

    expect(token).toBe('long-token');
    expect(deps.threads.refreshLongLived).not.toHaveBeenCalled();
    expect(deps.store.updateJob).not.toHaveBeenCalled();
  });

  it('leaves a token alone when it is under a day old, which Meta refuses to refresh', async () => {
    const deps = makeDeps();
    const token = await ensureFreshToken(
      { ...baseJob, tokenIssuedAt: NOW - 2000, tokenExpiresAt: NOW + DAY },
      deps
    );

    expect(token).toBe('long-token');
    expect(deps.threads.refreshLongLived).not.toHaveBeenCalled();
  });

  it('leaves a job with no recorded expiry alone', async () => {
    const deps = makeDeps();
    await expect(ensureFreshToken({ ...baseJob, tokenExpiresAt: 0 }, deps)).resolves.toBe('long-token');
    expect(deps.threads.refreshLongLived).not.toHaveBeenCalled();
  });

  it('refreshes inside the window and stores the new token and its expiry', async () => {
    const deps = makeDeps();
    const job = { ...baseJob, tokenIssuedAt: NOW - 40 * DAY, tokenExpiresAt: NOW + DAY };
    const token = await ensureFreshToken(job, deps);

    expect(token).toBe('refreshed');
    expect(deps.threads.refreshLongLived).toHaveBeenCalledWith('long-token');
    expect(deps.updates[0].userId).toBe('100');
    expect(deps.updates[0].patch).toMatchObject({
      accessToken: 'refreshed',
      tokenIssuedAt: NOW,
      tokenExpiresAt: NOW + 5183944 * 1000,
    });
  });
});
