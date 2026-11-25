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

      // ── 设置：通过宿主侧 `/prompt-redact-api` 读写 config.json ──────────
      // 客户端跑在渲染进程里，没有文件写权限，所以只能走宿主注册的 HTTP 端点。
      const API = '/prompt-redact-api';

      const TOGGLES = [
        { key: 'enabled', label: '总开关', hint: '关掉后请求原样透传，一个字节都不改' },
        { key: 'redactSessionLog', label: '界面也显示占位符', hint: '让你自己发的那条消息在气泡里也变成占位符' },
        { key: 'redactToolResults', label: '工具结果也脱敏', hint: '副作用：模型正在改的代码字面量也会被替换' },
        { key: 'enableSemantic', label: '语义规则（机构名）', hint: '会把「分析某某公司的风险」里的公司名也换掉' }
      ];

      function SettingsPanel(props) {
        const { config, onSaved } = props;
        const [draft, setDraft] = React.useState(null);
        const [busy, setBusy] = React.useState(false);
        const [message, setMessage] = React.useState(null);
        const [termText, setTermText] = React.useState('');

        React.useEffect(() => {
          if (!config) return;
          setDraft({ ...config });
          setTermText((config.customTerms || []).join(', '));
        }, [config]);

        if (!config || !draft) {
          return h('div', { style: { fontSize: 12, opacity: 0.7 } }, '设置读取中…');
        }

        const save = async patch => {
          setBusy(true);
          setMessage(null);
          try {
            const response = await fetch(API, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ settings: patch })
            });
            const data = await response.json();
            if (!data || data.ok !== true) throw new Error((data && data.error) || '保存失败');
            setDraft({ ...data.settings });
            onSaved(data.settings);
            const rejected = data.rejected && data.rejected.length ? `（被忽略：${data.rejected.join('、')}）` : '';
            setMessage({ kind: 'ok', text: `已保存${rejected}` });
          } catch (error) {
            setMessage({ kind: 'bad', text: `保存失败：${error.message}` });
          } finally {
            setBusy(false);
          }
        };

        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } }, [
          h('div', { key: 'title', style: { fontSize: 13, fontWeight: 600 } }, '设置'),

          ...TOGGLES.map(item => h('label', {
            key: item.key,
            style: { display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13, cursor: busy ? 'default' : 'pointer' }
          }, [
            h('input', {
              key: 'box',
              type: 'checkbox',
              checked: draft[item.key] === true,
              disabled: busy,
              onChange: event => {
                const next = { ...draft, [item.key]: event.target.checked };
                setDraft(next);
                save({ [item.key]: event.target.checked });
              },
              style: { marginTop: 2 }
            }),
            h('span', { key: 'text' }, [
              h('span', { key: 'label' }, item.label),
              h('span', { key: 'hint', style: { display: 'block', opacity: 0.65, fontSize: 11 } }, item.hint)
            ])
          ])),

          h('div', { key: 'terms', style: { display: 'flex', flexDirection: 'column', gap: 4 } }, [
            h('div', { key: 'label', style: { fontSize: 12, opacity: 0.72 } },
              '个人词表（人名、客户名、项目代号 —— 规则抓不住的词，用逗号分隔）'),
            h('div', { key: 'row', style: { display: 'flex', gap: 8 } }, [
              h('input', {
                key: 'input',
                value: termText,
                disabled: busy,
                onChange: event => setTermText(event.target.value),
                placeholder: '张三, 某某科技',
                style: { ...box, flex: 1 }
              }),
              h('button', {
                key: 'btn',
                disabled: busy,
                onClick: () => save({ customTerms: parseTerms(termText) }),
                style: { ...box, width: 'auto', cursor: busy ? 'default' : 'pointer' }
              }, '保存词表')
            ])
          ]),

          h('div', { key: 'path', style: { fontSize: 11, opacity: 0.6, wordBreak: 'break-all' } },
            `配置文件：${props.path || '（未知）'}`),

          message && h('div', {
            key: 'msg',
            style: { fontSize: 12, color: message.kind === 'ok' ? 'inherit' : '#c0392b', opacity: message.kind === 'ok' ? 0.75 : 1 }
          }, message.text)
        ]);
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

        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12, padding: '20px 24px', maxWidth: 960 } }, [
          h('div', { key: 'title', style: { fontSize: 18, fontWeight: 600 } }, '提示词脱敏 · 规则调试器'),
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
                  h('th', { key: 'a', style: { textAlign: 'left', padding: '5px 8px', opacity: 0.72, borderBottom: '1px solid rgba(127,127,127,0.25)' } }, '命中内容'),
                  h('th', { key: 'b', style: { textAlign: 'left', padding: '5px 8px', opacity: 0.72, borderBottom: '1px solid rgba(127,127,127,0.25)' } }, '占位符'),
                  h('th', { key: 'c', style: { textAlign: 'left', padding: '5px 8px', opacity: 0.72, borderBottom: '1px solid rgba(127,127,127,0.25)' } }, '规则')
                ])),
                h('tbody', { key: 'body' }, hits.map((hit, index) => h('tr', { key: index }, [
                  // hit 里没有 value 字段（只有 start/end），命中内容要从原文切片
                  h('td', { key: 'v', style: { padding: '5px 8px' } }, text.slice(hit.start, hit.end)),
                  h('td', { key: 'l', style: { padding: '5px 8px' } }, hit.label),
                  h('td', { key: 'r', style: { padding: '5px 8px', opacity: 0.75 } }, hit.ruleId)
                ])))
              ])
          ])
        ]);
      }

      /** 侧栏图标：和「余额与用量」一样是侧栏一级入口，需要一个图标组件。 */
      function RedactIcon() {
        return h('svg', {
          viewBox: '0 0 24 24',
          width: 18,
          height: 18,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block' }
        }, [
          h('path', { key: 'shield', d: 'M12 3l7 3v6c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6l7-3z' }),
          h('path', { key: 'mask', d: 'M9.5 12h5' })
        ]);
      }

      /** 整页：上面设置，下面调试器。 */
      function Page() {
        const [config, setConfig] = React.useState(null);
        const [configPathText, setConfigPathText] = React.useState('');
        const [loadError, setLoadError] = React.useState(null);

        const load = React.useCallback(async () => {
          try {
            const response = await fetch(API, { cache: 'no-store' });
            const data = await response.json();
            if (!data || data.ok !== true) throw new Error((data && data.error) || '读取失败');
            setConfig(data.settings || {});
            setConfigPathText(data.path || '');
            setLoadError(null);
          } catch (error) {
            setLoadError(error.message);
          }
        }, []);

        React.useEffect(() => { load(); }, [load]);

        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 20, padding: '20px 24px', maxWidth: 960 } }, [
          h('div', { key: 'title', style: { fontSize: 18, fontWeight: 600 } }, '提示词脱敏'),

          loadError
            ? h('div', { key: 'err', style: { fontSize: 12, color: '#c0392b' } },
              `读取设置失败：${loadError}（宿主接口可能未就绪；聊天脱敏不受影响）`)
            : h(SettingsPanel, {
              key: 'settings',
              config,
              path: configPathText,
              onSaved: next => setConfig({ ...next })
            }),

          h('div', { key: 'divider', style: { height: 1, background: 'rgba(127,127,127,0.25)' } }),

          h(Debugger, { key: 'debugger' })
        ]);
      }

      return {
        inject: ['slots'],
        apply(ctx) {
          if (!ctx || !ctx.slots || typeof ctx.slots.register !== 'function') return;

          // 侧栏一级入口：和「余额与用量」同一个 slot，label 是普通字符串
          ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
            { name: 'sidebar.panellist', id: 'prompt-redact', order: 40, label: '提示词脱敏' },
            RedactIcon
          ));

          // 点开侧栏入口后显示的主区域页面，key 与上面的 id 对应
          ctx.slots.inject('main', () => ctx.slots.register(
            { name: 'main', key: 'prompt-redact' },
            Page
          ));
        },
        // 仅供自测与排障
        __internals: { redact, scan, resolveConflicts, Session, RULES, buildSegments, Debugger, RedactIcon, Page, SettingsPanel }
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
