/**
 * The `device` block of the ingest contract for a browser: the browser family
 * and major version, the operating system, the app version and a random
 * per-browser install id. Nothing here fingerprints the user; the install id
 * is a random UUID kept in localStorage so the reports backend can count
 * affected installs.
 */

const INSTALL_ID_STORAGE_KEY = 'systicore-report:install-id';

/** Checked in order: Edge, Opera and Samsung Internet also carry "Chrome/". */
const BROWSER_PATTERNS = [
  { name: 'Edge', pattern: /Edg(?:e|A|iOS)?\/(\d+)/ },
  { name: 'Opera', pattern: /OPR\/(\d+)/ },
  { name: 'Samsung Internet', pattern: /SamsungBrowser\/(\d+)/ },
  { name: 'Firefox', pattern: /(?:Firefox|FxiOS)\/(\d+)/ },
  { name: 'Chrome', pattern: /(?:Chrome|CriOS)\/(\d+)/ },
  { name: 'Safari', pattern: /Version\/(\d+)[\d.]*(?: Mobile\/\S+)? Safari\// },
];

/** Checked in order: iOS says "like Mac OS X" and Android says "Linux". */
const OPERATING_SYSTEM_PATTERNS = [
  { name: 'iOS', pattern: /(?:iPhone|iPad|iPod).*? OS (\d+(?:_\d+)*)/ },
  { name: 'Android', pattern: /Android (\d+(?:\.\d+)*)/ },
  { name: 'Windows', pattern: /Windows NT (\d+\.\d+)/ },
  { name: 'macOS', pattern: /Mac OS X (\d+(?:[._]\d+)*)/ },
  { name: 'ChromeOS', pattern: /CrOS \S+ (\d+(?:\.\d+)*)/ },
  { name: 'Linux', pattern: /Linux/ },
];

/**
 * @typedef {object} DeviceInfo
 * @property {string} [brand] browser family, e.g. "Chrome"
 * @property {string} [model] browser major version, e.g. "128"
 * @property {string} [osVersion] operating system and version, e.g. "Windows 10.0"
 * @property {string} [appVersion]
 * @property {string} [installId]
 */

/**
 * @param {string | undefined} userAgent
 * @param {string | undefined} appVersion
 * @param {string | undefined} installId
 * @returns {DeviceInfo}
 */
export function describeDevice(userAgent, appVersion, installId) {
  const agent = typeof userAgent === 'string' ? userAgent : '';
  const browser = matchFirst(BROWSER_PATTERNS, agent);
  const operatingSystem = matchFirst(OPERATING_SYSTEM_PATTERNS, agent);
  return {
    brand: browser?.name,
    model: browser?.version,
    osVersion: operatingSystem
      ? [operatingSystem.name, operatingSystem.version].filter(Boolean).join(' ')
      : undefined,
    appVersion,
    installId,
  };
}

/**
 * @param {ReadonlyArray<{ name: string, pattern: RegExp }>} candidates
 * @param {string} userAgent
 * @returns {{ name: string, version: string | undefined } | undefined}
 */
function matchFirst(candidates, userAgent) {
  for (const candidate of candidates) {
    const match = candidate.pattern.exec(userAgent);
    if (match) {
      return { name: candidate.name, version: match[1]?.replaceAll('_', '.') };
    }
  }
  return undefined;
}

/**
 * @typedef {object} KeyValueStorage
 * @property {(key: string) => string | null} getItem
 * @property {(key: string, value: string) => void} setItem
 */

/**
 * Returns the install id stored in `storage`, creating and storing one on the
 * first call. Without usable storage (private mode, sandboxed iframe) the id
 * lives for the page only.
 *
 * @param {KeyValueStorage | undefined} storage
 * @param {() => string} createId
 * @returns {string}
 */
export function resolveInstallId(storage, createId) {
  try {
    const stored = storage?.getItem(INSTALL_ID_STORAGE_KEY);
    if (stored) {
      return stored;
    }
  } catch {
    // Storage access can throw (SecurityError); fall back to a page-scoped id.
  }
  const created = createId();
  try {
    storage?.setItem(INSTALL_ID_STORAGE_KEY, created);
  } catch {
    // Quota or access errors only cost the id its persistence.
  }
  return created;
}
