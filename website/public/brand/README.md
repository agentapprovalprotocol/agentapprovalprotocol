# AAP brand assets

The AAP symbol shows two agent flows entering an angular approval gate and one approved output. The lowercase wordmark uses outlined Roboto Mono Light glyphs with optical spacing. Its lighter strokes and smaller size balance the symbol, with the letter bodies optically centered on the output arrow.

| Files | Use |
| --- | --- |
| `aap-lockup-light.svg` / `.png` | Full logo for light surfaces |
| `aap-lockup-dark.svg` / `.png` | Full logo for dark surfaces |
| `aap-mark-light.svg` / `.png` | Standalone symbol for light surfaces |
| `aap-mark-dark.svg` / `.png` | Standalone symbol for dark surfaces |

All exports have transparent backgrounds. SVGs contain only vector artwork, with no embedded fonts or external dependencies. PNGs are convenience exports.

Use onyx (`#0a0d17`) on light surfaces and porcelain (`#f9f9f8`) on dark surfaces. Keep at least the arrow length of clear space around the symbol, and display the standalone mark at 24 px high or larger. The [favicon](../../app/icon.svg) uses a heavier stroke for smaller sizes.

The website's [Logo component](../../components/site/logo.tsx) reproduces the approved lockup using `currentColor`, so it follows the site's semantic ink token in both themes. Keep the component and these masters in sync when changing the artwork.

Roboto Mono is distributed under the SIL Open Font License 1.1. Its [license notice](../fonts/RobotoMono-LICENSE.txt) is included in the fonts directory.
