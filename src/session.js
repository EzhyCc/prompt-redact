import { DEFAULT_MAX_ENTRIES, MAX_TOKEN_COLLISION_RETRY } from './constants.js';

const TYPE_RE = /^[A-Z]{2,12}$/;

/**
 * Generate a cryptographically random token for a valid uppercase type.
 * @param {string} type Token type, consisting of 2–12 uppercase letters.
 * @returns {string} A token in the form `[TYPE_XXXX]`.
 * @throws {TypeError} If type is invalid.
 * @throws {Error} If a secure random number generator is unavailable.
 */
export function randomToken(type) {
  if (typeof type !== 'string' || !TYPE_RE.test(type)) {
    throw new TypeError('type must match /^[A-Z]{2,12}$/');
  }

  const cryptoProvider = globalThis.crypto;
  if (!cryptoProvider || typeof cryptoProvider.getRandomValues !== 'function') {
    throw new Error('A cryptographically secure random number generator is required');
  }

  const random = new Uint16Array(1);
  cryptoProvider.getRandomValues(random);
  const suffix = random[0].toString(16).toUpperCase().padStart(4, '0');
  return `[${type}_${suffix}]`;
}

/**
 * In-memory, session-scoped mapping between original string values and random tokens.
 */
export class Session {
  /** @type {Map<string, string>} */
  #keyToToken = new Map();

  /** @type {Map<string, string>} */
  #tokenToValue = new Map();

  /** @type {number} */
  #maxEntries;

  /**
   * Create an in-memory session.
   * @param {{ maxEntries?: number }} [opts]
   * @throws {TypeError} If maxEntries is not an integer greater than or equal to 1.
   */
  constructor({ maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new TypeError('maxEntries must be an integer greater than or equal to 1');
    }
    this.#maxEntries = maxEntries;
  }

  /**
   * Return the existing token for a value, or create and store a new token.
   * Whitespace and hyphens are removed from the lookup key only; the first
   * encountered string representation is retained for lookup and entries.
   * @param {string} type Token type, consisting of 2–12 uppercase letters.
   * @param {unknown} value Original value; null and undefined are not accepted.
   * @returns {string} The stable token for this type and normalized value.
   * @throws {TypeError} If type or value is invalid.
   * @throws {Error} If a unique token cannot be generated within the retry limit.
   */
  tokenFor(type, value) {
    if (typeof type !== 'string' || !TYPE_RE.test(type)) {
      throw new TypeError('type must match /^[A-Z]{2,12}$/');
    }
    if (value === null || value === undefined) {
      throw new TypeError('value must not be null or undefined');
    }

    const originalValue = String(value);
    const normalizedValue = originalValue.replace(/[\s-]/g, '');
    const key = `${type}|${normalizedValue}`;
    const existingToken = this.#keyToToken.get(key);
    if (existingToken !== undefined) return existingToken;

    let token;
    let retries = 0;
    while (true) {
      const candidate = randomToken(type);
      if (!this.#tokenToValue.has(candidate)) {
        token = candidate;
        break;
      }
      if (retries >= MAX_TOKEN_COLLISION_RETRY) {
        throw new Error(`Unable to generate a unique token after ${MAX_TOKEN_COLLISION_RETRY} retries`);
      }
      retries += 1;
    }

    if (this.#tokenToValue.size >= this.#maxEntries) this.clear();

    this.#keyToToken.set(key, token);
    this.#tokenToValue.set(token, originalValue);
    return token;
  }

  /**
   * Look up the first-seen original string value for a token.
   * @param {string} token Token to look up.
   * @returns {string | undefined} The original string, or undefined when absent.
   */
  lookup(token) {
    return this.#tokenToValue.get(token);
  }

  /**
   * Get the number of active mappings.
   * @returns {number} Current mapping count.
   */
  size() {
    return this.#tokenToValue.size;
  }

  /** Clear all mappings held by this session. @returns {void} */
  clear() {
    this.#keyToToken.clear();
    this.#tokenToValue.clear();
  }

  /**
   * Return a snapshot of `[token, originalValue]` entries.
   * @returns {Array<[string, string]>} A new array containing the active mappings.
   */
  entries() {
    return Array.from(this.#tokenToValue.entries());
  }
}
