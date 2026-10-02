# Third-party notices

## doocs/md

The Markdown rendering structure and bounded theme visual rules were studied
from [doocs/md](https://github.com/doocs/md/tree/a7c17fc4cda92e3c13aa7e24f06615cfa4219b31),
fixed commit `a7c17fc4cda92e3c13aa7e24f06615cfa4219b31`, under WTFPL v2
(included at `LICENSES/DOOCS-MD-WTFPL-2.txt`).

No upstream source file is copied or vendored. The following files at the
fixed commit were read as behaviour and structure references:

| Upstream file | Local file | Adaptation |
| --- | --- | --- |
| `packages/core/src/renderer/renderer-impl.ts` | `src/typesetting.js` | Reimplemented only the basic Markdown-to-HTML boundary with `marked`; omitted custom renderer classes, highlighting, extensions and footnotes. |
| `packages/shared/src/configs/theme-css/base.css` | `public/typesetting-theme.css` | Locally rewrote the scoped container, typography, image and table base rules. |
| `packages/shared/src/configs/theme-css/default.css` | `public/typesetting-theme.css` | Locally rewrote the supported default heading, paragraph, list, quote, image, link, code, separator and table rules. |
| `packages/shared/src/configs/theme-css/grace.css` | `public/typesetting-theme.css` | Locally rewrote only supported 雅致 theme selectors for the same Markdown output. |
| `packages/shared/src/configs/theme-css/simple.css` | `public/typesetting-theme.css` | Locally rewrote only supported 简洁 theme selectors for the same Markdown output. |
| `packages/shared/src/configs/style.ts` | `src/typesetting.js`, `public/typesetting-theme.css` | Adapted the bounded presentation handoff and the four local CSS variables: 主色、字号、行距、段间距. |
| `apps/web/src/stores/theme.ts` | `src/typesetting.js` | Adapted only fixed theme names and per-theme settings validation; no client store is copied. |

`src/typesetting.js` additionally uses this project's server-side
`sanitize-html` policy; it is not a copy of the upstream sanitizer. The local
theme is a same-origin static stylesheet so it remains compatible with this
project's CSP. The Vue editor, Pinia stores, AI, image hosting, publishing,
Mermaid, PlantUML, charts, clipboard export, theme market, custom CSS, font
selection and code themes are excluded.
