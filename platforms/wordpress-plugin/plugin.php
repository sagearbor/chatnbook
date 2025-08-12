<?php
/*
Plugin Name: AI SMB Booker
Description: Injects booking widget + JSON-LD and handles OAuth setup.
Version: 0.1.0
*/

if (!defined('ABSPATH')) exit;

require_once plugin_dir_path(__FILE__) . 'includes/AdminPage.php';
require_once plugin_dir_path(__FILE__) . 'includes/JsonLdRenderer.php';
require_once plugin_dir_path(__FILE__) . 'includes/ScriptInjector.php';

register_activation_hook(__FILE__, function() {
    if (get_option('ai_smb_account') === false) {
        add_option('ai_smb_account', '');
    }
});

register_deactivation_hook(__FILE__, function() {
    // Nothing for now.
});
