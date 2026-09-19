import crypto from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import web from '../src/web.js';
import signedRequestModule from '../src/signed-request.js';

const { parseSignedRequest } = signedRequestModule;
const APP_SECRET = 'app-secret';

const signedRequest = (payload, secret = APP_SECRET) => {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${sig}.${body}`;
};

const event = (method, path, { body } = {}) => ({
  rawPath: path,
  requestContext: { http: { method } },
  headers: { host: 'threads.han.life' },
  body: body ? new URLSearchParams(body).toString() : undefined,
  isBase64Encoded: false,
});

const makeDeps = () => ({
  now: Date.UTC(2026, 8, 17),
  store: {
    STATES: { active: 'active', paused: 'paused', done: 'done', previewed: 'previewed', error: 'error' },
    getJob: vi.fn(async () => null),
    putJob: vi.fn(async () => ({})),
    updateJob: vi.fn(async () => ({})),
    deleteJob: vi.fn(async () => ({})),
  },
  threads: {},
});

beforeEach(() => vi.clearAllMocks());

describe('parseSignedRequest', () => {
  it('accepts a correctly signed payload', () => {
    expect(parseSignedRequest(signedRequest({ user_id: '99', algorithm: 'HMAC-SHA256' }))).toMatchObject({
      user_id: '99',
    });
  });

  it('rejects a payload signed with the wrong secret', () => {
    expect(parseSignedRequest(signedRequest({ user_id: '99' }, 'wrong'))).toBeNull();
  });

  it('rejects a malformed value', () => {
    expect(parseSignedRequest('nodot')).toBeNull();
    expect(parseSignedRequest('')).toBeNull();
  });

  it('rejects an unexpected algorithm', () => {
    expect(parseSignedRequest(signedRequest({ user_id: '1', algorithm: 'RS256' }))).toBeNull();
  });

  it('rejects a payload with no user', () => {
    expect(parseSignedRequest(signedRequest({ nope: true }))).toBeNull();
  });
});

describe('POST /deauthorize', () => {
  it('deletes the job for a validly signed request', async () => {
    const deps = makeDeps();
    const response = await web.handler(
      event('POST', '/deauthorize', { body: { signed_request: signedRequest({ user_id: '77' }) } }),
      deps
    );

    expect(response.statusCode).toBe(200);
    expect(deps.store.deleteJob).toHaveBeenCalledWith('77');
  });

  it('refuses an unsigned request without touching the store', async () => {
    const deps = makeDeps();
    const response = await web.handler(
      event('POST', '/deauthorize', { body: { signed_request: 'forged.payload' } }),
      deps
    );

    expect(response.statusCode).toBe(400);
    expect(deps.store.deleteJob).not.toHaveBeenCalled();
  });
});

describe('POST /data-deletion', () => {
  it('deletes the job and returns a status url with a confirmation code', async () => {
    const deps = makeDeps();
    const response = await web.handler(
      event('POST', '/data-deletion', { body: { signed_request: signedRequest({ user_id: '88' }) } }),
      deps
    );

    expect(response.statusCode).toBe(200);
    expect(deps.store.deleteJob).toHaveBeenCalledWith('88');

    const payload = JSON.parse(response.body);
    expect(payload.url).toBe('https://threads.han.life/data-deletion');
    expect(payload.confirmation_code).toMatch(/^[0-9a-f]{16}$/);
  });

  it('refuses a forged request', async () => {
    const deps = makeDeps();
    const response = await web.handler(
      event('POST', '/data-deletion', { body: { signed_request: signedRequest({ user_id: '1' }, 'wrong') } }),
      deps
    );

    expect(response.statusCode).toBe(400);
    expect(deps.store.deleteJob).not.toHaveBeenCalled();
  });
});

describe('policy pages', () => {
  it.each(['/privacy', '/terms', '/data-deletion'])('serves %s', async (path) => {
    const response = await web.handler(event('GET', path), makeDeps());
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('<!doctype html>');
  });
});
