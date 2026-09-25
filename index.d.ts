/**
 * @systicore/report: error reporting from browser apps to the Systicore
 * reports backend (contract v1.1, POST {REPORTS_URL}/api/v1/ingest).
 */

export type Severity = 'warning' | 'error' | 'critical';

export type BreadcrumbCategory = 'http' | 'nav' | 'ui' | 'log';

export interface Release {
  /** App version, e.g. "1.4.2+17". Also sent as device.appVersion. */
  version?: string | undefined;
  /** Git commit SHA (short or full). */
  commit?: string | undefined;
  /** RFC 3339 build timestamp. */
  buildTime?: string | undefined;
}

export interface ReportUser {
  /** The app's own user id; numbers are sent as strings. */
  id: string | number;
  /** Who issued the id, e.g. the app backend's token issuer. Defaults server-side to "claimed:<source>". */
  issuer?: string | undefined;
}

export interface Breadcrumb {
  /** RFC 3339 timestamp. */
  ts: string;
  category: BreadcrumbCategory;
  /** At most 200 characters. */
  message: string;
}

/** A breadcrumb from the app's own log, as returned by `breadcrumbsProvider`. */
export interface BreadcrumbInput {
  /** Default "log". */
  category?: BreadcrumbCategory | undefined;
  /** Cut to 200 characters, URL queries removed. */
  message: string;
  /** When it happened: a Date, epoch milliseconds or an RFC 3339 string. Default: the capture time. */
  ts?: Date | number | string | undefined;
}

/** At most 10 tags are sent; keys up to 32, values up to 128 characters. Null and undefined values are skipped. */
export type Tags = Record<string, string | number | boolean | null | undefined>;

/** The ingest body (contract §3), as passed to `beforeSend`. */
export interface IngestEvent {
  error: {
    type?: string;
    code?: string;
    message?: string;
    trace?: string;
    action?: string;
    severity?: Severity;
    fingerprint?: string;
  };
  release?: Release;
  environment?: string;
  platform?: string;
  device?: {
    brand?: string;
    model?: string;
    osVersion?: string;
    apiLevel?: number;
    appVersion?: string;
    installId?: string;
  };
  user?: { id: string; issuer?: string };
  context?: {
    route?: string;
    url?: string;
    requestId?: string;
    tags?: Record<string, string>;
    breadcrumbs?: Breadcrumb[];
  };
}

export interface InitOptions {
  /**
   * REPORTS_ENABLED. Reporting is on only for `true` or the strings
   * "true", "1", "yes", "on" (as runtime env files deliver them).
   */
  enabled: boolean | string | null | undefined;
  /** REPORTS_URL, the reports backend base URL, e.g. https://reports.systicore.hu. Empty ⇒ off. */
  url?: string | null | undefined;
  /**
   * REPORTS_KEY, the component's public key: `scpk_live_` (production) or
   * `scpk_test_`, followed by 32 base62 characters. Empty, malformed, a
   * secret `scsk_` key or a retired `pk_`/`sk_` key ⇒ off.
   */
  key?: string | null | undefined;
  /** The component's name, e.g. "tarp-crm_web". Namespaces the IndexedDB queue; the key decides the source server-side. */
  source?: string | undefined;
  /** "production", "development", "staging". Informational: the key's environment is authoritative. */
  environment?: string | undefined;
  release?: Release | undefined;
  /** Read at every capture; wins over setUser() when it returns a user. */
  userProvider?: (() => ReportUser | null | undefined) | undefined;
  /** Read at every capture without an explicit `route`, e.g. the current route template. */
  routeProvider?: (() => string | null | undefined) | undefined;
  /**
   * Tags added to every event, e.g. `{ image: 'tarp-planner_web:1.4.2' }`.
   * Copied at init(). A capture's own tags win on a key clash and are kept
   * first when the 10-tag limit applies.
   */
  tags?: Tags | undefined;
  /**
   * Read at every capture: steps from the app's own log (oldest first). They
   * are merged with the reporter's breadcrumbs by time, and the newest 20
   * are sent; only the last 20 returned entries are read. A provider that
   * throws is ignored.
   */
  breadcrumbsProvider?:
    (() => ReadonlyArray<BreadcrumbInput | string> | null | undefined) | undefined;
  /**
   * Last chance to change or drop an event (return null). Synchronous; a hook
   * that throws drops the event. The result is size-limited again.
   */
  beforeSend?: ((event: IngestEvent) => IngestEvent | null | undefined) | undefined;
  /** Queued events kept at most; the oldest is dropped beyond it. Default 30. */
  maxQueue?: number | undefined;
  /** Persist the queue in IndexedDB so offline events survive a reload. Default false. */
  useIndexedDbQueue?: boolean | undefined;
  /** Client-side limit of events per minute. Default 20. */
  rateLimitPerMinute?: number | undefined;
  /** Log the reporter's own problems (bad config, dropped events) to the console. Default false. */
  debug?: boolean | undefined;
}

export interface CaptureOptions {
  /** Stable application error code, e.g. "VAULT_SYNC_FAILED". */
  code?: string | undefined;
  /** Route template, screen or operation, e.g. "GET /api/vault/:id". Never a raw URL with ids. */
  action?: string | undefined;
  /** Default "error". */
  severity?: Severity | undefined;
  /** Overrides server-side grouping: at most 64 characters of [A-Za-z0-9._:-]. */
  fingerprint?: string | undefined;
  /** Route template, e.g. "/vault/:id". */
  route?: string | undefined;
  requestId?: string | undefined;
  /** At most 10; keys up to 32, values up to 128 characters. Merged over the global `tags` of init(). */
  tags?: Tags | undefined;
}

export type CaptureExceptionOptions = CaptureOptions;

export type CaptureMessageOptions = CaptureOptions;

export interface HttpErrorDetails {
  /** e.g. "GET". */
  method?: string | undefined;
  /** Route template of the endpoint, e.g. "/api/vault/:id". Preferred over `url`. */
  urlTemplate?: string | undefined;
  /** Concrete URL; reduced to a template ("/api/vault/42?x=1" → "/api/vault/:id") when no urlTemplate is given. */
  url?: string | undefined;
  /** HTTP status; 0, null or undefined for a network failure. */
  status?: number | null | undefined;
  requestId?: string | null | undefined;
  /**
   * The error object the app throws for this failure (the fetch TypeError,
   * its own ApiError, Angular's HttpErrorResponse). It is remembered whether
   * or not it is reported: passing it again adds nothing, and the handlers of
   * uncaught errors (installGlobalHandlers, the Angular and Vue adapters) do
   * not report it when the app lets it escape. Explicit captureException()
   * calls still report a 4xx error.
   */
  error?: unknown;
}

/**
 * Configures reporting. Calls made before init() are buffered (up to 30) and
 * replayed. Calling it again replaces the configuration.
 * @returns whether reporting is on
 */
export declare function init(options: InitOptions): boolean;

/** Whether the last init() switched reporting on. */
export declare function isEnabled(): boolean;

/**
 * Reports anything that was thrown or rejected. Never throws.
 * @returns true when the event was queued for delivery
 */
export declare function captureException(
  error: unknown,
  options?: CaptureExceptionOptions,
): boolean;

/**
 * Reports a message without an exception. Never throws.
 * @returns true when the event was queued for delivery
 */
export declare function captureMessage(message: string, options?: CaptureMessageOptions): boolean;

/**
 * Reports a failed HTTP call of the app when it is a server fault (status >=
 * 500) or a network failure while online. Every call becomes an "http"
 * breadcrumb, except a second call with the same `error` object, which is
 * ignored. Never throws.
 * @returns true when an event was queued for delivery
 */
export declare function reportHttpError(details: HttpErrorDetails): boolean;

/** Sets the (claimed, unverified) user attached to later events; null clears it. */
export declare function setUser(user: ReportUser | null): void;

/** Remembers a step for the next events' context (the last 20 are kept). */
export declare function addBreadcrumb(
  breadcrumb: { category?: BreadcrumbCategory; message: string } | string,
): void;

/** Sends what is queued now, as far as the network and the server allow. */
export declare function flush(): Promise<void>;

/**
 * Reports uncaught errors ('error') and unhandled promise rejections
 * ('unhandledrejection') of the window, except error objects the app already
 * passed to reportHttpError. Idempotent.
 * @returns a function that removes the listeners
 */
export declare function installGlobalHandlers(): () => void;
