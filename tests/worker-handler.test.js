import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The Lambda entrypoint reaches for the real store and API client rather than
// taking them as arguments, so they are stubbed in the require cache before
// worker.js is first loaded. Everything else about runJob is covered in
// worker.test.js, which injects its dependencies instead.
const require = createRequire(import.meta.url);

const STATES = { active: 'active', paused: 'paused', done: 'done', previewed: 'previewed', error: 'error' };

const store = {
  STATES,
  getJob: vi.fn(),
  listActiveJobs: vi.fn(),
  updateJob: vi.fn(async () => ({})),
};

const threads = {
  getDeleteQuota: vi.fn(async () => ({ used: 0, total: 100, remaining: 100 })),
  refreshLongLived: vi.fn(),
  listMedia: vi.fn(async () => ({ data: [], paging: {} })),
  deletePost: vi.fn(async () => ({ success: true })),
};

const stub = (path, exports) => {
  const filename = require.resolve(path);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};

stub('../src/store.js', store);
stub('../src/threads.js', threads);

const worker = require('../src/worker.js');

const job = (userId) => ({
  userId,
  accessToken: 'tok',
  tokenExpiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
  state: 'active',
  mode: 'all',
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  threads.getDeleteQuota.mockResolvedValue({ used: 0, total: 100, remaining: 100 });
  threads.listMedia.mockResolvedValue({ data: [], paging: {} });
  store.updateJob.mockResolvedValue({});
});

describe('the scheduled run', () => {
  it('works through every active job', async () => {
    store.listActiveJobs.mockResolvedValue([job('1'), job('2')]);

    const result = await worker.handler({});

    expect(store.listActiveJobs).toHaveBeenCalled();
    expect(store.getJob).not.toHaveBeenCalled();
    expect(result.jobs).toBe(2);
    expect(result.results.map((r) => r.userId)).toEqual(['1', '2']);
  });

  it('reports no work rather than failing when nothing is active', async () => {
    store.listActiveJobs.mockResolvedValue([]);
    await expect(worker.handler({})).resolves.toEqual({ jobs: 0, results: [] });
  });
});

describe('a run kicked for one account', () => {
  it('fetches just that job and skips the scan', async () => {
    store.getJob.mockResolvedValue(job('555'));

    const result = await worker.handler({ userId: 555 });

    expect(store.getJob).toHaveBeenCalledWith('555');
    expect(store.listActiveJobs).not.toHaveBeenCalled();
    expect(result.jobs).toBe(1);
  });

  it('does nothing when that job has since been erased', async () => {
    store.getJob.mockResolvedValue(null);
    await expect(worker.handler({ userId: '555' })).resolves.toEqual({ jobs: 0, results: [] });
  });
});

describe('when a job throws', () => {
  it('records the error against that job and carries on with the rest', async () => {
    store.listActiveJobs.mockResolvedValue([job('1'), job('2')]);
    threads.getDeleteQuota
      .mockRejectedValueOnce(new Error('Threads is down'))
      .mockResolvedValue({ used: 0, total: 100, remaining: 100 });

    const result = await worker.handler({});

    expect(result.jobs).toBe(2);
    expect(result.results[0]).toMatchObject({ userId: '1', error: 'Threads is down' });
    expect(result.results[1].userId).toBe('2');
    expect(store.updateJob).toHaveBeenCalledWith('1', expect.objectContaining({
      lastError: 'Threads is down',
      lastMessage: 'Run failed: Threads is down',
    }));
  });

  it('leaves a transient failure active, so the next pass retries it', async () => {
    store.listActiveJobs.mockResolvedValue([job('1')]);
    threads.getDeleteQuota.mockRejectedValue(new Error('socket hang up'));

    await worker.handler({});

    expect(store.updateJob).toHaveBeenCalledWith('1', expect.objectContaining({ state: 'active' }));
  });

  it('stops a job whose failure is permanent, because retrying cannot fix it', async () => {
    store.listActiveJobs.mockResolvedValue([job('1')]);
    const fatal = new Error('The access token is invalid');
    fatal.isPermanent = true;
    threads.getDeleteQuota.mockRejectedValue(fatal);

    await worker.handler({});

    expect(store.updateJob).toHaveBeenCalledWith('1', expect.objectContaining({ state: 'error' }));
  });
});
