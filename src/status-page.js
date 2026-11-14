'use strict';

const config = require('./config.js');
const { escapeHtml, readableDate, render } = require('./render.js');

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
    : `Next pass <strong>within ${config.runEveryHours} hours</strong>`);

  return `<div class="nextpass${idle ? ' idle' : ''}">`
    + `<span class="when">${CLOCK}<span>${label}</span></span>`
    + `<span class="checked">${escapeHtml(checked)}</span></div>`;
};

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
    const text = typeof item.text === 'string' ? item.text.trim() : null;
    const body = text ? escapeHtml(text) : `<em>${text === null ? 'text unavailable' : 'no text'}</em>`;
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

// Four figures without separators is a number people have to count.
const grouped = (value) => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

// A KPI row of counts. Only figures that carry information earn a tile: a
// zero for something that has never happened is noise.
const statTiles = (job, quotaTotal) => {
  const deleted = Number(job.deletedCount || 0);
  const skipped = Number(job.skippedCount || 0);

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

  return tiles
    .map(([value, label], i) =>
      `<div class="stat${i === 0 ? ' lead' : ''}"><b>${escapeHtml(grouped(value))}</b>`
      + `<span>${escapeHtml(label)}</span></div>`)
    .join('');
};

// Post text is never stored, so withText(job) resolves to the job with its
// preview's text read live. Only a previewed job calls it.
const renderStatus = async (job, token, now, withText) => {
  const quotaTotal = Number(job.quotaTotal || 100);
  const quotaUsed = Number(job.quotaUsed || 0);
  const stats = statTiles(job, quotaTotal);

  const checked = job.lastRunAt ? `Checked ${sinceText(job.lastRunAt, now)}.` : 'Not checked yet.';
  const acts = buildActions(job, token);

  // The primary action rides with the preview it acts on. With no preview to
  // attach it to, it falls back to the job panel so the job is never stranded.
  const preview = job.state === 'previewed' ? previewList(await withText(job), acts.primary) : '';
  const strandedPrimary = acts.primary && !preview ? acts.primary : '';
  const jobBar = acts.job + strandedPrimary;
  const jobActionBar = jobBar ? `<div class="actions">${jobBar}</div>` : '';

  return render('status', {
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
  });
};

module.exports = { describeJob, renderStatus, sinceText };
