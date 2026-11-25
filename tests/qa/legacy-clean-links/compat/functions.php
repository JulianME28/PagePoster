<?php
namespace PagePoster\Compat;
// WordPress 6.2 supplies this PHP 8 helper globally; old WordPress does not.
// Keep the substitute private to this compatibility namespace.
function str_starts_with($haystack, $needle) {
    return $needle === '' || strpos($haystack, $needle) === 0;
}

// WordPress introduced this helper after some supported legacy releases.
// Default URI attributes copied from WordPress 6.2 wp-includes/kses.php (GPL).
function wp_kses_uri_attributes() {
    if (\function_exists('wp_kses_uri_attributes')) {
        return \wp_kses_uri_attributes();
    }
    return \apply_filters('wp_kses_uri_attributes', array(
        'action', 'archive', 'background', 'cite', 'classid', 'codebase',
        'data', 'formaction', 'href', 'icon', 'longdesc', 'manifest',
        'poster', 'profile', 'src', 'usemap', 'xmlns'
    ));
}
