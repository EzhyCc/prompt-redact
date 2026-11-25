/** @type {Readonly<Record<'high' | 'medium' | 'low', number>>} */
export const SEVERITY_WEIGHT = Object.freeze({ high: 3, medium: 2, low: 1 });

/** @type {ReadonlyArray<'high' | 'medium' | 'low'>} */
export const SEVERITIES = Object.freeze(['high', 'medium', 'low']);

/** @type {ReadonlyArray<'contact' | 'identity' | 'credential' | 'finance' | 'network' | 'custom'>} */
export const CATEGORIES = Object.freeze(['contact', 'identity', 'credential', 'finance', 'network', 'custom']);

/** @type {ReadonlyArray<'format' | 'semantic'>} */
export const TIERS = Object.freeze(['format', 'semantic']);

/** @type {RegExp} */
export const TOKEN_RE = /\[([A-Z]{2,12})_([0-9A-F]{4})\]/;

/** @type {number} */
export const MAX_TOKEN_COLLISION_RETRY = 16;

/** @type {number} */
export const DEFAULT_MAX_ENTRIES = 500;
