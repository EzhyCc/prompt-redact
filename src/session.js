import { DEFAULT_MAX_ENTRIES } from './constants.js';

/** 占位符里允许出现的字符：去掉方括号、空白和控制字符。 */
const UNSAFE = /[[\]\s\u0000-\u001F\u007F]/g;
const MAX_NAME_LENGTH = 20;

const FALLBACK = 'REDACTED';

/**
 * 把规则的中文 label 收敛成一个能放进方括号的名字。
 * @param {unknown} input
 * @returns {string}
 */
export function placeholderName(input) {
  const cleaned = String(input ?? '').replace(UNSAFE, '').slice(0, MAX_NAME_LENGTH);
  return cleaned || FALLBACK;
}

/**
 * 组装占位符：第一个是 `[手机号]`，同名的第二个起加序号 `[手机号_2]`。
 * @param {string} base
 * @param {number} index 从 1 开始
 * @returns {string}
 */
export function placeholder(base, index) {
  return index <= 1 ? `[${base}]` : `[${base}_${index}]`;
}

/**
 * 不建会话时用：每次都从 `[手机号]` 开始，不保证跨调用稳定。
 * @param {unknown} name
 * @returns {string}
 */
export function barePlaceholder(name) {
  return placeholder(placeholderName(name), 1);
}

/**
 * 会话级映射：同一个值在同一会话里复用同一个占位符。
 *
 * 占位符是可读的中文标签，不是随机码——因为这份文本常常要被写进正式文档，
 * `[报价总额]` 人能读懂、能手工替换，`[AMOUNT_9F2A]` 不行。
 */
export class Session {
  /** @type {Map<string, string>} 归一化值 → 占位符 */
  #byValue = new Map();

  /** @type {Map<string, string>} 占位符 → 首次见到的原始值 */
  #byPlaceholder = new Map();

  /** @type {Map<string, number>} 标签 → 已用到的最大序号 */
  #counters = new Map();

  /** @type {number} */
  #maxEntries;

  /**
   * @param {{ maxEntries?: number }} [opts]
   * @throws {TypeError} maxEntries 必须是 ≥1 的整数。
   */
  constructor({ maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new TypeError('maxEntries must be an integer greater than or equal to 1');
    }
    this.#maxEntries = maxEntries;
  }

  /**
   * 取得（或新建）某个值对应的占位符。
   * @param {string} name 展示用标签，通常取规则的 label，例如「手机号」。
   * @param {unknown} value 原始值；null / undefined 不接受。
   * @returns {string} 形如 `[手机号]` 或 `[手机号_2]`。
   * @throws {TypeError} value 为 null / undefined 时抛出。
   */
  tokenFor(name, value) {
    if (value === null || value === undefined) {
      throw new TypeError('value must not be null or undefined');
    }

    const base = placeholderName(name);
    const originalValue = String(value);
    const key = `${base}|${originalValue.replace(/[\s-]/g, '')}`;

    const existing = this.#byValue.get(key);
    if (existing !== undefined) return existing;

    if (this.#byPlaceholder.size >= this.#maxEntries) this.clear();

    let index = (this.#counters.get(base) ?? 0) + 1;
    let token = placeholder(base, index);
    while (this.#byPlaceholder.has(token)) {
      index += 1;
      token = placeholder(base, index);
    }

    this.#counters.set(base, index);
    this.#byValue.set(key, token);
    this.#byPlaceholder.set(token, originalValue);
    return token;
  }

  /**
   * @param {string} token
   * @returns {string | undefined} 首次见到的原始值。
   */
  lookup(token) {
    return this.#byPlaceholder.get(token);
  }

  /** @returns {number} 当前映射条数。 */
  size() {
    return this.#byPlaceholder.size;
  }

  /** 清空全部映射。@returns {void} */
  clear() {
    this.#byValue.clear();
    this.#byPlaceholder.clear();
    this.#counters.clear();
  }

  /** @returns {Array<[string, string]>} 占位符 → 原始值 的快照。 */
  entries() {
    return Array.from(this.#byPlaceholder.entries());
  }
}
