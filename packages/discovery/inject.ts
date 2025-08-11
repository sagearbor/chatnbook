import { JsonLdParams, generateJsonLdString } from './generator.js';

/**
 * Inject JSON-LD into document head. No-op on server.
 */
export function injectJsonLd(params: JsonLdParams): void {
  if (typeof document === 'undefined') return;
  const script = document.createElement('script');
  script.type = 'application/ld+json';
  script.textContent = generateJsonLdString(params);
  document.head.appendChild(script);
}

/**
 * Return an HTML string of a script tag with JSON-LD payload for server-side rendering.
 */
export function renderJsonLd(params: JsonLdParams): string {
  return `<script type="application/ld+json">${generateJsonLdString(params)}</script>`;
}
