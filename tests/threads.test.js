import { afterEach, describe, expect, it, vi } from 'vitest';
import threads from '../src/threads.js';

const mockFetch = (status, payload) => {
  const spy = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
  });
  global.fetch = spy;
  return spy;
};

afterEach(() => {
  vi.restoreAllMocks();
  delete global.fetch;
});

describe('authorizeUrl', () => {
  it('includes the app id, scope, state and the given redirect', () => {
    const url = new URL(threads.authorizeUrl('signed-state', 'https://example.test/callback'));
    expect(url.origin + url.pathname).toBe('https://threads.net/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('app-id');
    expect(url.searchParams.get('redirect_uri')).toBe('https://example.test/callback');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('state')).toBe('signed-state');
    expect(url.searchParams.get('scope')).toContain('threads_delete');
  });
});

describe('exchangeCode', () => {
  it('posts the code with the same redirect uri', async () => {
    const spy = mockFetch(200, { access_token: 'short', user_id: 42 });
    const result = await threads.exchangeCode('the-code', 'https://example.test/callback');

    expect(result.access_token).toBe('short');
    const [url, init] = spy.mock.calls[0];
    expect(url.toString()).toBe('https://graph.threads.net/oauth/access_token');
    expect(init.method).toBe('POST');
    const body = Object.fromEntries(init.body);
    expect(body).toMatchObject({
      client_id: 'app-id',
      client_secret: 'app-secret',
      grant_type: 'authorization_code',
      redirect_uri: 'https://example.test/callback',
      code: 'the-code',
    });
  });
});

describe('getDeleteQuota', () => {
  it('derives the remaining allowance', async () => {
    mockFetch(200, { data: [{ delete_quota_usage: 73, delete_config: { quota_total: 100 } }] });
    await expect(threads.getDeleteQuota('1', 'token')).resolves.toEqual({
      used: 73,
      total: 100,
      remaining: 27,
    });
  });

  it('never reports a negative allowance', async () => {
    mockFetch(200, { data: [{ delete_quota_usage: 120, delete_config: { quota_total: 100 } }] });
    await expect(threads.getDeleteQuota('1', 'token')).resolves.toMatchObject({ remaining: 0 });
  });

  it('falls back to the documented cap when config is absent', async () => {
    mockFetch(200, { data: [{ delete_quota_usage: 1 }] });
    await expect(threads.getDeleteQuota('1', 'token')).resolves.toMatchObject({
      total: 100,
      remaining: 99,
    });
  });
});

describe('listPosts', () => {
  it('passes the paging and until filters through', async () => {
    const spy = mockFetch(200, { data: [] });
    await threads.listPosts({ userId: '7', token: 'tok', limit: 50, until: 1700000000, after: 'cur' });

    const url = new URL(spy.mock.calls[0][0]);
    expect(url.pathname).toBe('/v1.0/7/threads');
    expect(url.searchParams.get('limit')).toBe('50');
    expect(url.searchParams.get('until')).toBe('1700000000');
    expect(url.searchParams.get('after')).toBe('cur');
  });

  it('omits empty optional filters', async () => {
    const spy = mockFetch(200, { data: [] });
    await threads.listPosts({ userId: '7', token: 'tok' });

    const url = new URL(spy.mock.calls[0][0]);
    expect(url.searchParams.has('until')).toBe(false);
    expect(url.searchParams.has('after')).toBe(false);
  });
});

describe('deletePost', () => {
  it('issues a DELETE against the media id', async () => {
    const spy = mockFetch(200, { success: true, deleted_id: '99' });
    await threads.deletePost('99', 'tok');

    const [url, init] = spy.mock.calls[0];
    expect(new URL(url).pathname).toBe('/v1.0/99');
    expect(init.method).toBe('DELETE');
  });
});

describe('exchangeLongLived', () => {
  it('trades the short-lived token for a 60-day one', async () => {
    const spy = mockFetch(200, { access_token: 'long', expires_in: 5183944 });
    const result = await threads.exchangeLongLived('short');

    expect(result.access_token).toBe('long');
    const url = new URL(spy.mock.calls[0][0]);
    expect(url.pathname).toBe('/access_token');
    expect(url.searchParams.get('grant_type')).toBe('th_exchange_token');
    expect(url.searchParams.get('access_token')).toBe('short');
    expect(url.searchParams.get('client_secret')).toBe('app-secret');
  });
});

describe('refreshLongLived', () => {
  it('extends a token that is already long-lived', async () => {
    const spy = mockFetch(200, { access_token: 'fresher', expires_in: 5183944 });
    await threads.refreshLongLived('stale');

    const url = new URL(spy.mock.calls[0][0]);
    expect(url.pathname).toBe('/refresh_access_token');
    expect(url.searchParams.get('grant_type')).toBe('th_refresh_token');
    expect(url.searchParams.get('access_token')).toBe('stale');
  });
});

describe('getMe', () => {
  it('asks for the id and username only', async () => {
    const spy = mockFetch(200, { id: '555', username: 'logan' });
    await expect(threads.getMe('tok')).resolves.toEqual({ id: '555', username: 'logan' });

    const url = new URL(spy.mock.calls[0][0]);
    expect(url.pathname).toBe('/v1.0/me');
    expect(url.searchParams.get('fields')).toBe('id,username');
  });
});

describe('listReplies', () => {
  it('reads the replies collection, which is separate from posts', async () => {
    const spy = mockFetch(200, { data: [] });
    await threads.listReplies({ userId: '555', token: 'tok' });

    expect(new URL(spy.mock.calls[0][0]).pathname).toBe('/v1.0/555/replies');
  });
});

describe('listMedia', () => {
  it('refuses a source it does not know, rather than building a bad URL', () => {
    expect(() => threads.listMedia({ userId: '555', token: 'tok', source: 'stories' }))
      .toThrow(/unknown media source: stories/);
  });

  it('leaves empty paging parameters out of the query', async () => {
    const spy = mockFetch(200, { data: [] });
    await threads.listMedia({ userId: '555', token: 'tok', until: undefined, after: undefined });

    const url = new URL(spy.mock.calls[0][0]);
    expect(url.searchParams.has('until')).toBe(false);
    expect(url.searchParams.has('after')).toBe(false);
  });

  it('passes the cutoff and cursor through when they are set', async () => {
    const spy = mockFetch(200, { data: [] });
    await threads.listMedia({ userId: '555', token: 'tok', until: 1740787200, after: 'cursor' });

    const url = new URL(spy.mock.calls[0][0]);
    expect(url.searchParams.get('until')).toBe('1740787200');
    expect(url.searchParams.get('after')).toBe('cursor');
  });
});

describe('a response that is not what the API promised', () => {
  it('surfaces a non-JSON error body instead of throwing a parse error', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false, status: 502, text: async () => '<html>bad gateway</html>',
    });

    const error = await threads.getMe('tok').catch((e) => e);
    expect(error.name).toBe('ThreadsApiError');
    expect(error.status).toBe(502);
    expect(error.body).toEqual({ raw: '<html>bad gateway</html>' });
    expect(error.message).toMatch(/failed with 502/);
  });

  it('treats an empty body as an empty object', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' });
    await expect(threads.getMe('tok')).resolves.toEqual({});
  });

  it('prefers the API error message over the generic one', async () => {
    mockFetch(400, { error: { message: 'Application does not have permission' } });
    const error = await threads.getMe('tok').catch((e) => e);
    expect(error.message).toBe('Application does not have permission');
  });
});

describe('ThreadsApiError', () => {
  it('classifies a 429 as a rate limit', async () => {
    mockFetch(429, { error: { message: 'too many' } });
    const error = await threads.deletePost('1', 'tok').catch((e) => e);
    expect(error.isRateLimit).toBe(true);
    expect(error.isPermanent).toBe(false);
  });

  it('classifies Meta error code 4 as a rate limit', async () => {
    mockFetch(400, { error: { message: 'throttled', code: 4 } });
    const error = await threads.deletePost('1', 'tok').catch((e) => e);
    expect(error.isRateLimit).toBe(true);
  });

  it('classifies an unsupported media type as permanent', async () => {
    mockFetch(400, { error: { message: 'Media type is not supported', code: -1 } });
    const error = await threads.deletePost('1', 'tok').catch((e) => e);
    expect(error.isPermanent).toBe(true);
    expect(error.isRateLimit).toBe(false);
  });

  it('classifies a missing scope as a permission problem, not a retryable one', async () => {
    mockFetch(400, { error: { message: 'Application does not have permission for this action' } });
    const error = await threads.getMe('tok').catch((e) => e);
    expect(error.isPermission).toBe(true);
  });

  it('classifies Meta error code 10 and 200 as permission problems', async () => {
    mockFetch(403, { error: { message: 'nope', code: 10 } });
    expect((await threads.getMe('tok').catch((e) => e)).isPermission).toBe(true);

    mockFetch(403, { error: { message: 'nope', code: 200 } });
    expect((await threads.getMe('tok').catch((e) => e)).isPermission).toBe(true);
  });

  it('does not call an ordinary failure a permission problem', async () => {
    mockFetch(400, { error: { message: 'Media type is not supported', code: -1 } });
    expect((await threads.getMe('tok').catch((e) => e)).isPermission).toBe(false);
  });

  it('does not treat a 500 as permanent', async () => {
    mockFetch(500, { error: { message: 'oops' } });
    const error = await threads.deletePost('1', 'tok').catch((e) => e);
    expect(error.isPermanent).toBe(false);
  });
});
