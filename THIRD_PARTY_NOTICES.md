# Third-party notices

## doocs/md

The Markdown rendering structure and default-theme visual rules were studied
from [doocs/md](https://github.com/doocs/md/tree/a7c17fc4cda92e3c13aa7e24f06615cfa4219b31),
fixed commit `a7c17fc4cda92e3c13aa7e24f06615cfa4219b31`, under WTFPL v2
(included at `LICENSES/DOOCS-MD-WTFPL-2.txt`).

No upstream source file is copied or vendored. The following files at the
fixed commit were read as behaviour and structure references:

| Upstream file | Local file | Adaptation |
| --- | --- | --- |
| `packages/core/src/renderer/renderer-impl.ts` | `src/typesetting.js` | Reimplemented only the basic Markdown-to-HTML boundary with `marked`; omitted custom renderer classes, highlighting, extensions and footnotes. |
| `packages/shared/src/configs/theme-css/base.css` | `public/typesetting-theme.css` | Locally rewrote the minimal container, typography, image, table and block spacing rules for the default proof. |
| `packages/shared/src/configs/theme-css/default.css` | `public/typesetting-theme.css` | Locally rewrote only default-theme heading, paragraph, quote, link, code and table rules. |

`src/typesetting.js` additionally uses this project's server-side
`sanitize-html` policy; it is not a copy of the upstream sanitizer. The local
theme is a same-origin static stylesheet so it remains compatible with this
project's CSP. The Vue editor, stores, AI, image hosting, publishing, Mermaid,
PlantUML, charts, clipboard export, and non-default themes are excluded.
