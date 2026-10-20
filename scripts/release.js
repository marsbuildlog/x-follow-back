#!/usr/bin/env node
// 发版: 改插件版本 → 测试 → 打安装包 → commit/tag/push → GitHub Release
// 用法:
//   pnpm release 0.9.0              # dry-run(默认): 检查 + 必要时生成发版说明草稿
//   pnpm release 0.9.0 --execute    # 真正发版
//   pnpm release patch|minor|major  # 相对当前 manifest 递增
'use strict';

const { execSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const manifestPath = path.join(root, 'extension', 'manifest.json');
const packagePath = path.join(root, 'package.json');
const outDir = path.join(root, 'releases');

function die(msg) {
  console.error(`\n❌ ${msg}`);
  process.exit(1);
}

function run(cmd, opts = {}) {
  return execSync(cmd, { cwd: root, stdio: 'inherit', ...opts });
}

function runCapture(cmd) {
  return execSync(cmd, { cwd: root, encoding: 'utf8' }).trim();
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
}

function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v || ''));
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3] };
}

function formatSemver({ major, minor, patch }) {
  return `${major}.${minor}.${patch}`;
}

function bumpKind(kind, cur) {
  const p = parseSemver(cur);
  if (!p) die(`当前插件版本不是 x.y.z: ${cur}`);
  if (kind === 'major') return formatSemver({ major: p.major + 1, minor: 0, patch: 0 });
  if (kind === 'minor') return formatSemver({ major: p.major, minor: p.minor + 1, patch: 0 });
  if (kind === 'patch') return formatSemver({ major: p.major, minor: p.minor, patch: p.patch + 1 });
  die(`未知递增类型: ${kind}`);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  let execute = false;
  const positional = [];
  for (const a of args) {
    if (a === '--execute') execute = true;
    else if (a === '--help' || a === '-h') {
      console.log(`用法:
  pnpm release <version|patch|minor|major>           dry-run
  pnpm release <version|patch|minor|major> --execute 真正发版
`);
      process.exit(0);
    } else if (a.startsWith('-')) die(`未知参数: ${a}`);
    else positional.push(a);
  }
  if (positional.length !== 1) die('请传入版本号(如 0.9.0)或 patch|minor|major\n例: pnpm release 0.9.0');
  return { spec: positional[0], execute };
}

function currentBranch() {
  return runCapture('git rev-parse --abbrev-ref HEAD');
}

function assertMain() {
  const b = currentBranch();
  if (b !== 'main') die(`发版仅允许在 main 上(当前: ${b})`);
}

function assertClean() {
  const out = runCapture('git status --porcelain');
  if (out) {
    die(`工作区不干净, 请先提交或收起改动:\n${out}`);
  }
}

// git push 可能走 SSH 主机别名(如 github.com-mars→marsbuildlog),
// 而 gh 用的是「当前激活」的 HTTPS token——二者不是同一账号时, create release 会 404。
function assertGhCanRelease() {
  let login = '';
  try {
    login = execFileSync('gh', ['api', 'user', '--jq', '.login'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    die('gh 未登录或不可用——请先: gh auth login\n若本机有多账号: gh auth switch --user <有推送权限的账号>');
  }
  let nwo = '';
  try {
    nwo = execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], {
      cwd: root, encoding: 'utf8',
    }).trim();
  } catch {
    die('gh 无法识别当前仓库——请在仓库根目录运行, 或: gh repo set-default marsbuildlog/x-follow-back');
  }
  let push = false;
  try {
    const perms = execFileSync('gh', ['api', `repos/${nwo}`, '--jq', '.permissions.push'], {
      cwd: root, encoding: 'utf8',
    }).trim();
    push = perms === 'true';
  } catch {
    die(`gh 账号 @${login} 无法读取 ${nwo} 权限(常被当成 404)\n请切换到有权限的账号: gh auth switch --user marsbuildlog`);
  }
  if (!push) {
    die(
      `gh 当前账号 @${login} 对 ${nwo} 没有 push 权限, 无法创建 GitHub Release\n`
      + `git 推送可能已用 SSH 另一账号成功, 但 gh 不共用那套密钥\n`
      + `请执行: gh auth switch --user marsbuildlog\n`
      + `然后再跑发版(若 tag 已推上, 只需补: gh release create …)`
    );
  }
  console.log(`\n✓ gh 账号 @${login} 对 ${nwo} 有 push 权限`);
}

function tagName(ver) {
  return `v${ver}`;
}

function notesPath(ver) {
  return path.join(outDir, `release-notes-v${ver}.md`);
}

function zipPath(ver) {
  return path.join(outDir, `x-follow-back-v${ver}.zip`);
}

function fetchAndAssertTagFree(ver) {
  const tag = tagName(ver);
  console.log(`\n→ git fetch --tags origin`);
  try {
    run('git fetch --tags origin');
  } catch {
    die('git fetch 失败——无法确认远端是否已有该 tag');
  }
  const localTags = execFileSync('git', ['tag', '-l', tag], { cwd: root, encoding: 'utf8' }).trim();
  if (localTags) die(`本地已存在 tag ${tag}, 拒绝覆盖`);
  const remote = execFileSync('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`], {
    cwd: root, encoding: 'utf8',
  }).trim();
  if (remote) die(`远端 origin 已存在 tag ${tag}, 拒绝覆盖`);
}

function notesTemplate(ver) {
  const zip = `x-follow-back-v${ver}.zip`;
  return `# v${ver} — 在此填写一句话标题

## 变更

- 

## 安装

1. 下载 \`${zip}\` 并解压
2. 打开 \`chrome://extensions\`(Edge 为 \`edge://extensions\`), 开启"开发者模式"
3. 点"加载已解压的扩展程序", 选择解压后的目录

## 升级

已安装旧版: 解压后覆盖原目录, 回到扩展管理页点 ↻ 重新加载即可, 已有队列与设置自动保留。
`;
}

function ensureNotesDraft(ver) {
  fs.mkdirSync(outDir, { recursive: true });
  const p = notesPath(ver);
  if (fs.existsSync(p)) {
    console.log(`\n✓ 发版说明已存在: ${path.relative(root, p)}`);
    return { created: false, path: p };
  }
  fs.writeFileSync(p, notesTemplate(ver));
  console.log(`\n✓ 已生成发版说明草稿: ${path.relative(root, p)}`);
  console.log('  请编辑后再执行: pnpm release ' + ver + ' --execute');
  return { created: true, path: p };
}

function assertNotesExist(ver) {
  const p = notesPath(ver);
  if (!fs.existsSync(p)) {
    die(`缺少发版说明 ${path.relative(root, p)}\n请先: pnpm release ${ver}  (dry-run 会生成草稿)`);
  }
  return p;
}

function titleFromNotes(notesFile) {
  const text = fs.readFileSync(notesFile, 'utf8');
  const m = text.match(/^#\s+(.+)$/m);
  return (m && m[1].trim()) || tagName(path.basename(notesFile).replace(/^release-notes-/, '').replace(/\.md$/, ''));
}

function resolveVersion(spec) {
  const manifest = readJson(manifestPath);
  const cur = manifest.version;
  if (spec === 'patch' || spec === 'minor' || spec === 'major') {
    return { ver: bumpKind(spec, cur), cur };
  }
  if (!parseSemver(spec)) die(`版本号必须是 x.y.z(收到: ${spec})`);
  return { ver: spec, cur };
}

function printPlan(ver, cur, execute) {
  console.log(`
======== 发版计划 ${execute ? '(EXECUTE)' : '(dry-run)'} ========
当前插件版本: ${cur}
目标插件版本: ${ver}
tag:            ${tagName(ver)}
发版说明:       ${path.relative(root, notesPath(ver))}
安装包:         ${path.relative(root, zipPath(ver))}
将改文件:       extension/manifest.json, package.json
commit:         release: v${ver}
然后:           annotated tag → push main+tag → gh release create
说明文档:       不修改(how2use 请自行维护索引)
========================================
`);
}

function writeVersions(ver) {
  const manifest = readJson(manifestPath);
  manifest.version = ver;
  writeJson(manifestPath, manifest);

  const pkg = readJson(packagePath);
  pkg.version = ver;
  writeJson(packagePath, pkg);

  console.log(`\n✓ 已写入版本 ${ver} → manifest.json + package.json`);
}

function main() {
  const { spec, execute } = parseArgs(process.argv);
  const { ver, cur } = resolveVersion(spec);

  if (ver === cur && execute) {
    die(`目标版本 ${ver} 与当前插件版本相同——请换新版本号或用 patch|minor|major`);
  }

  assertMain();
  assertClean();
  assertGhCanRelease();
  fetchAndAssertTagFree(ver);

  if (!execute) {
    ensureNotesDraft(ver);
    printPlan(ver, cur, false);
    console.log('这是 dry-run, 未改仓库。确认发版说明后执行:');
    console.log(`  pnpm release ${ver} --execute\n`);
    return;
  }

  const notesFile = assertNotesExist(ver);
  printPlan(ver, cur, true);

  console.log('\n→ pnpm test');
  run('pnpm test');

  writeVersions(ver);

  console.log('\n→ pnpm build');
  run('pnpm build');
  if (!fs.existsSync(zipPath(ver))) die(`打包后未找到 ${path.relative(root, zipPath(ver))}`);

  console.log('\n→ git commit');
  run('git add extension/manifest.json package.json');
  // 使用 HEREDOC 风格以外的 -m, 脚本内简单 message 即可
  execFileSync('git', ['commit', '-m', `release: v${ver}`], { cwd: root, stdio: 'inherit' });

  console.log(`\n→ git tag -a ${tagName(ver)}`);
  execFileSync('git', ['tag', '-a', tagName(ver), '-m', `v${ver}`], { cwd: root, stdio: 'inherit' });

  console.log('\n→ git push origin main && git push origin ' + tagName(ver));
  run('git push origin main');
  run(`git push origin ${tagName(ver)}`);

  const title = titleFromNotes(notesFile);
  const tag = tagName(ver);
  console.log(`\n→ gh release create ${tag}`);
  try {
    execFileSync('gh', [
      'release', 'create', tag,
      '--title', title,
      '--notes-file', notesFile,
      zipPath(ver),
    ], { cwd: root, stdio: 'inherit' });
  } catch {
    die(
      `gh release create 失败(tag ${tag} 可能已推到远端)\n`
      + `先确认账号: gh auth status  (需要仓库 owner/push 权限, 常用: gh auth switch --user marsbuildlog)\n`
      + `再手工补发:\n`
      + `  gh release create ${tag} --title ${JSON.stringify(title)} --notes-file ${notesFile} ${zipPath(ver)}`
    );
  }

  console.log(`
✅ 发版完成: ${tag}
   安装包已上传到 GitHub Release。
   若中途曾失败, 请对照上方日志看卡在哪一步(脚本不自动回滚)。
`);
}

if (require.main === module) main();
