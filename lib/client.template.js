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

    /*__ENGINE_START__*/
    /*__ENGINE_END__*/

    const RULES = /*__RULES__*/ [];

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
