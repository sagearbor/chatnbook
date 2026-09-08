#!/usr/bin/env node
// Zips platforms_out/wordpress-plugin into platforms_out/wordpress-plugin.zip
// Requires the plugin to have already been generated via `pnpm generate:adapter`.
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const pluginDir = path.join(root, 'platforms_out', 'wordpress-plugin');
const zipPath = path.join(root, 'platforms_out', 'wordpress-plugin.zip');

if (!existsSync(pluginDir)) {
  console.error(`Plugin directory not found: ${pluginDir}. Run "pnpm generate:adapter --manifest <path>" first.`);
  process.exit(1);
}

if (existsSync(zipPath)) {
  rmSync(zipPath);
}

execFileSync('zip', ['-r', '-X', zipPath, 'wordpress-plugin', '-x', '**/.DS_Store'], {
  cwd: path.join(root, 'platforms_out'),
  stdio: 'inherit',
});

console.log('Packaged WordPress plugin ->', zipPath);
