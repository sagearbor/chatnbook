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
  api_base?: string;
  account_id?: string;
  script_url?: string;
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

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

// Recursively substitutes the literal token "${api_base}" inside every string
// value of a (possibly nested) JSON-LD structure with the resolved api_base.
function resolveApiBaseTemplate(value: unknown, apiBase: string): unknown {
  if (typeof value === 'string') {
    return value.split('${api_base}').join(apiBase);
  }
  if (Array.isArray(value)) {
    return value.map((v) => resolveApiBaseTemplate(v, apiBase));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolveApiBaseTemplate(v, apiBase);
    }
    return out;
  }
  return value;
}

function resolveInjection(injection: InjectionManifest): {
  apiBase: string;
  accountId: string;
  scriptUrl: string;
  jsonld: JsonLdManifest;
} {
  let apiBase = '';
  if (injection.api_base !== undefined) {
    if (typeof injection.api_base !== 'string' || !isHttpUrl(injection.api_base)) {
      console.error(
        `injection.api_base must be an http(s) URL, got: ${JSON.stringify(injection.api_base)}`
      );
      process.exit(1);
    }
    apiBase = injection.api_base;
  }

  const accountId = injection.account_id || '';

  let scriptUrlRaw = injection.script_url;
  if (!scriptUrlRaw) {
    if (!apiBase) {
      console.error('injection.script_url is required when injection.api_base is not set');
      process.exit(1);
    }
    scriptUrlRaw = '${api_base}/widget.js';
  }
  const scriptUrl = apiBase ? scriptUrlRaw.split('${api_base}').join(apiBase) : scriptUrlRaw;

  const jsonldRaw: JsonLdManifest =
    injection.jsonld || { '@context': 'https://schema.org', '@type': 'LocalBusiness' };
  const jsonld = (
    apiBase ? resolveApiBaseTemplate(jsonldRaw, apiBase) : jsonldRaw
  ) as JsonLdManifest;

  return { apiBase, accountId, scriptUrl, jsonld };
}

function placeholders(manifest: Manifest): Record<string, string> {
  const { plugin, injection } = manifest;
  const resolved = resolveInjection(injection);
  const jsonld = JSON.stringify(resolved.jsonld, null, 2);

  // Indent the JSON-LD default so it reads cleanly as a PHP array literal comment/fallback.
  return {
    PLUGIN_SLUG: plugin.slug,
    PLUGIN_NAME: plugin.name,
    PLUGIN_VERSION: plugin.version,
    PLUGIN_DESCRIPTION: plugin.description,
    PLUGIN_AUTHOR: plugin.author || 'Unknown',
    PLUGIN_MIN_PHP: (plugin.php || '7.4').replace(/^[^\d]*/, ''),
    API_BASE: escapePhpSingleQuoted(resolved.apiBase),
    ACCOUNT_ID: escapePhpSingleQuoted(resolved.accountId),
    SCRIPT_URL: escapePhpSingleQuoted(resolved.scriptUrl),
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
console.log('  api_base:', values.API_BASE || '(none)', ' account_id:', values.ACCOUNT_ID || '(none)');
