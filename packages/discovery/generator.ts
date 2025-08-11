import fs from 'fs';

export interface JsonLdParams {
  business_name: string;
  business_url: string;
  opening_hours: string;
  api_base: string;
  requires_confirmation: boolean;
}

// Load template once at module load using import.meta for ESM-friendly path resolution
const templateUrl = new URL('./jsonld_template.json', import.meta.url);
const template = fs.readFileSync(templateUrl, 'utf-8');

/**
 * Generate JSON-LD object for scheduling discovery by replacing
 * handlebars-style placeholders in `jsonld_template.json`.
 */
export function generateJsonLd(params: JsonLdParams): Record<string, unknown> {
  let filled = template;
  for (const [key, value] of Object.entries(params)) {
    const placeholder = new RegExp(`{{${key}}}`, 'g');
    filled = filled.replace(placeholder, String(value));
  }
  return JSON.parse(filled);
}

/**
 * Convenience helper returning a JSON string suitable for embedding
 * directly into HTML.
 */
export function generateJsonLdString(params: JsonLdParams): string {
  return JSON.stringify(generateJsonLd(params));
}

