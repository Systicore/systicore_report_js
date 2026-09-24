/**
 * Vue 3 adapter of @systicore/report. It imports nothing from Vue; any app
 * returned by createApp() fits VueAppLike.
 */

export interface VueAppLike {
  config: { errorHandler?: unknown };
}

/**
 * Sets app.config.errorHandler to report every error Vue catches, then calls
 * the handler that was installed before (or logs the error when there was
 * none). Idempotent per app.
 * @returns a function that restores the previous handler
 */
export declare function installVueErrorHandler(app: VueAppLike): () => void;
