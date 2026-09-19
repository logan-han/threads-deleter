import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// src/ is CommonJS and pulls the AWS SDK in at require time. Vitest does not
// rewrite CJS requires, so vi.mock never sees it; seeding Node's own require
// cache with stand-ins before the module is first required does intercept it,
// and keeps the store free of a seam that exists only for tests.
const require = createRequire(import.meta.url);

const send = vi.fn();

class FakeCommand {
  constructor(input) {
    this.input = input;
  }
}
class PutCommand extends FakeCommand {}
class GetCommand extends FakeCommand {}
class DeleteCommand extends FakeCommand {}
class ScanCommand extends FakeCommand {}
class UpdateCommand extends FakeCommand {}

const stub = (name, exports) => {
  const filename = require.resolve(name);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};

stub('@aws-sdk/client-dynamodb', { DynamoDBClient: class {} });
stub('@aws-sdk/lib-dynamodb', {
  DynamoDBDocumentClient: { from: () => ({ send }) },
  PutCommand,
  GetCommand,
  DeleteCommand,
  ScanCommand,
  UpdateCommand,
});

const store = require('../src/store.js');

const sent = (i = 0) => send.mock.calls[i][0];

beforeEach(() => {
  send.mockReset();
  send.mockResolvedValue({});
});

describe('putJob', () => {
  it('writes the whole record to the configured table', async () => {
    await store.putJob({ userId: '7', state: 'active' });

    expect(sent()).toBeInstanceOf(PutCommand);
    expect(sent().input).toEqual({
      TableName: 'threads-deleter-test',
      Item: { userId: '7', state: 'active' },
    });
  });
});

describe('getJob', () => {
  it('returns the stored item', async () => {
    send.mockResolvedValue({ Item: { userId: '7', state: 'paused' } });
    await expect(store.getJob('7')).resolves.toEqual({ userId: '7', state: 'paused' });
    expect(sent()).toBeInstanceOf(GetCommand);
    expect(sent().input.Key).toEqual({ userId: '7' });
  });

  it('returns null rather than undefined when there is no job', async () => {
    send.mockResolvedValue({});
    await expect(store.getJob('7')).resolves.toBeNull();
  });

  it('keys on a string even when given a number', async () => {
    send.mockResolvedValue({});
    await store.getJob(7);
    expect(sent().input.Key).toEqual({ userId: '7' });
  });
});

describe('deleteJob', () => {
  it('deletes by user id', async () => {
    await store.deleteJob(7);
    expect(sent()).toBeInstanceOf(DeleteCommand);
    expect(sent().input.Key).toEqual({ userId: '7' });
  });
});

describe('listActiveJobs', () => {
  it('filters on the active state', async () => {
    send.mockResolvedValue({ Items: [{ userId: '1' }] });
    await store.listActiveJobs();

    expect(sent()).toBeInstanceOf(ScanCommand);
    expect(sent().input.FilterExpression).toBe('#state = :active');
    expect(sent().input.ExpressionAttributeNames).toEqual({ '#state': 'state' });
    expect(sent().input.ExpressionAttributeValues).toEqual({ ':active': 'active' });
  });

  it('follows the pagination key until the scan is complete', async () => {
    send
      .mockResolvedValueOnce({ Items: [{ userId: '1' }], LastEvaluatedKey: { userId: '1' } })
      .mockResolvedValueOnce({ Items: [{ userId: '2' }], LastEvaluatedKey: { userId: '2' } })
      .mockResolvedValueOnce({ Items: [{ userId: '3' }] });

    await expect(store.listActiveJobs()).resolves.toEqual([
      { userId: '1' }, { userId: '2' }, { userId: '3' },
    ]);
    expect(send).toHaveBeenCalledTimes(3);
    expect(sent(0).input.ExclusiveStartKey).toBeUndefined();
    expect(sent(1).input.ExclusiveStartKey).toEqual({ userId: '1' });
    expect(sent(2).input.ExclusiveStartKey).toEqual({ userId: '2' });
  });

  it('copes with a page that carries no items', async () => {
    send.mockResolvedValue({});
    await expect(store.listActiveJobs()).resolves.toEqual([]);
  });
});

describe('updateJob', () => {
  it('builds a SET expression with placeholders, so a reserved word like "state" is safe', async () => {
    send.mockResolvedValue({ Attributes: { userId: '7', state: 'done' } });
    const result = await store.updateJob('7', { state: 'done', deletedCount: 12 });

    expect(sent()).toBeInstanceOf(UpdateCommand);
    expect(sent().input.UpdateExpression).toBe('SET #k0 = :v0, #k1 = :v1');
    expect(sent().input.ExpressionAttributeNames).toEqual({ '#k0': 'state', '#k1': 'deletedCount' });
    expect(sent().input.ExpressionAttributeValues).toEqual({ ':v0': 'done', ':v1': 12 });
    expect(sent().input.ReturnValues).toBe('ALL_NEW');
    expect(result).toEqual({ userId: '7', state: 'done' });
  });

  it('writes nothing at all for an empty patch', async () => {
    await expect(store.updateJob('7', {})).resolves.toBeNull();
    expect(send).not.toHaveBeenCalled();
  });
});
