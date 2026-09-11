<?php
/*
Plugin Name: AI SMB Booker
Description: Injects booking widget and JSON-LD and handles OAuth setup.
Version: 0.2.0
Author: Chatnbook Team
Requires PHP: 7.4
Text Domain: ai-smb-booker
Default script URL: https://chatnbook-api-664594784582.us-central1.run.app/widget.js
*/

if (!defined('ABSPATH')) exit;

require_once plugin_dir_path(__FILE__) . 'includes/AdminPage.php';
require_once plugin_dir_path(__FILE__) . 'includes/JsonLdRenderer.php';
require_once plugin_dir_path(__FILE__) . 'includes/ScriptInjector.php';

register_activation_hook(__FILE__, function() {
  // add_option() never overwrites an existing value, so reactivating the
  // plugin (or updating it) never clobbers settings the site owner changed.
  add_option('ai-smb-booker_api_base', 'https://chatnbook-api-664594784582.us-central1.run.app');
  add_option('ai-smb-booker_account_id', 'acct_demo');
});
register_deactivation_hook(__FILE__, function() {
  // Nothing to clean up on deactivation; settings persist until uninstall.
});
