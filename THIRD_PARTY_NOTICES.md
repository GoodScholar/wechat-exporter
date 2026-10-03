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
| `apps/web/src/services/export/clipboard-dom.ts` | `src/typesetting-output.js` | Copied and adapted only `solveWeChatImage()`, `modifyHtmlStructure()` and `createEmptyNode()`. The server-side adaptations use Cheerio, restrict conditionally reachable image dimensions to the local style allowlist, preserve the relative order of multiple nested lists, and keep clipboard boundary nodes out of plain text and full HTML. |
| `apps/web/src/services/export/clipboard.ts` | `src/typesetting-output.js`, `public/typesetting.js` | Read only as a reference for the safe DOM → CSS inlining → compatibility fix → dual-MIME order. The browser DOM clone, complete clipboard pipeline and fallback behavior were not copied. |

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

For Issue #7, the three clipboard DOM helpers above are the only copied
clipboard code. This project has not copied the complete doocs clipboard
pipeline. It deliberately renders again on the server instead of cloning the
preview DOM. It also excludes `createEmptyNode()` sentinels from plain text and
keeps multiple nested lists in their original order. Rich-copy failure never
returns un-inlined HTML, never calls the legacy `execCommand` path and never
reports a plain-text fallback as rich-copy success. This is an active deviation
from the upstream fallback semantics.

## Juice

This project uses [Juice 11.0.3](https://github.com/Automattic/juice/tree/ce15687713507252813744b0daaa70d4549527d1),
fixed git commit `ce15687713507252813744b0daaa70d4549527d1`, under the MIT
License. Its bundled license states `Copyright (c) 2021 Automattic`, and its
package metadata requires Node.js `>=18.17`.

The output module calls only the string public API `juice(html, options)` with
local HTML, repository-owned CSS and fixed options. It does not call
`juiceResources()` or `juiceFile()`, does not use Juice's internal DOM, and
does not permit Juice to fetch remote resources. Any inlining or post-inline
validation failure fails the rich HTML artifact instead of returning an
un-inlined fallback. The installed npm package includes `LICENSE.md`; this
notice preserves the version, source commit, copyright and license provenance
for source distributions.

The Clipboard API, Blob and object URL APIs used by the browser output flow are
browser standards; no third-party source code was copied to use them. The
project has not completed compatibility acceptance in the real WeChat Official
Account editor; automated tests cover only the local safety, structure,
inlining, MIME, metadata and race contracts.
