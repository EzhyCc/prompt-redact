// 配置文件的位置解析。宿主中立：任何适配器（DSH 插件 / 浏览器扩展 / 本地代理 / PWA）
// 读的都是同一个文件，设置页写的也是它。
//
// 优先级：
//   1. 环境变量 PROMPT_REDACT_CONFIG（指向具体文件，测试和自定义部署用）
//   2. ~/.prompt-redact/config.json
//
// 只有一个位置，没有隐藏的第二个来源。

import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * 规范位置：设置页往这里写，插件优先读这里。
 * @returns {string}
 */
export function configPath() {
  const explicit = process.env.PROMPT_REDACT_CONFIG;
  if (explicit) return explicit;
  return join(homedir(), '.prompt-redact', 'config.json');
}

/**
 * 实际读取的路径。
 *
 * 早先版本还提供过一条「回退到 ~/.dsh/prompt-redact.config.json」的路径，已经去掉：
 * 隐藏的第二个配置来源会让「为什么我的设置没生效 / 为什么它自己变了」变成玄学。
 * 只有一个位置，一个来源。
 * @returns {string}
 */
export function readableConfigPath() {
  return configPath();
}
