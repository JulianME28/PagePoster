<?php
define('ABSPATH', __DIR__ . '/');
$ctx = array('content' => '<style>#pp-landing{color:#123456}</style><div id="pp-landing"><h1>Ready HTML</h1><a href="https://offer.example/?x=1&amp;y=2">Visit casino</a></div>', 'title' => 'Title <safe> & exact');
$actions = array(); $filters = array();
function add_action($name, $callback, $priority = 10) { global $actions; $actions[$name] = $callback; }
function add_filter($name, $callback, $priority = 10) { global $filters; $filters[$name] = $callback; }
function apply_filters($name, $value, $post = null) { global $ctx; return !empty($ctx['disabled']) && in_array($name, array('pageposter_clean_links_enabled', 'pageposter_canvas_enabled'), true) ? false : $value; }
function __($text) { return $text; }
function _doing_it_wrong($function, $message, $version) { throw new RuntimeException($message); }
function esc_attr($value) { return htmlspecialchars($value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8'); }
function esc_html($value) { return esc_attr($value); }
function home_url($path = '') { return 'https://site.example' . $path; }
function site_url($path = '') { return home_url($path); }
function get_bloginfo($name) { return 'UTF-8'; }
function language_attributes() { echo 'lang="en-GB" dir="ltr"'; }
function get_the_title($post) { global $ctx; return $ctx['title']; }
function wp_robots() { echo '<meta name="robots" content="noindex, follow">'; }
function rel_canonical() { echo '<link rel="canonical" href="https://site.example/page/">'; }
function is_admin() { global $ctx; return !empty($ctx['admin']); }
function wp_doing_ajax() { global $ctx; return !empty($ctx['ajax']); }
function is_singular($types) { global $ctx; return empty($ctx['archive']); }
function is_feed() { global $ctx; return !empty($ctx['feed']); }
function is_embed() { global $ctx; return !empty($ctx['embed']); }
function is_trackback() { global $ctx; return !empty($ctx['trackback']); }
function is_404() { global $ctx; return !empty($ctx['404']); }
function post_password_required($post) { global $ctx; return !empty($ctx['password']); }
class WP_Post { public $post_content; public function __construct($content) { $this->post_content = $content; } }
function get_queried_object() { global $ctx; return !empty($ctx['missing']) ? null : new WP_Post($ctx['content']); }
require getenv('PP_CANVAS_PLUGIN');
$checks = 0;
function check($ok, $label) { global $checks; ++$checks; if (!$ok) { throw new RuntimeException('FAIL: ' . $label); } }
check(isset($filters['template_include']) && is_callable($filters['template_include']), 'standalone template filter exists');
function selected_template() { global $filters; return call_user_func($filters['template_include'], '/theme/empty-page.php'); }
$selected = selected_template();
check($selected !== '/theme/empty-page.php' && is_file($selected), 'marked page replaces an empty theme template');
ob_start(); include $selected; $html = ob_get_clean();
check(strpos($html, '<!doctype html>') !== false, 'complete document');
check(strpos($html, $ctx['content']) !== false, 'exact saved HTML is rendered without autop or shortcodes');
check(strpos($html, 'Title &lt;safe&gt; &amp; exact') !== false, 'title escaped');
check(strpos($html, 'lang="en-GB"') !== false, 'language preserved');
check(strpos($html, 'name="robots" content="noindex, follow"') !== false, 'core robots policy retained');
check(strpos($html, 'rel="canonical"') !== false, 'canonical retained');
check(strpos($html, 'name="viewport"') !== false, 'mobile viewport');
foreach (array('admin', 'ajax', 'archive', 'feed', 'embed', 'trackback', '404', 'password', 'missing', 'disabled') as $skip) {
 $ctx[$skip] = true; check(selected_template() === '/theme/empty-page.php', 'unchanged ' . $skip); unset($ctx[$skip]);
}
foreach (array('<p>Ordinary page</p>', '<!-- <div id="pp-landing">comment</div> -->', '<script>"<div id=pp-landing>text</div>"</script>') as $ordinary) {
 $ctx['content'] = $ordinary; check(selected_template() === '/theme/empty-page.php', 'ordinary or spoofed marker does not opt in');
}
$ctx['content'] = '<!-- wp:html --><div id="pp-landing">Prepared block</div><!-- /wp:html -->';
ob_start(); include selected_template(); $block = ob_get_clean();
check(strpos($block, $ctx['content']) !== false, 'native HTML block remains exact');
echo json_encode(array('passed' => true, 'checks' => $checks, 'php' => PHP_VERSION));
