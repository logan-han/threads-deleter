'use strict';

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  DeleteCommand,
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} = require('@aws-sdk/lib-dynamodb');

const config = require('./config.js');

let cachedClient;

const client = () => {
  if (!cachedClient) {
    cachedClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    });
  }
  return cachedClient;
};

const STATES = {
  active: 'active',
  paused: 'paused',
  done: 'done',
  previewed: 'previewed',
  error: 'error',
};

const putJob = (job) =>
  client().send(new PutCommand({ TableName: config.tableName, Item: job }));

const getJob = async (userId) => {
  const result = await client().send(
    new GetCommand({ TableName: config.tableName, Key: { userId: String(userId) } })
  );
  return result.Item || null;
};

const deleteJob = (userId) =>
  client().send(
    new DeleteCommand({ TableName: config.tableName, Key: { userId: String(userId) } })
  );

// The table only ever holds a handful of jobs, so a filtered Scan is cheaper
// than provisioning a GSI against the DynamoDB free-tier capacity budget.
const listActiveJobs = async () => {
  const items = [];
  let startKey;

  do {
    const result = await client().send(
      new ScanCommand({
        TableName: config.tableName,
        FilterExpression: '#state = :active',
        ExpressionAttributeNames: { '#state': 'state' },
        ExpressionAttributeValues: { ':active': STATES.active },
        ExclusiveStartKey: startKey,
      })
    );
    items.push(...(result.Items || []));
    startKey = result.LastEvaluatedKey;
  } while (startKey);

  return items;
};

const updateJob = async (userId, patch) => {
  const keys = Object.keys(patch);
  if (keys.length === 0) return null;

  const names = {};
  const values = {};
  const sets = [];

  keys.forEach((key, index) => {
    const nameRef = `#k${index}`;
    const valueRef = `:v${index}`;
    names[nameRef] = key;
    values[valueRef] = patch[key];
    sets.push(`${nameRef} = ${valueRef}`);
  });

  const result = await client().send(
    new UpdateCommand({
      TableName: config.tableName,
      Key: { userId: String(userId) },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW',
    })
  );

  return result.Attributes;
};

module.exports = { STATES, deleteJob, getJob, listActiveJobs, putJob, updateJob };
