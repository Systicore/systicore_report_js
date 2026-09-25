# @systicore/report

Error reporting from browser apps (Angular, Vue, plain JavaScript) to the
Systicore reports backend. Every app sends its uncaught errors, failed API
calls and explicit reports to `POST {REPORTS_URL}/api/v1/ingest` with the
component's public `scpk_` key, whether a user is logged in or not.

- Native ES modules with hand-written TypeScript declarations. There is no
  build step, no `postinstall` and no runtime dependency.
- Never throws into the app and never blocks the UI thread. When reporting
  is disabled or misconfigured, every call is a no-op.
- Sends through its own `fetch` and `sendBeacon` calls, never through the
  app's `HttpClient` or fetch wrapper. The app's interceptors therefore
  cannot attach cookies, CSRF headers or development tokens, and a failed
  report cannot re-enter the app's error handling.

## Install

Apps install a tagged GitHub tarball. The `node:alpine` builders have no
git, and the tarball needs no token:

```bash
npm install https://codeload.github.com/Systicore/systicore_report_js/tar.gz/refs/tags/v0.2.0
```

```json
"dependencies": {
  "@systicore/report": "https://codeload.github.com/Systicore/systicore_report_js/tar.gz/refs/tags/v0.2.0"
}
```

Entry points:

| Import | Contents |
|---|---|
| `@systicore/report` | `init`, `captureException`, `captureMessage`, `reportHttpError`, `setUser`, `addBreadcrumb`, `installGlobalHandlers`, `flush`, `isEnabled` |
| `@systicore/report/angular` | `ReportingErrorHandler`, `bootstrapWithReporting`, `reportHttpErrorResponse`, `isHttpErrorResponse` |
| `@systicore/report/vue` | `installVueErrorHandler` |

Bundle size: about 25 kB minified, 9 kB gzip, all of it in the initial
bundle, because the reporter has to be ready before the app bootstraps.
An Angular app close to its `initial` budget (500 kB warning by default)
may cross it; raise the budget in `angular.json` rather than splitting the
error handler into a lazy chunk.

`package.json` lists the modules that keep module-level state (the
reporter, the Angular bootstrap phase, the Vue handler registry) under
`sideEffects`, so bundlers never drop them. Importing an entry point by
itself still does nothing: reporting starts with `init()`.

## Configuration

Every client uses the same three settings:

| Env | `init()` option | Meaning |
|---|---|---|
| `REPORTS_ENABLED` | `enabled` | `true` (or the string `"true"`, `"1"`, `"yes"`, `"on"`) turns reporting on. Keep it `false` in dev/local builds. |
| `REPORTS_URL` | `url` | Base URL of the reports backend, e.g. `https://reports.systicore.hu`. |
| `REPORTS_KEY` | `key` | The component's public key, `scpk_live_…` (production) or `scpk_test_…` (any other environment). |

An empty URL or key disables reporting. So does any key other than a
public one, `scpk_live_` or `scpk_test_` followed by 32 base62 characters:

- A secret `scsk_` key belongs to backends only and must never ship to a
  browser. The server refuses it from a browser anyway.
- Keys in the retired `pk_`/`sk_` format (before contract v1.1) are refused
  too. Create a new `scpk_` key for the component in the projects admin.

With `debug: true` the console names the reason reporting is off.

Other options:

| Option | Default | |
|---|---|---|
| `source` | none | The component's name, e.g. `tarp-crm_web`. It only namespaces the IndexedDB queue; the server derives the source from the key. |
| `environment` | none | `production`, `development`, `staging`. Informational: the key's environment is authoritative. |
| `release` | none | `{ version, commit, buildTime }`. `version` is also sent as `device.appVersion`. |
| `userProvider` | none | `() => ({ id, issuer? }) \| null`, read at every capture. It wins over `setUser()` when it returns a user. |
| `routeProvider` | none | `() => string \| null`, the current route template, used when a capture has no `route`. |
| `tags` | none | Tags added to every event, e.g. `{ image: 'tarp-planner_web:1.4.2' }`, copied at `init()`. A capture's own tags win on a key clash and are kept first under the 10-tag limit. |
| `breadcrumbsProvider` | none | `() => Array<{ category?, message, ts? } \| string> \| null`, read at every capture: steps from the app's own log, oldest first. They are merged with the reporter's breadcrumbs by time and the newest 20 are sent. `ts` is a `Date`, epoch milliseconds or an RFC 3339 string (default: the capture time). Only the last 20 returned entries are read; a provider that throws is ignored. |
| `beforeSend` | none | `(event) => event \| null`, a synchronous hook to change or drop an event. A hook that throws drops the event. |
| `maxQueue` | `30` | Events kept while offline or backing off. Beyond it, the oldest is dropped. |
| `useIndexedDbQueue` | `false` | Persists the queue in IndexedDB, so events captured offline survive a reload. For offline-first PWAs. |
| `rateLimitPerMinute` | `20` | Client-side cap on events per minute. |
| `debug` | `false` | Logs the reporter's own problems (bad config, dropped events) to the console. |

## Angular (zoneless)

`src/main.ts`: initialize before bootstrapping, and bootstrap through
`bootstrapWithReporting`, so the error that stops the start is reported as
critical:

```ts
import { bootstrapApplication } from '@angular/platform-browser';
import { init } from '@systicore/report';
import { bootstrapWithReporting } from '@systicore/report/angular';

import { App } from './app/app';
import { appConfig } from './app/app.config';
import { environment } from './app/shared/environment';
import { APP_BUILD_TIME, APP_COMMIT, APP_VERSION } from './app/core/version';

init({
  enabled: environment.reportsEnabled, // REPORTS_ENABLED
  url: environment.reportsUrl, // REPORTS_URL
  key: environment.reportsKey, // REPORTS_KEY (scpk_…)
  source: 'tarp-crm_web',
  environment: environment.production ? 'production' : 'development',
  release: { version: APP_VERSION, commit: APP_COMMIT, buildTime: APP_BUILD_TIME },
});

bootstrapWithReporting(() => bootstrapApplication(App, appConfig)).catch((error: unknown) =>
  console.error(error),
);
```

Why not `bootstrapApplication(...).catch(error => captureException(error, { severity: 'critical' }))`,
as v0.1.0 suggested: Angular hands an app-initializer or root-component
failure to the ErrorHandler *before* the bootstrap promise rejects. By the
time the `.catch()` runs, `ReportingErrorHandler` has already reported the
error at the default severity, and the second capture of the same object
is dropped.

`bootstrapWithReporting` holds back what `ReportingErrorHandler` would
report while the bootstrap runs: until it settles, and at most 1 s per
error, so a start that hangs delays other errors briefly and escalates
none. Then:

| Error | Reported as |
|---|---|
| The one the bootstrap rejects with, unless an HTTP row below applies | action `bootstrap`, severity `critical`, whether or not the ErrorHandler saw it (an environment initializer fails before the ErrorHandler exists) |
| Any other error met meanwhile (a third-party script error, a `ResizeObserver` loop) | as usual: default severity, no action |
| An HTTP failure the interceptor (or `reportHttpError`) already reported: status ≥ 500, or a network failure while online | its HTTP event only, e.g. `HTTP_503` at `error` or `NETWORK_ERROR` at `warning` with action `GET /api/config`; no second event |
| A network failure while offline | not reported, like any offline failure |
| Any other HTTP status (a 4xx), which the interceptor keeps only as a breadcrumb | action `bootstrap`, severity `critical`: a start a client error stops is a bug |
| An error a `beforeHandle` hook skipped or handled | not reported |

One error object is still sent once, and the returned promise settles like
`bootstrapApplication`'s own.

`src/app/app.config.ts`:

```ts
import {
  ApplicationConfig,
  ErrorHandler,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
} from '@angular/core';
import { HttpInterceptorFn, provideHttpClient, withInterceptors } from '@angular/common/http';
import { ReportingErrorHandler, reportHttpErrorResponse } from '@systicore/report/angular';
import { tap } from 'rxjs';

import { authInterceptor } from './core/interceptors/auth.interceptor';

/** First (outermost), so it sees the final outcome after the auth interceptor's refresh and retry. */
const reportingInterceptor: HttpInterceptorFn = (request, next) =>
  next(request).pipe(tap({ error: (error: unknown) => reportHttpErrorResponse(error, request) }));

export const appConfig: ApplicationConfig = {
  providers: [
    provideZonelessChangeDetection(),
    provideBrowserGlobalErrorListeners(), // window errors and rejections → ErrorHandler
    { provide: ErrorHandler, useClass: ReportingErrorHandler },
    provideHttpClient(withInterceptors([reportingInterceptor, authInterceptor])),
  ],
};
```

- `ReportingErrorHandler` logs the way Angular's default handler does
  (`console.error('ERROR', error)`) and then reports the error.
- `provideBrowserGlobalErrorListeners()` already routes window errors and
  unhandled rejections into the ErrorHandler. Do not also call
  `installGlobalHandlers()` in Angular apps.
- `reportHttpErrorResponse` reports only status ≥ 500 and network failures
  (status 0). It reduces the URL to a path template, e.g. `/api/items/42` →
  `/api/items/:id`.
- An HttpErrorResponse that passes both the interceptor and the
  ErrorHandler is handled once: one report (for ≥ 500 and 0) and one
  `http` breadcrumb. An error object the app passed to `reportHttpError`
  itself (see the Vue section) is logged by the ErrorHandler but not
  reported again.

To act on an error before it is logged and reported, for example to reload
the page after a failed lazy chunk, give the handler a `beforeHandle` hook.
Construct it with `useFactory`; the factory runs in an injection context,
so it may `inject()` what the hook needs:

```ts
import { ReportingErrorHandler } from '@systicore/report/angular';

const CHUNK_LOAD_FAILURE = /Loading chunk [\w-]+ failed|Failed to fetch dynamically imported module/;

{
  provide: ErrorHandler,
  useFactory: () =>
    new ReportingErrorHandler({
      beforeHandle: (error) => {
        if (error instanceof Error && CHUNK_LOAD_FAILURE.test(error.message)) {
          location.reload();
          return 'handled';
        }
        return 'report';
      },
    }),
},
```

`beforeHandle` receives the error with a Zone.js promise rejection
unwrapped and returns:

| Decision | Logged | Reported |
|---|---|---|
| `'report'` (also no return value, any other value, or a hook that throws) | yes | yes |
| `'skip'` | yes | no |
| `'handled'` | no | no |

`bootstrapWithReporting` respects the decision: an error the hook skipped
or handled is not reported as a bootstrap failure either. A subclass
(`class AppErrorHandler extends ReportingErrorHandler` that overrides
`handleError` and calls `super.handleError(error)` for the rest) works
too, but an error it swallows without calling `super` during bootstrap is
still reported by `bootstrapWithReporting`; use `beforeHandle` when that
matters.

The session cookie is HttpOnly, so the app can only claim its user. The
server stores that user unverified. Set it wherever the app tracks the
signed-in user, for example in `AuthService`:

```ts
import { setUser } from '@systicore/report';

effect(() => {
  const user = this.currentUser();
  setUser(user ? { id: user.id } : null);
});
```

## Vue 3

`src/main.ts`:

```ts
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { init, installGlobalHandlers } from '@systicore/report';
import { installVueErrorHandler } from '@systicore/report/vue';

import App from './App.vue';
import { sessionLogger } from './core/session-logger';
import { useAuthStore } from './core/stores/auth.store';

const pinia = createPinia();
const runtimeConfig = window.APP_CONFIG ?? {};

init({
  enabled: runtimeConfig.REPORTS_ENABLED, // "true" / "false" from env.js
  url: runtimeConfig.REPORTS_URL,
  key: runtimeConfig.REPORTS_KEY,
  source: 'tarp-planner_web',
  environment: import.meta.env.MODE,
  release: { version: import.meta.env.VITE_VERSION, commit: import.meta.env.VITE_COMMIT },
  useIndexedDbQueue: true, // offline-first: keep events across reloads until the device is online
  userProvider: () => {
    const user = useAuthStore(pinia).user;
    return user ? { id: user.id } : null;
  },
  tags: { image: import.meta.env.VITE_IMAGE_TAG },
  breadcrumbsProvider: () => sessionLogger.recentSteps(), // [{ category: 'ui', message, ts }]
});
installGlobalHandlers(); // window 'error' + 'unhandledrejection'

const app = createApp(App);
app.use(pinia);
installVueErrorHandler(app); // chains any app.config.errorHandler set before
app.mount('#app');
```

`installVueErrorHandler` tags each event with the component name and Vue's
error source ("render function", "watcher callback" and so on). Production
builds of Vue 3.4+ only pass a code, which is sent as is, e.g. `runtime-1`
(see https://vuejs.org/error-reference/). When the app uses vue-router, it
also records the matched route template.

To report failed API calls, add `reportHttpError` to the app's fetch
wrapper. Only status ≥ 500 and network failures are sent; every call is
kept as an `http` breadcrumb. Pass the error object the wrapper throws as
`error`:

```ts
import { reportHttpError } from '@systicore/report';

let response: Response;
try {
  response = await fetch(url, init);
} catch (error) {
  reportHttpError({ method, url, status: 0, error }); // skipped while the device is offline
  throw error;
}
if (!response.ok) {
  const failure = new ApiError(response.status, await response.text());
  reportHttpError({
    method,
    url,
    status: response.status,
    requestId: response.headers.get('X-Request-Id'),
    error: failure,
  });
  throw failure;
}
```

Every error object passed to `reportHttpError` is remembered, whether it
was reported or not. When the app lets it escape (an `async` click handler
without `try`/`catch`, say), `installGlobalHandlers()` and
`installVueErrorHandler` leave it alone, so a 4xx `ApiError` or an offline
`Failed to fetch` does not come back as an uncaught error. The Vue handler
chain still runs. An explicit `captureException(failure)` still reports a
4xx the app wants reported. Passing the same object to `reportHttpError`
again adds neither a report nor a breadcrumb.

Pass `urlTemplate: '/api/measurements/:id'` instead of `url` when the
wrapper knows the route. Otherwise numeric, UUID, hex, token and e-mail
path segments become `:id`.

## Plain JavaScript

```js
import { addBreadcrumb, captureException, captureMessage, init, installGlobalHandlers } from '@systicore/report';

init({ enabled: true, url: 'https://reports.systicore.hu', key: 'scpk_live_…', source: 'my_web' });
installGlobalHandlers();

addBreadcrumb({ category: 'ui', message: 'clicked Save' });
try {
  await save();
} catch (error) {
  captureException(error, { action: 'vault.save', severity: 'critical', tags: { feature: 'vault' } });
}
captureMessage('Cache rebuilt from scratch', { code: 'CACHE_REBUILT', severity: 'warning' });
```

Calls made before `init()` are buffered, up to 30, and replayed once
`init()` runs. `captureException` and `captureMessage` return `true` when
the event was queued for delivery.

Use `code` and `action` to keep grouping stable. `code` is a fixed
application code. `action` is a route template or an operation name, never
a URL with ids. The server groups by type or code, the normalized message
and the top in-app stack frames. To group by your own rule, pass
`fingerprint` (up to 64 characters of `[A-Za-z0-9._:-]`).

## Content Security Policy

`fetch` and `sendBeacon` both fall under `connect-src`, so the reports
origin must be allowed there:

```
Content-Security-Policy: connect-src 'self' https://api.example.hu https://reports.systicore.hu
```

The key's allowed origins, set in the projects admin, must also contain the
app's origin (e.g. `https://crm.tarp.systicore.hu`). Otherwise the server
answers 403, and the reporter stops sending for 5 minutes.

The reports backend, for its part, has to answer the real `POST` (every
status, including 429) with `Access-Control-Allow-Origin` and with
`Access-Control-Expose-Headers: Retry-After`. `Retry-After` is not a
CORS-safelisted response header: without the expose header the browser
hides it, and the reporter falls back to its 60 s default wait.

## What is sent

The body follows the ingest contract (§3). It is sent as a CORS "simple
request": a POST with a `text/plain;charset=UTF-8` body and the key in
`?key=`, so there is no preflight.

```json
{
  "error": { "type": "TypeError", "code": "…", "message": "…", "trace": "…", "action": "GET /api/vault/:id", "severity": "error" },
  "release": { "version": "1.4.2+17", "commit": "abc1234", "buildTime": "2026-09-24T10:00:00Z" },
  "environment": "production",
  "platform": "web",
  "device": { "brand": "Chrome", "model": "128", "osVersion": "Windows 10.0", "appVersion": "1.4.2+17", "installId": "uuid" },
  "user": { "id": "42" },
  "context": { "route": "/vault/:id", "url": "https://app.example/vault/42", "requestId": "…", "tags": {}, "breadcrumbs": [] }
}
```

- **No cookies.** Every `fetch` runs with `credentials: 'omit'` and
  `referrerPolicy: 'strict-origin'`, also the keepalive requests sent while
  the page is being hidden. Only browsers whose `fetch` has no keepalive
  (Firefox before 133) fall back to `sendBeacon` there, which has no
  credentials option: a cookie scoped to a parent domain (e.g.
  `Domain=.systicore.hu`) can travel with such a beacon. The reports backend
  ignores cookies.
- **No query strings.** Query strings and fragments are removed from the
  page URL, the route and the action, and from http(s) URLs and
  root-relative paths (`/api/items?page=2`) inside messages, traces,
  breadcrumbs and tags. A failed HTTP call is reported with its path
  template only.
- **Size limits.** Fields are cut to the server's caps on character
  boundaries: type 200 B, code 100 B, message 8 KB, trace 32 KB, action
  200 B, route and URL 500 B, request id 100 B. There are at most 10 tags
  (key 32, value 128 characters) and 20 breadcrumbs of 200 characters. If
  the body would still exceed about 60 KB, breadcrumbs go first, then most
  of the trace.
- **Install id.** `device.installId` is a random UUID kept in localStorage
  (`systicore-report:install-id`) so the backend can count affected
  installs. `brand`, `model` and `osVersion` are the browser family, its
  major version and the operating system.

## Delivery

| Server answer | Reporter |
|---|---|
| 2xx | Done. |
| 400, 413, other 4xx | The event is dropped: sending it again would not help. |
| 401, 403 | The event is dropped, and nothing is sent for 5 minutes (circuit breaker). |
| 429 | The event is kept; nothing is sent until `Retry-After` has passed. The default wait, also used when the header is missing or not exposed to the page, is 60 s; the maximum is 1 h. |
| 5xx, 408, network error | The event is kept and retried with backoff: 2 s, 4 s, 8 s … up to 5 min, ±20 % jitter. It is dropped after 8 failed attempts. |

- Events go out one at a time, oldest first, as `fetch(…, { keepalive: true })`.
- **Offline.** No attempt is made while `navigator.onLine` is `false`.
  The queue is replayed on the `online` event and on `init()` (for the
  IndexedDB queue). Persisted events older than 7 days are discarded.
- **Page hide.** On `pagehide`, and on `visibilitychange` to hidden, the
  whole queue is sent at once as keepalive `fetch` requests, which outlive
  the page; their answers are not awaited. Browsers without keepalive get
  `navigator.sendBeacon` instead. Whatever does not fit the browser's
  64 KiB keepalive budget stays queued. This is skipped while offline or
  while the circuit breaker or `Retry-After` holds.
- **Flood control.** An identical error (type, code, message, action)
  within 60 s is sent once, and the same `Error` object is never sent
  twice. An error object passed to `reportHttpError` is never reported
  again as an uncaught error (only a 4xx that stops an Angular start is,
  see `bootstrapWithReporting`). At most 20 events per minute are sent.

## Development

```bash
npm test                                          # node --test (Node 24), no install needed
npx -p typescript tsc -p tsconfig.json            # type-checks the JSDoc sources and the .d.ts files
```

The tests stub `fetch`, `sendBeacon`, timers, the window and IndexedDB.
`test/types/consumer.ts` compiles the public declarations through the
package's own `exports` map.

To release, bump `version` in `package.json`, add a section to the
changelog below, then commit, tag `vX.Y.Z` and push the tag. Apps then
point their dependency at the new tag's tarball URL. The archive leaves
out `test/` and the tooling files (see `.gitattributes`).

## Changelog

### 0.2.0

Backward compatible: apps on 0.1.0 compile and run unchanged. Behaviour
changes only where 0.1.0 was wrong.

Added:

- `init({ tags })`: tags added to every event. A capture's own tags win on
  a key clash and are kept first under the 10-tag limit.
- `init({ breadcrumbsProvider })`: breadcrumbs from the app's own step log,
  read at every capture and merged with the reporter's trail by time.
- `new ReportingErrorHandler({ beforeHandle })` (Angular): a hook that runs
  first and decides `'report'`, `'skip'` (log only) or `'handled'` (neither),
  e.g. for a reload after a chunk-load failure. `useClass:
  ReportingErrorHandler` keeps working as before.
- `bootstrapWithReporting(() => bootstrapApplication(App, appConfig))`
  (Angular): reports the error that stops the start as `critical` with
  action `bootstrap`. Other errors met during the start keep their usual
  severity, and HTTP failures the interceptor already reported (≥ 500, or a
  network failure while online) keep their HTTP event; offline network
  failures stay unreported. The
  `bootstrapApplication(...).catch(captureException(...))` pattern of the
  0.1.0 README never produced `critical` for app-initializer or
  root-component failures, because Angular reports them to the ErrorHandler
  before the promise rejects.

Fixed:

- `reportHttpError` remembers every error object it is given, not only the
  ones it reports. A 4xx `ApiError` or an offline `Failed to fetch` that the
  app lets escape is no longer reported again as an uncaught error by
  `installGlobalHandlers()`, `installVueErrorHandler` or
  `ReportingErrorHandler`. Explicit `captureException()` calls are
  unaffected, and a 4xx that stops an Angular start is still reported by
  `bootstrapWithReporting`.
- The same error object passed to `reportHttpError` twice (an interceptor,
  then `ReportingErrorHandler`) no longer adds a second `http` breadcrumb.
- `package.json` declared `"sideEffects": false` although the reporter, the
  Angular bootstrap phase and the Vue handler registry keep module-level
  state. It now lists those modules, so bundlers never drop them.

Size: about 3 kB minified (1 kB gzip) more than 0.1.0.

### 0.1.0

First release: `init`, `captureException`, `captureMessage`,
`reportHttpError`, `setUser`, `addBreadcrumb`, `installGlobalHandlers`,
`flush`, `isEnabled`; the Angular `ReportingErrorHandler` and
`reportHttpErrorResponse`; the Vue `installVueErrorHandler`.
