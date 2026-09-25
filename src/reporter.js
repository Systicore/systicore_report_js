/**
 * The reporter: turns captures into contract events and hands them to the
 * dispatcher. createReporter returns a DisabledReporter (every call a no-op)
 * when reporting is switched off or misconfigured, so callers never branch
 * on configuration.
 *
 * Public methods never throw: a failure inside the reporter is logged (with
 * debug on) and the capture reports false.
 */

import { BreadcrumbTrail } from './breadcrumbs.js';
import { resolveConfiguration } from './configuration.js';
import { attachDeliveryTriggers } from './delivery-triggers.js';
import { describeDevice, resolveInstallId } from './device.js';
import { Dispatcher } from './dispatcher.js';
import { describeError } from './error-description.js';
import { EventQueue, NULL_STORE } from './event-queue.js';
import { assembleEvent, limitEvent } from './event-builder.js';
import {
  breadcrumbOfHttpCall,
  captureOfHttpFailure,
  describeHttpCall,
  isReportableHttpFailure,
} from './http-failure.js';
import { IndexedDbStore, queueDatabaseName } from './indexed-db-store.js';
import { createLogger } from './logger.js';
import { detectRuntime, isOnline } from './runtime.js';
import { serializeEvent } from './serializer.js';
import { DuplicateFilter, RateLimiter, duplicateIdentityOf } from './throttle.js';
import {
  FetchTransport,
  KeepaliveBudget,
  buildIngestEndpoint,
  createPageHideTransport,
} from './transport.js';

/**
 * @typedef {object} CaptureOptions
 * @property {string} [code]
 * @property {string} [action]
 * @property {string} [severity]
 * @property {string} [fingerprint]
 * @property {string} [route]
 * @property {string} [requestId]
 * @property {Record<string, unknown>} [tags]
 */

/**
 * @typedef {object} Reporter
 * @property {boolean} enabled
 * @property {(error: unknown, options?: CaptureOptions | null) => boolean} captureException
 * @property {(error: unknown, options?: CaptureOptions | null) => boolean} captureUncaughtError
 * @property {(message: unknown, options?: CaptureOptions | null) => boolean} captureMessage
 * @property {(details: import('./http-failure.js').HttpFailureDetails) => boolean} reportHttpError
 * @property {(user: { id?: unknown, issuer?: unknown } | null | undefined) => void} setUser
 * @property {(breadcrumb: { category?: unknown, message?: unknown } | string) => void} addBreadcrumb
 * @property {() => Promise<void>} flush
 * @property {() => void} dispose
 */

/**
 * @param {unknown} options the init() options
 * @param {import('./runtime.js').Runtime} [runtime]
 * @returns {Reporter}
 */
export function createReporter(options, runtime = detectRuntime()) {
  const { configuration, disabledReason } = resolveConfiguration(options);
  const debug =
    typeof options === 'object' && options !== null && /** @type {any} */ (options).debug === true;
  const logger = createLogger(debug);
  if (!configuration) {
    logger.warn(`reporting is off: ${disabledReason}`);
    return new DisabledReporter();
  }
  const fetchFunction = runtime.fetch;
  if (!fetchFunction) {
    logger.warn('reporting is off: fetch is not available');
    return new DisabledReporter();
  }
  return new ActiveReporter(configuration, { ...runtime, fetch: fetchFunction }, logger);
}

/** @implements {Reporter} */
export class DisabledReporter {
  enabled = false;

  captureException() {
    return false;
  }

  captureUncaughtError() {
    return false;
  }

  captureMessage() {
    return false;
  }

  reportHttpError() {
    return false;
  }

  setUser() {}

  addBreadcrumb() {}

  async flush() {}

  dispose() {}
}

/** @implements {Reporter} */
export class ActiveReporter {
  enabled = true;
  #configuration;
  #runtime;
  #logger;
  #breadcrumbs;
  #duplicates = new DuplicateFilter();
  #rateLimiter;
  #dispatcher;
  #detachTriggers;
  #device;
  #restored;
  /** @type {{ id?: unknown, issuer?: unknown } | null} */
  #explicitUser = null;
  /** Error objects already reported, so one error seen by two handlers is sent once. */
  #reportedErrors = new WeakSet();
  /**
   * Every error object passed to reportHttpError, reported or not. The HTTP
   * layer has decided about each of them, so a second pass and the handlers
   * of uncaught errors leave them alone.
   */
  #httpErrors = new WeakSet();

  /**
   * @param {import('./configuration.js').Configuration} configuration
   * @param {import('./runtime.js').Runtime & { fetch: import('./runtime.js').FetchFunction }} runtime
   * @param {import('./logger.js').Logger} logger
   */
  constructor(configuration, runtime, logger) {
    this.#configuration = configuration;
    this.#runtime = runtime;
    this.#logger = logger;
    this.#breadcrumbs = new BreadcrumbTrail(runtime.now);
    this.#rateLimiter = new RateLimiter(configuration.rateLimitPerMinute);
    this.#device = describeDevice(
      runtime.navigator?.userAgent,
      configuration.release.version,
      resolveInstallId(runtime.localStorage, runtime.createId),
    );

    const endpoint = buildIngestEndpoint(configuration.url, configuration.key);
    const queue = new EventQueue(configuration.maxQueue, this.#createStore());
    const keepaliveBudget = new KeepaliveBudget();
    this.#dispatcher = new Dispatcher({
      queue,
      transport: new FetchTransport(endpoint, runtime.fetch, keepaliveBudget),
      pageHideTransport: createPageHideTransport(endpoint, runtime, keepaliveBudget),
      runtime,
      logger,
    });
    this.#detachTriggers = attachDeliveryTriggers(runtime, this.#dispatcher);
    this.#restored = queue
      .restore(runtime.now())
      .then(() => this.#dispatcher.drain())
      .catch((failure) => logger.warn('restoring the persisted queue failed', failure));
  }

  /**
   * @param {unknown} error
   * @param {CaptureOptions | null} [options]
   * @returns {boolean} true when the event was queued for delivery
   */
  captureException(error, options) {
    try {
      if (!this.#claimReport(error)) {
        return false;
      }
      const captureOptions = options ?? {};
      const description = describeError(error);
      return this.#submit({
        ...description,
        code: captureOptions.code ?? description.code,
        action: captureOptions.action,
        severity: captureOptions.severity,
        fingerprint: captureOptions.fingerprint,
        route: captureOptions.route,
        requestId: captureOptions.requestId,
        tags: captureOptions.tags,
      });
    } catch (failure) {
      this.#logger.warn('captureException failed', failure);
      return false;
    }
  }

  /**
   * Reports an error nobody handled: from the window listeners or a
   * framework's error handler. An error object the app passed to
   * reportHttpError is skipped, because the HTTP layer already reported it or
   * decided it is not worth a report (a 4xx, a network failure while
   * offline). Explicit captureException() calls are not affected.
   *
   * @param {unknown} error
   * @param {CaptureOptions | null} [options]
   * @returns {boolean} true when the event was queued for delivery
   */
  captureUncaughtError(error, options) {
    try {
      if (canBeRemembered(error) && this.#httpErrors.has(error)) {
        return false;
      }
      return this.captureException(error, options);
    } catch (failure) {
      this.#logger.warn('captureUncaughtError failed', failure);
      return false;
    }
  }

  /**
   * @param {unknown} message
   * @param {CaptureOptions | null} [options]
   * @returns {boolean}
   */
  captureMessage(message, options) {
    try {
      const captureOptions = options ?? {};
      return this.#submit({
        message: typeof message === 'string' ? message : String(message),
        code: captureOptions.code,
        action: captureOptions.action,
        severity: captureOptions.severity,
        fingerprint: captureOptions.fingerprint,
        route: captureOptions.route,
        requestId: captureOptions.requestId,
        tags: captureOptions.tags,
      });
    } catch (failure) {
      this.#logger.warn('captureMessage failed', failure);
      return false;
    }
  }

  /**
   * Reports a failed HTTP call of the app when it is a server fault (>= 500)
   * or a network failure while online. Every call, reported or not, becomes
   * an "http" breadcrumb. An error object passed a second time (the same
   * failure seen by an interceptor and then by the ErrorHandler) is ignored
   * entirely: no second report and no second breadcrumb.
   *
   * @param {import('./http-failure.js').HttpFailureDetails} details
   * @returns {boolean}
   */
  reportHttpError(details) {
    try {
      const httpFailure = details ?? {};
      if (!this.#rememberHttpError(httpFailure.error)) {
        return false;
      }
      const call = describeHttpCall(httpFailure);
      if (call.target?.startsWith(this.#configuration.url)) {
        return false;
      }
      const reported =
        isReportableHttpFailure(call) &&
        (call.status !== undefined || isOnline(this.#runtime)) &&
        this.#claimReport(httpFailure.error) &&
        this.#submit(captureOfHttpFailure(call, httpFailure));
      this.#breadcrumbs.add({ category: 'http', message: breadcrumbOfHttpCall(call) });
      return reported;
    } catch (failure) {
      this.#logger.warn('reportHttpError failed', failure);
      return false;
    }
  }

  /**
   * The user sent when no userProvider is configured or it returns nothing.
   *
   * @param {{ id?: unknown, issuer?: unknown } | null | undefined} user
   */
  setUser(user) {
    this.#explicitUser =
      typeof user === 'object' && user !== null ? { id: user.id, issuer: user.issuer } : null;
  }

  /**
   * @param {{ category?: unknown, message?: unknown } | string} breadcrumb
   */
  addBreadcrumb(breadcrumb) {
    try {
      this.#breadcrumbs.add(
        typeof breadcrumb === 'string' ? { message: breadcrumb } : (breadcrumb ?? {}),
      );
    } catch (failure) {
      this.#logger.warn('addBreadcrumb failed', failure);
    }
  }

  /**
   * Resolves once the persisted queue is restored and the queue has been
   * sent as far as the network and the server allow.
   *
   * @returns {Promise<void>}
   */
  async flush() {
    try {
      await this.#restored;
      await this.#dispatcher.drain();
    } catch (failure) {
      this.#logger.warn('flush failed', failure);
    }
  }

  dispose() {
    this.#detachTriggers();
    this.#dispatcher.dispose();
  }

  /**
   * @param {import('./event-builder.js').Capture} capture
   * @returns {boolean}
   */
  #submit(capture) {
    const limited = limitEvent(assembleEvent(capture, this.#currentScope()));
    const event = limited ? this.#applyBeforeSend(limited) : null;
    if (!event) {
      return false;
    }
    const now = this.#runtime.now();
    if (this.#duplicates.isDuplicate(duplicateIdentityOf(event.error), now)) {
      return false;
    }
    if (!this.#rateLimiter.tryAcquire(now)) {
      this.#logger.warn('event dropped: client-side rate limit reached');
      return false;
    }
    const body = serializeEvent(event);
    if (body === null) {
      return false;
    }
    this.#dispatcher.enqueue(body);
    return true;
  }

  /**
   * @param {import('./event-builder.js').IngestEvent} event
   * @returns {import('./event-builder.js').IngestEvent | null}
   */
  #applyBeforeSend(event) {
    const beforeSend = this.#configuration.beforeSend;
    if (!beforeSend) {
      return event;
    }
    try {
      const result = beforeSend(event);
      return result ? limitEvent(result) : null;
    } catch (failure) {
      this.#logger.warn('beforeSend threw; the event is dropped', failure);
      return null;
    }
  }

  /**
   * @returns {import('./event-builder.js').Scope}
   */
  #currentScope() {
    return {
      release: this.#configuration.release,
      environment: this.#configuration.environment,
      device: this.#device,
      user: this.#currentUser(),
      url: this.#runtime.location?.href,
      route: this.#callProvider(this.#configuration.routeProvider),
      breadcrumbs: this.#breadcrumbs.snapshot(),
    };
  }

  /**
   * @returns {{ id?: unknown, issuer?: unknown } | null}
   */
  #currentUser() {
    const provided = this.#callProvider(this.#configuration.userProvider);
    if (typeof provided === 'object' && provided !== null) {
      return /** @type {{ id?: unknown, issuer?: unknown }} */ (provided);
    }
    return this.#explicitUser;
  }

  /**
   * @param {(() => unknown) | undefined} provider
   * @returns {unknown}
   */
  #callProvider(provider) {
    if (!provider) {
      return undefined;
    }
    try {
      return provider() ?? undefined;
    } catch (failure) {
      this.#logger.warn('a userProvider or routeProvider threw', failure);
      return undefined;
    }
  }

  /**
   * Remembers `error` as reported. Returns false when it already was, so an
   * error that reaches an HTTP interceptor and then the ErrorHandler, or
   * Angular's global listener and installGlobalHandlers(), is sent once.
   * Primitive values cannot be remembered and always pass.
   *
   * @param {unknown} error
   * @returns {boolean}
   */
  #claimReport(error) {
    if (!canBeRemembered(error)) {
      return true;
    }
    if (this.#reportedErrors.has(error)) {
      return false;
    }
    this.#reportedErrors.add(error);
    return true;
  }

  /**
   * Remembers `error` as seen by the HTTP layer. Returns false when it
   * already was. Primitive values and a missing error always pass.
   *
   * @param {unknown} error
   * @returns {boolean}
   */
  #rememberHttpError(error) {
    if (!canBeRemembered(error)) {
      return true;
    }
    if (this.#httpErrors.has(error)) {
      return false;
    }
    this.#httpErrors.add(error);
    return true;
  }

  /**
   * @returns {import('./event-queue.js').QueueStore}
   */
  #createStore() {
    const { useIndexedDbQueue, source } = this.#configuration;
    if (!useIndexedDbQueue || !this.#runtime.indexedDB) {
      return NULL_STORE;
    }
    return new IndexedDbStore(this.#runtime.indexedDB, queueDatabaseName(source));
  }
}

/**
 * Whether `value` can be kept in a WeakSet: objects and functions can,
 * primitives (a thrown string, undefined) cannot.
 *
 * @param {unknown} value
 * @returns {value is object}
 */
function canBeRemembered(value) {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}
