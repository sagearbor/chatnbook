<?php
if (!defined('ABSPATH')) exit;

class JsonLdRenderer {
  const BAKED_API_BASE = 'https://chatnbook-api-664594784582.us-central1.run.app';

  public static function inject() {
    add_action('wp_head', function() {
      $default_json = <<<'JSONLD'
{
  "@context": "https://schema.org",
  "@type": "LocalBusiness",
  "potentialAction": {
    "@type": "ScheduleAction",
    "target": {
      "@type": "EntryPoint",
      "urlTemplate": "https://chatnbook-api-664594784582.us-central1.run.app/v1/public/appointments",
      "httpMethod": "POST",
      "encodingType": "application/json"
    },
    "instrument": "https://chatnbook-api-664594784582.us-central1.run.app/openapi.json"
  }
}
JSONLD;

      $api_base = AdminPage::get_api_base();
      $baked_api_base = self::BAKED_API_BASE;

      // The JSON-LD baked into the template at generation time points at
      // whatever api_base the manifest had then. If the site owner has since
      // changed the API base URL in Settings, rewrite every occurrence of
      // the baked value in the raw JSON before decoding it, so urlTemplate
      // and instrument always track the configured server.
      if (!empty($api_base) && !empty($baked_api_base) && $api_base !== $baked_api_base) {
        $default_json = str_replace($baked_api_base, rtrim($api_base, '/'), $default_json);
      }

      $default = json_decode($default_json, true) ?: [];
      $json = array_merge($default, [
        "name" => get_bloginfo('name'),
        "url" => get_bloginfo('url'),
      ]);
      echo '<script type="application/ld+json">' . wp_json_encode($json) . '</script>';
    });
  }
}
JsonLdRenderer::inject();
