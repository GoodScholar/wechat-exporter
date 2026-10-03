# Third-party notices

## doocs/md

The Markdown rendering structure and bounded theme visual rules were studied
from [doocs/md](https://github.com/doocs/md/tree/a7c17fc4cda92e3c13aa7e24f06615cfa4219b31),
fixed commit `a7c17fc4cda92e3c13aa7e24f06615cfa4219b31`, under WTFPL v2
(included at `LICENSES/DOOCS-MD-WTFPL-2.txt`).

The following files at the fixed commit were either minimally adapted or read
as behaviour and structure references:

| Upstream file | Local file | Adaptation |
| --- | --- | --- |
| `packages/core/src/renderer/renderer-impl.ts` | `src/typesetting-render.js` | Minimally adapted `addFootnote()` first-number/reuse behavior, the `buildFootnoteArray()` / `buildFootnotes()` reference-list structure, and the `renderer.link()` ordering that checks the WeChat exception before ordinary external-link conversion. |
| `packages/shared/src/configs/theme-css/base.css` | `public/typesetting-theme.css` | Locally rewrote the scoped container, typography, image and table base rules. |
| `packages/shared/src/configs/theme-css/default.css` | `public/typesetting-theme.css` | Locally rewrote the supported default heading, paragraph, list, quote, image, link, code, separator and table rules. |
| `packages/shared/src/configs/theme-css/grace.css` | `public/typesetting-theme.css` | Locally rewrote only supported 雅致 theme selectors for the same Markdown output. |
| `packages/shared/src/configs/theme-css/simple.css` | `public/typesetting-theme.css` | Locally rewrote only supported 简洁 theme selectors for the same Markdown output. |
| `packages/shared/src/configs/style.ts` | `src/typesetting.js`, `public/typesetting-theme.css` | Adapted the bounded presentation handoff and the four local CSS variables: 主色、字号、行距、段间距. |
| `apps/web/src/stores/theme.ts` | `src/typesetting.js` | Adapted only fixed theme names and per-theme settings validation; no client store is copied. |

The footnote adaptation deliberately differs from upstream: it normalizes and
classifies links with the platform URL parser, uses an exact HTTPS WeChat
article boundary, keeps a bare URL as a link with a reference, aggregates
preview targets for repeated normalized URLs, explicitly escapes generated
text and attributes, and runs the complete result through this project's final
`sanitize-html` policy. The upstream regex, `href === text` unlinking behavior,
Vue editor, Pinia stores, full renderer, footnote extension, image hosting,
publishing and clipboard pipeline are not copied.

The local theme is a same-origin static stylesheet so it remains compatible
with this project's CSP. AI, Mermaid, PlantUML, charts, the theme market,
custom CSS, font selection and code themes are excluded.
