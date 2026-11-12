<?php
/**
 * Plugin Name: PagePoster Clean Links
 * Description: Removes external web, email and telephone link destinations outside PagePoster content on generated pages. Keeps the page design, offer buttons and brand links intact.
 * Version: 1.1.3
 * Requires at least: 3.5
 * Requires PHP: 5.6.20
 * Author: PagePoster
 * License: GPL-2.0-or-later
 */

if (!defined('ABSPATH')) { exit; }

final class PagePoster_Clean_Links {
    const VERSION = '1.1.3';
    const FEATURES = array('contact-schemes', 'exact-wrapper-boundary', 'dynamic-links', 'javascript-placeholders', 'standalone-canvas');
    private static $started = false;

    private static function parser($html) {
        if (class_exists('WP_HTML_Tag_Processor')) {
            return new WP_HTML_Tag_Processor($html);
        }
        if (!class_exists('PagePoster\\Compat\\WP_HTML_Tag_Processor', false)) {
            $base = __DIR__ . '/compat/';
            require_once $base . 'functions.php';
            require_once $base . 'class-wp-html-attribute-token.php';
            require_once $base . 'class-wp-html-text-replacement.php';
            require_once $base . 'class-wp-html-span.php';
            require_once $base . 'class-wp-html-tag-processor.php';
        }
        return new \PagePoster\Compat\WP_HTML_Tag_Processor($html);
    }

    private static function parse_url($url, $part = -1) {
        return function_exists('wp_parse_url') ? wp_parse_url($url, $part) : parse_url($url, $part);
    }

    private static function local_http_path($href, $home_host) {
        if (!is_string($href) || !preg_match('~^http://~i', trim($href))) { return null; }
        $parts = self::parse_url(trim($href));
        if (!is_array($parts) || empty($parts['host'])
            || self::normalize_host($parts['host']) !== self::normalize_host($home_host)
            || isset($parts['user']) || isset($parts['pass']) || isset($parts['port'])) { return null; }
        $path = isset($parts['path']) && $parts['path'] !== '' ? $parts['path'] : '/';
        // A protocol-relative path must not accidentally become a different host.
        if (strpos($path, '//') === 0 || strpos($path, '\\') !== false) { return null; }
        if (isset($parts['query'])) { $path .= '?' . $parts['query']; }
        if (isset($parts['fragment'])) { $path .= '#' . $parts['fragment']; }
        return $path;
    }

    private static function is_root($tags) {
        return $tags->get_tag() === 'DIV'
            && in_array($tags->get_attribute('id'), array('pp-universal-pl', 'pp-landing'), true);
    }

    public static function is_pageposter_content($html) {
        if (!is_string($html)) { return false; }
        $tags = self::parser($html);
        while ($tags->next_tag('DIV')) {
            if (self::is_root($tags)) { return true; }
        }
        return false;
    }

    private static function normalize_host($host) {
        return preg_replace('/^www\./i', '', rtrim(strtolower((string) $host), '.'));
    }

    public static function is_external_http_url($href, $local_hosts) {
        if (!is_string($href)) { return false; }
        $href = trim($href);
        // This helper classifies HTTP(S) only; contact schemes are handled separately.
        if (!preg_match('~^(?:https?:)?//~i', $href)) { return false; }
        if (strpos($href, '//') === 0) { $href = 'https:' . $href; }
        $host = self::parse_url($href, PHP_URL_HOST);
        if (!is_string($host) || $host === '') { return false; }
        $host = self::normalize_host($host);
        foreach ($local_hosts as $local_host) {
            if ($host === self::normalize_host($local_host)) { return false; }
        }
        return true;
    }

    private static function is_contact_url($href) {
        return is_string($href) && preg_match('~^(?:mailto|tel):~i', trim($href)) === 1;
    }


    private static function is_script_url($href) {
        return is_string($href) && preg_match('~^javascript:~i', preg_replace('/[\x00-\x20]/', '', $href)) === 1;
    }

    private static function runtime($local_hosts) {
        $hosts = json_encode(array_map(array(__CLASS__, 'normalize_host'), $local_hosts), JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT);
        $js = <<<'JS'
(function(hosts){
 'use strict';
 var roots='div#pp-landing,div#pp-universal-pl';
 function own(el){for(var n=el;n&&n.nodeType===1;n=n.parentElement){if(n.tagName==='DIV'&&(n.id==='pp-landing'||n.id==='pp-universal-pl'))return true;}return false;}
 function normalize(host){return host.toLowerCase().replace(/\.$/,'').replace(/^www\./,'');}
 function clean(el){
  if(!el||!/^(A|AREA)$/.test(el.tagName)||own(el))return;
  var href=el.getAttribute('href');if(href===null)return;
  var compact=href.replace(/[\x00-\x20]/g,''),remove=/^(javascript|mailto|tel):/i.test(compact);
  if(!remove&&/^(https?:)?\/\//i.test(compact)){
   var link=document.createElement('a');link.href=compact;
   remove=!!link.hostname&&hosts.indexOf(normalize(link.hostname))===-1;
  }
  if(remove){el.removeAttribute('href');el.removeAttribute('ping');}
 }
 function scan(node){
  if(!node||node.nodeType!==1||own(node))return;
  clean(node);var links=node.querySelectorAll('a[href],area[href]');
  for(var i=0;i<links.length;i++)clean(links[i]);
 }
 if(!document.querySelector(roots))return;
 scan(document.documentElement);
 if(window.MutationObserver)new MutationObserver(function(records){
  for(var i=0;i<records.length;i++){
   var r=records[i];
   if(r.type==='attributes')clean(r.target);
   else for(var j=0;j<r.addedNodes.length;j++)scan(r.addedNodes[j]);
  }
 }).observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['href','ping']});
})(__HOSTS__);
JS;
        return '<script id="pageposter-clean-links-runtime">' . str_replace('__HOSTS__', $hosts, $js) . '</script>';
    }

    public static function filter_html($html) {
        if (!is_string($html)) { return $html; }
        $local_hosts = array(self::parse_url(home_url('/'), PHP_URL_HOST), self::parse_url(site_url('/'), PHP_URL_HOST));
        $tags = self::parser($html);
        $depth = 0;
        $found_root = false;
        $has_runtime = false;
        while ($tags->next_tag(array('tag_closers' => 'visit'))) {
            $tag = $tags->get_tag();
            if ($tag === 'SCRIPT' && $tags->get_attribute('id') === 'pageposter-clean-links-runtime') { $has_runtime = true; }
            if ($tags->is_tag_closer()) {
                if ($depth > 0 && $tag === 'DIV') { --$depth; }
                continue;
            }
            if ($depth > 0) {
                if ($tag === 'DIV') { ++$depth; }
                continue;
            }
            if (self::is_root($tags)) {
                $found_root = true;
                $depth = 1;
                continue;
            }
            if ($tag === 'A' || $tag === 'AREA') {
                $href = $tags->get_attribute('href');
                if (self::is_external_http_url($href, $local_hosts) || self::is_contact_url($href) || self::is_script_url($href)) {
                    $tags->remove_attribute('href');
                    if ($tags->get_attribute('ping') !== null) {
                        // Early WordPress parsers can skip the next tag when two
                        // attribute removals shift their cursor in one batch.
                        $tags->get_updated_html();
                        $tags->remove_attribute('ping');
                    }
                } else {
                    $relative = self::local_http_path($href, $local_hosts[0]);
                    if ($relative !== null) { $tags->set_attribute('href', $relative); }
                }
            }
        }
        // Never return speculative edits for ordinary pages or an incomplete root.
        if (!$found_root || $depth !== 0) { return $html; }
        if (method_exists($tags, 'paused_at_incomplete_token') && $tags->paused_at_incomplete_token()) { return $html; }
        $out = $tags->get_updated_html();
        if (!$has_runtime) {
            $runtime = self::runtime($local_hosts);
            $end = strripos($out, '</body>');
            $out = $end === false ? $out . $runtime : substr($out, 0, $end) . $runtime . substr($out, $end);
        }
        return $out;
    }

    private static function eligible_post() {
        if (is_admin() || (defined('DOING_AJAX') && DOING_AJAX)
            || (function_exists('wp_doing_ajax') && wp_doing_ajax()) || (defined('REST_REQUEST') && REST_REQUEST)
            || !is_singular(array('post', 'page')) || is_feed()
            || (function_exists('is_embed') && is_embed()) || is_trackback()
            || (function_exists('is_404') && is_404())) { return null; }
        $post = get_queried_object();
        if (!($post instanceof WP_Post) || post_password_required($post)
            || !self::is_pageposter_content($post->post_content)) { return null; }
        return apply_filters('pageposter_clean_links_enabled', true, $post) ? $post : null;
    }

    public static function canvas_post() {
        $post = self::eligible_post();
        return $post && apply_filters('pageposter_canvas_enabled', true, $post) ? $post : null;
    }

    public static function template($template) {
        if (!self::canvas_post()) { return $template; }
        $canvas = __DIR__ . '/templates/canvas.php';
        return is_file($canvas) ? $canvas : $template;
    }

    public static function start() {
        if (self::$started || !self::eligible_post()) { return; }

        self::$started = true;
        $streamed = false;
        // Filter complete HTML responses only. Explicit streaming flushes pass
        // through unchanged, including native ob_clean/ob_end_clean semantics.
        // No posts, options or theme files are edited.
        ob_start(static function ($html, $phase) use (&$streamed) {
            if ($phase & PHP_OUTPUT_HANDLER_CLEAN) { return ''; }
            if (!($phase & PHP_OUTPUT_HANDLER_FINAL)) { $streamed = true; return $html; }
            if ($streamed) { return $html; }
            foreach (headers_list() as $header) {
                if (stripos($header, 'Content-Type:') === 0
                    && stripos($header, 'text/html') === false) { return $html; }
            }
            return self::filter_html($html);
        });
    }
}

add_action('template_redirect', array('PagePoster_Clean_Links', 'start'), 0);
add_filter('template_include', array('PagePoster_Clean_Links', 'template'), 99);
