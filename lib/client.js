// DSH 客户端插件：在「设置」里加一个「提示词脱敏」分区，内置规则调试器。
//
// 这份是**模板**，`node tools/build-client.mjs` 会把引擎源码和规则注入进来，
// 生成 `lib/client.js`（真正被 DSH 加载的那份）。改代码请改这里，不要改生成物。
//
// 为什么要把引擎塞进来：客户端插件运行在渲染进程，只能 require 宿主白名单里的模块
// （react / react-dom / @deepseek-ai/dsh-client-ui-primitives），读不到仓库里的文件。
// 所以匹配逻辑和规则必须在构建时内联。
window.__ModuleLoader__.load({
  id: 'prompt-redact',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require('react');
    const h = React.createElement;
    let primitives = {};
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives') || {};
    } catch {
      primitives = {};
    }

/** @type {Readonly<Record<'high' | 'medium' | 'low', number>>} */
const SEVERITY_WEIGHT = Object.freeze({ high: 3, medium: 2, low: 1 });

/** @type {ReadonlyArray<'high' | 'medium' | 'low'>} */
const SEVERITIES = Object.freeze(['high', 'medium', 'low']);

/** @type {ReadonlyArray<'contact' | 'identity' | 'credential' | 'finance' | 'network' | 'custom'>} */
const CATEGORIES = Object.freeze(['contact', 'identity', 'credential', 'finance', 'network', 'custom']);

/** @type {ReadonlyArray<'format' | 'semantic'>} */
const TIERS = Object.freeze(['format', 'semantic']);

/**
 * 占位符外形：方括号 + 1–20 个不含方括号和换行的字符，例如 `[手机号]`、`[报价总额_2]`。
 * 不带 g 标志，避免 lastIndex 状态污染；需要全局遍历时用 new RegExp(PLACEHOLDER_SOURCE, 'g')。
 * @type {RegExp}
 */
const PLACEHOLDER_RE = /\[[^[\]\n]{1,20}\]/;

/** @type {string} */
const PLACEHOLDER_SOURCE = PLACEHOLDER_RE.source;

/** @type {number} */
const DEFAULT_MAX_ENTRIES = 500;

/** Pure validators for Prompt Redact. Zero runtime dependencies. */

/** @param {unknown} value @returns {boolean} */
function luhn(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return false;
  const digits = String(value).replace(/[^0-9]/g, '');
  if (digits.length < 12) return false;
  let sum = 0;
  let doubleDigit = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let digit = digits.charCodeAt(i) - 48;
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}

/** @param {unknown} value @returns {boolean} */
function cnMobile(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return false;
  return /^1[3-9][0-9]{9}$/.test(String(value).replace(/[\s-]/g, ''));
}

/** @param {unknown} value @returns {boolean} */
function cnIdCard(value) {
  if (typeof value !== 'string' || !/^[0-9]{17}[0-9Xx]$/.test(value)) return false;
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const checkChars = '10X98765432';
  let sum = 0;
  for (let i = 0; i < 17; i += 1) {
    sum += (value.charCodeAt(i) - 48) * weights[i];
  }
  return checkChars[sum % 11] === value[17].toUpperCase();
}

/** @param {unknown} value @returns {boolean} */
function cnUscc(value) {
  if (typeof value !== 'string' || value.length !== 18) return false;
  const charset = '0123456789ABCDEFGHJKLMNPQRTUWXY';
  const weights = [1, 3, 9, 27, 135, 405, 1215, 3645, 10935, 32805, 98415, 295245, 885735, 2657205, 7971615, 23914845, 71744535];
  let sum = 0;
  for (let i = 0; i < 17; i += 1) {
    const index = charset.indexOf(value[i]);
    if (index === -1) return false;
    sum += index * weights[i];
  }
  if (charset.indexOf(value[17]) === -1) return false;
  return charset[(31 - (sum % 31)) % 31] === value[17];
}

/** @param {unknown} value @returns {boolean} */
function ipv4(value) {
  if (typeof value !== 'string') return false;
  const parts = value.split('.');
  if (parts.length !== 4) return false;
  for (const part of parts) {
    if (!/^[0-9]{1,3}$/.test(part)) return false;
    if (Number(part) > 255) return false;
  }
  return true;
}

/** @type {Readonly<Record<string, (value: unknown) => boolean>>} */
const validators = Object.freeze({ cnMobile, cnIdCard, cnUscc, luhn, ipv4 });

/** 占位符里允许出现的字符：去掉方括号、空白和控制字符。 */
const UNSAFE = /[[\]\s\u0000-\u001F\u007F]/g;
const MAX_NAME_LENGTH = 20;

const FALLBACK = 'REDACTED';

/**
 * 把规则的中文 label 收敛成一个能放进方括号的名字。
 * @param {unknown} input
 * @returns {string}
 */
function placeholderName(input) {
  const cleaned = String(input ?? '').replace(UNSAFE, '').slice(0, MAX_NAME_LENGTH);
  return cleaned || FALLBACK;
}

/**
 * 组装占位符：第一个是 `[手机号]`，同名的第二个起加序号 `[手机号_2]`。
 * @param {string} base
 * @param {number} index 从 1 开始
 * @returns {string}
 */
function placeholder(base, index) {
  return index <= 1 ? `[${base}]` : `[${base}_${index}]`;
}

/**
 * 不建会话时用：每次都从 `[手机号]` 开始，不保证跨调用稳定。
 * @param {unknown} name
 * @returns {string}
 */
function barePlaceholder(name) {
  return placeholder(placeholderName(name), 1);
}

/**
 * 会话级映射：同一个值在同一会话里复用同一个占位符。
 *
 * 占位符是可读的中文标签，不是随机码——因为这份文本常常要被写进正式文档，
 * `[报价总额]` 人能读懂、能手工替换，`[AMOUNT_9F2A]` 不行。
 */
class Session {
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

/**
 * Scan text with the supplied rules and return candidate hits in original-text coordinates.
 * @param {string} text
 * @param {Array<object>} rules
 * @returns {Array<{ruleId:string,label:string,category:string,severity:string,token:string,start:number,end:number,value:string}>}
 */
function scan(text, rules) {
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
        // 已经是占位符的值不再处理：`密码：xxx` 这种关键词锚定规则会把冒号后面的
        // 任何内容当成值，包括上一轮自己产出的 `[手机号]`、`[PASSWORD_DB67]`。
        // 不挡的话，对已脱敏文本再跑一次会把它替换成规则自己的标签，映射就断了。
        // 用前缀匹配而不是整串匹配：宽松的规则可能把占位符后面的标点一起吞进来。
        if (/^\[[^[\]\n]{1,20}\]/.test(value)) continue;
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
function resolveConflicts(hits) {
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
function redact(text, opts = {}) {
  const empty = () => ({ text: '', hits: [], blocked: false, residuals: [], stats: { total: 0, byCategory: {} } });
  if (typeof text !== 'string') return empty();
  const suppliedRules = Array.isArray(opts.rules) ? opts.rules : [];
  if (suppliedRules.length === 0) {
    return { text, hits: [], blocked: false, residuals: [], stats: { total: 0, byCategory: {} } };
  }

  const activeRules = suppliedRules.filter(rule => rule && (rule.tier !== 'semantic' || opts.enableSemantic === true));

  // 个人词表支持两种写法：
  //   ["张三", "某某科技"]                      → 占位符统一是 [自定义词]
  //   { "某某科技": "客户", "某某医院": "医院" }   → 占位符是 [客户]、[医院]
  // 命名版本读起来好得多，正式文档里 `[客户]` 比 `[自定义词_4]` 有用。
  const termGroups = new Map();
  const addTerm = (value, label) => {
    if (typeof value !== 'string' || !value.trim()) return;
    const name = String(label ?? '').trim() || '自定义词';
    if (!termGroups.has(name)) termGroups.set(name, []);
    termGroups.get(name).push({ type: 'literal', value: value.trim() });
  };

  if (Array.isArray(opts.customTerms)) {
    for (const item of opts.customTerms) {
      if (typeof item === 'string') addTerm(item, '自定义词');
      else if (item && typeof item === 'object') addTerm(item.value, item.label);
    }
  } else if (opts.customTerms && typeof opts.customTerms === 'object') {
    for (const [value, label] of Object.entries(opts.customTerms)) addTerm(value, label);
  }

  let termIndex = 0;
  for (const [label, match] of termGroups) {
    termIndex += 1;
    activeRules.push({
      id: `user-term:${termIndex}`, label, category: 'custom', tier: 'format',
      severity: 'high', token: 'TERM', match
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

    const RULES = [{"id":"money-quote","label":"报价总额","category":"finance","tier":"format","severity":"high","token":"AMOUNT","match":[{"type":"regex","pattern":"(?:报价|总价|合同额|合同金额|预算|标底|底价|成交价|投标价|中标价)(?:总额|金额|合计|价|款)?[ ]?[:：]?[ ]?[¥￥]?([0-9][0-9,]{1,15}(?:[.][0-9]{1,2})?)","valueGroup":1}],"note":"商务文档里最该保护的一类：底价泄漏不可逆。关键词后面允许再跟「总额/金额/合计/价/款」，否则「报价总额：248000」这种最常见写法会漏掉（踩过）。要求至少两位数字，避免把「报价需在 3 日内确认」里的计数当成金额。已知误报：预算 2026 年 会把年份当成金额。"},{"id":"money-unit","label":"单价","category":"finance","tier":"format","severity":"high","token":"UNITPRICE","match":[{"type":"regex","pattern":"(?:单价|单位价格)[ ]?[:：]?[ ]?[¥￥]?([0-9][0-9,]{0,12}(?:[.][0-9]{1,2})?)","valueGroup":1}],"note":"单价通常比总额更能反推出成本结构，单独列一条以便占位符显示为「单价」而不是「报价总额」。"},{"id":"money-cost","label":"成本价","category":"finance","tier":"format","severity":"high","token":"COST","match":[{"type":"regex","pattern":"(?:成本价|成本|进价|采购价)[ ]?[:：]?[ ]?[¥￥]?([0-9][0-9,]{0,12}(?:[.][0-9]{1,2})?)","valueGroup":1}],"note":"成本价一旦随标书外发，等于把利润空间交给对手。已知误报：「成本控制」「成本分析」后面紧跟数字时可能命中。"},{"id":"money-rate","label":"利润率","category":"finance","tier":"format","severity":"high","token":"RATE","match":[{"type":"regex","pattern":"(?:利润率|毛利率|净利率|折扣率|返点率|返点)[ ]?[:：]?[ ]?([0-9]{1,3}(?:[.][0-9]{1,2})?[ ]?[%％])","valueGroup":1}],"note":"只认带百分号的比率，避免把「返点 3 个点」里的 3 当成比率。"},{"id":"bid-number","label":"项目编号","category":"identity","tier":"format","severity":"medium","token":"BIDNO","match":[{"type":"regex","pattern":"(?:项目|招标|投标|标书|采购|合同|订单)(?:编号|编码|号)[ ]?[:：]?[ ]?([A-Za-z0-9][A-Za-z0-9_/-]{2,30})","valueGroup":1}],"note":"编号本身往往能反查到项目和客户，属于准标识符。要求值以字母或数字开头且至少 3 位，避免命中「项目编号待定」这类占位文字。"},{"id":"tax-id","label":"税号","category":"identity","tier":"format","severity":"high","token":"TAXID","match":[{"type":"regex","pattern":"(?:税号|纳税人识别号)[ ]?[:：]?[ ]?([0-9A-Za-z]{15,20})","valueGroup":1}],"note":"税号有时是 15 位老税号、有时是 18 位统一社会信用代码、有时是 20 位，所以不复用 cn-uscc 的校验位判断，改由关键词锚定。故意不把「统一社会信用代码」写进关键词，否则会抢走 cn-uscc 的标签。"},{"id":"cn-mobile","label":"手机号","category":"contact","tier":"format","severity":"high","token":"PHONE","match":[{"type":"regex","pattern":"(?<![0-9])1[3-9][0-9][- ]?[0-9]{4}[- ]?[0-9]{4}(?![0-9])","validate":"cnMobile"}],"note":"按大陆手机号号段和 11 位结构识别；可能误报格式恰好相同的测试号码或虚构号码。"},{"id":"email","label":"邮箱","category":"contact","tier":"format","severity":"medium","token":"EMAIL","match":[{"type":"regex","pattern":"(?<![A-Za-z0-9:/])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}[.][A-Za-z]{2,24}"}],"note":"识别常见 ASCII 邮箱；可能误报示例地址、文档占位地址或不实际存在的邮箱。"},{"id":"qq","label":"QQ号","category":"contact","tier":"format","severity":"low","token":"QQ","match":[{"type":"regex","pattern":"(?:QQ|qq)[:：]?[ ]?([1-9][0-9]{4,10})","valueGroup":1}],"note":"要求 QQ/qq 标签锚定并只替换号码捕获组；可能误报文档中的示例 QQ 号。"},{"id":"wechat","label":"微信号","category":"contact","tier":"format","severity":"medium","token":"WECHAT","match":[{"type":"regex","pattern":"(?:微信|WeChat|wechat|VX|vx)[号]?[:：]?[ ]?([A-Za-z][-_A-Za-z0-9]{5,19})","valueGroup":1}],"note":"要求微信或 VX 标签锚定并只替换账号；可能误报示例账号或紧随标签的普通英文单词。"},{"id":"openai-key","label":"OpenAI 密钥","category":"credential","tier":"format","severity":"high","token":"APIKEY","match":[{"type":"regex","pattern":"(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{16,256}(?![A-Za-z0-9_-])"}],"note":"识别 sk- 前缀的长密钥样式并限制长度；可能误报文档中的伪造密钥或示例串。"},{"id":"anthropic-key","label":"Anthropic 密钥","category":"credential","tier":"format","severity":"high","token":"APIKEY","match":[{"type":"regex","pattern":"(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{16,256}(?![A-Za-z0-9_-])"}],"note":"识别 sk-ant- 前缀的长密钥样式并限制长度；可能误报文档中的伪造密钥或示例串。"},{"id":"github-token","label":"GitHub 令牌","category":"credential","tier":"format","severity":"high","token":"TOKEN","match":[{"type":"regex","pattern":"(?<![A-Za-z0-9_])gh[pousr]_[A-Za-z0-9]{20,128}(?![A-Za-z0-9])"}],"note":"识别 GitHub 令牌前缀及较长随机串；可能误报公开文档中的占位令牌。"},{"id":"aws-access-key","label":"AWS Access Key","category":"credential","tier":"format","severity":"high","token":"TOKEN","match":[{"type":"regex","pattern":"(?<![A-Z0-9])AKIA[0-9A-Z]{16}(?![A-Z0-9])"}],"note":"识别 AWS 常见 Access Key ID 结构；该 ID 本身不等同于 Secret Access Key，可能误报示例值。"},{"id":"google-api-key","label":"Google 密钥","category":"credential","tier":"format","severity":"high","token":"APIKEY","match":[{"type":"regex","pattern":"(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])"}],"note":"识别常见 Google API key 固定前缀和长度；可能误报公开示例或测试密钥。"},{"id":"slack-token","label":"Slack 令牌","category":"credential","tier":"format","severity":"high","token":"TOKEN","match":[{"type":"regex","pattern":"(?<![A-Za-z0-9])xox[abprs]-[0-9A-Za-z-]{10,160}(?![A-Za-z0-9-])"}],"note":"识别 Slack xox 系列令牌；可能误报文档占位串或非真实测试串。"},{"id":"jwt","label":"JWT","category":"credential","tier":"format","severity":"high","token":"JWT","match":[{"type":"regex","pattern":"(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,2048}[.][A-Za-z0-9_-]{10,2048}[.][A-Za-z0-9_-]{10,2048}(?![A-Za-z0-9_-])"}],"note":"识别三段式 JWT 外形；不验证签名和 claims，可能误报仿 JWT 的示例字符串。"},{"id":"private-key","label":"PEM 私钥","category":"credential","tier":"format","severity":"high","token":"PRIVATEKEY","match":[{"type":"regex","pattern":"-----BEGIN ([A-Z ]{0,40}PRIVATE KEY)-----[\\s\\S]{1,8000}?-----END \\1-----"}],"note":"通过回引用确保 BEGIN/END 的密钥类型一致；内容长度限制为 1–8000 字符。可能误报文档中的示例块，不验证密钥是否真实可用。"},{"id":"password-kv","label":"口令","category":"credential","tier":"format","severity":"high","token":"PASSWORD","match":[{"type":"regex","pattern":"(?:密码|口令|[Pp]assword|[Pp]asswd|[Pp]wd)[ ]?[:：=][ ]?([^ \\n，。；！？、）】」》]{3,64})","valueGroup":1}],"note":"由密码关键词锚定，只替换捕获的口令值。剔除中文标点，否则「密码：xxx，电话 yyy」会把逗号后面的内容一起吞掉。可能误报说明文字、示例密码。"},{"id":"db-uri","label":"数据库连接串","category":"credential","tier":"format","severity":"high","token":"DBURI","match":[{"type":"regex","pattern":"(?:mysql|postgres|postgresql|mongodb|redis|amqp)(?:[+]srv)?://[^ \\n:@/]{1,64}:[^ \\n@/]{1,128}@[^ \\n，。；！？、）】」》]{1,255}"}],"note":"整段匹配常见含用户名和密码的数据库 URI；可能误报示例连接串，暂不覆盖所有 URI 参数和 IPv6 形式。 库名和查询参数一并吞掉，靠中文标点和换行收尾。"},{"id":"bearer-token","label":"Bearer 令牌","category":"credential","tier":"format","severity":"high","token":"TOKEN","match":[{"type":"regex","pattern":"[Bb]earer[ ]+[A-Za-z0-9._-]{16,512}(?![A-Za-z0-9._-])"}],"note":"识别 Bearer 后的长 token；可能误报文档中的示例令牌或测试串。"},{"id":"bank-card","label":"银行卡号","category":"finance","tier":"format","severity":"high","token":"CARD","match":[{"type":"regex","pattern":"(?<![0-9A-Za-z])[0-9](?:[ -]?[0-9]){14,18}(?![0-9A-Za-z])","validate":"luhn"}],"note":"匹配 15–19 位数字并用 Luhn 校验；可能误报恰好通过 Luhn 的长编号，订单号等通常会被校验排除。"},{"id":"cn-bank-account","label":"银行账号","category":"finance","tier":"format","severity":"high","token":"ACCOUNT","match":[{"type":"regex","pattern":"(?:账号|卡号|账户|对公账号)[ ]?[:：]?[ ]?([0-9]{12,25})","valueGroup":1}],"note":"要求账号/账户关键词锚定，仅替换 12–25 位数字捕获组；可能误报标签后面的企业内部长编号。"},{"id":"cvv","label":"CVV","category":"finance","tier":"format","severity":"high","token":"CVV","match":[{"type":"regex","pattern":"(?:CVV2?|CVC2?|安全码)[ ]?[:：]?[ ]?([0-9]{3,4})(?![0-9])","valueGroup":1}],"note":"要求 CVV/CVC/安全码标签锚定，仅替换 3–4 位值；可能误报测试文档中的安全码示例或其他三四位验证码。"},{"id":"cn-id-card","label":"身份证","category":"identity","tier":"format","severity":"high","token":"IDCARD","match":[{"type":"regex","pattern":"(?<![0-9A-Za-z])[1-9][0-9]{5}(?:19|20)[0-9]{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12][0-9]|3[01])[0-9]{3}[0-9Xx](?![0-9A-Za-z])","validate":"cnIdCard"}],"note":"限定常见 18 位大陆身份证结构并用校验位复核；仍可能命中合成测试号，生日日期的完整日历合法性由校验器负责。"},{"id":"cn-uscc","label":"统一社会信用代码","category":"identity","tier":"format","severity":"medium","token":"USCC","match":[{"type":"regex","pattern":"(?<![0-9A-Za-z])[0-9A-HJ-NPQRTUWXY]{2}[0-9]{6}[0-9A-HJ-NPQRTUWXY]{10}(?![0-9A-Za-z])","validate":"cnUscc"}],"note":"限定 18 位统一社会信用代码字符集并执行校验；可能命中测试或示例代码。"},{"id":"cn-passport","label":"护照号","category":"identity","tier":"format","severity":"medium","token":"PASSPORT","match":[{"type":"regex","pattern":"(?<![A-Za-z0-9])[EGDSP][0-9]{8}(?![A-Za-z0-9])"}],"note":"覆盖常见中国护照号码形式；可能误报以 E/G/D/S/P 开头的业务编号。"},{"id":"cn-license-plate","label":"车牌","category":"identity","tier":"format","severity":"medium","token":"PLATE","match":[{"type":"regex","pattern":"[京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼][A-HJ-NP-Z][A-HJ-NP-Z0-9]{5,6}"}],"note":"覆盖常见民用车牌字符形态；未校验新能源/特殊号牌全部规则，可能误报模拟车牌或编码。"},{"id":"employee-id","label":"工号/学号","category":"identity","tier":"format","severity":"low","token":"EMPID","match":[{"type":"regex","pattern":"(?:工号|学号|员工号|员工编号|工牌号)[ ]?[:：]?[ ]?([A-Za-z0-9-]{3,20})","valueGroup":1}],"note":"必须由工号/学号等关键词锚定，仅替换捕获组；可能误报关键词后面的普通短编号。"},{"id":"ipv4","label":"IP 地址","category":"network","tier":"format","severity":"low","token":"IP","match":[{"type":"regex","pattern":"(?<![0-9.])[0-9]{1,3}(?:[.][0-9]{1,3}){3}(?![0-9.])","validate":"ipv4"}],"note":"识别点分四段 IPv4 并由 ipv4 校验每段范围；可能误报版本号或普通四段数字，但校验器只排除越界地址。"},{"id":"cn-company-name","label":"公司名","category":"identity","tier":"semantic","severity":"medium","token":"COMPANY","match":[{"type":"regex","pattern":"[一-龥A-Za-z0-9（）]{2,20}(?:股份有限公司|有限责任公司|有限公司|集团)"}],"note":"语义类规则默认关闭。开启后会把“帮我分析深圳市××科技有限公司的供应链风险”里的公司名也替换，导致需求失效；仅供用户手动开启。可能误报需要分析、比较或公开讨论的公司名称。"}];

    const SAMPLE = '联系人张三，手机 13800138000，身份证 110101199003071233，合同金额 1,280,000 元。';

    /** 把命中片段切成「普通段 / 高亮段」，用来做预览。 */
    function buildSegments(text, hits) {
      const segments = [];
      let cursor = 0;
      for (const hit of hits) {
        if (hit.start > cursor) segments.push({ text: text.slice(cursor, hit.start), hit: null });
        segments.push({ text: text.slice(hit.start, hit.end), hit });
        cursor = hit.end;
      }
      if (cursor < text.length) segments.push({ text: text.slice(cursor), hit: null });
      return segments;
    }

    function parseTerms(raw) {
      return String(raw || '')
        .split(/[,，]/)
        .map(item => item.trim())
        .filter(Boolean);
    }

    function Debugger() {
      const [text, setText] = React.useState(SAMPLE);
      const [termText, setTermText] = React.useState('');

      const customTerms = React.useMemo(() => parseTerms(termText), [termText]);

      const result = React.useMemo(() => {
        try {
          const session = new Session({ maxEntries: 500 });
          const output = redact(text, { rules: RULES, session, customTerms });
          return { output, session };
        } catch (error) {
          return { error: error && error.message ? error.message : String(error) };
        }
      }, [text, customTerms]);

      const safe = result.error ? null : result.output;
      const hits = safe ? safe.hits : [];

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12, padding: '4px 0' } }, [
        h('div', { key: 'hint', style: { fontSize: 12, opacity: 0.7 } },
          '左边是你打算发给 AI 的话，下面立刻显示真正会发出去的样子。所有处理都在本地完成。'),

        h('textarea', {
          key: 'input',
          value: text,
          onChange: event => setText(event.target.value),
          rows: 5,
          style: {
            width: '100%', boxSizing: 'border-box', font: 'inherit', fontSize: 13,
            padding: 8, borderRadius: 6, resize: 'vertical'
          }
        }),

        h('input', {
          key: 'terms',
          value: termText,
          onChange: event => setTermText(event.target.value),
          placeholder: '个人词表（可选）：张三, 某某科技',
          style: { width: '100%', boxSizing: 'border-box', font: 'inherit', fontSize: 13, padding: 8, borderRadius: 6 }
        }),

        result.error
          ? h('div', { key: 'err', style: { color: '#c0392b', fontSize: 13 } }, `出错：${result.error}`)
          : h('div', { key: 'preview', style: { fontSize: 13, lineHeight: 1.8 } },
            buildSegments(text, hits).map((segment, index) => (segment.hit
              ? h('mark', {
                key: index,
                title: `${segment.hit.ruleId} · ${segment.hit.category} · ${segment.hit.severity}`,
                style: { background: '#ffe58f', padding: '0 2px', borderRadius: 3 }
              }, segment.text)
              : h('span', { key: index }, segment.text)))),

        !result.error && h('div', { key: 'out', style: { fontSize: 13 } }, [
          h('div', { key: 'label', style: { fontSize: 12, opacity: 0.7, marginBottom: 4 } }, '实际发给模型的内容：'),
          h('pre', {
            key: 'code',
            style: {
              margin: 0, padding: 10, borderRadius: 6, background: 'rgba(127,127,127,0.12)',
              whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 13
            }
          }, safe ? safe.text : '')
        ]),

        !result.error && h('div', { key: 'hits', style: { fontSize: 12 } }, [
          h('div', { key: 'label', style: { opacity: 0.7, marginBottom: 4 } },
            `命中 ${hits.length} 处`),
          hits.length === 0
            ? h('div', { key: 'none', style: { opacity: 0.6 } }, '没有命中任何规则')
            : h('table', { key: 'table', style: { width: '100%', borderCollapse: 'collapse' } }, [
              h('thead', { key: 'head' }, h('tr', {}, [
                h('th', { key: 'a', style: { textAlign: 'left', padding: '3px 6px', opacity: 0.7 } }, '命中内容'),
                h('th', { key: 'b', style: { textAlign: 'left', padding: '3px 6px', opacity: 0.7 } }, '占位符'),
                h('th', { key: 'c', style: { textAlign: 'left', padding: '3px 6px', opacity: 0.7 } }, '规则')
              ])),
              h('tbody', { key: 'body' }, hits.map((hit, index) => h('tr', { key: index }, [
                h('td', { key: 'v', style: { padding: '3px 6px' } }, hit.value),
                h('td', { key: 'l', style: { padding: '3px 6px' } }, hit.label),
                h('td', { key: 'r', style: { padding: '3px 6px', opacity: 0.75 } }, hit.ruleId)
              ])))
            ])
        ])
      ]);
    }

    function apply(ctx) {
      if (!ctx || !ctx.slots || typeof ctx.slots.register !== 'function') return;

      ctx.slots.inject('settings.section', () => ctx.slots.register(
        {
          name: 'settings.section',
          id: 'prompt-redact',
          order: 60,
          label: () => '提示词脱敏'
        },
        Debugger
      ));
    }

    exports.apply = apply;
    exports.inject = { required: [], optional: [] };
    exports.Debugger = Debugger;
    // 仅供自测与排障：让 Node 侧的测试能在不启动 DSH 的情况下验证引擎确实被内联进来了
    exports.__internals = { redact, scan, resolveConflicts, Session, RULES, buildSegments };
    return module.exports;
  }
});
