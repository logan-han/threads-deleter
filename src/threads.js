'use strict';

const config = require('./config.js');

class ThreadsApiError extends Error {
  constructor(message, { status, body, endpoint }) {
    super(message);
    this.name = 'ThreadsApiError';
    this.status = status;
    this.body = body;
    this.endpoint = endpoint;
  }

  // Meta returns 429 for quota exhaustion; 4 and 613 are its rate-limit codes.
  get isRateLimit() {
    const code = this.body && this.body.error && this.body.error.code;
    return this.status === 429 || code === 4 || code === 613;
  }

  // A scope the app or the token does not hold. Worth reporting plainly rather
  // than retrying, because only re-authorising fixes it.
  get isPermission() {
    const code = this.body && this.body.error && this.body.error.code;
    return /permission/i.test(this.message || '') || code === 10 || code === 200;
  }

  // A permanently undeletable post (wrong media type, already gone) must be
  // skipped rather than retried forever.
  get isPermanent() {
    return this.status >= 400 && this.status < 500 && !this.isRateLimit;
  }
}

const parse = async (response) => {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
};

const request = async (endpoint, { method = 'GET', body, query, signal } = {}) => {
  const url = new URL(endpoint);
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  const init = { method, signal };
  if (body) {
    init.body = new URLSearchParams(body);
  }

  const response = await fetch(url, init);
  const payload = await parse(response);

  if (!response.ok) {
    const message =
      (payload.error && payload.error.message) ||
      payload.error_message ||
      `Threads API ${method} ${url.pathname} failed with ${response.status}`;
    throw new ThreadsApiError(message, {
      status: response.status,
      body: payload,
      endpoint: url.pathname,
    });
  }

  return payload;
};

// Step 1 of the OAuth flow: authorisation-code -> short-lived (1 hour) token.
// redirect_uri must be byte-identical to the one used for the authorise call.
const exchangeCode = (code, redirectUri) =>
  request(`${config.graphHost}/oauth/access_token`, {
    method: 'POST',
    body: {
      client_id: config.appId,
      client_secret: config.appSecret,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      code,
    },
  });

// Step 2: short-lived -> long-lived (60 day) token.
const exchangeLongLived = (shortLivedToken) =>
  request(`${config.graphHost}/access_token`, {
    query: {
      grant_type: 'th_exchange_token',
      client_secret: config.appSecret,
      access_token: shortLivedToken,
    },
  });

// Valid once the token is at least 24h old and not yet expired.
const refreshLongLived = (token) =>
  request(`${config.graphHost}/refresh_access_token`, {
    query: { grant_type: 'th_refresh_token', access_token: token },
  });

const getMe = (token) =>
  request(`${config.graphHost}/v1.0/me`, {
    query: { fields: 'id,username', access_token: token },
  });

// Meta exposes the live deletion quota, so the worker never has to guess.
const getDeleteQuota = async (userId, token) => {
  const payload = await request(`${config.graphHost}/v1.0/${userId}/threads_publishing_limit`, {
    query: { fields: 'delete_quota_usage,delete_config', access_token: token },
  });

  const entry = (payload.data && payload.data[0]) || {};
  const used = Number(entry.delete_quota_usage || 0);
  const total = Number((entry.delete_config && entry.delete_config.quota_total) || 0) || 100;

  return { used, total, remaining: Math.max(0, total - used) };
};

// Top-level posts and replies are separate collections with identical shapes
// and query parameters, so one reader serves both.
const SOURCE_PATHS = { posts: 'threads', replies: 'replies' };

const listMedia = ({ userId, token, source = 'posts', limit = config.pageSize, until, after }) => {
  const path = SOURCE_PATHS[source];
  if (!path) throw new Error(`unknown media source: ${source}`);

  return request(`${config.graphHost}/v1.0/${userId}/${path}`, {
    query: {
      fields: 'id,timestamp,media_type,text,permalink',
      limit,
      until,
      after,
      access_token: token,
    },
  });
};

const listPosts = (args) => listMedia({ ...args, source: 'posts' });
const listReplies = (args) => listMedia({ ...args, source: 'replies' });

const deletePost = (mediaId, token) =>
  request(`${config.graphHost}/v1.0/${mediaId}`, {
    method: 'DELETE',
    query: { access_token: token },
  });

// Reads one post's text live, so a preview never has to store it.
const getMedia = (mediaId, token, { signal } = {}) =>
  request(`${config.graphHost}/v1.0/${mediaId}`, {
    query: { fields: 'text', access_token: token },
    signal,
  });

const authorizeUrl = (state, redirectUri) => {
  const url = new URL(`${config.authHost}/oauth/authorize`);
  url.searchParams.set('client_id', config.appId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', config.scope);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  return url.toString();
};

module.exports = {
  ThreadsApiError,
  authorizeUrl,
  deletePost,
  exchangeCode,
  exchangeLongLived,
  getDeleteQuota,
  getMe,
  getMedia,
  listMedia,
  listPosts,
  listReplies,
  refreshLongLived,
};
