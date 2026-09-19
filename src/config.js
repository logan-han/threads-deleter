'use strict';

const num = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

module.exports = {
  tableName: process.env.TABLE_NAME || 'threads-deleter-prod',
  workerFunctionName: process.env.WORKER_FUNCTION_NAME || '',
  // How often the schedule fires, used to tell people when to expect a pass.
  runEveryHours: Number(process.env.RUN_EVERY_HOURS || 4),
  // What Threads allows per account per rolling 24 hours.
  deleteQuotaPerDay: num(process.env.DELETE_QUOTA_PER_DAY, 100),
  appId: process.env.THREADS_APP_ID || '',
  appSecret: process.env.THREADS_APP_SECRET || '',
  // Signs OAuth state and status-page tokens. Falls back to the app secret so a
  // missing STATE_SECRET cannot silently produce unsigned links.
  stateSecret: process.env.STATE_SECRET || process.env.THREADS_APP_SECRET || '',
  redirectUri: process.env.REDIRECT_URI || '',
  // threads_delete is required by the delete endpoint but is missing from Meta's
  // authorisation-window scope table, so keep it overridable.
  scope: process.env.THREADS_SCOPE || 'threads_basic,threads_delete,threads_read_replies',
  graphHost: process.env.THREADS_GRAPH_HOST || 'https://graph.threads.net',
  authHost: process.env.THREADS_AUTH_HOST || 'https://threads.net',

  // Meta's 100-per-rolling-24h quota is the real limit, so a run uses whatever
  // is left of it. 100 sequential deletes take well under the worker's timeout.
  perRunDeleteCap: num(process.env.PER_RUN_DELETE_CAP, 100),
  // How many matches a preview keeps so the person can see what would go.
  previewSampleSize: num(process.env.PREVIEW_SAMPLE_SIZE, 50),
  pageSize: num(process.env.PAGE_SIZE, 100),
  maxPagesPerRun: num(process.env.MAX_PAGES_PER_RUN, 10),
  // Long-lived tokens last 60 days; refresh once inside this window.
  refreshWhenDaysLeft: num(process.env.REFRESH_WHEN_DAYS_LEFT, 10),
  // Permission grants expire after 90 days, so a job cannot outlive that by much.
  jobTtlDays: num(process.env.JOB_TTL_DAYS, 120),
  // Unsupported media keeps reappearing at the top of the listing; remember a
  // bounded number of them so a job cannot wedge on the same page forever.
  maxSkipIds: num(process.env.MAX_SKIP_IDS, 300),
};
