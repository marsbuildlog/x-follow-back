#!/usr/bin/env node
// 打包 extension/ 为 zip, 输出到 releases/x-follow-back-v{version}.zip
// 用法: npm run build  (零依赖, 使用系统 zip 命令)
'use strict';

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const extDir = path.join(root, 'extension');
const outDir = path.join(root, 'releases');

// 版本号取自 manifest.json, 保证 zip 名与插件版本一致
const { version } = JSON.parse(
  fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'),
);
const zipName = `x-follow-back-v${version}.zip`;
const zipPath = path.join(outDir, zipName);

fs.mkdirSync(outDir, { recursive: true });
fs.rmSync(zipPath, { force: true });

// test/ 与系统杂物不进包; extension/README.md 保留(装好后可看说明)
execSync(
  `zip -r -X ${JSON.stringify(zipPath)} . -x "test/*" -x "*.DS_Store" -x ".*.swp"`,
  { cwd: extDir, stdio: 'inherit' },
);

console.log(`\n✅ 打包完成: ${path.relative(root, zipPath)}`);
execSync(`unzip -l ${JSON.stringify(zipPath)}`, { stdio: 'inherit' });
