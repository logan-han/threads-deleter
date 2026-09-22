'use strict';

const crypto = require('node:crypto');

const config = require('./config.js');
const defaultStore = require('./store.js');
const defaultThreads = require('./threads.js');
const { render, escapeHtml } = require('./render.js');
const { sign, verify } = require('./sign.js');
const { parseSignedRequest } = require('./signed-request.js');
const { runNow } = require('./runner.js');
const { runJob } = require('./worker.js');

const DAY_MS = 24 * 60 * 60 * 1000;
const MODES = new Set(['all', 'older_than']);

const html = (body, status = 200) => ({
  statusCode: status,
  headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  body,
});

const redirect = (location) => ({
  statusCode: 302,
  headers: { location, 'cache-control': 'no-store' },
  body: '',
});

const parseForm = (event) => {
  if (!event.body) return {};
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;
  return Object.fromEntries(new URLSearchParams(raw));
};

const errorPage = (message, status = 400) =>
  html(render('error', { message }), status);

const configured = () => Boolean(config.appId && config.appSecret && config.stateSecret);

// Meta demands the same redirect_uri on both the authorise and token calls.
// Deriving it from the request host means the deployed URL needs no second
// deploy pass; REDIRECT_URI overrides it when a custom domain is in front.
const baseUrl = (event) => {
  const headers = event.headers || {};
  const host = headers.host || headers.Host;
  if (!host) throw new Error('cannot determine this deployment\'s URL');
  return `https://${host}`;
};

const redirectUriFor = (event) => {
  if (config.redirectUri) return config.redirectUri;
  const headers = event.headers || {};
  const host = headers.host || headers.Host;
  if (!host) throw new Error('cannot determine the callback URL for this request');
  return `https://${host}/callback`;
};

// The signed state proves the options came from /start, not which browser asked
// for them, so a cookie holding its nonce ties the callback to that browser.
const NONCE_COOKIE = '__Host-oauth_state';
const NONCE_MAX_AGE = 3600;

// Payload format 2.0 moves the Cookie header into event.cookies.
const readCookie = (event, name) => {
  const pairs = event.cookies || String((event.headers || {}).cookie || '').split(';');
  const prefix = `${name}=`;
  const found = pairs.map((pair) => pair.trim()).find((pair) => pair.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
};

// Browsers send Origin with a form post, so a mismatch means another site
// submitted the form and chose what would be deleted.
const fromThisSite = (event) => {
  const headers = event.headers || {};
  if (headers.origin) return headers.origin === `https://${headers.host || headers.Host}`;
  const site = headers['sec-fetch-site'];
  return !site || site === 'same-origin' || site === 'none';
};

const statusLink = (userId) => `/status?s=${encodeURIComponent(sign({ u: String(userId) }))}`;

const jobFromToken = async (event, store) => {
  const token = (event.queryStringParameters || {}).s || parseForm(event).s;
  const payload = verify(token);
  if (!payload || !payload.u) return null;
  const job = await store.getJob(payload.u);
  return job ? { job, token } : null;
};

const describeJob = (job) => {
  const targets = Array.isArray(job.targets) && job.targets.length ? job.targets : ['posts'];
  const what = targets.length === 2
    ? 'posts and replies'
    : (targets[0] === 'replies' ? 'replies' : 'posts');
  const when = job.mode === 'older_than' ? ` older than ${readableDate(job.cutoffIso)}` : '';
  const keyword = job.keyword ? ` containing "${job.keyword}"` : '';
  return `${what}${when}${keyword}`;
};

// Threads counts deletions over a rolling 24 hours rather than resetting at
// midnight, so a spent allowance comes back gradually rather than all at once.
const spentAllowance = (job) =>
  Number(job.quotaUsed || 0) >= Number(job.quotaTotal || 100);

const nextRunHint = (job) => {
  if (job.state === 'done') return 'Posts already removed stay removed.';
  if (job.state === 'previewed') {
    return 'A preview only. Nothing has been deleted and nothing will be until you say so.';
  }
  if (job.state === 'paused') return 'Resume when you want it to carry on.';
  if (job.state === 'error') return 'Connect again to retry.';
  if (spentAllowance(job)) {
    return 'Nothing can be deleted until some of the allowance comes back. Threads counts the last 24 hours, '
      + 'so it returns gradually rather than all at once, and each pass takes whatever has freed up.';
  }
  return 'This repeats on its own each day, taking whatever allowance is left, until the job is done.';
};

const handleIndex = () =>
  html(
    render('index', {
      configured: configured() ? '' : 'disabled',
      warning: configured()
        ? ''
        : '<div class="notice bad"><span class="tag">Not configured</span>'
          + '<p>This deployment has no Threads app credentials, so connecting is switched off.</p></div>',
      today: new Date().toISOString().slice(0, 10),
      todayLabel: new Date().toLocaleDateString('en-AU', {
        day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
      }),
      scope: config.scope,
    })
  );

const policyPage = (name) => html(render(name, { updated: 'September 2026' }));

const handleStart = (event, { threads }) => {
  if (!configured()) return errorPage('This deployment is missing its Threads app credentials.', 503);
  if (!fromThisSite(event)) return errorPage('Connect from this site\'s own form.', 403);

  const form = parseForm(event);
  if (form.confirm !== 'yes') {
    return errorPage('You must tick the confirmation box before connecting.');
  }

  const mode = MODES.has(form.mode) ? form.mode : 'all';
  let cutoffIso;

  if (mode === 'older_than') {
    const parsed = Date.parse(form.cutoff);
    if (!Number.isFinite(parsed)) {
      return errorPage('Pick a valid cutoff date for "older than" mode.');
    }
    cutoffIso = new Date(parsed).toISOString();
  }

  const targets = [];
  if (form.includePosts === 'yes') targets.push('posts');
  if (form.includeReplies === 'yes') targets.push('replies');
  if (targets.length === 0) {
    return errorPage('Choose at least one of posts or replies to remove.');
  }

  const nonce = crypto.randomBytes(16).toString('base64url');
  const state = sign({
    mode,
    targets,
    cutoffIso,
    keyword: (form.keyword || '').trim().slice(0, 100) || undefined,
    dryRun: form.dryRun === 'yes',
    nonce,
  });

  return {
    ...redirect(threads.authorizeUrl(state, redirectUriFor(event))),
    cookies: [`${NONCE_COOKIE}=${nonce}; Path=/; Max-Age=${NONCE_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`],
  };
};

// Same filters means the same job carrying on, so its tally belongs to it.
// Different filters describe a different job that happens to share an account,
// and inheriting the old count made a fresh job open claiming work it never did.
const sameFilters = (existing, options, targets) =>
  existing.mode === options.mode
  && String(existing.cutoffIso || '') === String(options.cutoffIso || '')
  && String(existing.keyword || '') === String(options.keyword || '')
  && [...(existing.targets || [])].sort().join() === [...targets].sort().join();

// Reconnecting rewrites the job, so say plainly when that turns a live job
// back into a preview and how much the earlier runs already removed.
const buildConnectMessage = (existing, options) => {
  const already = Number((existing && existing.deletedCount) || 0);
  const history = already > 0 ? ` Earlier runs of this job already deleted ${already}.` : '';

  if (options.dryRun) {
    const downgraded = existing && existing.dryRun === false
      ? ' This is a preview, so the live run you had set up is now paused.'
      : '';
    return `Connected. Previewing matches without deleting.${downgraded}${history}`;
  }
  return `Connected. Deleting for real.${history}`;
};

const handleCallback = async (event, deps) => {
  const { threads, store, now } = deps;
  const query = event.queryStringParameters || {};

  if (query.error) {
    return errorPage(`Threads returned "${query.error_description || query.error}".`);
  }
  if (!query.code) return errorPage('Threads did not return an authorisation code.');

  const options = verify(query.state);
  if (!options) return errorPage('The authorisation state was missing or invalid. Start again.');
  if (!options.nonce || readCookie(event, NONCE_COOKIE) !== options.nonce) {
    return errorPage('This connection was started in a different browser or has expired. Start again.');
  }

  const shortLived = await threads.exchangeCode(
    String(query.code).replace(/#_$/, ''),
    redirectUriFor(event)
  );
  const longLived = await threads.exchangeLongLived(shortLived.access_token);
  const profile = await threads.getMe(longLived.access_token);

  const userId = String(profile.id || shortLived.user_id);
  const previous = await store.getJob(userId);
  const targets = Array.isArray(options.targets) && options.targets.length ? options.targets : ['posts'];
  const existing = previous && sameFilters(previous, options, targets) ? previous : null;

  await store.putJob({
    userId,
    username: profile.username || null,
    accessToken: longLived.access_token,
    tokenIssuedAt: now,
    tokenExpiresAt: now + Number(longLived.expires_in || 0) * 1000,
    state: store.STATES.active,
    mode: options.mode,
    targets,
    cutoffIso: options.cutoffIso,
    keyword: options.keyword,
    dryRun: Boolean(options.dryRun),
    deletedCount: Number((existing && existing.deletedCount) || 0),
    skippedCount: Number((existing && existing.skippedCount) || 0),
    scannedCount: 0,
    skipIds: (existing && existing.skipIds) || [],
    lastMessage: buildConnectMessage(existing, options),
    createdAt: (existing && existing.createdAt) || now,
    ttl: Math.floor((now + config.jobTtlDays * DAY_MS) / 1000),
  });

  // A dry run only reads: the quota endpoint plus a few pages of listings, well
  // inside the app's call budget. Run it inline so the page has real results by
  // the time it loads. A live run deletes and can take longer, so it goes to the
  // worker instead.
  const job = await store.getJob(userId);
  if (job && job.dryRun) {
    try {
      await (deps.runJob || runJob)(job, { store, threads, now });
    } catch (error) {
      // A failed preview must never block connecting.
      await store.updateJob(userId, {
        lastMessage: `Could not preview just now: ${error.message}. It will retry shortly.`,
      });
    }
  } else {
    await (deps.runNow || runNow)(userId);
  }

  return redirect(statusLink(userId));
};

const STATE_HEADINGS = {
  active: 'working through it',
  paused: 'paused',
  done: 'nothing left',
  previewed: 'dry run done',
  error: 'stopped',
};

// The heading is a phrase, not a status, so the state itself is named above it.
const STATE_TAGS = {
  active: ['', 'Active'],
  paused: ['waiting', 'Paused'],
  done: ['', 'Done'],
  previewed: ['waiting', 'Dry run'],
  error: ['stopped', 'Stopped'],
};

const stateTag = (state) => {
  const found = STATE_TAGS[state];
  if (!found) return '';
  return `<span class="state${found[0] ? ' ' + found[0] : ''}">${escapeHtml(found[1])}</span>`;
};

const CLOCK = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" '
  + 'stroke-width="1.4" aria-hidden="true"><circle cx="8" cy="8" r="6.3"></circle>'
  + '<path d="M8 4.3V8l2.5 1.6"></path></svg>';

const REPLY_MARK = '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" '
  + 'stroke-width="1.8" aria-hidden="true"><path d="M3 2v6.5a2 2 0 0 0 2 2h8"></path>'
  + '<path d="M9.8 7.3 13 10.5l-3.2 3.2"></path></svg>';

// When the next pass happens is what people reopen a bookmarked status link
// for, so it gets a line of its own instead of the tail of a grey paragraph.
const nextPassRow = (job, checked) => {
  const idle = job.state !== 'active';
  const label = {
    done: 'Nothing further is scheduled',
    previewed: 'Nothing scheduled until you go live',
    paused: 'Paused until you resume it',
    error: 'Stopped after an error',
  }[job.state] || (spentAllowance(job)
    // Promising a pass in four hours is misleading when that pass has nothing
    // to spend; what is actually being waited on is the allowance.
    ? 'Waiting on the allowance, then <strong>deleting resumes</strong>'
    : `Next pass <strong>within ${Number(config.runEveryHours)} hours</strong>`);

  return `<div class="nextpass${idle ? ' idle' : ''}">`
    + `<span class="when">${CLOCK}<span>${label}</span></span>`
    + `<span class="checked">${escapeHtml(checked)}</span></div>`;
};

const readableDate = (iso) =>
  new Date(iso).toLocaleDateString('en-AU', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  });

const sinceText = (then, now) => {
  if (!then) return 'not yet';
  const mins = Math.round((now - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins === 1) return '1 minute ago';
  if (mins < 60) return `${mins} minutes ago`;
  const hours = Math.round(mins / 60);
  return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
};

const actionButton = (action, token, label, className, confirmText) => {
  const confirmAttr = confirmText
    ? ` onsubmit="return confirm('${escapeHtml(confirmText).replace(/'/g, "\\'")}')"`
    : '';
  return `<form method="post" action="${action}"${confirmAttr}>` +
    `<input type="hidden" name="s" value="${escapeHtml(token)}">` +
    `<button type="submit"${className ? ` class="${className}"` : ''}>${escapeHtml(label)}</button></form>`;
};

// Each action sits with the thing it acts on: the primary one under the list it
// applies to, job controls with the job, and account admin away from both.
const buildActions = (job, token) => {
  const out = { primary: '', job: '', footer: '' };

  if (job.state === 'previewed') {
    out.primary = actionButton('/go-live', token, 'Delete these for real', 'danger',
      'This permanently deletes the matching posts and replies from Threads and cannot be undone. Continue?');
  }

  if (job.state === 'active' || job.state === 'paused') {
    out.job += actionButton(
      job.state === 'paused' ? '/resume' : '/pause',
      token,
      job.state === 'paused' ? 'Resume' : 'Pause',
      'quiet'
    );
  }

  out.footer = actionButton('/forget', token, 'Erase my token', 'quiet',
    'Erase your stored token and stop this job? Posts already removed stay removed.');

  return out;
};

const previewList = (job, primaryAction) => {
  const items = Array.isArray(job.preview) ? job.preview : [];
  if (items.length === 0) return '';

  const rows = items.map((item, i) => {
    const when = item.timestamp ? readableDate(item.timestamp) : 'no date';
    const kind = item.source === 'replies' ? 'reply' : 'post';
    const text = (item.text || '').trim();
    const body = text ? escapeHtml(text) : '<em>no text</em>';
    const link = item.permalink
      ? `<a class="open" href="${escapeHtml(item.permalink)}" target="_blank" rel="noopener">open</a>`
      : '';
    const mark = item.source === 'replies' ? REPLY_MARK : '';
    return `<li data-i="${i}"><span class="when">`
      + `<span class="who"><span class="kind">${mark}${kind}</span><span>${escapeHtml(when)}</span></span>`
      + `${link}</span><span class="what">${body}</span></li>`;
  }).join('');

  const total = Number(job.previewCount || items.length);
  const caption = total > items.length
    ? `A sample of ${items.length}, from ${total} matches in this pass.`
    : `${items.length} ${items.length === 1 ? 'match' : 'matches'} in this pass.`;

  return `<section class="panel wide">
    <h2>What would be removed</h2>
    <p class="hint">${escapeHtml(caption)}</p>
    <ul class="preview" id="preview">${rows}</ul>
    <div class="pager" id="pager" hidden>
      <button type="button" class="quiet" id="prev">Previous</button>
      <span class="hint" id="pageLabel"></span>
      <button type="button" class="quiet" id="next">Next</button>
    </div>
    ${primaryAction ? `<div class="golive"><p class="hint">Going live deletes these permanently, ${Number(job.quotaTotal || 100)} a day, until the backlog is clear. It cannot be undone.</p>${primaryAction}</div>` : ''}
  </section>`;
};

const handleStatus = async (event, { store, now }) => {
  const found = await jobFromToken(event, store);
  if (!found) return errorPage('That status link is not valid. It may have been erased already.', 404);

  const { job, token } = found;
  const quotaTotal = Number(job.quotaTotal || 100);
  const quotaUsed = Number(job.quotaUsed || 0);
  const deleted = Number(job.deletedCount || 0);
  const skipped = Number(job.skippedCount || 0);

  // A KPI row of counts. Only figures that carry information earn a tile: a
  // zero for something that has never happened is noise.
  const tiles = [];
  if (job.dryRun && job.previewCount !== undefined) {
    // A scan that stopped at its page limit has found a floor, not a total, and
    // must not be presented as one.
    const partial = Boolean(job.previewPartial);
    tiles.push([job.previewCount, partial ? 'matched before the scan stopped' : 'would be removed']);
    // At a fixed ration a backlog has a length in days, which is the thing
    // people actually want to know before going live.
    const days = Math.ceil(Number(job.previewCount || 0) / quotaTotal);
    if (days > 1) tiles.push([days, partial ? `days at ${quotaTotal} a day, at least` : `days at ${quotaTotal} a day`]);
  }
  // A preview deletes nothing, so any tally under it belongs to earlier live
  // runs of the same job. Labelling it "deleted so far" on a dry run read as
  // though the preview itself had removed them.
  if (!job.dryRun) tiles.push([deleted, 'deleted so far']);
  else if (deleted > 0) tiles.push([deleted, 'deleted by earlier runs']);
  if (skipped > 0) tiles.push([skipped, 'the API would not remove']);

  // Four figures without separators is a number people have to count.
  const grouped = (value) => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  const stats = tiles
    .map(([value, label], i) =>
      `<div class="stat${i === 0 ? ' lead' : ''}"><b>${escapeHtml(grouped(value))}</b>`
      + `<span>${escapeHtml(label)}</span></div>`)
    .join('');

  const checked = job.lastRunAt ? `Checked ${sinceText(job.lastRunAt, now)}.` : 'Not checked yet.';
  const acts = buildActions(job, token);

  // The primary action rides with the preview it acts on. With no preview to
  // attach it to, it falls back to the job panel so the job is never stranded.
  const preview = job.state === 'previewed' ? previewList(job, acts.primary) : '';
  const strandedPrimary = acts.primary && !preview ? acts.primary : '';
  const jobBar = acts.job + strandedPrimary;
  const jobActionBar = jobBar ? `<div class="actions">${jobBar}</div>` : '';

  return html(
    render('status', {
      token,
      heading: STATE_HEADINGS[job.state] || job.state,
      message: job.lastMessage || 'Connected.',
      error: job.lastError
        ? '<div class="notice bad"><span class="tag">Last error</span><p>'
          + escapeHtml(job.lastError) + '</p></div>'
        : '',
      stateTag: stateTag(job.state),
      nextPass: nextPassRow(job, checked),
      hint: nextRunHint(job),
      account: job.username ? '@' + job.username : job.userId,
      scope: describeJob(job),
      stats,
      quotaUsed,
      quotaTotal,
      quotaLeft: Math.max(quotaTotal - quotaUsed, 0),
      quotaPercent: Math.round((Math.min(quotaUsed, quotaTotal) / quotaTotal) * 100),
      jobActions: jobActionBar,
      footerAction: acts.footer,
      previewList: preview,
      refresh: job.state === 'active' && !job.lastRunAt ? '<meta http-equiv="refresh" content="5">' : '',
    })
  );
};

const handleGoLive = async (event, deps) => {
  const found = await jobFromToken(event, deps.store);
  if (!found) return errorPage('That link is not valid. It may have been erased already.', 404);

  await deps.store.updateJob(found.job.userId, {
    dryRun: false,
    state: deps.store.STATES.active,
    lastMessage: 'Deleting for real now. The first batch is running.',
  });
  await (deps.runNow || runNow)(found.job.userId);

  return redirect(statusLink(found.job.userId));
};

const handleControl = async (event, { store, now }, action) => {
  const found = await jobFromToken(event, store);
  if (!found) return errorPage('That control link is invalid or has expired.', 404);

  const { job } = found;

  if (action === 'forget') {
    await store.deleteJob(job.userId);
    return html(render('forgotten', {}));
  }

  await store.updateJob(job.userId, {
    state: action === 'pause' ? store.STATES.paused : store.STATES.active,
    lastRunAt: job.lastRunAt || null,
    lastMessage: action === 'pause' ? 'Paused by you.' : 'Resumed by you.',
    updatedAt: now,
  });

  return redirect(statusLink(job.userId));
};

// Threads calls this when someone removes the app; drop their record.
const handleDeauthorize = async (event, { store }) => {
  const parsed = parseSignedRequest(parseForm(event).signed_request);
  if (!parsed) return { statusCode: 400, headers: { 'content-type': 'application/json' }, body: '{"error":"bad signed_request"}' };

  await store.deleteJob(String(parsed.user_id));
  return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' };
};

// Meta's data deletion callback wants a status URL and a confirmation code back.
const handleDataDeletionRequest = async (event, { store }) => {
  const parsed = parseSignedRequest(parseForm(event).signed_request);
  if (!parsed) return { statusCode: 400, headers: { 'content-type': 'application/json' }, body: '{"error":"bad signed_request"}' };

  const userId = String(parsed.user_id);
  await store.deleteJob(userId);

  const code = crypto.createHash('sha256').update(userId + '|' + config.stateSecret).digest('hex').slice(0, 16);
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: `${baseUrl(event)}/data-deletion`, confirmation_code: code }),
  };
};

const handler = async (event, overrides = {}) => {
  const deps = {
    threads: overrides.threads || defaultThreads,
    store: overrides.store || defaultStore,
    now: overrides.now || Date.now(),
    runNow: overrides.runNow || runNow,
    runJob: overrides.runJob || runJob,
  };

  const method = (event.requestContext && event.requestContext.http.method) || 'GET';
  const path = event.rawPath || '/';

  try {
    // Awaited, or a handler that rejects skips this catch and API Gateway
    // answers with a bare 500 instead of the error page.
    if (method === 'GET' && (path === '/' || path === '')) return await handleIndex();
    if (method === 'GET' && path === '/privacy') return await policyPage('privacy');
    if (method === 'GET' && path === '/terms') return await policyPage('terms');
    if (method === 'GET' && path === '/data-deletion') return await policyPage('data-deletion');
    if (method === 'POST' && path === '/deauthorize') return await handleDeauthorize(event, deps);
    if (method === 'POST' && path === '/data-deletion') return await handleDataDeletionRequest(event, deps);
    if (method === 'POST' && path === '/start') return await handleStart(event, deps);
    if (method === 'GET' && path === '/callback') return await handleCallback(event, deps);
    if (method === 'GET' && path === '/status') return await handleStatus(event, deps);
    if (method === 'POST' && path === '/go-live') return await handleGoLive(event, deps);
    if (method === 'POST' && path === '/pause') return await handleControl(event, deps, 'pause');
    if (method === 'POST' && path === '/resume') return await handleControl(event, deps, 'resume');
    if (method === 'POST' && path === '/forget') return await handleControl(event, deps, 'forget');
    return errorPage('Page not found.', 404);
  } catch (error) {
    console.error(JSON.stringify({ msg: 'request failed', path, error: error.message }));
    return errorPage(`Something went wrong: ${error.message}`, 500);
  }
};

module.exports = { handler, describeJob, parseForm, readableDate, redirectUriFor, sinceText };
