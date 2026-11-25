// 盲生成测试数据：随机号码/身份证/金额写进文件，**不打印任何值**。
// 目的是在「我这个会话从没见过这些值」的前提下做一次干净的脱敏测试。
import { writeFileSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';

const TARGET = 'C:/SGL/快速访问/Downloads/prompt-redact-测试.txt';

const randomDigits = count => Array.from({ length: count }, () => Math.floor(Math.random() * 10)).join('');

// 手机号：139 开头 + 8 位随机
const phone = `139${randomDigits(8)}`;

// 身份证：区域码 + 生日 + 3 位顺序码 + 校验位（MOD 11-2，保证能通过 cn-id-card 规则）
const WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const CHECK = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];
function makeIdCard() {
  const body = `11010119900307${randomDigits(3)}`;
  let sum = 0;
  for (let index = 0; index < 17; index += 1) sum += Number(body[index]) * WEIGHTS[index];
  return body + CHECK[sum % 11];
}
const idCard = makeIdCard();

// 金额：10 万 ~ 999 万之间，带千分位
const amount = (Math.floor(Math.random() * 9_890_000) + 100_000).toLocaleString('en-US');

const content = [
  '联系人 张三',
  `手机 ${phone}`,
  `身份证 ${idCard}`,
  `合同金额 ${amount} 元`
].join('\n');

writeFileSync(TARGET, content, 'utf8');

// 只报告「变了」这件事，不报告内容
const buffer = readFileSync(TARGET);
console.log(`已重写：${TARGET}`);
console.log(`文件大小：${statSync(TARGET).size} 字节`);
console.log(`内容指纹：${createHash('sha256').update(buffer).digest('hex').slice(0, 12)}`);
console.log('（内容未打印：生成用的值只存在于文件里，不在本会话的上下文里）');
