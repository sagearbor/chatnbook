<?php
class ScriptInjector {
  public static function inject() {
    add_action('wp_footer', function() {
      echo '<script src="' . esc_url('https://cdn.example.com/widget.js') . '" async data-account="acct_demo"></script>';
    });
  }
}
ScriptInjector::inject();
