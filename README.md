# Threads Deleter

[![codecov](https://codecov.io/gh/logan-han/threads-deleter/graph/badge.svg?token=5ZaOScjFX3)](https://codecov.io/gh/logan-han/threads-deleter)

**[threads.han.life](https://threads.han.life)** — my deployment. The Meta app is
unpublished, so only accounts with a role on it can connect; deploy your own to
use it.

Bulk-delete your own Threads posts and replies through Meta's official API, at
the 100-per-day rate the API allows, without babysitting it.

Threads has no built-in bulk delete. Its API does support deletion, so this
connects your account once and then works through the backlog on a schedule.

## How it works

1. Pick what to delete (everything, or older than a date, with an optional
   keyword filter) and connect your account over OAuth.
2. The job is stored in DynamoDB with a long-lived token.
3. A Lambda runs every 4 hours: it reads your live delete quota, lists your
   posts, and deletes as many matches as the quota allows.
4. A signed status link shows progress and can pause or forget the job.

Dry run is on by default: it reports what would match and deletes nothing.

## Limits and scope

| Limit | Value |
| --- | --- |
| Deletions | 100 per rolling 24h per profile |
| Long-lived token | 60 days, refreshable after 24h |
| Permission grant | 90 days, then reconnect |

The worker reads the live quota from `threads_publishing_limit` rather than
assuming, so it never burns requests on a spent one. Unlike the X API, Threads
deletion is not billed per call.

Posts (`/{user}/threads`) and replies (`/{user}/replies`) are separate
collections; pick either or both. Reposts cannot be removed through the API.
Posts the API refuses are recorded in `skipIds` and skipped later, otherwise they
wedge the job. In `older_than` mode the cutoff is applied both as the API's
`until` parameter and again locally, so nothing newer is ever deleted.

## Setup

Create an app with the **Threads** use case in
[Meta's dashboard](https://developers.facebook.com/apps), and note the **Threads**
App ID and secret under **App settings → Basic** (not the Facebook ones). Request
`threads_basic`, `threads_delete` and `threads_read_replies`. Until it passes App
Review, only accounts with a role on the app can authorise it.

```sh
export THREADS_APP_ID=...
export THREADS_APP_SECRET=...
export STATE_SECRET=$(openssl rand -hex 32)
npm run deploy
```

`scripts/deploy.sh` bundles, creates its artifact bucket on first run, and
deploys `infra/template.yaml` with the AWS CLI. No Serverless Framework account
or SAM CLI needed; the SAM transform runs inside CloudFormation.

The deploy prints the API URL. Add `<url>/callback` to the app's redirect URIs.
The callback is derived from the request host, so no second deploy is needed.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `THREADS_APP_ID` | — | Threads app ID |
| `THREADS_APP_SECRET` | — | Threads app secret |
| `STATE_SECRET` | app secret | Signs OAuth state and status links |
| `REDIRECT_URI` | derived from host | Override for a custom domain |
| `THREADS_SCOPE` | `threads_basic,threads_delete,threads_read_replies` | Requested permissions |
| `PER_RUN_DELETE_CAP` | `100` | Upper bound on deletes per run |
| `JOB_TTL_DAYS` | `120` | DynamoDB TTL on a stored job |

Deploy-time only: `AWS_REGION` (default `ap-southeast-4`), `STACK_NAME` (default
`threads-deleter`), `ARTIFACT_BUCKET`.

For a custom domain set `CUSTOM_DOMAIN_NAME` and `CERTIFICATE_ARN`; leave either
empty and the stack stays on the execute-api URL. The certificate must be in the
same region as the stack, because HTTP APIs only support regional custom domains.
The deploy prints `CustomDomainTarget` to point a CNAME at, and the new
`https://<domain>/callback` has to be added to the app's redirect URIs.

## Development

```
infra/template.yaml   CloudFormation + SAM: table, HTTP API, two functions
src/web.js            OAuth and status routes
src/worker.js         the scheduled drip
src/threads.js        Threads API client
src/store.js          DynamoDB access
```

```sh
npm install
npm test
npm run test:coverage
npm run lint
```
