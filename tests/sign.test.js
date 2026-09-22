import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { sign, verify } = require('../src/sign.js');
const config = require('../src/config.js');

const original = config.stateSecret;

const b64 = (text) => Buffer.from(text).toString('base64url');
const tokenFor = (body, secret = original) =>
  `${body}.${crypto.createHmac('sha256', secret).update(body).digest('base64url')}`;

afterEach(() => {
  config.stateSecret = original;
});

describe('sign', () => {
  it('round-trips a payload', () => {
    const token = sign({ u: '123', mode: 'all' });
    expect(verify(token)).toEqual({ u: '123', mode: 'all' });
  });

  it('rejects a tampered signature', () => {
    const token = sign({ u: '123' });
    expect(verify(`${token.slice(0, -1)}x`)).toBeNull();
  });

  it('rejects a tampered payload', () => {
    const token = sign({ u: '123' });
    const [, mac] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ u: '999' })).toString('base64url');
    expect(verify(`${forged}.${mac}`)).toBeNull();
  });

  it('rejects malformed input', () => {
    expect(verify('')).toBeNull();
    expect(verify('nodot')).toBeNull();
    expect(verify(undefined)).toBeNull();
  });

  it('rejects a correctly signed body that is not JSON', () => {
    expect(verify(tokenFor(b64('not json')))).toBeNull();
  });

  it('refuses to sign or verify without a secret, since anyone can sign with an empty key', () => {
    config.stateSecret = '';

    expect(() => sign({ u: '123' })).toThrow('STATE_SECRET is not configured');
    expect(verify(tokenFor(b64(JSON.stringify({ u: '123' })), ''))).toBeNull();
  });
});
