import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const filename = require.resolve('../src/config.js');

// config.js reads the environment once, when it is first required.
const load = (env) => {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  delete require.cache[filename];
  return require(filename);
};

afterEach(() => {
  vi.unstubAllEnvs();
  delete require.cache[filename];
});

describe('config', () => {
  it('signs with the app secret when STATE_SECRET is unset, so links are never unsigned', () => {
    expect(load({ STATE_SECRET: undefined }).stateSecret).toBe('app-secret');
  });

  it('has no built-in secret to fall back to', () => {
    const config = load({ STATE_SECRET: undefined, THREADS_APP_SECRET: undefined, THREADS_APP_ID: undefined });
    expect(config.stateSecret).toBe('');
    expect(config.appSecret).toBe('');
    expect(config.appId).toBe('');
  });

  it('takes numeric limits from the environment', () => {
    const config = load({ PER_RUN_DELETE_CAP: '25', MAX_PAGES_PER_RUN: '3' });
    expect(config.perRunDeleteCap).toBe(25);
    expect(config.maxPagesPerRun).toBe(3);
  });

  it('ignores a numeric limit that is not a positive number', () => {
    // A cap of 0 would have every run declare its job done without deleting anything.
    const config = load({ PER_RUN_DELETE_CAP: '0', PAGE_SIZE: 'lots', MAX_PAGES_PER_RUN: '-2', JOB_TTL_DAYS: '' });
    expect(config.perRunDeleteCap).toBe(100);
    expect(config.pageSize).toBe(100);
    expect(config.maxPagesPerRun).toBe(10);
    expect(config.jobTtlDays).toBe(120);
  });
});
