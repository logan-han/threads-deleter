import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

// Both handlers are stubbed in the require cache, so the entrypoints load
// without the AWS SDK and the calls they make can be checked directly.
const require = createRequire(import.meta.url);

const web = { handler: vi.fn(async () => ({ statusCode: 200 })) };
const worker = { handler: vi.fn(async () => ({ jobs: 0, results: [] })) };

const stub = (path, exports) => {
  const filename = require.resolve(path);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};

stub('../src/web.js', web);
stub('../src/worker.js', worker);

const handler = require('../src/handler.js');

describe('Lambda entrypoints', () => {
  // Lambda passes a context second, which web.handler would take as its overrides.
  it('hands an API request, and only the request, to the web handler', async () => {
    const event = { rawPath: '/' };
    await expect(handler.api(event, { awsRequestId: 'req' })).resolves.toEqual({ statusCode: 200 });
    expect(web.handler).toHaveBeenCalledWith(event);
  });

  it('hands a scheduled or kicked event to the worker', async () => {
    const event = { userId: '555' };
    await expect(handler.worker(event, { awsRequestId: 'req' })).resolves.toEqual({ jobs: 0, results: [] });
    expect(worker.handler).toHaveBeenCalledWith(event);
  });
});
