<?php
if (!defined('ABSPATH')) exit;

class AdminPage {
  const OPTION_API_BASE = 'ai-smb-booker_api_base';
  const OPTION_ACCOUNT_ID = 'ai-smb-booker_account_id';
  const SETTINGS_GROUP = 'ai-smb-booker_settings';
  const SETTINGS_PAGE = 'ai-smb-booker';
  const DEFAULT_API_BASE = 'https://chatnbook-api-664594784582.us-central1.run.app';
  const DEFAULT_ACCOUNT_ID = 'acct_demo';

  public static function register() {
    add_action('admin_menu', [self::class, 'add_menu']);
    add_action('admin_init', [self::class, 'register_settings']);
  }

  public static function add_menu() {
    add_options_page(
      'AI SMB Booker',
      'AI SMB Booker',
      'manage_options',
      self::SETTINGS_PAGE,
      [self::class, 'render']
    );
  }

  public static function register_settings() {
    register_setting(self::SETTINGS_GROUP, self::OPTION_API_BASE, [
      'type' => 'string',
      'sanitize_callback' => 'esc_url_raw',
      'default' => self::DEFAULT_API_BASE,
    ]);
    register_setting(self::SETTINGS_GROUP, self::OPTION_ACCOUNT_ID, [
      'type' => 'string',
      'sanitize_callback' => [self::class, 'sanitize_account_id'],
      'default' => self::DEFAULT_ACCOUNT_ID,
    ]);

    add_settings_section(
      'ai-smb-booker_main_section',
      __('Connection', 'ai-smb-booker'),
      '__return_false',
      self::SETTINGS_PAGE
    );

    add_settings_field(
      self::OPTION_API_BASE,
      __('API base URL', 'ai-smb-booker'),
      [self::class, 'render_api_base_field'],
      self::SETTINGS_PAGE,
      'ai-smb-booker_main_section'
    );

    add_settings_field(
      self::OPTION_ACCOUNT_ID,
      __('Account ID', 'ai-smb-booker'),
      [self::class, 'render_account_id_field'],
      self::SETTINGS_PAGE,
      'ai-smb-booker_main_section'
    );
  }

  // Strict allow-list: letters, digits, underscore, hyphen, 1-64 chars.
  public static function sanitize_account_id($value) {
    $value = trim((string) $value);
    if (preg_match('/^[A-Za-z0-9_-]{1,64}$/', $value)) {
      return $value;
    }
    add_settings_error(
      self::OPTION_ACCOUNT_ID,
      'ai-smb-booker_account_id_invalid',
      __('Account ID must be 1-64 characters: letters, numbers, underscore or hyphen. Keeping the previous value.', 'ai-smb-booker')
    );
    return get_option(self::OPTION_ACCOUNT_ID, self::DEFAULT_ACCOUNT_ID);
  }

  public static function get_api_base() {
    return get_option(self::OPTION_API_BASE, self::DEFAULT_API_BASE);
  }

  public static function get_account_id() {
    return get_option(self::OPTION_ACCOUNT_ID, self::DEFAULT_ACCOUNT_ID);
  }

  public static function build_script_url($api_base) {
    return rtrim($api_base, '/') . '/widget.js';
  }

  public static function render_api_base_field() {
    $value = self::get_api_base();
    echo '<input type="url" class="regular-text" name="' . esc_attr(self::OPTION_API_BASE) . '" value="' . esc_attr($value) . '" placeholder="https://your-chatnbook-server.com" />';
    echo '<p class="description">' . esc_html__('API base URL of your chatnbook server', 'ai-smb-booker') . '</p>';
  }

  public static function render_account_id_field() {
    $value = self::get_account_id();
    echo '<input type="text" class="regular-text" name="' . esc_attr(self::OPTION_ACCOUNT_ID) . '" value="' . esc_attr($value) . '" placeholder="acct_demo" />';
    echo '<p class="description">' . esc_html__('Your account ID', 'ai-smb-booker') . '</p>';
  }

  public static function render() {
    if (!current_user_can('manage_options')) {
      return;
    }

    $api_base = self::get_api_base();
    $account_id = self::get_account_id();

    echo '<div class="wrap">';
    echo '<h1>' . esc_html__('AI SMB Booker', 'ai-smb-booker') . '</h1>';
    echo '<form method="post" action="options.php">';
    settings_fields(self::SETTINGS_GROUP);
    do_settings_sections(self::SETTINGS_PAGE);
    submit_button();
    echo '</form>';

    echo '<h2>' . esc_html__('Status', 'ai-smb-booker') . '</h2>';
    echo '<table class="widefat" style="max-width:640px"><tbody>';

    if (!empty($api_base)) {
      $script_tag = '<script src="' . esc_url(self::build_script_url($api_base)) . '" data-account="' . esc_attr($account_id) . '" async></script>';
      $health_url = esc_url(rtrim($api_base, '/') . '/health');
      echo '<tr><th scope="row">' . esc_html__('Injected script tag', 'ai-smb-booker') . '</th><td><code>' . esc_html($script_tag) . '</code></td></tr>';
      echo '<tr><th scope="row">' . esc_html__('Health check', 'ai-smb-booker') . '</th><td><a href="' . $health_url . '" target="_blank" rel="noopener noreferrer">' . esc_html($health_url) . '</a></td></tr>';
    } else {
      echo '<tr><td colspan="2">' . esc_html__('Set an API base URL above to enable the booking widget.', 'ai-smb-booker') . '</td></tr>';
    }

    echo '</tbody></table>';
    echo '</div>';
  }
}
AdminPage::register();
