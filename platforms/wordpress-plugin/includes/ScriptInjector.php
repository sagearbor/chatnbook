<?php
class ScriptInjector {
    public static function inject() {
        add_action('wp_footer', function() {
            $account = esc_attr(get_option('ai_smb_account', 'acct_demo'));
            echo '<script src="https://cdn.example.com/widget.js" async data-account="' . $account . '"></script>';
        });
    }
}
ScriptInjector::inject();
