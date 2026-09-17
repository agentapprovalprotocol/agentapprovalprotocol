# Fonts

Inter and Roboto Mono are distributed under the SIL Open Font License 1.1.
Their license notices are included in this directory.

Display headings use the reader's installed Georgia font. No proprietary font files are included.

The root layout preloads both webfonts, using the same URLs as the CSS.
Each face uses `font-display: optional` so a late font never replaces text
that is already visible. If a font misses the browser's initial loading
window or fails to download, that view keeps `system-ui` (sans) or
`ui-monospace` (mono). A subsequent full page load can use the downloaded
fonts from cache. Inter retains its 92% glyph scale.

CSS uses private `AAP` family names so installed desktop copies cannot
take over after an optional webfont misses its loading window.
