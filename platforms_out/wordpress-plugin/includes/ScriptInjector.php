<?php
if (!defined('ABSPATH')) exit;

class ScriptInjector {
  public static function inject() {
    add_action('wp_footer', function() {
      if (is_admin()) {
        return;
      }

      $api_base = AdminPage::get_api_base();
      if (empty($api_base)) {
        return;
      }

      $account_id = AdminPage::get_account_id();
      $script_url = AdminPage::build_script_url($api_base);
      echo '<script src="' . esc_url($script_url) . '" data-account="' . esc_attr($account_id) . '" async></script>';
    });
  }
}
ScriptInjector::inject();
