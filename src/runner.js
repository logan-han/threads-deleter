'use strict';

const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');

const config = require('./config.js');

let cached;
const client = () => {
  if (!cached) cached = new LambdaClient({});
  return cached;
};

// Kick the worker for one job so a newly connected account sees a result in
// seconds instead of waiting for the next scheduled pass.
const runNow = async (userId) => {
  if (!config.workerFunctionName) return false;

  try {
    await client().send(
      new InvokeCommand({
        FunctionName: config.workerFunctionName,
        InvocationType: 'Event',
        Payload: Buffer.from(JSON.stringify({ userId: String(userId) })),
      })
    );
    return true;
  } catch (error) {
    // A failed kick only costs the user a wait, so never fail their request.
    console.error(JSON.stringify({ msg: 'could not start an immediate run', error: error.message }));
    return false;
  }
};

module.exports = { runNow };
