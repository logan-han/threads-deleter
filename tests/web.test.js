import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const web = require('../src/web.js');
const { sign, verify } = require('../src/sign.js');

const NOW = Date.UTC(2026, 8, 17);

const event = (method, path, { body, query, headers, cookies } = {}) => ({
  rawPath: path,
  requestContext: { http: { method } },
  queryStringParameters: query,
  headers: { host: 'deleter.example.test', ...headers },
  cookies,
  body: body ? new URLSearchParams(body).toString() : undefined,
  isBase64Encoded: false,
});

const NONCE = 'nonce-from-start';

// A callback from the browser that started the flow, so it carries the nonce cookie.
const callbackEvent = (options, query = {}) => event('GET', '/callback', {
  query: { code: 'c', state: sign({ ...options, nonce: NONCE }), ...query },
  cookies: [`__Host-oauth_state=${NONCE}`],
});

// texts stands in for what Threads returns when the preview reads a post live.
const makeDeps = ({ job = null, texts = {} } = {}) => ({
  now: NOW,
  runNow: vi.fn(async () => true),
  runJob: vi.fn(async () => ({ deleted: 0 })),
  store: {
    STATES: { active: 'active', paused: 'paused', done: 'done', previewed: 'previewed', error: 'error' },
    getJob: vi.fn(async () => job),
    putJob: vi.fn(async () => ({})),
    updateJob: vi.fn(async () => ({})),
    deleteJob: vi.fn(async () => ({})),
  },
  threads: {
    authorizeUrl: vi.fn((state, redirectUri) => `https://threads.net/oauth/authorize?state=${state}&redirect_uri=${redirectUri}`),
    exchangeCode: vi.fn(async () => ({ access_token: 'short', user_id: 555 })),
    exchangeLongLived: vi.fn(async () => ({ access_token: 'long', expires_in: 5183944 })),
    getMe: vi.fn(async () => ({ id: '555', username: 'logan' })),
    getMedia: vi.fn(async (id) => ({ id, text: texts[id] ?? `post ${id}` })),
  },
});

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe('GET /', () => {
  it('renders the connect form', async () => {
    const response = await web.handler(event('GET', '/'), makeDeps());
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('Threads Deleter');
    expect(response.body).toContain('name="confirm"');
    expect(response.body).toContain('threads_delete');
  });
});

describe('POST /start', () => {
  it('refuses without the confirmation box', async () => {
    const response = await web.handler(
      event('POST', '/start', { body: { mode: 'all' } }),
      makeDeps()
    );
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('confirmation box');
  });

  it('refuses an invalid cutoff in older_than mode', async () => {
    const response = await web.handler(
      event('POST', '/start', { body: { mode: 'older_than', cutoff: 'not-a-date', confirm: 'yes', includePosts: 'yes' } }),
      makeDeps()
    );
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('valid cutoff date');
  });

  it('redirects to Threads with a signed state and derived callback', async () => {
    const deps = makeDeps();
    const response = await web.handler(
      event('POST', '/start', { body: { mode: 'all', confirm: 'yes', dryRun: 'yes', includePosts: 'yes' } }),
      deps
    );

    expect(response.statusCode).toBe(302);
    const [state, redirectUri] = deps.threads.authorizeUrl.mock.calls[0];
    expect(redirectUri).toBe('https://deleter.example.test/callback');
    const decoded = verify(state);
    expect(decoded).toMatchObject({ mode: 'all', dryRun: true });
  });

  it('carries the cutoff and keyword into the signed state', async () => {
    const deps = makeDeps();
    await web.handler(
      event('POST', '/start', {
        body: { mode: 'older_than', cutoff: '2024-01-01', keyword: '  hello  ', confirm: 'yes', includePosts: 'yes', includeReplies: 'yes' },
      }),
      deps
    );

    const decoded = verify(deps.threads.authorizeUrl.mock.calls[0][0]);
    expect(decoded.cutoffIso).toBe('2024-01-01T00:00:00.000Z');
    expect(decoded.keyword).toBe('hello');
    expect(decoded.dryRun).toBe(false);
  });

  it('refuses when neither posts nor replies is chosen', async () => {
    const response = await web.handler(
      event('POST', '/start', { body: { mode: 'all', confirm: 'yes' } }),
      makeDeps()
    );
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('at least one of posts or replies');
  });

  it('can target replies alone', async () => {
    const deps = makeDeps();
    await web.handler(
      event('POST', '/start', { body: { mode: 'all', confirm: 'yes', includeReplies: 'yes' } }),
      deps
    );
    expect(verify(deps.threads.authorizeUrl.mock.calls[0][0]).targets).toEqual(['replies']);
  });

  it('decodes a form body that API Gateway base64-encoded', async () => {
    const deps = makeDeps();
    const form = new URLSearchParams({ mode: 'all', confirm: 'yes', includePosts: 'yes' }).toString();

    const response = await web.handler(
      { ...event('POST', '/start'), body: Buffer.from(form).toString('base64'), isBase64Encoded: true },
      deps
    );

    expect(response.statusCode).toBe(302);
    expect(verify(deps.threads.authorizeUrl.mock.calls[0][0]).targets).toEqual(['posts']);
  });

  it('ties the flow to this browser with a cookie holding the signed nonce', async () => {
    const deps = makeDeps();
    const response = await web.handler(
      event('POST', '/start', { body: { mode: 'all', confirm: 'yes', includePosts: 'yes' } }),
      deps
    );

    const { nonce } = verify(deps.threads.authorizeUrl.mock.calls[0][0]);
    expect(nonce).toMatch(/^[\w-]{22}$/);
    expect(response.cookies).toEqual([
      `__Host-oauth_state=${nonce}; Path=/; Max-Age=3600; HttpOnly; Secure; SameSite=Lax`,
    ]);
  });

  it('refuses a form that another site submitted', async () => {
    const deps = makeDeps();
    const body = { mode: 'all', confirm: 'yes', includePosts: 'yes' };

    const posted = await web.handler(event('POST', '/start', { body, headers: { origin: 'https://attacker.example' } }), deps);
    const unlabelled = await web.handler(event('POST', '/start', { body, headers: { 'sec-fetch-site': 'cross-site' } }), deps);

    expect(posted.statusCode).toBe(403);
    expect(unlabelled.statusCode).toBe(403);
    expect(deps.threads.authorizeUrl).not.toHaveBeenCalled();
  });

  it('accepts its own form', async () => {
    const body = { mode: 'all', confirm: 'yes', includePosts: 'yes' };

    const posted = await web.handler(event('POST', '/start', { body, headers: { origin: 'https://deleter.example.test' } }), makeDeps());
    const fetched = await web.handler(event('POST', '/start', { body, headers: { 'sec-fetch-site': 'same-origin' } }), makeDeps());

    expect(posted.statusCode).toBe(302);
    expect(fetched.statusCode).toBe(302);
  });
});

describe('GET /callback', () => {
  it('rejects a missing or forged state', async () => {
    const forged = await web.handler(
      event('GET', '/callback', { query: { code: 'abc', state: 'forged' } }),
      makeDeps()
    );
    expect(forged.statusCode).toBe(400);
    expect(forged.body).toContain('authorisation state');
  });

  it('surfaces a user denial', async () => {
    const response = await web.handler(
      event('GET', '/callback', { query: { error: 'access_denied', error_description: 'The user denied your request' } }),
      makeDeps()
    );
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('denied');
  });

  it('exchanges the code, stores the job and redirects to the status link', async () => {
    const deps = makeDeps();

    const response = await web.handler(callbackEvent({ mode: 'all', dryRun: true }, { code: 'the-code#_' }), deps);

    expect(deps.threads.exchangeCode).toHaveBeenCalledWith('the-code', 'https://deleter.example.test/callback');
    expect(deps.threads.exchangeLongLived).toHaveBeenCalledWith('short');

    const stored = deps.store.putJob.mock.calls[0][0];
    expect(stored).toMatchObject({
      userId: '555',
      username: 'logan',
      accessToken: 'long',
      state: 'active',
      mode: 'all',
      dryRun: true,
    });
    expect(stored.ttl).toBeGreaterThan(Math.floor(NOW / 1000));

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toMatch(/^\/status\?s=/);
  });

  it('preserves cumulative counters across a reconnect', async () => {
    const deps = makeDeps({ job: { userId: '555', mode: 'all', targets: ['posts'], deletedCount: 120, skippedCount: 3, skipIds: ['x'], createdAt: 1 } });
    await web.handler(callbackEvent({ mode: 'all' }), deps);

    expect(deps.store.putJob.mock.calls[0][0]).toMatchObject({
      deletedCount: 120,
      skippedCount: 3,
      skipIds: ['x'],
      createdAt: 1,
    });
  });

  it('refuses a callback from a browser that did not start the flow', async () => {
    // Otherwise anyone could start a live job at /start and send its Threads link to someone else.
    const deps = makeDeps();
    const requests = [
      { ...callbackEvent({ mode: 'all' }), cookies: undefined },
      { ...callbackEvent({ mode: 'all' }), cookies: ['__Host-oauth_state=another-flow'] },
      event('GET', '/callback', { query: { code: 'c', state: sign({ mode: 'all' }) }, cookies: ['__Host-oauth_state='] }),
    ];

    for (const request of requests) {
      const response = await web.handler(request, deps);
      expect(response.statusCode).toBe(400);
      expect(response.body).toContain('started in a different browser');
    }
    expect(deps.threads.exchangeCode).not.toHaveBeenCalled();
  });

  it('also reads the nonce from a Cookie header', async () => {
    const deps = makeDeps();
    const request = { ...callbackEvent({ mode: 'all' }), cookies: undefined };
    request.headers = { ...request.headers, cookie: `theme=dark; __Host-oauth_state=${NONCE}` };

    await web.handler(request, deps);

    expect(deps.threads.exchangeCode).toHaveBeenCalled();
  });

  it('refuses a callback with no authorisation code', async () => {
    const response = await web.handler(
      event('GET', '/callback', { query: { state: sign({ mode: 'all' }) } }),
      makeDeps()
    );
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('did not return an authorisation code');
  });

  it('names the error when Threads sends no description', async () => {
    const response = await web.handler(event('GET', '/callback', { query: { error: 'access_denied' } }), makeDeps());
    expect(response.body).toContain('Threads returned &quot;access_denied&quot;');
  });

  it('keys the job on the token exchange user id when the profile has none', async () => {
    const deps = makeDeps();
    deps.threads.getMe.mockResolvedValue({ username: 'logan' });

    await web.handler(callbackEvent({ mode: 'all' }), deps);

    expect(deps.store.putJob.mock.calls[0][0].userId).toBe('555');
  });

  it('previews inline, so the status page opens on real results', async () => {
    const deps = makeDeps({ job: { userId: '555', mode: 'all', dryRun: true } });
    await web.handler(callbackEvent({ mode: 'all', dryRun: true }), deps);

    expect(deps.runJob).toHaveBeenCalledWith(
      expect.objectContaining({ userId: '555' }),
      expect.objectContaining({ now: NOW })
    );
    expect(deps.runNow).not.toHaveBeenCalled();
  });

  it('hands a live job to the worker instead of running it inline', async () => {
    const deps = makeDeps({ job: { userId: '555', mode: 'all', dryRun: false } });
    await web.handler(callbackEvent({ mode: 'all' }), deps);

    expect(deps.runNow).toHaveBeenCalledWith('555');
    expect(deps.runJob).not.toHaveBeenCalled();
  });

  it('still connects when the inline preview fails', async () => {
    const deps = makeDeps({ job: { userId: '555', mode: 'all', dryRun: true } });
    deps.runJob.mockRejectedValue(new Error('Threads is down'));

    const response = await web.handler(callbackEvent({ mode: 'all', dryRun: true }), deps);

    expect(response.statusCode).toBe(302);
    expect(deps.store.updateJob).toHaveBeenCalledWith('555', {
      lastMessage: 'Could not preview just now: Threads is down. It will retry shortly.',
    });
  });
});

describe('GET /status', () => {
  it('rejects an unsigned status link', async () => {
    const response = await web.handler(event('GET', '/status', { query: { s: 'nope' } }), makeDeps());
    expect(response.statusCode).toBe(404);
  });

  it('renders progress for a signed link', async () => {
    const job = {
      userId: '555',
      username: 'logan',
      state: 'active',
      mode: 'older_than',
      cutoffIso: '2024-01-01T00:00:00.000Z',
      deletedCount: 42,
      skippedCount: 1,
      quotaUsed: 42,
      quotaTotal: 100,
      lastMessage: 'Deleted 40 post(s) this run.',
    };
    const response = await web.handler(
      event('GET', '/status', { query: { s: sign({ u: '555' }) } }),
      makeDeps({ job })
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('@logan');
    expect(response.body).toContain('42');
    expect(response.body).toContain('posts older than 1 January 2024');
    expect(response.body).toContain('Deleted 40 post(s) this run.');
  });

  it('escapes job values into the page', async () => {
    const job = { userId: '555', username: '<script>x</script>', state: 'active', mode: 'all' };
    const response = await web.handler(
      event('GET', '/status', { query: { s: sign({ u: '555' }) } }),
      makeDeps({ job })
    );

    expect(response.body).not.toContain('<script>x</script>');
    expect(response.body).toContain('&lt;script&gt;');
  });

  it('refuses a request with no link at all', async () => {
    const response = await web.handler(event('GET', '/status'), makeDeps());
    expect(response.statusCode).toBe(404);
  });

  it('treats a signed link to an erased job as invalid', async () => {
    const response = await web.handler(event('GET', '/status', { query: { s: sign({ u: '555' }) } }), makeDeps());
    expect(response.statusCode).toBe(404);
  });

  it('shows the last error, escaped', async () => {
    const job = { userId: '555', state: 'active', mode: 'all', lastError: 'Invalid <token>' };
    const response = await web.handler(
      event('GET', '/status', { query: { s: sign({ u: '555' }) } }),
      makeDeps({ job })
    );

    expect(response.body).toContain('Last error');
    expect(response.body).toContain('Invalid &lt;token&gt;');
  });

  it('shows the error page when the store fails, rather than a bare 500', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const deps = makeDeps();
    deps.store.getJob.mockRejectedValue(new Error('The provisioned throughput for the table was exceeded.'));

    const response = await web.handler(event('GET', '/status', { query: { s: sign({ u: '555' }) } }), deps);

    expect(response.statusCode).toBe(500);
    expect(response.body).toContain('Something went wrong: The provisioned throughput for the table was exceeded.');
  });
});

describe('job controls', () => {
  it('pauses a job', async () => {
    const deps = makeDeps({ job: { userId: '555', state: 'active', mode: 'all' } });
    const response = await web.handler(
      event('POST', '/pause', { body: { s: sign({ u: '555' }) } }),
      deps
    );

    expect(deps.store.updateJob).toHaveBeenCalledWith('555', expect.objectContaining({ state: 'paused' }));
    expect(response.statusCode).toBe(302);
  });

  it('resumes a job', async () => {
    const deps = makeDeps({ job: { userId: '555', state: 'paused', mode: 'all' } });
    await web.handler(event('POST', '/resume', { body: { s: sign({ u: '555' }) } }), deps);

    expect(deps.store.updateJob).toHaveBeenCalledWith('555', expect.objectContaining({ state: 'active' }));
  });

  it('forgets a job and its token', async () => {
    const deps = makeDeps({ job: { userId: '555', state: 'active', mode: 'all' } });
    const response = await web.handler(
      event('POST', '/forget', { body: { s: sign({ u: '555' }) } }),
      deps
    );

    expect(deps.store.deleteJob).toHaveBeenCalledWith('555');
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('token erased');
  });

  it('refuses controls without a valid token', async () => {
    const deps = makeDeps();
    const response = await web.handler(event('POST', '/pause', { body: { s: 'bad' } }), deps);

    expect(response.statusCode).toBe(404);
    expect(deps.store.updateJob).not.toHaveBeenCalled();
  });
});

describe('unknown routes', () => {
  it('returns 404', async () => {
    const response = await web.handler(event('GET', '/nope'), makeDeps());
    expect(response.statusCode).toBe(404);
  });
});

describe('status actions follow the state', () => {
  const statusFor = async (job) =>
    (await web.handler(event('GET', '/status', { query: { s: sign({ u: '555' }) } }), makeDeps({ job }))).body;

  it('offers a way to go live after a dry run, and no re-check', async () => {
    const body = await statusFor({ userId: '555', state: 'previewed', mode: 'all', dryRun: true });
    expect(body).toContain('/go-live');
    expect(body).toContain('Delete these for real');
    expect(body).not.toContain('action="/run"');
  });

  it('never offers a manual batch, because passes are automatic and quota-bound', async () => {
    const live = await statusFor({ userId: '555', state: 'active', mode: 'all', dryRun: false, quotaUsed: 0, quotaTotal: 100 });
    expect(live).not.toContain('action="/run"');
    expect(live).toContain('repeats on its own');
  });

  it('offers nothing to run once finished', async () => {
    const body = await statusFor({ userId: '555', state: 'done', mode: 'all' });
    expect(body).not.toContain('action="/run"');
    expect(body).not.toContain('/go-live');
    expect(body).toContain('/forget');
  });
});

describe('POST /go-live', () => {
  it('clears dry run, reactivates and starts a run', async () => {
    const deps = makeDeps({ job: { userId: '555', state: 'previewed', mode: 'all', dryRun: true } });
    const response = await web.handler(
      event('POST', '/go-live', { body: { s: sign({ u: '555' }) } }),
      deps
    );

    expect(deps.store.updateJob).toHaveBeenCalledWith('555', expect.objectContaining({
      dryRun: false,
      state: 'active',
    }));
    expect(deps.runNow).toHaveBeenCalledWith('555');
    expect(response.statusCode).toBe(302);
  });

  it('drops the preview sample, and the post text in it', async () => {
    const deps = makeDeps({
      job: { userId: '555', state: 'previewed', mode: 'all', dryRun: true, preview: [{ id: '1', text: 'hello' }] },
    });
    await web.handler(event('POST', '/go-live', { body: { s: sign({ u: '555' }) } }), deps);

    expect(deps.store.updateJob).toHaveBeenCalledWith('555', expect.objectContaining({ preview: [] }));
  });

  it('refuses without a valid token', async () => {
    const deps = makeDeps();
    const response = await web.handler(event('POST', '/go-live', { body: { s: 'bad' } }), deps);
    expect(response.statusCode).toBe(404);
    expect(deps.store.updateJob).not.toHaveBeenCalled();
  });
});

describe('reconnecting over an existing job', () => {
  const connect = async (existing, dryRun) => {
    const deps = makeDeps({ job: existing });
    await web.handler(callbackEvent({ mode: 'all', targets: ['posts'], dryRun }), deps);
    return deps.store.putJob.mock.calls[0][0];
  };

  it('reports what earlier runs already deleted', async () => {
    const stored = await connect({ userId: '555', mode: 'all', targets: ['posts'], deletedCount: 40, dryRun: false }, true);
    expect(stored.lastMessage).toMatch(/already deleted 40/);
  });

  it('says plainly when a preview pauses a live run', async () => {
    const stored = await connect({ userId: '555', mode: 'all', targets: ['posts'], deletedCount: 40, dryRun: false }, true);
    expect(stored.lastMessage).toMatch(/live run .* now paused/i);
  });

  it('starts from zero when the filters describe a different job', async () => {
    const deps = makeDeps({
      job: {
        userId: '555', mode: 'all', targets: ['posts'],
        deletedCount: 60, skippedCount: 2, skipIds: ['x'], createdAt: 1,
      },
    });
    await web.handler(
      callbackEvent({ mode: 'older_than', cutoffIso: '2026-03-01T00:00:00.000Z', targets: ['posts', 'replies'] }),
      deps
    );

    const stored = deps.store.putJob.mock.calls[0][0];
    expect(stored).toMatchObject({ deletedCount: 0, skippedCount: 0, skipIds: [] });
    expect(stored.lastMessage).not.toMatch(/already deleted/);
  });

  it('keeps the message clean for a brand new job', async () => {
    const stored = await connect(null, true);
    expect(stored.lastMessage).not.toMatch(/already deleted/);
    expect(stored.lastMessage).not.toMatch(/paused/);
  });

  it('does not claim a preview when going live', async () => {
    const stored = await connect({ userId: '555', mode: 'all', targets: ['posts'], deletedCount: 40, dryRun: true }, false);
    expect(stored.lastMessage).toMatch(/Deleting for real/);
    expect(stored.lastMessage).toMatch(/already deleted 40/);
  });
});

describe('preview shows what would go', () => {
  const previewJob = {
    userId: '555', state: 'previewed', mode: 'all', dryRun: true, targets: ['posts', 'replies'],
    accessToken: 'long-token',
    previewCount: 40,
    preview: [
      { id: '1', source: 'replies', timestamp: '2025-03-04T00:00:00+0000', permalink: 'https://www.threads.net/x/1' },
      { id: '2', source: 'posts', timestamp: '2025-02-01T00:00:00+0000', permalink: null },
    ],
  };
  const texts = { 1: 'a reply of mine', 2: '' };

  it('lists the matched items with dates and links', async () => {
    const body = (await web.handler(
      event('GET', '/status', { query: { s: sign({ u: '555' }) } }), makeDeps({ job: previewJob, texts })
    )).body;

    expect(body).toContain('What would be removed');
    expect(body).toContain('a reply of mine');
    expect(body).toContain('<em>no text</em>');
    expect(body).toContain('4 March 2025');
    expect(body).toContain('https://www.threads.net/x/1');
    expect(body).toContain('reply');
  });

  it('reads the text of each post live with the job token, since none is stored', async () => {
    const deps = makeDeps({ job: previewJob, texts });
    await web.handler(event('GET', '/status', { query: { s: sign({ u: '555' }) } }), deps);

    expect(deps.threads.getMedia).toHaveBeenCalledTimes(2);
    expect(deps.threads.getMedia).toHaveBeenCalledWith('1', 'long-token', { signal: expect.any(AbortSignal) });
  });

  it('still lists what would go when Threads will not return the text', async () => {
    const deps = makeDeps({ job: previewJob });
    deps.threads.getMedia.mockRejectedValue(new Error('Object with ID 1 does not exist'));

    const body = (await web.handler(event('GET', '/status', { query: { s: sign({ u: '555' }) } }), deps)).body;

    expect(body).toContain('<em>text unavailable</em>');
    expect(body).toContain('4 March 2025');
    expect(body).toContain('https://www.threads.net/x/1');
  });

  it('reads a few posts at a time rather than all at once', async () => {
    let inFlight = 0;
    let peak = 0;
    const job = { ...previewJob, preview: Array.from({ length: 30 }, (_, i) => ({ id: String(i), source: 'posts' })) };
    const deps = makeDeps({ job });
    deps.threads.getMedia.mockImplementation(async (id) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return { id, text: 'x' };
    });

    await web.handler(event('GET', '/status', { query: { s: sign({ u: '555' }) } }), deps);

    expect(deps.threads.getMedia).toHaveBeenCalledTimes(30);
    expect(peak).toBe(8);
  });

  it('says how many of the total are shown', async () => {
    const body = (await web.handler(
      event('GET', '/status', { query: { s: sign({ u: '555' }) } }), makeDeps({ job: previewJob })
    )).body;
    expect(body).toContain('A sample of 2, from 40 matches');
  });

  it('escapes post text into the list', async () => {
    const job = { ...previewJob, preview: [{ id: '1', source: 'posts', timestamp: null }] };
    const body = (await web.handler(
      event('GET', '/status', { query: { s: sign({ u: '555' }) } }), makeDeps({ job, texts: { 1: '<script>bad</script>' } })
    )).body;
    expect(body).not.toContain('<script>bad</script>');
    expect(body).toContain('&lt;script&gt;');
  });

  it('shows no list, and reads nothing from Threads, for a live job', async () => {
    const deps = makeDeps({ job: { ...previewJob, state: 'active', dryRun: false } });
    const body = (await web.handler(event('GET', '/status', { query: { s: sign({ u: '555' }) } }), deps)).body;

    expect(body).not.toContain('What would be removed');
    expect(deps.threads.getMedia).not.toHaveBeenCalled();
  });
});

describe('preview layout and paging', () => {
  const many = (n) => Array.from({ length: n }, (_, i) => ({
    id: String(i), source: i % 2 ? 'replies' : 'posts',
    timestamp: '2025-01-01T00:00:00+0000', text: 'item ' + i, permalink: 'https://x/' + i,
  }));

  const render = async (count) => (await web.handler(
    event('GET', '/status', { query: { s: sign({ u: '555' }) } }),
    makeDeps({ job: { userId: '555', state: 'previewed', mode: 'all', dryRun: true, previewCount: count, preview: many(count) } })
  )).body;

  it('widens the page so a list does not sit in a narrow column', async () => {
    const body = await render(20);
    expect(body).toContain('panel wide');
  });

  it('ships the pager markup when there are many matches', async () => {
    const body = await render(30);
    expect(body).toContain('id="pager"');
    expect(body).toContain('id="prev"');
    expect(body).toContain('id="next"');
    // Every item is rendered; the script pages through them client-side.
    expect((body.match(/data-i="/g) || []).length).toBe(30);
  });

  it('says it is a sample only when the pass found more than it kept', async () => {
    const exact = await render(5);
    expect(exact).toContain('5 matches in this pass');
    expect(exact).not.toContain('A sample of');
  });

  it('uses singular wording for a lone match', async () => {
    const body = await render(1);
    expect(body).toContain('1 match in this pass');
  });
});

describe('the job panel shows only figures that carry information', () => {
  const statusFor = async (job) =>
    (await web.handler(event('GET', '/status', { query: { s: sign({ u: '555' }) } }), makeDeps({ job }))).body;

  it('leads a dry run with what would be removed', async () => {
    const body = await statusFor({
      userId: '555', username: 'logan', state: 'previewed', mode: 'all', dryRun: true,
      previewCount: 60, deletedCount: 0, skippedCount: 0,
    });
    expect(body).toContain('would be removed');
    expect(body).toContain('60');
    expect(body).toContain('@logan');
  });

  it('hides a zero deleted count on a dry run that has removed nothing', async () => {
    const body = await statusFor({
      userId: '555', state: 'previewed', mode: 'all', dryRun: true,
      previewCount: 60, deletedCount: 0, skippedCount: 0,
    });
    expect(body).not.toContain('deleted so far');
  });

  it('still shows the deleted count on a live job, even at zero', async () => {
    const body = await statusFor({
      userId: '555', state: 'active', mode: 'all', dryRun: false, deletedCount: 0,
    });
    expect(body).toContain('deleted so far');
  });

  it('keeps the deleted count on a preview once earlier runs removed things', async () => {
    const body = await statusFor({
      userId: '555', state: 'previewed', mode: 'all', dryRun: true,
      previewCount: 5, deletedCount: 40,
    });
    expect(body).toContain('deleted by earlier runs');
    expect(body).not.toContain('deleted so far');
    expect(body).toContain('40');
  });

  it('says what it is waiting on when the allowance is spent', async () => {
    const body = await statusFor({
      userId: '555', state: 'active', mode: 'all', dryRun: false,
      deletedCount: 60, quotaUsed: 100, quotaTotal: 100,
    });
    expect(body).toContain('Waiting on the allowance');
    expect(body).not.toContain('Next pass');
    expect(body).toMatch(/returns gradually rather than all at once/);
  });

  it('promises the next pass while there is still allowance to spend', async () => {
    const body = await statusFor({
      userId: '555', state: 'active', mode: 'all', dryRun: false,
      deletedCount: 60, quotaUsed: 40, quotaTotal: 100,
    });
    expect(body).toContain('Next pass');
    expect(body).not.toContain('Waiting on the allowance');
  });

  it('mentions refusals only when there have been some', async () => {
    const none = await statusFor({ userId: '555', state: 'active', mode: 'all', dryRun: false, skippedCount: 0 });
    expect(none).not.toContain('the API would not remove');

    const some = await statusFor({ userId: '555', state: 'active', mode: 'all', dryRun: false, skippedCount: 3 });
    expect(some).toContain('the API would not remove');
  });

  it('does not repeat the run type that the heading already states', async () => {
    const body = await statusFor({
      userId: '555', state: 'previewed', mode: 'all', dryRun: true, previewCount: 1,
    });
    expect(body).not.toContain('Dry run, nothing is removed');
  });

  it('states when it last checked', async () => {
    const body = await statusFor({
      userId: '555', state: 'active', mode: 'all', dryRun: false, lastRunAt: NOW - 3 * 60000,
    });
    expect(body).toContain('Checked 3 minutes ago');
  });

  it('sizes a preview in days at the daily allowance', async () => {
    const body = await statusFor({
      userId: '555', state: 'previewed', mode: 'all', dryRun: true, previewCount: 1234,
    });
    expect(body).toContain('<b>1,234</b><span>would be removed</span>');
    expect(body).toContain('<b>13</b><span>days at 100 a day</span>');
  });

  it('calls a preview that stopped at its page limit a floor, not a total', async () => {
    const body = await statusFor({
      userId: '555', state: 'previewed', mode: 'all', dryRun: true, previewCount: 1000, previewPartial: true,
    });
    expect(body).toContain('<b>1,000</b><span>matched before the scan stopped</span>');
    expect(body).toContain('<b>10</b><span>days at 100 a day, at least</span>');
  });
});

describe('where the actions sit', () => {
  const statusFor = async (job) =>
    (await web.handler(event('GET', '/status', { query: { s: sign({ u: '555' }) } }), makeDeps({ job }))).body;

  const previewed = {
    userId: '555', state: 'previewed', mode: 'all', dryRun: true, previewCount: 2,
    preview: [
      { id: '1', source: 'posts', timestamp: '2025-01-01T00:00:00+0000', text: 'a' },
      { id: '2', source: 'replies', timestamp: '2025-01-02T00:00:00+0000', text: 'b' },
    ],
  };

  it('puts the primary action inside the panel it acts on', async () => {
    const body = await statusFor(previewed);
    const previewPanel = body.slice(body.indexOf('What would be removed'), body.indexOf('class="tail"'));
    expect(previewPanel).toContain('/go-live');
  });

  it('keeps erasing the token away from the job controls', async () => {
    const body = await statusFor(previewed);
    const tail = body.slice(body.indexOf('class="tail"'));
    expect(tail).toContain('/forget');
    expect(tail).not.toContain('/go-live');
  });

  it('falls back to the job panel when there is no preview to attach to', async () => {
    const body = await statusFor({ userId: '555', state: 'previewed', mode: 'all', dryRun: true });
    expect(body).toContain('/go-live');
    expect(body).not.toContain('What would be removed');
  });

  it('keeps job controls with the job', async () => {
    const body = await statusFor({
      userId: '555', state: 'active', mode: 'all', dryRun: false, quotaUsed: 40, quotaTotal: 100,
    });
    const jobPanel = body.slice(body.indexOf('This job'), body.indexOf('class="tail"'));
    expect(jobPanel).toContain('/pause');
  });
});

describe('each state explains itself', () => {
  const statusFor = async (job) =>
    (await web.handler(event('GET', '/status', { query: { s: sign({ u: '555' }) } }), makeDeps({ job }))).body;

  it('tells a paused job how to carry on, and offers resume instead of pause', async () => {
    const body = await statusFor({ userId: '555', state: 'paused', mode: 'all' });
    expect(body).toContain('Paused until you resume it');
    expect(body).toContain('Resume when you want it to carry on.');
    expect(body).toContain('action="/resume"');
    expect(body).not.toContain('action="/pause"');
  });

  it('tells a stopped job to reconnect, with nothing to pause or resume', async () => {
    const body = await statusFor({ userId: '555', state: 'error', mode: 'all' });
    expect(body).toContain('Stopped after an error');
    expect(body).toContain('Connect again to retry.');
    expect(body).not.toMatch(/action="\/(pause|resume)"/);
  });

  it('names a state it does not know rather than failing', async () => {
    const body = await statusFor({ userId: '555', state: 'archived', mode: 'all' });
    expect(body).toContain('<h1>archived</h1>');
    expect(body).not.toContain('<span class="state');
  });
});

describe('deployment configuration', () => {
  const config = require('../src/config.js');
  const saved = { ...config };
  const start = () => event('POST', '/start', { body: { mode: 'all', confirm: 'yes', includePosts: 'yes' } });

  afterEach(() => {
    Object.assign(config, saved);
  });

  it('switches connecting off, and says why, without app credentials', async () => {
    config.appId = '';

    const page = await web.handler(event('GET', '/'), makeDeps());
    expect(page.body).toContain('Not configured');
    expect(page.body).toContain('<button type="submit" disabled>');

    const response = await web.handler(start(), makeDeps());
    expect(response.statusCode).toBe(503);
  });

  it('uses REDIRECT_URI for both the authorise and token calls, which Meta needs to match', async () => {
    config.redirectUri = 'https://threads.han.life/callback';
    const deps = makeDeps();

    await web.handler(start(), deps);
    await web.handler(callbackEvent({ mode: 'all' }), deps);

    expect(deps.threads.authorizeUrl.mock.calls[0][1]).toBe('https://threads.han.life/callback');
    expect(deps.threads.exchangeCode).toHaveBeenCalledWith('c', 'https://threads.han.life/callback');
  });

  it('shows an error page when it cannot work out its own callback URL', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await web.handler({ ...start(), headers: {} }, makeDeps());

    expect(response.statusCode).toBe(500);
    expect(response.body).toContain('cannot determine the callback URL');
  });
});

describe('describeJob', () => {
  it('names what a job covers in words', () => {
    expect(web.describeJob({ targets: ['replies'] })).toBe('replies');
    expect(web.describeJob({ targets: ['posts', 'replies'], keyword: 'crypto' }))
      .toBe('posts and replies containing "crypto"');
    expect(web.describeJob({ mode: 'older_than', cutoffIso: '2026-03-01T00:00:00.000Z' }))
      .toBe('posts older than 1 March 2026');
  });
});

describe('sinceText', () => {
  it('reads naturally from seconds to hours', () => {
    const ago = (ms) => web.sinceText(NOW - ms, NOW);
    expect(web.sinceText(null, NOW)).toBe('not yet');
    expect(ago(20 * 1000)).toBe('just now');
    expect(ago(60 * 1000)).toBe('1 minute ago');
    expect(ago(45 * 60 * 1000)).toBe('45 minutes ago');
    expect(ago(60 * 60 * 1000)).toBe('1 hour ago');
    expect(ago(5 * 60 * 60 * 1000)).toBe('5 hours ago');
  });
});
