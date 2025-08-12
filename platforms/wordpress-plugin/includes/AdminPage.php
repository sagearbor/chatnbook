<?php
class AdminPage {
    public static function register() {
        add_action('admin_menu', function() {
            add_menu_page('AI SMB Booker', 'AI SMB Booker', 'manage_options', 'ai-smb-booker', [self::class, 'render']);
        });
        add_action('admin_init', [self::class, 'settings']);
    }

    public static function settings() {
        register_setting('ai_smb_booker', 'ai_smb_account');
    }

    public static function render() {
        if (isset($_GET['oauth'])) {
            $provider = sanitize_text_field($_GET['oauth']);
            echo '<div class="notice notice-info"><p>OAuth flow for ' . esc_html($provider) . ' would start here.</p></div>';
        }
        ?>
        <div class="wrap">
            <h1>AI SMB Booker</h1>
            <form method="post" action="options.php">
                <?php
                    settings_fields('ai_smb_booker');
                    $account = esc_attr(get_option('ai_smb_account', ''));
                ?>
                <table class="form-table">
                    <tr>
                        <th scope="row">Account ID</th>
                        <td><input type="text" name="ai_smb_account" value="<?php echo $account; ?>" /></td>
                    </tr>
                </table>
                <?php submit_button(); ?>
            </form>
            <h2>Connect Calendars</h2>
            <p>
                <a class="button button-primary" href="<?php echo esc_url(admin_url('admin.php?page=ai-smb-booker&oauth=google')); ?>">Connect Google</a>
                <a class="button" href="<?php echo esc_url(admin_url('admin.php?page=ai-smb-booker&oauth=microsoft')); ?>">Connect Microsoft</a>
            </p>
        </div>
        <?php
    }
}
AdminPage::register();
