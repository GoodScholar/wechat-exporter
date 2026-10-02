# Third-party notices

## doocs/md

The Markdown rendering structure and default-theme visual rules were studied
from [doocs/md](https://github.com/doocs/md/tree/a7c17fc4cda92e3c13aa7e24f06615cfa4219b31),
fixed commit `a7c17fc4cda92e3c13aa7e24f06615cfa4219b31`, under WTFPL v2
(included at `LICENSES/DOOCS-MD-WTFPL-2.txt`).

No upstream source file is copied or vendored. `src/typesetting.js` is a small
local compatibility layer: it uses server-side sanitization and `marked` for
basic Markdown, then applies a locally rewritten default-theme subset. It
intentionally excludes the Vue editor, stores, AI, image hosting, publishing,
Mermaid, PlantUML, charts, clipboard export, and non-default themes.
