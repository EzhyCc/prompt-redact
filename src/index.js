import { validators } from './validators.js';
import { Session } from './session.js';
import { SEVERITY_WEIGHT } from './constants.js';

/**
 * Scan text with the supplied rules and return candidate hits in original-text coordinates.
 * @param {string} text
 * @param {Array<object>} rules
 * @returns {Array<{ruleId:string,label:string,category:string,severity:string,token:string,start:number,end:number,value:string}>}
 */
export function scan(text, rules) {
  if (typeof text !== 'string' || !Array.isArray(rules) || text.length === 0) return [];
  /** @type {Array<{ruleId:string,label:string,category:string,severity:string,token:string,start:number,end:number,value:string}>} */
  const hits = [];

  for (const rule of rules) {
    if (!rule || !Array.isArray(rule.match)) continue;
    for (const matcher of rule.match) {
      if (!matcher) continue;
      const valueGroup = Number.isInteger(matcher.valueGroup) && matcher.valueGroup > 0
        ? matcher.valueGroup : 0;
      let expression;
      if (matcher.type === 'regex' && typeof matcher.pattern === 'string') {
        expression = new RegExp(matcher.pattern, `g${valueGroup > 0 ? 'd' : ''}`);
      } else if (matcher.type === 'literal' && typeof matcher.value === 'string' && matcher.value.length > 0) {
        const escaped = matcher.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        expression = new RegExp(escaped, 'g');
      } else {
        continue;
      }

      let match;
      while ((match = expression.exec(text)) !== null) {
        if (match[0].length === 0) {
          expression.lastIndex += 1;
          continue;
        }
        const value = match[valueGroup];
        if (typeof value !== 'string' || value.length === 0) continue;
        if (matcher.validate) {
          const validator = Object.hasOwn(validators, matcher.validate) ? validators[matcher.validate] : null;
          if (typeof validator !== 'function' || !validator(value)) continue;
        }
        let start = match.index;
        let end = match.index + match[0].length;
        if (valueGroup > 0) {
          const indices = match.indices && match.indices[valueGroup];
          if (!indices) continue;
          [start, end] = indices;
        }
        hits.push({
          ruleId: rule.id,
          label: rule.label,
          category: rule.category,
          severity: rule.severity,
          token: rule.token,
          start,
          end,
          value
        });
      }
    }
  }
  return hits;
}

/**
 * Resolve overlapping hits deterministically using leftmost, longest, severity, then rule id.
 * @param {Array<object>} hits
 * @returns {Array<object>}
 */
export function resolveConflicts(hits) {
  if (!Array.isArray(hits) || hits.length === 0) return [];
  const sorted = hits.slice().sort((a, b) => {
    const primary = a.start - b.start ||
      (b.end - b.start) - (a.end - a.start) ||
      (SEVERITY_WEIGHT[b.severity] || 0) - (SEVERITY_WEIGHT[a.severity] || 0);
    if (primary !== 0) return primary;
    const leftId = String(a.ruleId);
    const rightId = String(b.ruleId);
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  });
  const kept = [];
  let edge = -1;
  for (const hit of sorted) {
    if (hit.start >= edge) {
      kept.push(hit);
      edge = hit.end;
    }
  }
  return kept;
}

/**
 * Redact supported sensitive values. The returned metadata never contains matched source values.
 * @param {unknown} text
 * @param {{rules?:Array<object>,session?:({tokenFor:(type:string,value:string)=>string}|null),enableSemantic?:boolean,customTerms?:string[],maxEntries?:number}} [opts]
 * @returns {{text:string,hits:Array<{ruleId:string,label:string,category:string,severity:string,token:string,start:number,end:number}>,blocked:boolean,residuals:Array<{ruleId:string,label:string,severity:string}>,stats:{total:number,byCategory:Record<string,number>}}}
 */
export function redact(text, opts = {}) {
  const empty = () => ({ text: '', hits: [], blocked: false, residuals: [], stats: { total: 0, byCategory: {} } });
  if (typeof text !== 'string') return empty();
  const suppliedRules = Array.isArray(opts.rules) ? opts.rules : [];
  if (suppliedRules.length === 0) {
    return { text, hits: [], blocked: false, residuals: [], stats: { total: 0, byCategory: {} } };
  }

  const activeRules = suppliedRules.filter(rule => rule && (rule.tier !== 'semantic' || opts.enableSemantic === true));
  const terms = Array.isArray(opts.customTerms) ? opts.customTerms.filter(value => typeof value === 'string' && Boolean(value)) : [];
  if (terms.length > 0) {
    activeRules.push({
      id: 'user-term', label: '自定义词', category: 'custom', tier: 'format',
      severity: 'high', token: 'TERM',
      match: terms.map(value => ({ type: 'literal', value }))
    });
  }

  const candidates = resolveConflicts(scan(text, activeRules));
  // 没有传入会话时自己建一个临时的：同一次调用内同一个值仍然共用一个占位符。
  const runSession = opts.session ?? new Session({ maxEntries: opts.maxEntries ?? 500 });

  let cursor = 0;
  let output = '';
  const safeHits = [];
  const tokenSpans = [];
  const byCategory = {};
  for (const hit of candidates) {
    output += text.slice(cursor, hit.start);
    const token = runSession.tokenFor(hit.label || hit.token, hit.value);
    tokenSpans.push([output.length, output.length + token.length]);
    output += token;
    cursor = hit.end;
    safeHits.push({
      ruleId: hit.ruleId, label: hit.label, category: hit.category,
      severity: hit.severity, token, start: hit.start, end: hit.end
    });
    byCategory[hit.category] = (byCategory[hit.category] || 0) + 1;
  }
  output += text.slice(cursor);

  // 二次扫描是保险丝：正常路径下不该触发，它防的是「某条规则命中了自己产出的占位符」。
  // 做法不是把占位符遮蔽成 #（那样 密码：xxx 这类关键词锚定规则会改吃 ###### 而误报），
  // 而是把刚才记下的区间过滤掉——占位符的坐标在拼装时就已知，不需要再用正则去找。
  const residuals = scan(output, activeRules)
    .filter(hit => hit.severity === 'high')
    .filter(hit => !tokenSpans.some(([start, end]) => hit.start < end && hit.end > start))
    .map(hit => ({ ruleId: hit.ruleId, label: hit.label, severity: hit.severity }));
  return {
    text: output,
    hits: safeHits,
    blocked: residuals.length > 0,
    residuals,
    stats: { total: safeHits.length, byCategory }
  };
}
