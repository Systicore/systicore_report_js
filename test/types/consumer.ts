// Compile-only check of the published declarations, resolved through the
// package's own "exports" map the way an app resolves them. Never executed.

import {
  addBreadcrumb,
  captureException,
  captureMessage,
  flush,
  init,
  installGlobalHandlers,
  isEnabled,
  reportHttpError,
  setUser,
  type BreadcrumbInput,
  type IngestEvent,
  type InitOptions,
  type Tags,
} from '@systicore/report';
import {
  ReportingErrorHandler,
  bootstrapWithReporting,
  isHttpErrorResponse,
  reportHttpErrorResponse,
  type ErrorHandlingDecision,
} from '@systicore/report/angular';
import { installVueErrorHandler } from '@systicore/report/vue';

declare const runtimeConfig: {
  REPORTS_ENABLED?: string;
  REPORTS_URL?: string;
  REPORTS_KEY?: string;
};

const options: InitOptions = {
  enabled: runtimeConfig.REPORTS_ENABLED,
  url: runtimeConfig.REPORTS_URL,
  key: runtimeConfig.REPORTS_KEY,
  source: 'tarp-crm_web',
  environment: 'production',
  release: { version: '1.0.0', commit: 'abc1234', buildTime: '2026-09-24T10:00:00Z' },
  userProvider: () => ({ id: 42 }),
  routeProvider: () => '/vault/:id',
  beforeSend: (event: IngestEvent) =>
    event.error.message?.includes('ChunkLoadError') ? null : event,
  maxQueue: 30,
  useIndexedDbQueue: true,
  tags: { image: 'tarp-crm_web:1.0.0', canary: false },
  breadcrumbsProvider: (): BreadcrumbInput[] => [
    { category: 'ui', message: 'opened planner', ts: Date.now() },
    { message: 'saved plan', ts: new Date() },
  ],
};

const enabled: boolean = init(options);
init({ enabled: false });
const queued: boolean = captureException(new Error('boom'), {
  action: 'save',
  severity: 'critical',
  tags: { feature: 'vault', attempt: 2 },
  route: '/vault/:id',
});
captureMessage('cache rebuilt', { code: 'CACHE_REBUILT', severity: 'warning', action: 'startup' });
setUser({ id: '42', issuer: 'https://crm.example' });
setUser(null);
addBreadcrumb({ category: 'nav', message: '/vault' });
addBreadcrumb('clicked save');
reportHttpError({
  method: 'GET',
  urlTemplate: '/api/vault/:id',
  status: 503,
  requestId: null,
  error: new Error('x'),
});
const uninstall: () => void = installGlobalHandlers();
uninstall();
const flushed: Promise<void> = flush();
const on: boolean = isEnabled();

const handler = new ReportingErrorHandler();
handler.handleError(new Error('from Angular'));
const hookedHandler = new ReportingErrorHandler({
  beforeHandle: (error: unknown): ErrorHandlingDecision =>
    error instanceof Error && error.name === 'ChunkLoadError' ? 'handled' : 'report',
});
new ReportingErrorHandler({
  beforeHandle: () => {
    // No decision counts as "report".
  },
});
class AppErrorHandler extends ReportingErrorHandler {
  override handleError(error: unknown): void {
    super.handleError(error);
  }
}
const subclassedHandler: ReportingErrorHandler = new AppErrorHandler();
// @ts-expect-error the decision is a closed set
new ReportingErrorHandler({ beforeHandle: () => 'ignore' });

interface ApplicationRefLike {
  destroy(): void;
}
declare function bootstrapApplication(): Promise<ApplicationRefLike>;
const started: Promise<ApplicationRefLike> = bootstrapWithReporting(() => bootstrapApplication());
started.catch((error: unknown) => console.error(error));
void hookedHandler;
void subclassedHandler;
const failure: unknown = { name: 'HttpErrorResponse', status: 500, url: null };
if (isHttpErrorResponse(failure)) {
  const status: number = failure.status;
  void status;
}
reportHttpErrorResponse(failure, { method: 'GET', url: '/api/items' });

const restore: () => void = installVueErrorHandler({ config: { errorHandler: undefined } });
restore();

// @ts-expect-error severity is a closed set
captureMessage('x', { severity: 'fatal' });
// @ts-expect-error breadcrumbs need a message
addBreadcrumb({ category: 'ui' });
// @ts-expect-error provided breadcrumbs need a message too
init({ enabled: true, breadcrumbsProvider: () => [{ category: 'ui' }] });
// @ts-expect-error tag values are primitives
const nestedTags: Tags = { nested: { deep: true } };
void nestedTags;

void enabled;
void queued;
void flushed;
void on;
