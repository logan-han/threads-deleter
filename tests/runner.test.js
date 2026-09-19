import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Same reason as store.test.js: src/ is CommonJS, so the SDK is stubbed in
// Node's require cache rather than through vi.mock.
const require = createRequire(import.meta.url);

const send = vi.fn();

class InvokeCommand {
  constructor(input) {
    this.input = input;
  }
}

const filename = require.resolve('@aws-sdk/client-lambda');
require.cache[filename] = {
  id: filename,
  filename,
  loaded: true,
  exports: {
    LambdaClient: class {
      send(...args) {
        return send(...args);
      }
    },
    InvokeCommand,
  },
};

const runner = require('../src/runner.js');
const config = require('../src/config.js');

const original = config.workerFunctionName;

beforeEach(() => {
  send.mockReset();
  send.mockResolvedValue({});
  config.workerFunctionName = 'threads-deleter-worker';
});

afterEach(() => {
  config.workerFunctionName = original;
  vi.restoreAllMocks();
});

describe('runNow', () => {
  it('invokes the worker for one job without waiting for it', async () => {
    await expect(runner.runNow('555')).resolves.toBe(true);

    const command = send.mock.calls[0][0];
    expect(command).toBeInstanceOf(InvokeCommand);
    expect(command.input.FunctionName).toBe('threads-deleter-worker');
    expect(command.input.InvocationType).toBe('Event');
    expect(JSON.parse(Buffer.from(command.input.Payload).toString())).toEqual({ userId: '555' });
  });

  it('passes the user id as a string even when given a number', async () => {
    await runner.runNow(555);
    const payload = JSON.parse(Buffer.from(send.mock.calls[0][0].input.Payload).toString());
    expect(payload).toEqual({ userId: '555' });
  });

  it('does nothing when no worker function is configured', async () => {
    config.workerFunctionName = '';
    await expect(runner.runNow('555')).resolves.toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('swallows an invoke failure, because a missed kick only costs a wait', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    send.mockRejectedValue(new Error('lambda is unhappy'));

    await expect(runner.runNow('555')).resolves.toBe(false);
    expect(console.error).toHaveBeenCalled();
  });
});
