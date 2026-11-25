<?php
define('ABSPATH', __DIR__ . '/');
function add_action() {}
function apply_filters($name, $value) { return $value; }
function wp_allowed_protocols() { return array('https'); }
if (!function_exists('str_starts_with')) { function str_starts_with($text, $prefix) { return $prefix === '' || strpos($text, $prefix) === 0; } }
require __DIR__ . '/wordpress-kses-6.2.php';
function esc_attr($value) { return htmlspecialchars($value, ENT_QUOTES, 'UTF-8'); }
function esc_html($value) { return htmlspecialchars($value, ENT_QUOTES, 'UTF-8'); }
function get_option($key, $fallback = false) { global $options; return isset($options[$key]) ? $options[$key] : $fallback; }
function is_admin() { return false; }
function is_feed() { return false; }
function is_singular() { return true; }
function is_preview() { return false; }
function is_embed() { return false; }
function user_can() { global $unfiltered; return $unfiltered; }
function post_password_required($post) { return false; }
function get_queried_object() { global $post; return $post; }
function get_permalink($post) { return 'https://fixture.example/page/'; }
function add_query_arg($name, $value, $url) { return $url . '?' . $name . '=' . $value; }
function get_post_meta() { return ''; }
class WP_Post { public $post_content; public $post_author = 1; public $post_status = 'publish'; public $ID = 10; }
$input = json_decode(file_get_contents($argv[1]), true); $options = array(); $unfiltered = true;
$post = new WP_Post(); $post->post_content = $input['content'];
require $argv[2];
if ($input['mode'] === 'head') { echo PagePoster_AMP_Mode::head($post->post_content, get_permalink($post), get_permalink($post) . '?pageposter_amp=1'); exit; }
if ($input['mode'] === 'amp') { $_GET['pageposter_amp'] = '1'; PagePoster_AMP_Mode::start(); exit; }
if ($input['mode'] === 'main') { PagePoster_AMP_Mode::start(); echo '<!doctype html><html><head><title>Main</title><link rel="canonical" href="https://wrong.example/"><link href="https://old.example/" rel=amphtml></head><body>' . $post->post_content . '</body></html>'; exit; }
$valid = PagePoster_AMP_Mode::payload($post->post_content);
$checks = array('payload' => (bool) $valid, 'eligible' => (bool) PagePoster_AMP_Mode::eligible());
$options['pageposter_amp_disabled'] = true; $checks['disabled'] = PagePoster_AMP_Mode::eligible() === null;
$options = array(); $unfiltered = false; $checks['filteredAuthor'] = PagePoster_AMP_Mode::eligible() === null;
$unfiltered = true; $post->post_status = 'draft'; $checks['draft'] = PagePoster_AMP_Mode::eligible() === null;
$post->post_status = 'publish'; $post->post_content = '<p>Ordinary page</p>'; $checks['ordinary'] = PagePoster_AMP_Mode::eligible() === null;
echo json_encode($checks);
