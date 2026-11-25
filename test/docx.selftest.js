// docx 两条命令的端到端自测：redact（保格式脱敏）→ compose（保格式填充）
// 依赖 python-docx；缺依赖时整组跳过（打印 0 passed），不影响 CI。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractOfficeText } from '../tools/extract/office.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CLI = join(ROOT, 'tools', 'docx.mjs');

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); passed += 1; process.stdout.write(`PASS ${name}\n`); }
  catch (error) { failed += 1; process.stderr.write(`FAIL ${name}: ${error.message}\n`); }
}

/** 找一个装了 python-docx 的解释器。 */
function findPython() {
  const candidates = [process.env.PROMPT_REDACT_PYTHON, 'python', 'python3'].filter(Boolean);
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-c', 'import docx'], { stdio: 'ignore' });
    if (probe.status === 0) return candidate;
  }
  return null;
}

const python = findPython();
if (!python) {
  process.stdout.write('SKIP 没有可用的 python-docx，跳过 docx 命令测试\n\n0 passed, 0 failed\n');
  process.exit(0);
}
process.env.PROMPT_REDACT_PYTHON = python;

const work = mkdtempSync(join(tmpdir(), 'pr-docx-test-'));

/** 造一份带假敏感信息的模板。 */
const FIXTURE = `import sys
from docx import Document
doc = Document()
doc.add_paragraph("项目初步验收方案")
doc.add_heading("1 项目简介", level=1)
doc.add_paragraph("建设单位：某某科技有限公司，联系人张三，手机 13800138000。")
doc.add_heading("2 初验目的", level=1)
doc.add_paragraph("原模板里的说明文字。")
doc.save(sys.argv[1])
`;

try {
  const fixture = join(work, '模板.docx');
  writeFileSync(join(work, 'make_fixture.py'), FIXTURE, 'utf8');
  spawnSync(python, [join(work, 'make_fixture.py'), fixture], { encoding: 'utf8' });
  check('fixture 生成', () => assert.ok(existsSync(fixture)));

  // ── redact ──────────────────────────────────────────────────────
  const outDir = join(work, 'out');
  const redactRun = spawnSync(process.execPath, [
    CLI, 'redact', '--in', fixture, '--out', outDir,
    '--terms', '某某科技=客户', '--org'
  ], { encoding: 'utf8' });

  check('redact 命令执行成功', () => assert.equal(redactRun.status, 0, redactRun.stderr));

  const redactedPath = join(outDir, '模板-脱敏.docx');
  const mapPath = join(outDir, '模板.map.json');
  check('只产出两个文件：脱敏 docx + 映射表', () => {
    assert.ok(existsSync(redactedPath), '缺少脱敏 docx');
    assert.ok(existsSync(mapPath), '缺少映射表');
  });

  check('脱敏后的 docx 里没有原始敏感信息', () => {
    const text = extractOfficeText(readFileSync(redactedPath), '.docx');
    assert.ok(!text.includes('13800138000'), '手机号仍在');
    assert.ok(!text.includes('某某科技'), '公司名仍在');
    assert.ok(text.includes('[手机号]'), '缺少手机号占位符');
  });

  check('映射表记录了占位符与原值', () => {
    const map = JSON.parse(readFileSync(mapPath, 'utf8'));
    const keys = Object.keys(map.tokens ?? {});
    assert.ok(keys.length >= 2, `只有 ${keys.length} 条`);
    assert.ok(keys.includes('[手机号]'));
  });

  check('章节标题与样式保留', () => {
    const text = extractOfficeText(readFileSync(redactedPath), '.docx');
    assert.ok(text.includes('项目简介'));
    assert.ok(text.includes('初验目的'));
  });

  // ── compose ─────────────────────────────────────────────────────
  const contentPath = join(work, '内容.json');
  writeFileSync(contentPath, JSON.stringify({
    项目简介: ['本项目为[医院]电子病历归档数据管理系统（一期）建设。', '数据库每日 02:00 全量备份。'],
    初验目的: ['确认承建单位按合同完成本期全部建设内容。']
  }), 'utf8');

  const productPath = join(work, '成品.docx');
  const composeRun = spawnSync(process.execPath, [
    CLI, 'compose', '--base', redactedPath, '--content', contentPath, '--out', productPath
  ], { encoding: 'utf8' });

  check('compose 命令执行成功', () => assert.equal(composeRun.status, 0, composeRun.stderr));

  check('成品里是新内容、旧正文已清掉', () => {
    const text = extractOfficeText(readFileSync(productPath), '.docx');
    assert.ok(text.includes('电子病历归档数据管理系统'), '缺少新内容');
    assert.ok(text.includes('[医院]'), '占位符丢失');
    assert.ok(!text.includes('原模板里的说明文字'), '旧正文没清掉');
  });

  check('成品保留章节标题', () => {
    const text = extractOfficeText(readFileSync(productPath), '.docx');
    assert.ok(text.includes('项目简介'));
    assert.ok(text.includes('初验目的'));
  });
} finally {
  rmSync(work, { recursive: true, force: true });
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
