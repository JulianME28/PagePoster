<?php
// Loaded only by the experimental Clean Links package.
if (!defined('ABSPATH')) { exit; }
final class PagePoster_AMP_Mode {
    public static function payload($content) {
        if (!is_string($content) || strlen($content) > 1000000
            || preg_match_all('/<div\s+hidden(?:="")?\s+data-pp-amp="([A-Za-z0-9+\/=]+)"\s*>\s*<\/div>/i', $content, $matches) !== 1) { return null; }
        $bytes = base64_decode($matches[1][0], true);
        if ($bytes === false || strlen($bytes) > 650000) { return null; }
        $data = json_decode($bytes, true);
        if (!is_array($data) || !isset($data['version'], $data['title'], $data['language'], $data['css'], $data['body'], $data['schema'])
            || $data['version'] !== 1 || !is_string($data['title']) || strlen($data['title']) > 2000
            || !is_string($data['language']) || !preg_match('/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i', $data['language'])
            || !is_string($data['css']) || strlen($data['css']) > 75000
            || preg_match('/[<\\\\]|!important|@import\b|expression\s*\(|javascript\s*:/i', $data['css'])
            || !is_string($data['body']) || !is_array($data['schema']) || count($data['schema']) > 20) { return null; }
        // Base64 must not provide an escape from WordPress's content permissions.
        $attributes = array_fill_keys(explode(' ', 'id class title lang dir role aria-label aria-hidden aria-expanded aria-controls href target rel width height src alt layout colspan rowspan scope span start reversed open datetime'), true);
        $allowed = array();
        foreach (explode(' ', 'a abbr address article aside b bdi bdo blockquote br caption cite code col colgroup dd del details dfn div dl dt em figcaption figure footer h1 h2 h3 h4 h5 h6 header hr i kbd li main mark nav ol p pre q s samp section small span strong sub summary sup table tbody td tfoot th thead time tr u ul var amp-img') as $tag) { $allowed[$tag] = $attributes; }
        if (wp_kses($data['body'], $allowed, array('https')) !== $data['body']) { return null; }
        return $data;
    }
    public static function eligible() {
        if (get_option('pageposter_amp_disabled', false) || is_admin() || is_feed()
            || (defined('REST_REQUEST') && REST_REQUEST) || !is_singular(array('post', 'page'))
            || (function_exists('is_preview') && is_preview()) || (function_exists('is_embed') && is_embed())) { return null; }
        $post = get_queried_object();
        if (!($post instanceof WP_Post) || $post->post_status !== 'publish' || post_password_required($post)
            || !user_can($post->post_author, 'unfiltered_html')) { return null; }
        $payload = self::payload($post->post_content);
        return $payload ? array($post, $payload) : null;
    }
    public static function head($html, $canonical, $amp) {
        if (!is_string($html)) { return $html; }
        // Ignore tag-like text in comments and raw-text elements. Keep the
        // original bytes outside the two managed relations.
        $attributes = '(?:[^<>"\x27]++|"[^"]*"|\x27[^\x27]*\x27)*';
        $token = '~<!--.*?(?:-->|$)|<(script|style|title|noscript)(?=[\s/>])' . $attributes .
            '>.*?(?:</\1\s*>|$)|<(/?)([a-z][a-z0-9:-]*)(?=[\s/>])' . $attributes . '>~is';
        $offset = 0;
        $in_head = false;
        $templates = 0;
        $remove = array();
        while (preg_match($token, $html, $matches, PREG_OFFSET_CAPTURE, $offset)) {
            list($tag, $start) = $matches[0];
            $offset = $start + strlen($tag);
            if (!isset($matches[3])) { continue; }
            $name = strtolower($matches[3][0]);
            $closing = $matches[2][0] === '/';
            if ($name === 'template') { $templates = max(0, $templates + ($closing ? -1 : 1)); continue; }
            if ($templates) { continue; }
            if ($name === 'body') { break; }
            if ($name === 'head') {
                if (!$closing) { $in_head = true; continue; }
                if (!$in_head) { break; }
                $links = '<link rel="canonical" href="' . esc_attr($canonical) . '"><link rel="amphtml" href="' . esc_attr($amp) . '">';
                $html = substr_replace($html, $links, $start, 0);
                foreach (array_reverse($remove) as $range) { $html = substr_replace($html, '', $range[0], $range[1]); }
                return $html;
            }
            if ($in_head && !$closing && $name === 'link' && self::managed_link($tag)) { $remove[] = array($start, strlen($tag)); }
        }
        return $html;
    }
    private static function managed_link($tag) {
        preg_match_all('~\s+([^\s=/<>]+)(?:\s*=\s*(?:"([^"]*)"|\x27([^\x27]*)\x27|([^\s>]+)))?~', $tag, $attributes, PREG_SET_ORDER);
        foreach ($attributes as $attribute) {
            if (strtolower($attribute[1]) !== 'rel') { continue; }
            $value = html_entity_decode(trim(implode(' ', array_slice($attribute, 2))), ENT_QUOTES | ENT_HTML5, 'UTF-8');
            $tokens = preg_split('/[\t\n\f\r ]+/', strtolower($value));
            return in_array('canonical', $tokens, true) || in_array('amphtml', $tokens, true);
        }
        return false;
    }
    public static function document($payload, $canonical, $robots = '') {
        $boilerplate = 'body{-webkit-animation:-amp-start 8s steps(1,end) 0s 1 normal both;-moz-animation:-amp-start 8s steps(1,end) 0s 1 normal both;-ms-animation:-amp-start 8s steps(1,end) 0s 1 normal both;animation:-amp-start 8s steps(1,end) 0s 1 normal both}@-webkit-keyframes -amp-start{from{visibility:hidden}to{visibility:visible}}@-moz-keyframes -amp-start{from{visibility:hidden}to{visibility:visible}}@-ms-keyframes -amp-start{from{visibility:hidden}to{visibility:visible}}@-o-keyframes -amp-start{from{visibility:hidden}to{visibility:visible}}@keyframes -amp-start{from{visibility:hidden}to{visibility:visible}}';
        $schema = '';
        foreach ($payload['schema'] as $item) { $schema .= '<script type="application/ld+json">' . json_encode($item, JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT) . '</script>'; }
        return '<!doctype html><html amp lang="' . esc_attr($payload['language']) . '"><head><meta charset="utf-8"><script async src="https://cdn.ampproject.org/v0.js"></script><title>' . esc_html($payload['title']) . '</title><link rel="canonical" href="' . esc_attr($canonical) . '"><meta name="viewport" content="width=device-width,minimum-scale=1,initial-scale=1">' . $robots . '<style amp-boilerplate>' . $boilerplate . '</style><noscript><style amp-boilerplate>body{-webkit-animation:none;-moz-animation:none;-ms-animation:none;animation:none}</style></noscript><style amp-custom>' . $payload['css'] . '</style>' . $schema . '</head><body>' . $payload['body'] . '</body></html>';
    }
    public static function start() {
        $found = self::eligible(); if (!$found) { return; }
        list($post, $payload) = $found;
        $canonical = get_permalink($post);
        $amp = add_query_arg('pageposter_amp', '1', $canonical);
        if (isset($_GET['pageposter_amp']) && is_string($_GET['pageposter_amp']) && $_GET['pageposter_amp'] === '1') {
            $robots = '';
            if (function_exists('wp_robots')) { ob_start(); wp_robots(); $robots = ob_get_clean(); }
            $rank = get_post_meta($post->ID, 'rank_math_robots', true);
            if ((string) get_option('blog_public', '1') === '0' || get_post_meta($post->ID, '_yoast_wpseo_meta-robots-noindex', true) === '1'
                || (is_array($rank) && in_array('noindex', $rank, true))) { $robots = '<meta name="robots" content="noindex,follow">'; }
            header('Content-Type: text/html; charset=UTF-8'); header('X-PagePoster-AMP: 1');
            echo self::document($payload, $canonical, $robots); exit;
        }
        $streamed = false;
        ob_start(static function ($html, $phase) use ($canonical, $amp, &$streamed) {
            if ($phase & PHP_OUTPUT_HANDLER_CLEAN) { return ''; }
            if (!($phase & PHP_OUTPUT_HANDLER_FINAL)) { $streamed = true; return $html; }
            if ($streamed) { return $html; }
            return PagePoster_AMP_Mode::head($html, $canonical, $amp);
        });
    }
}
add_action('template_redirect', array('PagePoster_AMP_Mode', 'start'), -10);
// Standard WordPress option; only an administrator can disable the helper.
add_action('admin_init', static function () {
    register_setting('pageposter_amp', 'pageposter_amp_disabled', array('sanitize_callback' => static function ($value) { return (bool) $value; }));
});
add_action('admin_menu', static function () {
    add_options_page('PagePoster AMP', 'PagePoster AMP', 'manage_options', 'pageposter-amp', static function () {
        if (!current_user_can('manage_options')) { return; }
        echo '<div class="wrap"><h1>PagePoster AMP</h1><p>Only pages with a PagePoster AMP payload are affected. Ordinary pages are unchanged.</p><form method="post" action="options.php">';
        settings_fields('pageposter_amp');
        echo '<label><input type="checkbox" name="pageposter_amp_disabled" value="1" ' . checked(get_option('pageposter_amp_disabled', false), true, false) . '> Disable experimental AMP on this site</label>';
        submit_button(); echo '</form></div>';
    });
});
