=== AI SMB Booker ===
Contributors: Chatnbook Team
Tags: booking, scheduling, chat, widget
Requires at least: 5.8
Tested up to: 6.4
Requires PHP: 7.4
Stable tag: 0.2.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Injects booking widget and JSON-LD and handles OAuth setup.

== Description ==

Injects booking widget and JSON-LD and handles OAuth setup.

Injects the chatnbook booking widget script and JSON-LD scheduling
metadata into your site, and adds a Settings page so you can point the
widget at your own chatnbook server and account without editing any code.

== Installation ==

1. Upload the plugin zip via Plugins -> Add New -> Upload Plugin (or
   extract it into `wp-content/plugins/`).
2. Activate the plugin through the 'Plugins' menu in WordPress.
3. Go to Settings -> AI SMB Booker and set your API base URL and account
   ID.
4. Visit your site to see the booking widget.

== Frequently Asked Questions ==

= Where do I find my API base URL and account ID? =

Ask whoever set up your chatnbook server. The API base URL is the root
URL of your chatnbook API deployment (for example
`https://your-account.example-region.run.app`), and the account ID
identifies your business within that deployment.

= What happens if I don't set an API base URL? =

The plugin will not inject the widget script or working scheduling links
until an API base URL is configured on the Settings page.

== Changelog ==

= 0.2.0 =
* Add a Settings API page (Settings -> AI SMB Booker) for the API base
  URL and account ID, with sanitization, capability checks, and nonces.
* Widget script and JSON-LD scheduling metadata now point at the
  configured API base instead of hardcoded placeholder domains.
* Add uninstall.php to remove the plugin's options on uninstall.

= 0.1.0 =
* Initial generated plugin: injects widget script and JSON-LD metadata.
