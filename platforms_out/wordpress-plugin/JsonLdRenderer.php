<?php
class JsonLdRenderer {
  public static function inject() {
    add_action('wp_head', function() {
      $json = [
        "@context" => "https://schema.org",
        "@type" => "LocalBusiness",
        "name" => get_bloginfo('name'),
        "url" => get_bloginfo('url'),
        "potentialAction" => [
          "@type" => "ScheduleAction",
          "target" => [
            "@type" => "EntryPoint",
            "urlTemplate" => "https://api.example.com/v1/appointments",
            "httpMethod" => "POST",
            "encodingType" => "application/json"
          ],
          "instrument" => "https://api.example.com/openapi.json"
        ]
      ];
      echo '<script type="application/ld+json">' . wp_json_encode($json) . '</script>';
    });
  }
}
JsonLdRenderer::inject();
