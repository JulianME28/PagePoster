<?php
define('ABSPATH', __DIR__ . '/');
function add_action($name, $callback, $priority = 10) {}
function add_filter($name, $callback, $priority = 10) {}
function home_url($path = '') { return 'https://' . (getenv('PP_HOME_HOST') ?: 'site.example') . $path; }
function site_url($path = '') { return 'https://' . (getenv('PP_SITE_HOST') ?: 'site.example') . $path; }
require getenv('PP_CANVAS_PLUGIN');
echo PagePoster_Clean_Links::filter_html(file_get_contents('php://stdin'));
