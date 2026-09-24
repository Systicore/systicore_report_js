/**
 * Browser events that move the queue: coming back online replays it, and
 * the page being hidden or unloaded sends it with requests that outlive the
 * page.
 */

import { listen } from './listen.js';

/**
 * @param {import('./runtime.js').Runtime} runtime
 * @param {{ drain(): Promise<void>, flushOnPageHide(): void }} dispatcher
 * @returns {() => void} detaches every listener
 */
export function attachDeliveryTriggers(runtime, dispatcher) {
  const documentTarget = runtime.documentTarget;
  const detachers = [
    listen(runtime.windowTarget, 'online', () => void dispatcher.drain()),
    listen(runtime.windowTarget, 'pagehide', () => dispatcher.flushOnPageHide()),
    listen(documentTarget, 'visibilitychange', () => {
      if (documentTarget?.visibilityState === 'hidden') {
        dispatcher.flushOnPageHide();
      }
    }),
  ];
  return () => {
    for (const detach of detachers) {
      detach();
    }
  };
}
