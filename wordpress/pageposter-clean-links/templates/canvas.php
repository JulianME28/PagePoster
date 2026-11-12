<?php
// Render only WordPress-authorized, marked content; direct requests reveal nothing.
if (!defined('ABSPATH') || !class_exists('PagePoster_Clean_Links', false)) { exit; }
$pageposter_post = PagePoster_Clean_Links::canvas_post();
if (!$pageposter_post) { return; }
?>
<!doctype html>
<html <?php language_attributes(); ?>>
<head>
<meta charset="<?php echo esc_attr(get_bloginfo('charset')); ?>">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title><?php echo esc_html(get_the_title($pageposter_post)); ?></title>
<?php
// Retain core visibility/canonical policy while keeping theme assets out of the
// self-contained customer layout. The saved content has already passed WP's
// normal permission and content-save checks; do not run autop/shortcodes on it.
if (function_exists('wp_robots')) { wp_robots(); }
elseif (function_exists('noindex')) { noindex(); }
if (function_exists('rel_canonical')) { rel_canonical(); }
?>
<style>html,body{margin:0;padding:0;min-height:100%;}</style>
</head>
<body class="pageposter-canvas">
<?php echo $pageposter_post->post_content; ?>
</body>
</html>
