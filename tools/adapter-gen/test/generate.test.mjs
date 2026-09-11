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

const API_BASE = 'https://chatnbook-api-664594784582.us-central1.run.app';
const ACCOUNT_ID = 'acct_demo';

function walkAllFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkAllFiles(p));
    else out.push(p);
  }
  return out;
}

test('generator produces a WordPress plugin from the manifest', () => {
  execFileSync('npx', ['ts-node', 'tools/adapter-gen/index.ts', '--manifest', manifestPath], {
    cwd: repoRoot,
    stdio: 'pipe',
  });

  assert.ok(existsSync(pluginDir), 'plugin directory should be generated');
  const pluginPhp = readFileSync(path.join(pluginDir, 'plugin.php'), 'utf-8');
  assert.match(pluginPhp, /Plugin Name: AI SMB Booker/);
  assert.match(pluginPhp, /Version: 0\.2\.0/);
  assert.doesNotMatch(pluginPhp, /{{.*}}/, 'no unresolved placeholders should remain');
  assert.ok(pluginPhp.includes(API_BASE), 'plugin.php should bake in the manifest api_base');
  assert.ok(pluginPhp.includes(ACCOUNT_ID), 'plugin.php should bake in the manifest account_id');

  const scriptInjector = readFileSync(path.join(pluginDir, 'includes', 'ScriptInjector.php'), 'utf-8');
  assert.match(scriptInjector, /AdminPage::get_api_base\(\)/);
  assert.match(scriptInjector, /AdminPage::build_script_url\(/);

  const adminPage = readFileSync(path.join(pluginDir, 'includes', 'AdminPage.php'), 'utf-8');
  assert.match(adminPage, /'ai-smb-booker_api_base'/);
  assert.match(adminPage, /'ai-smb-booker_account_id'/);
  assert.match(adminPage, /esc_url_raw/);
  assert.match(adminPage, /A-Za-z0-9_-\]\{1,64\}/);
  assert.ok(adminPage.includes(API_BASE), 'AdminPage.php should default to the manifest api_base');
  assert.ok(adminPage.includes(ACCOUNT_ID), 'AdminPage.php should default to the manifest account_id');
  assert.match(adminPage, /add_options_page/, 'settings page should live under Settings, not a top-level menu');
  assert.match(adminPage, /manage_options/);

  const jsonLdRenderer = readFileSync(path.join(pluginDir, 'includes', 'JsonLdRenderer.php'), 'utf-8');
  assert.ok(jsonLdRenderer.includes(`${API_BASE}/v1/public/appointments`), 'urlTemplate should point at the live bookings endpoint');
  assert.ok(jsonLdRenderer.includes(`${API_BASE}/openapi.json`), 'instrument should point at the live OpenAPI doc');

  assert.ok(existsSync(path.join(pluginDir, 'uninstall.php')), 'uninstall.php should be generated');
  assert.ok(existsSync(path.join(pluginDir, 'readme.txt')), 'readme.txt should be generated');

  const uninstall = readFileSync(path.join(pluginDir, 'uninstall.php'), 'utf-8');
  assert.match(uninstall, /delete_option\('ai-smb-booker_api_base'\)/);
  assert.match(uninstall, /delete_option\('ai-smb-booker_account_id'\)/);

  const readme = readFileSync(path.join(pluginDir, 'readme.txt'), 'utf-8');
  assert.match(readme, /=== AI SMB Booker ===/);
  assert.match(readme, /Stable tag: 0\.2\.0/);
  assert.match(readme, /== Changelog ==/);
  assert.match(readme, /= 0\.2\.0 =/);

  for (const file of walkAllFiles(pluginDir)) {
    const content = readFileSync(file, 'utf-8');
    assert.ok(!content.includes('example.com'), `${file} should not reference example.com`);
  }
});

test('generated plugin packages into a zip', () => {
  execFileSync('node', ['tools/adapter-gen/package.mjs'], { cwd: repoRoot, stdio: 'pipe' });
  assert.ok(existsSync(zipPath), 'zip should be created');
  assert.ok(statSync(zipPath).size > 0, 'zip should not be empty');
});

test('zip contains readme.txt', () => {
  const listing = execFileSync('unzip', ['-l', zipPath], { encoding: 'utf-8' });
  assert.match(listing, /wordpress-plugin\/readme\.txt/);
  assert.match(listing, /wordpress-plugin\/uninstall\.php/);
});

test('every generated PHP file passes php -l', { skip: !hasPhpCli() && 'php CLI not installed' }, () => {
  const extractDir = mkdtempSync(path.join(tmpdir(), 'wp-plugin-lint-'));
  try {
    execFileSync('unzip', ['-o', '-q', zipPath, '-d', extractDir]);
    const phpFiles = walkPhpFiles(path.join(extractDir, 'wordpress-plugin'));
    assert.ok(phpFiles.length >= 5, 'expected at least 5 generated PHP files (including uninstall.php)');
    for (const file of phpFiles) {
      const res = spawnSync('php', ['-l', file], { encoding: 'utf-8' });
      assert.strictEqual(res.status, 0, `php -l failed for ${file}:\n${res.stdout}${res.stderr}`);
      assert.match(res.stdout, /No syntax errors detected/);
    }
  } finally {
    rmSync(extractDir, { recursive: true, force: true });
  }
});
