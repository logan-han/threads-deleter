'use strict';

const crypto = require('node:crypto');

const config = require('./config.js');

// Meta signs its deauthorize and data-deletion callbacks as
// "<base64url signature>.<base64url payload>", signed with the app secret.
const parseSignedRequest = (signedRequest) => {
  if (!config.appSecret || typeof signedRequest !== 'string') return null;

  const parts = signedRequest.split('.');
  if (parts.length !== 2) return null;

  const [signature, payload] = parts;
  const expected = crypto
    .createHmac('sha256', config.appSecret)
    .update(payload)
    .digest('base64url');

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (!decoded || typeof decoded.user_id === 'undefined') return null;
  if (decoded.algorithm && String(decoded.algorithm).toUpperCase() !== 'HMAC-SHA256') return null;

  return decoded;
};

module.exports = { parseSignedRequest };
