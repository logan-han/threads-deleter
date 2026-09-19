import { describe, expect, it } from 'vitest';
import signModule from '../src/sign.js';

const { sign, verify } = signModule;

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
});
