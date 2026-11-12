PagePoster Clean Links 1.1.3

Marked PagePoster pages use a standalone canvas template. Saved HTML renders
when the theme template is empty or omits the content. Theme assets stay out
of this layout. Core canonical and robots policy, title, language and viewport
remain. The plugin does not create or modify posts, options or theme files.

Only authorized singular posts/pages with a parsed DIV pp-landing or
pp-universal-pl use the canvas. Ordinary pages, archives, admin, AJAX, REST,
feeds, embeds, errors and password-protected content keep the original template.
Filter pageposter_canvas_enabled can opt a marked page out of the canvas.
Existing outside HTTP(S), contact and javascript: link cleanup is retained.

WordPress > Plugins > Add New > Upload Plugin > select the ZIP. If prompted,
choose Replace current with uploaded, then activate. Clear the page cache
if present and reload the existing published page. No repasting or regeneration
is required. Do not delete the page or change the active site theme.

Requires WordPress 3.5+ and PHP 5.6.20+. This standalone native-editor package
is separate from existing Bridge workflows with their pinned 1.1.1 package.