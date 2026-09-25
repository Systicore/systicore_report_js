/**
 * Vue 3 adapter, without importing Vue:
 *
 *   const app = createApp(App);
 *   installVueErrorHandler(app);
 *
 * Reports every error Vue catches (render, watchers, lifecycle hooks, event
 * handlers) and then runs the handler that was installed before, so an
 * existing app.config.errorHandler keeps working.
 */

import { captureException } from './facade.js';

const VUE_ERROR_HANDLER_MECHANISM = 'vue.errorHandler';

/**
 * Production builds of Vue 3.4+ pass a link to the error reference instead
 * of the description, e.g. https://vuejs.org/error-reference/#runtime-1.
 */
const PRODUCTION_ERROR_INFO = /^https:\/\/vuejs\.org\/error-reference\/#([\w-]+)$/;

/** @type {WeakMap<object, () => void>} app config → uninstall of the installed handler */
const installedHandlers = new WeakMap();

/**
 * @typedef {(this: unknown, error: unknown, instance: unknown, info: string) => unknown} VueErrorHandler
 */

/**
 * @param {{ config: { errorHandler?: unknown } }} app a Vue 3 app from createApp()
 * @returns {() => void} restores the previous handler
 */
export function installVueErrorHandler(app) {
  const config = app?.config;
  if (typeof config !== 'object' || config === null) {
    return () => {};
  }
  const installed = installedHandlers.get(config);
  if (installed) {
    return installed;
  }
  const previousHandler = config.errorHandler;

  /** @type {VueErrorHandler} */
  const reportingHandler = function reportingHandler(error, instance, info) {
    captureException(error, {
      route: routeTemplateOf(instance),
      tags: {
        mechanism: VUE_ERROR_HANDLER_MECHANISM,
        'vue.info': errorSourceOf(info),
        'vue.component': componentNameOf(instance),
      },
    });
    if (typeof previousHandler === 'function') {
      return previousHandler.call(this, error, instance, info);
    }
    // Without any errorHandler Vue logs the error itself; keep that visible.
    try {
      globalThis.console?.error(error);
    } catch {
      // A broken console must not turn into a second error.
    }
    return undefined;
  };

  config.errorHandler = reportingHandler;
  const uninstall = () => {
    if (config.errorHandler === reportingHandler) {
      config.errorHandler = previousHandler;
    }
    installedHandlers.delete(config);
  };
  installedHandlers.set(config, uninstall);
  return uninstall;
}

/**
 * Where Vue caught the error: "render function" and the like in development
 * builds, the error code ("runtime-1") in production builds. The code is
 * taken out of the reference link because tag values lose URL fragments.
 *
 * @param {unknown} info
 * @returns {unknown}
 */
function errorSourceOf(info) {
  if (typeof info !== 'string') {
    return info;
  }
  return PRODUCTION_ERROR_INFO.exec(info.trim())?.[1] ?? info;
}

/**
 * The matched vue-router route record's path (a template such as
 * /vault/:id), when the app uses vue-router. `in` checks avoid Vue's
 * "property accessed during render but not defined" warning.
 *
 * @param {unknown} instance the component public instance, or null
 * @returns {string | undefined}
 */
function routeTemplateOf(instance) {
  try {
    if (typeof instance !== 'object' || instance === null || !('$route' in instance)) {
      return undefined;
    }
    const matched = /** @type {{ $route?: { matched?: unknown } }} */ (instance).$route?.matched;
    if (!Array.isArray(matched) || matched.length === 0) {
      return undefined;
    }
    const path = matched[matched.length - 1]?.path;
    return typeof path === 'string' ? path : undefined;
  } catch {
    return undefined;
  }
}

/**
 * @param {unknown} instance
 * @returns {string | undefined}
 */
function componentNameOf(instance) {
  try {
    if (typeof instance !== 'object' || instance === null || !('$options' in instance)) {
      return undefined;
    }
    const options = /** @type {{ $options?: { name?: unknown, __name?: unknown } }} */ (instance)
      .$options;
    const name = options?.name ?? options?.__name;
    return typeof name === 'string' ? name : undefined;
  } catch {
    return undefined;
  }
}
