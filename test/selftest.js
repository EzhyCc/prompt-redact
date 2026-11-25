// Unified test runner: serially executes every *.selftest.js next to this file.
// Paths are resolved from this file's directory, so it works from any cwd.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here)
  .filter(name => name.endsWith('.selftest.js'))
  .sort();

let totalPassed = 0;
let totalFailed = 0;

for (const file of files) {
  const absolute = join(here, file);
  const result = spawnSync(process.execPath, [absolute], { encoding: 'utf8' });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  const match = output.match(/(\d+) passed, (\d+) failed/);

  if (!match || result.status !== 0) {
    process.stdout.write(output);
    console.error(`test/${file}: 无法解析结果或进程失败`);
    totalFailed += match ? Number(match[2]) : 1;
    continue;
  }

  const passed = Number(match[1]);
  const failed = Number(match[2]);
  totalPassed += passed;
  totalFailed += failed;
  console.log(`test/${file}: ${passed}/${passed + failed}`);
}

console.log(`TOTAL: ${totalPassed} passed, ${totalFailed} failed`);
if (totalFailed > 0) process.exitCode = 1;
