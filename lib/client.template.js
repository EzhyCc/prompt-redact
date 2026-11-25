// DSH 客户端插件源码（模板）：在「设置」里加一个「提示词脱敏」分区，内置规则调试器。
//
// `node tools/build-client.mjs` 会把引擎源码和规则注入进来，生成 lib/client.js。
// 改代码请改这里，不要改生成物。
//
// ── 三条铁律（都踩过）──────────────────────────────────────────────
// 1. 格式必须是 window.__ModuleLoader__.load({ id, factory })。
//    这是 DSH 客户端插件的真实契约（文档里的普通 JS 插件范本就是这样），
//    不要改成裸 ESM。
// 2. factory 返回值用 `inject: ['slots']` + `apply`。
//    写成 { required: [], optional: [] } 会让宿主在装载期解析失败。
// 3. 整个 factory 包在 try/catch 里，失败就返回一个空插件。
//    客户端插件在渲染进程里跑，抛出去会连累整个界面；
//    吞掉之后最坏情况只是「设置里没有这一页」，聊天脱敏照常工作。
//    另外不要在 factory 里 require 任何 Harness Client 包（如 ui-primitives），
//    DSH 文档明确禁止：它们随时会变，纯 JS 插件没有类型检查。
window.__ModuleLoader__.load({
  id: 'prompt-redact',
  factory: (require) => {
    try {
      const React = require('react');
      const h = React.createElement;

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

      const box = {
        width: '100%',
        boxSizing: 'border-box',
        font: 'inherit',
        fontSize: 13,
        padding: 8,
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border, rgba(127,127,127,0.35))',
        background: 'transparent',
        color: 'inherit'
      };

      function Debugger() {
        const [text, setText] = React.useState(SAMPLE);
        const [termText, setTermText] = React.useState('');

        const customTerms = React.useMemo(() => parseTerms(termText), [termText]);

        const result = React.useMemo(() => {
          try {
            const session = new Session({ maxEntries: 500 });
            return { output: redact(text, { rules: RULES, session, customTerms }) };
          } catch (error) {
            return { error: error && error.message ? error.message : String(error) };
          }
        }, [text, customTerms]);

        if (result.error) {
          return h('div', { style: { color: 'var(--dsw-alias-danger, #c0392b)', fontSize: 13 } },
            `调试器出错：${result.error}`);
        }

        const hits = result.output.hits;
        const segments = buildSegments(text, hits);

        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12, padding: '4px 0', maxWidth: 900 } }, [
          h('div', { key: 'hint', style: { fontSize: 12, opacity: 0.72 } },
            '左边是你打算发给 AI 的话，下面立刻显示真正会发出去的样子。所有处理都在本地完成，不发任何网络请求。'),

          h('textarea', {
            key: 'input',
            value: text,
            onChange: event => setText(event.target.value),
            rows: 5,
            style: Object.assign({}, box, { resize: 'vertical' })
          }),

          h('input', {
            key: 'terms',
            value: termText,
            onChange: event => setTermText(event.target.value),
            placeholder: '个人词表（可选）：张三, 某某科技',
            style: box
          }),

          h('div', { key: 'preview', style: { fontSize: 13, lineHeight: 1.9 } },
            segments.map((segment, index) => (segment.hit
              ? h('mark', {
                key: index,
                title: `${segment.hit.ruleId} · ${segment.hit.category} · ${segment.hit.severity}`,
                style: { background: '#ffe58f', color: '#1f1f1f', padding: '0 2px', borderRadius: 3 }
              }, segment.text)
              : h('span', { key: index }, segment.text)))),

          h('div', { key: 'out', style: { fontSize: 13 } }, [
            h('div', { key: 'label', style: { fontSize: 12, opacity: 0.72, marginBottom: 4 } }, '实际发给模型的内容：'),
            h('pre', {
              key: 'code',
              style: {
                margin: 0, padding: 10, borderRadius: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                fontSize: 13, background: 'rgba(127,127,127,0.12)'
              }
            }, result.output.text)
          ]),

          h('div', { key: 'hits', style: { fontSize: 12 } }, [
            h('div', { key: 'label', style: { opacity: 0.72, marginBottom: 4 } }, `命中 ${hits.length} 处`),
            hits.length === 0
              ? h('div', { key: 'none', style: { opacity: 0.6 } }, '没有命中任何规则')
              : h('table', { key: 'table', style: { width: '100%', borderCollapse: 'collapse' } }, [
                h('thead', { key: 'head' }, h('tr', {}, [
                  h('th', { key: 'a', style: { textAlign: 'left', padding: '3px 6px', opacity: 0.72 } }, '命中内容'),
                  h('th', { key: 'b', style: { textAlign: 'left', padding: '3px 6px', opacity: 0.72 } }, '占位符'),
                  h('th', { key: 'c', style: { textAlign: 'left', padding: '3px 6px', opacity: 0.72 } }, '规则')
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

      return {
        inject: ['slots'],
        apply(ctx) {
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
        },
        // 仅供自测与排障
        __internals: { redact, scan, resolveConflicts, Session, RULES, buildSegments, Debugger }
      };
    } catch (error) {
      // 任何异常都不能往外抛：客户端插件抛错会连累整个渲染进程
      try {
        console.warn('[prompt-redact] 客户端插件装载失败，设置页不显示调试器：', error && error.message ? error.message : error);
      } catch { /* 连 console 都不给用也要活下来 */ }
      return { inject: [], apply() {} };
    }
  }
});
