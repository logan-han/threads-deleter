'use strict';

const crypto = require('node:crypto');

const config = require('./config.js');

const b64url = (input) => Buffer.from(input).toString('base64url');

const digest = (payload) =>
  crypto.createHmac('sha256', config.stateSecret).update(payload).digest('base64url');

// Signs a small JSON payload so the OAuth state and status links need no
// server-side session storage.
const sign = (payload) => {
  if (!config.stateSecret) throw new Error('STATE_SECRET is not configured');
  const body = b64url(JSON.stringify(payload));
  return `${body}.${digest(body)}`;
};

const verify = (token) => {
  if (!config.stateSecret || typeof token !== 'string') return null;

  const separator = token.lastIndexOf('.');
  if (separator <= 0) return null;

  const body = token.slice(0, separator);
  const provided = token.slice(separator + 1);
  const expected = digest(body);

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
};

module.exports = { sign, verify };
