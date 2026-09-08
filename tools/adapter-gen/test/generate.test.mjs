import test from 'node:test';
import assert from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const manifestPath = path.join('platforms', 'wordpress.manifest.yaml');
const pluginDir = path.join(repoRoot, 'platforms_out', 'wordpress-plugin');
const zipPath = path.join(repoRoot, 'platforms_out', 'wordpress-plugin.zip');

function walkPhpFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkPhpFiles(p));
    else if (entry.name.endsWith('.php')) out.push(p);
  }
  return out;
}

function hasPhpCli() {
  const res = spawnSync('php', ['--version']);
  return res.status === 0;
}

test('generator produces a WordPress plugin from the manifest', () => {
  execFileSync('npx', ['ts-node', 'tools/adapter-gen/index.ts', '--manifest', manifestPath], {
    cwd: repoRoot,
    stdio: 'pipe',
  });

  assert.ok(existsSync(pluginDir), 'plugin directory should be generated');
  const pluginPhp = readFileSync(path.join(pluginDir, 'plugin.php'), 'utf-8');
  assert.match(pluginPhp, /Plugin Name: AI SMB Booker/);
  assert.match(pluginPhp, /Version: 0\.1\.0/);
  assert.doesNotMatch(pluginPhp, /{{.*}}/, 'no unresolved placeholders should remain');

  const scriptInjector = readFileSync(path.join(pluginDir, 'includes', 'ScriptInjector.php'), 'utf-8');
  assert.match(scriptInjector, /https:\/\/cdn\.example\.com\/widget\.js/);

  const adminPage = readFileSync(path.join(pluginDir, 'includes', 'AdminPage.php'), 'utf-8');
  assert.match(adminPage, /'ai-smb-booker'/);
});

test('generated plugin packages into a zip', () => {
  execFileSync('node', ['tools/adapter-gen/package.mjs'], { cwd: repoRoot, stdio: 'pipe' });
  assert.ok(existsSync(zipPath), 'zip should be created');
  assert.ok(statSync(zipPath).size > 0, 'zip should not be empty');
});

test('every generated PHP file passes php -l', { skip: !hasPhpCli() && 'php CLI not installed' }, () => {
  const extractDir = mkdtempSync(path.join(tmpdir(), 'wp-plugin-lint-'));
  try {
    execFileSync('unzip', ['-o', '-q', zipPath, '-d', extractDir]);
    const phpFiles = walkPhpFiles(path.join(extractDir, 'wordpress-plugin'));
    assert.ok(phpFiles.length >= 4, 'expected at least 4 generated PHP files');
    for (const file of phpFiles) {
      const res = spawnSync('php', ['-l', file], { encoding: 'utf-8' });
      assert.strictEqual(res.status, 0, `php -l failed for ${file}:\n${res.stdout}${res.stderr}`);
      assert.match(res.stdout, /No syntax errors detected/);
    }
  } finally {
    rmSync(extractDir, { recursive: true, force: true });
  }
});
