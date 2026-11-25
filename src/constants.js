/** @type {Readonly<Record<'high' | 'medium' | 'low', number>>} */
export const SEVERITY_WEIGHT = Object.freeze({ high: 3, medium: 2, low: 1 });

/** @type {ReadonlyArray<'high' | 'medium' | 'low'>} */
export const SEVERITIES = Object.freeze(['high', 'medium', 'low']);

/** @type {ReadonlyArray<'contact' | 'identity' | 'credential' | 'finance' | 'network' | 'custom'>} */
export const CATEGORIES = Object.freeze(['contact', 'identity', 'credential', 'finance', 'network', 'custom']);

/** @type {ReadonlyArray<'format' | 'semantic'>} */
export const TIERS = Object.freeze(['format', 'semantic']);

/**
 * 占位符外形：方括号 + 1–20 个不含方括号和换行的字符，例如 `[手机号]`、`[报价总额_2]`。
 * 不带 g 标志，避免 lastIndex 状态污染；需要全局遍历时用 new RegExp(PLACEHOLDER_SOURCE, 'g')。
 * @type {RegExp}
 */
export const PLACEHOLDER_RE = /\[[^[\]\n]{1,20}\]/;

/** @type {string} */
export const PLACEHOLDER_SOURCE = PLACEHOLDER_RE.source;

/** @type {number} */
export const DEFAULT_MAX_ENTRIES = 500;
