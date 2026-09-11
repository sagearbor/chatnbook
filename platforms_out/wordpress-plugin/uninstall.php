<?php
// If this file is called directly, abort.
if (!defined('WP_UNINSTALL_PLUGIN')) {
  exit;
}

delete_option('ai-smb-booker_api_base');
delete_option('ai-smb-booker_account_id');
