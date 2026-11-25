<?php
/**
 * Plugin Name: PagePoster Bridge
 * Description: Authenticated idempotent static-page operations with a transactional compare-and-swap ledger.
 * Version: 0.2.1
 * Requires at least: 5.6
 * Requires PHP: 8.0
 * Author: PagePoster
 * License: GPL-2.0-or-later
 * License URI: https://www.gnu.org/licenses/old-licenses/gpl-2.0.html
 */
namespace PagePoster\Bridge;

if (!defined('ABSPATH')) exit;
if (PHP_VERSION_ID < 80000) return;

require_once __DIR__ . '/includes/class-contract.php';
require_once __DIR__ . '/includes/class-database.php';
require_once __DIR__ . '/includes/class-engine.php';
require_once __DIR__ . '/includes/class-rest.php';
require_once __DIR__ . '/includes/class-native-editor.php';

$bridge = new Rest(static function () {
    global $wpdb;
    return Database::connect($wpdb);
});
add_action('application_password_did_authenticate', [$bridge, 'captureApplicationPassword'], 10, 2);
add_action('rest_api_init', [$bridge, 'registerRoutes']);
$native = new NativeEditor(static function () {global $wpdb;return Database::connect($wpdb);}, $bridge);
add_filter('use_block_editor_for_post', [$native, 'blockEditor'], 100, 2);
add_filter('wp_default_editor', [$native, 'editorMode']);
add_action('edit_form_after_title', [$native, 'fields']);
add_action('admin_init', [$native, 'submit'], 1);
add_filter('rest_post_dispatch', static function ($response, $server, $request) {
    if (strpos($request->get_route(), '/pageposter/v1/') === 0 && method_exists($response, 'header')) {
        $response->header('Cache-Control', 'no-store');
    }
    return $response;
}, 10, 3);

register_activation_hook(__FILE__, static function ($networkWide = false) {
    if ($networkWide || is_multisite()) wp_die('PagePoster Bridge supports single-site WordPress only.');
    if (!extension_loaded('mysqli') || !class_exists('\DOMDocument')) wp_die('PagePoster Bridge requires the PHP mysqli/mysqlnd and DOM extensions.');
    global $wpdb;
    $database = null;
    try {
        $database = Database::connect($wpdb);
        $database->install();
    } catch (\Throwable $error) {
        wp_die('PagePoster Bridge requires a dedicated mysqli connection and InnoDB posts/storage tables without SQL triggers. No existing post was changed.');
    } finally {
        if ($database) $database->close();
    }
});
// Deactivation/uninstallation deliberately retain the operation ledger and managed-page registry.
// Deleting the ledger would remove the protection against duplicate operation IDs after retries.
