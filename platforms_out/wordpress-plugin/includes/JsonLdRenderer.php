<?php
class JsonLdRenderer {
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
      "urlTemplate": "https://api.example.com/v1/appointments",
      "httpMethod": "POST",
      "encodingType": "application/json"
    },
    "instrument": "https://api.example.com/openapi.json"
  }
}
JSONLD;
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
