import fs from 'fs';
import path from 'path';
import { parse as parseYaml } from 'yaml';

interface PluginManifest {
  slug: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  php?: string;
}

interface JsonLdManifest {
  '@context'?: string;
  '@type'?: string;
  [key: string]: unknown;
}

interface InjectionManifest {
  script_url: string;
  jsonld?: JsonLdManifest;
}

interface Manifest {
  platform: string;
  language: string;
  plugin: PluginManifest;
  injection: InjectionManifest;
}

const args = process.argv.slice(2);
const idx = args.indexOf('--manifest');
if (idx === -1 || idx === args.length - 1) {
  console.error('Usage: generate:adapter --manifest <path>');
  process.exit(1);
}
const manifestPath = args[idx + 1];
console.log('Loaded manifest:', manifestPath);

const manifestRaw = fs.readFileSync(path.resolve(process.cwd(), manifestPath), 'utf-8');
const manifest = parseYaml(manifestRaw) as Manifest;

if (!manifest || !manifest.plugin || !manifest.injection) {
  console.error('Manifest is missing required "plugin" or "injection" sections');
  process.exit(1);
}

if (manifest.platform !== 'wordpress') {
  console.error(`Unsupported platform: ${manifest.platform}`);
  process.exit(1);
}

const src = path.join(process.cwd(), 'tools', 'adapter-gen', 'templates', 'wordpress');
const dest = path.join(process.cwd(), 'platforms_out', 'wordpress-plugin');
fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });

function escapePhpSingleQuoted(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function placeholders(manifest: Manifest): Record<string, string> {
  const { plugin, injection } = manifest;
  const jsonld = injection.jsonld
    ? JSON.stringify(injection.jsonld, null, 2)
    : JSON.stringify({ '@context': 'https://schema.org', '@type': 'LocalBusiness' }, null, 2);

  // Indent the JSON-LD default so it reads cleanly as a PHP array literal comment/fallback.
  return {
    PLUGIN_SLUG: plugin.slug,
    PLUGIN_NAME: plugin.name,
    PLUGIN_VERSION: plugin.version,
    PLUGIN_DESCRIPTION: plugin.description,
    PLUGIN_AUTHOR: plugin.author || 'Unknown',
    PLUGIN_MIN_PHP: (plugin.php || '7.4').replace(/^[^\d]*/, ''),
    SCRIPT_URL: escapePhpSingleQuoted(injection.script_url),
    JSONLD_DEFAULT_JSON: jsonld,
  };
}

function applyPlaceholders(content: string, values: Record<string, string>): string {
  let out = content;
  for (const [key, value] of Object.entries(values)) {
    out = out.split(`{{${key}}}`).join(value);
  }
  return out;
}

function copyDir(s: string, d: string, values: Record<string, string>): void {
  for (const entry of fs.readdirSync(s, { withFileTypes: true })) {
    const sp = path.join(s, entry.name);
    const dp = path.join(d, entry.name.replace('.tmpl', ''));
    if (entry.isDirectory()) {
      fs.mkdirSync(dp, { recursive: true });
      copyDir(sp, dp, values);
    } else {
      const content = fs.readFileSync(sp, 'utf-8');
      fs.writeFileSync(dp, applyPlaceholders(content, values));
    }
  }
}

const values = placeholders(manifest);
copyDir(src, dest, values);
console.log('Generated WordPress plugin at', dest);
console.log('  slug:', values.PLUGIN_SLUG, ' version:', values.PLUGIN_VERSION);
