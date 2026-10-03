# 复制公众号富文本并下载 HTML 与 Markdown 设计规格

## 目标

在现有公众号排版工作台中增加四类输出：

1. 把经过最新格式检查的正文以一次 `ClipboardItem` 写入语义一致的 `text/html` 与 `text/plain`；
2. 分别复制标题、作者、公众号名称和发布日期的原始字段值；
3. 下载包含元信息、当前主题和安全正文的完整 HTML；
4. 下载或复制带规范 YAML front matter 的源 Markdown。

本规格实现 GitHub Issue #7，依赖已经交付的 #5 三套主题与 #6 格式检查。富文本和完整 HTML 必须由服务端基于当前源文稿重新渲染并生成，不能读取或信任浏览器当前预览 DOM。只有真正写入 `text/html` 后才显示富文本复制成功；权限拒绝或 API 不支持时明确保留 Markdown/HTML 替代入口。

自动化验收只证明本项目的安全、结构、内联样式、双 MIME、元信息边界和竞态契约，不宣称已在真实微信公众号编辑器中完成兼容验收。

## 已确认的产品与架构裁决

以下裁决已经确认，实施不得自行改写：

1. 不扩展 #6 的四键 `RenderResult`：`{ html, presentation, diagnostics, blocked }`。
2. 新增 `src/typesetting-output.js` 深模块和严格 `POST /api/typesetting/output`；输出模块在服务端重新调用 renderer，不复制当前 preview DOM。
3. 输出请求顶层恰好为 `document`、`presentation`、`convertExternalLinksToFootnotes`、`failedImageTargets`；`document` 恰好包含 `title`、`author`、`account`、`publishedAt`、`body`。
4. `failedImageTargets` 中的每一项都必须在本次重新渲染的安全 HTML 中对应唯一、受控的 HTTPS `<img>`；重复、未知、静态占位、链接或其他节点 target 一律拒绝。
5. blocker 响应仍提供源 Markdown；只有非 blocker 响应才提供 clipboard HTML/plain 与完整 HTML。
6. 固定复用 `doocs/md@a7c17fc4cda92e3c13aa7e24f06615cfa4219b31` 的 `solveWeChatImage()`、`modifyHtmlStructure()`、`createEmptyNode()`，并保持“安全 DOM → Juice → 修正 → 双 MIME”的顺序。
7. 精确依赖 `juice@11.0.3`。任何 CSS 内联或内联后安全校验失败都不得输出富文本/完整 HTML 成功，不允许退化为未内联 HTML。
8. 最新成功 render 后自动预生成并缓存严格 output bundle。字段、主题、主题设置、脚注开关或运行时坏图集合变化时立即失效并重建。
9. “复制到微信”的固定门禁为：最新 `renderFresh=true`、`renderBlocked=false`、`outputFresh=true`，且 render version、output version 与完整输入 snapshot 同时一致。
10. 富文本只允许一次 `navigator.clipboard.write([ClipboardItem])` 写入双 MIME；只有 Promise resolve 才成功。拒绝、不支持或抛错时不调用 `execCommand`，也不以纯文本写入冒充成功。
11. 四项元信息各自通过 `navigator.clipboard.writeText()` 精确复制当前字段值；正文 clipboard MIME 不包含任何元信息。
12. 完整 HTML 包含安全文档壳、四项元信息、当前主题正文；Markdown 使用 JSON 双引号兼容的 YAML front matter、规范 LF 和源正文。
13. 静态图片占位和其他非 blocker 允许输出。运行时失败图片按当前 target 集合在输出中变成可见占位，也不阻断输出。
14. HTML/Markdown 下载只由客户端基于当前 bundle 创建 Blob。blocker 时 Markdown 可以使用 bundle，也可从当前源字段本地生成；HTML 只允许来自当前、安全、非 blocker bundle。

## 范围与非目标

### 本次范围

- 严格输出请求/响应与 typed error；
- 服务端重新渲染、主题 CSS 内联、图片和边界修正、最终白名单；
- 正文双 MIME 复制、四项元信息独立复制；
- 完整 HTML 与 Markdown 下载；
- 输出预生成、缓存、失效、竞态门禁和失败替代 UI；
- 源码许可说明和结构/浏览器自动化测试。

### 非目标

- 不实现 Issue #8 的三栏重排、面板折叠、移动端单视图或完整设置抽屉。
- 不上传、代理、下载、重托管或探测远程图片，不把 HTTP 升级为 HTTPS。
- 不加入自定义 CSS、远程 CSS、网络字体、脚本、主题市场、邮件模板或新的 Markdown 语法。
- 不复制 doocs 的 Vue/Pinia/store、SVG/图表/emoji pipeline、图床和 `execCommand` fallback。
- 不修改文章批量导出领域，也不把 output bundle 持久化到文稿或磁盘。
- 不保证微信会永久保留每个 CSS 属性；真实微信粘贴行为属于后续人工兼容验收。

## 总体架构

```text
当前严格文稿快照 + 当前 presentation + 脚注开关 + 运行时坏图 target 集合
  → POST /api/typesetting/output
      → src/typesetting-output.js 严格规范化
      → 重新调用 renderTypesettingMarkdown()
      → 校验 failedImageTargets 属于本次唯一受控 img
      → blocker：只生成规范 Markdown bundle
      → 非 blocker：
          安全 renderer HTML
          → 应用运行时坏图占位
          → 固定主题 CSS + Juice 11.0.3
          → canonical 内联正文最终白名单
          ├─ 安全文档壳 + 元信息 + canonical 正文 HTML
          └─ clipboard 派生副本
              → 嵌套列表 / 图片尺寸修正
              → clipboard 最终白名单
              → 正文 clipboard HTML + 块语义 plain text
      → strict OutputBundle
  → 浏览器仅缓存通过完整 schema 与 snapshot 校验的最新 bundle
      ├─ ClipboardItem(text/html + text/plain)
      ├─ writeText(单项元信息 / Markdown)
      └─ Blob 下载 HTML / Markdown
```

模块职责：

- `src/typesetting-render.js` 继续是 Markdown、安全 HTML、静态 diagnostics 和 blocked 的唯一来源，不知道 clipboard、元信息或下载。
- `src/typesetting-output.js` 是输出深模块；除 default builder 和测试/组装 factory 外，规范化、front matter、DOM 修正、plain text、文件名和文档壳 helper 均保持私有。
- `src/server.js` 只做严格 HTTP 接线和错误映射，不在路由里拼 HTML。
- `public/typesetting.js` 不生成富文本 HTML，只负责 snapshot、严格响应校验、状态门禁以及浏览器 Clipboard/Blob API。

## 输出请求契约

`POST /api/typesetting/output` 只接受 `application/json`，顶层必须恰好四键：

```json
{
  "document": {
    "title": "示例标题",
    "author": "作者",
    "account": "公众号名称",
    "publishedAt": "2026-10-03",
    "body": "# 正文"
  },
  "presentation": {
    "theme": "default",
    "settings": {
      "primaryColor": "#0F4C81",
      "fontSize": "16px",
      "lineHeight": "1.75",
      "blockSpacing": "1"
    }
  },
  "convertExternalLinksToFootnotes": false,
  "failedImageTargets": []
}
```

严格规则：

- `document` 必须恰好包含五个字符串字段；不接收 `revision`、`savedAt`、`theme` 或完整 `themeSettings`。输出允许基于尚未保存的当前编辑值，不触发持久化。
- `presentation` 完全复用 #5 的 `normalizeTypesettingPresentation()`，只接受三个主题和四项有界设置。
- `convertExternalLinksToFootnotes` 必须是 boolean。
- `failedImageTargets` 必须是字符串数组，元素非空、互不重复，并按当前预览 DOM 的 target 顺序排列。客户端从自己的失败集合按 DOM 顺序投影，不能按事件到达顺序发送。
- 服务端用 `{ body, presentation, convertExternalLinksToFootnotes }` 重新 renderer。对每个 failed target，重新渲染结果中必须恰好找到一个带该 `data-format-target` 的 `<img>`；该图片还必须满足现有 renderer 的 HTTPS、无凭据、`referrerpolicy="no-referrer"` 与受控 target 规则。
- failed target 在重渲染 DOM 中的顺序必须与请求数组一致；unknown、duplicate、乱序、非 `<img>`、静态占位或重复 DOM target 返回 400，不生成任何 output bundle。
- 路由不读取浏览器发来的 HTML、diagnostics、blocked、主题 CSS、文件名或 MIME；出现这些额外键一律 400。

服务端重启会改变 #6 的 target nonce。若打开页面持有旧 target，请求会收到 failed target 400；客户端必须把 render/output 标记 stale 并重新请求 `/api/typesetting/render`，不得删除 failed target 后静默重试。

## 严格 OutputBundle

成功 HTTP 响应必须恰好包含七个顶层字段：

```js
{
  schemaVersion: 1,
  status: 'ready' | 'blocked',
  snapshot: {
    document: { title, author, account, publishedAt, body },
    presentation: { theme, settings: { primaryColor, fontSize, lineHeight, blockSpacing } },
    convertExternalLinksToFootnotes: boolean,
    failedImageTargets: string[]
  },
  diagnostics: Diagnostic[],
  markdown: {
    mimeType: 'text/markdown;charset=utf-8',
    filename: string,
    content: string
  },
  clipboard: null | {
    html: { mimeType: 'text/html', content: string },
    plain: { mimeType: 'text/plain', content: string }
  },
  html: null | {
    mimeType: 'text/html;charset=utf-8',
    filename: string,
    content: string
  }
}
```

判别规则：

- `schemaVersion` 固定为数字 `1`；未知版本必须整包拒绝。
- `snapshot` 是服务端规范化后的输入回显，键和嵌套 shape 严格。`failedImageTargets` 使用重新渲染 DOM 顺序。客户端必须与当前 snapshot 逐字段比较，不能只比较正文或 revision。
- `diagnostics` 复用 #6 的严格 schema。运行时坏图追加 `IMAGE_LOAD_FAILED/advisory`，target 为请求对应的 preview target；ID 在本 bundle 内唯一。`status === 'blocked'` 当且仅当 diagnostics 中存在 blocker。
- `markdown` 在两种 status 下都必须存在。
- `status === 'blocked'` 时 `clipboard === null` 且 `html === null`，服务端跳过 Juice。
- `status === 'ready'` 时 `clipboard` 和 `html` 都必须为非 null，且 diagnostics 中没有 blocker。
- 响应不返回独立 `blocked` boolean，避免它与判别字段分叉；客户端的富文本门禁仍使用当前四键 RenderResult 的 `renderBlocked === false`，并额外要求 bundle `status === 'ready'`。
- 文件名必须等于服务端对同一标题生成的规范 basename 加 `.md` / `.html`。客户端不得自行重命名后又把 bundle 视为严格一致。

## 错误契约

非 2xx 响应恰好为：

```json
{
  "error": {
    "code": "OUTPUT_REQUEST_INVALID",
    "message": "排版输出请求无效",
    "retryable": false
  }
}
```

固定 code/status：

| HTTP | code | 条件 | retryable | 客户端行为 |
| --- | --- | --- | --- | --- |
| 400 | `OUTPUT_REQUEST_INVALID` | shape、类型、主题、设置、布尔值、数组或额外键非法 | `false` | 当前 output stale；保留 Markdown 本地 fallback，显示输出数据无效。 |
| 400 | `OUTPUT_FAILED_IMAGE_TARGET_INVALID` | failed target 重复、乱序、未知、非唯一、非受控 `<img>` 或 server restart 后失配 | `false` | render 与 output 同时 stale，重新请求 preview；不得静默丢弃 target。 |
| 500 | `OUTPUT_GENERATION_FAILED` | renderer 返回畸形结果、Juice 抛错、结构修正失败、白名单拒绝或最终 sanitizer 发生差异 | `true` | 不缓存部分响应；明确“未生成富文本”，保留复制/下载 Markdown。 |

错误消息不得包含堆栈、文件路径、原始 CSS parser 错误、HTML 或用户正文。错误响应不携带 markdown、clipboard 或 html 半成品。renderer 正常返回的 `EMPTY_BODY` / `RENDER_FAILED` 是 200 blocked bundle，不是 HTTP error；这保证 blocker 仍可拿到 Markdown。

## `src/typesetting-output.js` 深 interface

生产 interface：

```js
buildTypesettingOutput({
  document,
  presentation,
  convertExternalLinksToFootnotes,
  failedImageTargets
}) => Promise<OutputBundle>
```

可测试组装 seam：

```js
createTypesettingOutputBuilder({
  renderTypesetting = renderTypesettingMarkdown,
  inlineCss = defaultJuiceAdapter,
  themeCss = fixedTypesettingThemeCss
}) => buildTypesettingOutput
```

约束：

- 生产调用者只使用 `buildTypesettingOutput`；factory 只给单元测试和 `createApp()` 注入可控 renderer/Juice failure。
- `inlineCss` 接收已清理的 HTML fragment、固定主题 CSS 和固定 Juice options，必须同步或 Promise 返回字符串；非字符串视为失败。
- 模块不导出 front matter、filename、plain-text、DOM 修正或 sanitizer helper，避免形成浅工具集合。
- `createApp()` 增加可选 `typesettingOutputBuilder` adapter，默认使用生产 builder；现有 `typesettingRenderer` 仍只服务 `/render`。HTTP 集成测试可分别注入 output builder 失败，不 monkey patch 模块全局。

## 服务端生成顺序

### 1. 规范化与重新渲染

先严格规范化请求，再调用现有 renderer。必须校验 renderer 结果仍为四键严格 `RenderResult`，`blocked` 与 blocker 严格等价。输出模块不能直接调用 `marked`、复制 renderer HTML 拼装逻辑或重算外链脚注。

同时按本规格生成 Markdown；因此即使 renderer 返回 blocker，仍可立即返回 blocked bundle。

### 2. 运行时坏图合并

只在重新渲染的安全 fragment 中查找 failed target：

- 每个匹配 `<img>` 原位替换为 `<figure role="note"><figcaption>图片加载失败。请检查图片地址后重试。` + 可选安全 alt + `</figcaption></figure>`；
- alt 继续使用 #6 的折叠空白、最多 200 Unicode code point 规则；不回显 src；
- 每项追加一条 `IMAGE_LOAD_FAILED/advisory`，不改变 blocked；
- 静态 `format-image-placeholder` 已经由 renderer 生成，原样进入后续主题/内联步骤，不需要出现在 `failedImageTargets`；
- 未列为 failed 的 HTTPS 图片按可复制图片处理。输出模块不发网络请求，也不等待图片加载。

failed target 处理完成后、调用 Juice 前，移除所有 `data-format-target`；对仍保留的 HTTPS `<img>` 移除 `data-image-state="pending"`，避免预览专用的 pending opacity 被内联进最终产物。用于主题选择器的固定 class 保留到 Juice 完成后再移除。

### 3. 安全 DOM → Juice

把处理后的安全 fragment 放入唯一受控根：

```html
<section class="typeset-preview typeset-theme-default" style="--md-primary-color:...;--md-font-size:...;--md-line-height:...;--md-block-spacing:...">…</section>
```

主题名和变量只能来自已规范化 presentation。`themeCss` 只允许读取仓库固定的 `public/typesetting-theme.css`；不接收请求 CSS，不加载远程 CSS。调用 `juice@11.0.3` 的字符串公开 API，固定 options：

```js
{
  applyStyleTags: true,
  removeStyleTags: true,
  inlinePseudoElements: false,
  preserveFontFaces: false,
  preserveMediaQueries: false,
  preserveKeyFrames: false,
  preservePseudos: false,
  preserveImportant: false,
  resolveCSSVariables: true,
  applyWidthAttributes: false,
  applyHeightAttributes: false,
  xmlMode: false
}
```

不得调用 `juiceResources()`、`juiceFile()` 或任何会取远程资源的接口。不得沿用 doocs“多次失败后返回未内联字符串”的 fallback；任意异常直接变为 `OUTPUT_GENERATION_FAILED`。

### 4. Juice 后分支与 clipboard 修正

Juice 输出先移除主题根及正文节点上的 class、id、残余 CSS variable 和运行时属性，通过下述标签、属性、URL 与 style 白名单，形成不可再变的 `canonicalInlineBody`。该产物保留最外层 `<section style="…">`，让根上的字体、字号、行距、颜色和换行规则继续被正文继承。完整 HTML 直接使用该 canonical 正文，不应用微信剪贴板专用的列表搬移或边界节点。

随后克隆 `canonicalInlineBody` 为 clipboard 派生 DOM，并按固定顺序执行：

1. `modifyHtmlStructure()`：把 `li > ul/ol` 移到父 `li` 之后，保持原节点和顺序；同一 `li` 有多个直接子列表时也必须保持原相对顺序，主动修正上游逐项 `afterend` 可能导致的反转；
2. `solveWeChatImage()`：把允许的 width/height 属性移到 style；纯整数转 `px`，只额外接受 `px | % | em | rem` 的非负有限长度和 `auto`（仅 height）；其他值使生成失败；
3. 所有剩余图片确保 `display:block;max-width:100%`；没有显式安全高度时设 `height:auto`；保留 `src`、安全 alt 和 `referrerpolicy="no-referrer"`；
4. 再次逐节点执行同一最终白名单和防御性 sanitizer 一致性检查。

`createEmptyNode()` 在最终正文已通过检查后调用两次，只包围 clipboard HTML。完整 HTML 不加入这两个边界，plain text 遍历也忽略它们。

## 最终 HTML 安全白名单

允许标签仅为当前 renderer 会产生且输出有意义的集合：

`h1`～`h6`、`p`、`br`、`hr`、`blockquote`、`pre`、`code`、`ul`、`ol`、`li`、`strong`、`em`、`b`、`i`、`s`、`del`、`a`、`sup`、`sub`、`img`、`figure`、`figcaption`、`table`、`thead`、`tbody`、`tfoot`、`tr`、`th`、`td`、`caption`、`section`、`span`。

属性规则：

- 所有允许标签最多有 `style`；未知属性直接使生成失败，不静默保留。
- `a` 额外允许 `href`、`title`；协议只允许 `http`、`https`、`mailto`，拒绝凭据和协议相对 URL。
- `img` 额外允许 `src`、`alt`、`referrerpolicy`；src 必须是无凭据绝对 HTTPS，referrerpolicy 必须为 `no-referrer`。
- `th` / `td` 额外允许规范正整数 `colspan` / `rowspan`。
- failed/static 占位可保留固定 `role="note"`；不保留 tabindex，因为下载/剪贴板产物不承担当前预览定位。
- 禁止 `script`、`style`、`link`、`meta`、`form`、`input`、事件属性、任意 `data-*`、`contenteditable`、`target`、`download`、SVG/MathML 和 HTML 注释。

允许 style property 固定为：

`color`、`background`、`background-color`、`font`、`font-family`、`font-size`、`font-weight`、`font-style`、`line-height`、`letter-spacing`、`text-align`、`text-decoration`、`text-underline-offset`、`white-space`、`overflow-wrap`、`word-break`、`vertical-align`、`display`、`width`、`max-width`、`height`、`max-height`、`margin` 及四边、`padding` 及四边、`border` 及四边、`border-width`、`border-style`、`border-color`、`border-radius`、`border-collapse`、`table-layout`、`list-style-type`、`overflow`。

style value 必须来自固定主题 CSS 或受控图片尺寸；统一拒绝控制字符、反斜线逃逸、`url(`、`@import`、`expression`、`javascript:`、`data:`、`blob:`、`var(`、`env(`、`attr(`、`behavior` 和未知函数。只允许固定颜色、已知字体列表、关键字、有限数字、`px/em/rem/%` 长度及由固定主题产生的简单 `calc()`；出现无法解析的 declaration 不做“尽量保留”，而是整包失败。

最终再用 `sanitize-html` 的独立输出策略清理序列化 fragment，并比较规范化 DOM。若标签、属性、文本或 style 与白名单验证后的 DOM 不一致，视为内部安全契约漂移，返回 500，不输出部分结果。

## Markdown 产物

Markdown 始终从请求 `document` 直接生成，不从 renderer HTML 逆转换。行尾规则：

1. 五个字符串先把 `CRLF` 和裸 `CR` 规范为 `LF`；元信息中的换行由 `JSON.stringify()` 表示为转义序列；
2. front matter 字段顺序固定为 `title`、`author`、`account`、`publishedAt`；
3. 每个值是 JSON 双引号字符串，JSON 字符串是 YAML 1.2 可接受的双引号标量，避免冒号、井号、引号和换行注入结构；
4. front matter 结束后恰好一个空行，再接规范 LF 的源 `body`；
5. 删除 body 末尾已有的换行后补一个且仅一个最终 `LF`，不 trim 其他正文空白。

固定示例：

```markdown
---
title: "示例标题"
author: "作者"
account: "公众号名称"
publishedAt: "2026-10-03"
---

# 正文
```

脚注开关只影响 HTML renderer，不改写导出的源 Markdown。静态或运行时图片诊断也不改写源 Markdown。

## Clipboard HTML 与 plain text

### HTML

clipboard HTML 只包含主题正文，不含标题、作者、公众号名称、发布日期或完整文档壳。它保留已经内联样式且移除 class/data 属性的正文根 `<section>`，并在该 section 首尾之外各加入一个：

```html
<p style="font-size:0;line-height:0;margin:0">&nbsp;</p>
```

正文所有展示样式均已内联，不依赖 class、CSS variable、`<style>`、外部 stylesheet 或页面当前主题状态。

### Plain text 块级语义

`text/plain` 必须遍历与 clipboard HTML 相同的修正后正文 `<section>` 生成，不能使用剥标签正则。固定规则：

- 普通文本保留可见字符；在非 `pre/code` 上下文折叠连续横向空白；HTML entity 先按 DOM 解码。
- `br` 生成一个 LF；段落、标题、blockquote、figure、figcaption、div/section、列表、表格和 pre 在块结束处生成 LF。
- 无序 `li` 使用 `- ` 前缀；有序 `li` 从父 `ol[start]`（当前没有时为 1）按 DOM 顺序生成 `N. `；嵌套层每级使用两个空格缩进。
- table 单元格以 `\t` 分隔、行以 LF 分隔；同一单元格内部按普通 inline 规则。
- `pre` 保留内部换行和空格，块后补 LF；inline `code` 只保留文本。
- 图片输出非空 alt 时为 `[图片：ALT]`，否则为 `[图片]`；failed/static placeholder 输出其可见固定文案。
- 链接保留显示文字；#6 已生成的 `<sup>[N]</sup>` 和尾注正文自然进入文本，不额外拼 URL。
- 两个 `createEmptyNode()` 边界不进入 plain text。
- 每行移除尾随空格，连续空行压到最多一个空行，移除开头/结尾空行；最终 plain text 不附加额外 LF。

这保证两种 MIME 表达同一正文语义，但不要求字节级相同。

## 完整 HTML 产物

完整 HTML 使用固定安全壳：

- `<!doctype html>`、`<html lang="zh-CN">`；
- `<head>` 的首个元素为 UTF-8 charset，随后是 viewport、escaped title、`Referrer-Policy: no-referrer` 和 meta CSP；
- CSP 固定为 `default-src 'none'; img-src https:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'`；
- 不包含 script、外部 stylesheet、字体、base、form、iframe 或自动请求资源（正文绝对 HTTPS 图片除外）；
- `<body>` 先放 metadata header，再放 `<main>` 中的同一份无边界、已内联正文 HTML。

metadata header 固定包含四项：标题用 `<h1>`，作者、公众号名称、发布日期使用带固定中文标签的 `<dl><dt>/<dd>`。空值仍保留空的安全节点，确保“包含四项元信息”的结构稳定。全部值以 text node 构造，不拼接未转义字符串。

完整 HTML 与 clipboard HTML 来自同一次 renderer、同一次坏图合并和同一次 Juice。完整 HTML 使用 `canonicalInlineBody`；clipboard 只在其派生副本上增加 doocs 的列表/图片兼容修正和首尾边界。不能再次 renderer 或再次 Juice，不能把 clipboard 专用结构回写 canonical 正文。

## 文件名

服务端私有 `safeOutputBaseName(title)` 规则固定：

1. Unicode 字符按原样保留，先 trim；
2. 把 `< > : " / \\ | ? *` 和 U+0000～U+001F 每个字符替换为 `_`；
3. 去除开头的点、结尾的点或空格；
4. 截取前 80 个 Unicode code point，再次去除结尾点/空格；
5. 结果为空时使用 `未命名文章`。

Markdown 文件名为 `${base}.md`，HTML 为 `${base}.html`。浏览器必须使用 bundle 提供的 filename；不得从当前输入重新计算，以免竞态下文件名和内容不一致。

## 客户端状态与版本门禁

新增状态：

```js
let outputVersion = 0;
let outputRequestVersion = 0;
let outputFresh = false;
let outputPending = false;
let outputBundle;
let outputCache; // { outputVersion, renderVersion, snapshot, bundle }
const failedImageTargets = new Set();
```

### snapshot

`outputSnapshot()` 精确收集：

- 当前五个 `document` 字符串；
- 当前已被最新 render 规范化并应用的 `presentation`；
- 当前脚注开关；
- `failedImageTargets` 按当前 preview DOM target 顺序形成数组。

它不包含 revision/savedAt，也不读取 preview innerHTML。比较必须递归检查 exact keys 和所有字符串/数组项。

### 失效与预生成

- 标题、作者、公众号名称、发布日期、正文、主题、任一主题设置、脚注开关变化时，先执行 `outputVersion++`、`outputFresh=false`、清空 cache，再进入现有 preview/save 流程。
- 新 RenderResult 原子应用时清空旧 failed target 集合，记录新的 `appliedRenderVersion`，立即为当前 snapshot 发起 output 请求；blocker 也请求，以获得 server bundle Markdown。
- 图片变成 loaded 不改变 failed set，不失效；图片第一次变成 load-failed 时把唯一 target 加入 Set，立即失效并为新 snapshot 重建 output。重复 error 不重复请求。
- static placeholder 不进入 failed set；它已在 renderer HTML 中稳定存在。
- 网络错误、非 2xx、畸形 200 或 schema/snapshot 不匹配时保持 `outputFresh=false`，不回退旧 bundle。

### 竞态接受条件

发起请求时捕获 `{ requestVersion: ++outputRequestVersion, outputVersion, renderVersion: appliedRenderVersion, snapshot }`。只有以下条件全部成立才缓存响应：

1. requestVersion 仍是最新；
2. 捕获的 outputVersion 等于当前 outputVersion；
3. 捕获的 renderVersion 同时等于当前 `appliedRenderVersion` 和 `previewVersion`；
4. `renderFresh === true`；
5. 当前 `outputSnapshot()` 与捕获 snapshot 相等；
6. 响应通过严格 OutputBundle schema；
7. 响应 `snapshot` 与捕获 snapshot 相等；
8. bundle status 与当前 `renderBlocked` 一致：blocked ↔ true，ready ↔ false。

任何旧成功、旧失败或旧图片事件都不能修改 output 状态、按钮可用性或提示。缓存只存在内存，不持久化。

### 富文本固定 gate

“复制到微信”和“下载 HTML”的可用条件分别为：

```text
renderFresh
&& !renderBlocked
&& outputFresh
&& bundle.status === 'ready'
&& cache.outputVersion === outputVersion
&& cache.renderVersion === appliedRenderVersion === previewVersion
&& cache.snapshot === outputSnapshot()
```

任何一项不满足，点击不得使用旧 bundle。复制按钮在等待时显示“正在准备输出”，blocker 时显示“请先处理阻断问题”，失败时显示替代操作。

## Clipboard 与下载交互

### 复制到微信

点击后再次执行 gate，然后检查：

- `window.isSecureContext === true`；
- `navigator.clipboard?.write` 是函数；
- `window.ClipboardItem` 存在；
- 若 `ClipboardItem.supports` 存在，则 `text/html` 与 `text/plain` 都返回 true。

创建一个且仅一个：

```js
new ClipboardItem({
  'text/html': new Blob([bundle.clipboard.html.content], { type: 'text/html' }),
  'text/plain': new Blob([bundle.clipboard.plain.content], { type: 'text/plain' })
})
```

随后只调用一次 `await navigator.clipboard.write([item])`。resolve 后显示“已复制正文富文本”；reject/throw 后显示“未能复制富文本，请复制 Markdown 或下载 HTML”，保留替代按钮。不得调用 `writeText`、`execCommand`、隐藏 textarea 或把 plain fallback 计为成功。

### 独立元信息复制

标题、作者、公众号名称、发布日期字段旁各有一个明确标注的复制按钮。点击时捕获该字段当前字符串并执行一次 `await navigator.clipboard.writeText(value)`；空字符串也按原值写入。只有 resolve 后显示对应成功提示；不支持或拒绝时显示该项失败，不尝试 `execCommand`。按钮的 accessible name 必须包含字段名。

元信息操作不依赖 render/output gate，也绝不进入正文 clipboard HTML/plain。

### 复制 Markdown

优先使用当前严格 bundle 的 `markdown.content`。若 bundle 不新鲜、请求失败或尚无成功 render，则按本规格相同算法从当前五个源字段在客户端生成规范 Markdown；客户端 helper 必须与服务端共享固定 fixture 测试，禁止另一套字段顺序或换行规则。使用 `navigator.clipboard.writeText(markdown)`；失败时继续提供“下载 Markdown”。

### 下载

- HTML 只在富文本 gate 成立时使用 `bundle.html`。
- Markdown 优先使用 bundle；任何 blocker/stale/服务端失败时可使用当前源字段本地生成的 fallback。
- 客户端用当前 content 创建带 bundle mimeType 的 Blob，`URL.createObjectURL()`，创建临时 `<a download="filename">` 点击，并在同步 click 后 `setTimeout(..., 0)` revoke URL、移除节点。
- 下载不请求新的服务端文件、不写仓库/数据目录、不打开新标签页。创建 Blob 前再次比较 snapshot；失败时不下载旧内容。

## UI 布局与状态文案

在现有左侧编辑区增加最小输出区，不实施 #8 重排：

- 四个元信息输入各自紧邻一个小型“复制”按钮；现有 label 关系保持有效。
- 正文下方新增“输出”fieldset：主按钮“复制到微信”，次按钮“复制 Markdown”“下载 HTML”“下载 Markdown”。
- 增加 `#output-status`（`role="status"`）和 `#output-error`（`role="alert"`）。成功状态与失败原因分离，新的操作会清除旧成功提示。
- HTML 不可用时按钮 disabled；Markdown 下载始终可用。blocker 时显示“存在阻断问题，仍可复制或下载 Markdown”。
- Clipboard API 不支持/拒绝时不隐藏 HTML 下载；服务端 output 失败时 HTML 下载也不可用，因为没有安全 bundle。
- pending 时不阻止继续编辑；所有动作在执行瞬间重查 gate。
- 窄屏下按钮自动换行为单列或两列，每个触控目标至少 42px 高，不改变预览/检查区主体布局。

## 测试矩阵

### A. 深模块与严格 schema

- 请求 exact keys：缺失、额外、错误类型、非法 presentation、非 boolean、failed target 非数组/空值/重复/乱序均 400。
- 重新 renderer：输出与传入 preview DOM 无关；注入伪造 DOM、class、style 或 metadata 不会进入产物。
- ready/blocked 判别：空正文和可控 renderer failure 返回 blocked + Markdown + null clipboard/html；conversion/advisory 返回 ready。
- failed target：正常唯一图片可替换；未知、链接、静态占位、重复 DOM target 和 server restart nonce 失配拒绝。
- factory seam：Juice throw、返回非字符串、后校验遇到非法 style/tag/attribute、sanitizer 差异均得到 `OUTPUT_GENERATION_FAILED`，不暴露半产物。

### B. Markdown 与文件名

- 四项元信息固定顺序；空值、引号、冒号、`#`、反斜线、中文、CRLF、多行值均为 JSON 双引号兼容 YAML。
- body 只规范换行和最终 LF，不受主题、脚注、diagnostics 或 failed target 改写。
- 标题空白、全点、禁用字符、控制字符、emoji/CJK 和超过 80 code point 的文件名。
- 服务端 bundle 与客户端 blocker fallback 对同一 fixture 字节相同。

### C. CSS、结构和图片

- 三个主题与四项设置都产生内联 style，不残留 `<style>`、class、CSS variable、媒体查询、字体文件或远程 CSS。
- 标题、段落、列表、引用、代码、分隔线、表格、链接、脚注、图片和两类占位通过最终白名单。
- clipboard 的嵌套 ul/ol 在 Juice 后按 doocs 规则修正，同一 `li` 多个子列表也不反转；完整 HTML 保持 canonical 语义列表结构。
- 数字和允许单位的图片尺寸正确转 style；危险/未知尺寸使整包失败；默认图片 `max-width:100%;height:auto`。
- 运行时失败图在同位置成为不含 src 的占位，alt 安全且不泄漏 URL；静态占位和坏图都保持 ready。
- clipboard HTML 恰有首尾边界，完整 HTML 没有；所有 data target/runtime attrs 被移除。

### D. plain text 语义

- 段落/标题换行、`br`、连续空白、无序/有序/嵌套列表、table tab、pre 保留、inline code、链接脚注、图片 alt、占位文案。
- 边界 `&nbsp;` 不进入 plain；连续空行最多一个；无额外末尾 LF。
- HTML 与 plain 都不包含四项元信息，且 plain 不是简单 strip-tags 结果。

### E. 完整 HTML 与安全

- 解析完整文档验证 doctype、lang、meta charset 首位、viewport、title、Referrer-Policy、CSP、四项 metadata 和同一正文。
- 无 script、事件属性、form、iframe、外部 stylesheet、SVG、未知 scheme、凭据 URL、data/blob 图片、`url()` style。
- 元信息和正文的 HTML 字符可见但不形成节点/属性注入。
- HTML 下载 content、mimeType、filename 与 bundle 一致。

### F. Clipboard/Blob 浏览器测试

- `ClipboardItem` 只创建一次，包含恰好 `text/html` / `text/plain`；`clipboard.write` 只调用一次。
- write pending 时不提前报成功；resolve 才成功；reject、不支持、非 secure context 时不调用 `execCommand`/`writeText`，显示两个替代入口。
- 四项元信息分别精确 `writeText`，不 trim、不拼 label；拒绝时不报成功。
- Markdown `writeText` 和 HTML/Markdown Blob 下载均使用当前内容；URL 被 revoke，临时 anchor 被移除。
- blocker 禁止富文本和 HTML，仍能复制/下载 Markdown；advisory/conversion 不阻止。

### G. 版本与竞态

- 慢旧 output success/failure 不能覆盖新字段、正文、主题、脚注或 failed target snapshot。
- render stale/pending/畸形时即使旧 output ready 也不能复制。
- output ready 后修改任一元信息立即失效，不能下载旧 metadata HTML/Markdown。
- 图片 failure 到达后立即失效旧 bundle；新 bundle 含占位后恢复 gate。旧 DOM 图片事件不得改变当前 failed set。
- 服务端重启导致 target 400 时强制重新 render，不静默删除坏图事实或复用旧 bundle。
- 快速重复点击复制不能绕过当前 gate；每次成功都对应一次已 resolve 的 write。

### H. 回归和静态检查

- #3～#6 的导入、富文本粘贴、主题、保存/冲突/恢复、脚注、三类 diagnostics 和图片状态测试继续通过。
- `package.json` / lockfile 精确锁定 `juice@11.0.3`，Node engine 兼容；`THIRD_PARTY_NOTICES.md` 记录两类来源。
- `node --check` 覆盖所有修改 JavaScript，`npm test` 与 `git diff --check` 通过。
- 测试解析产物并断言局部结构，不对整份 HTML 做 snapshot，也不访问真实微信或第三方图片。

## 文件职责与修改边界

| 文件 | Issue #7 职责 |
| --- | --- |
| `src/typesetting-output.js` | 新增深模块、严格输入、renderer 复用、failed target 校验、Markdown、Juice、三个 doocs helper 适配、最终白名单、plain text、完整 HTML 和文件名。 |
| `src/server.js` | 新增 `/api/typesetting/output`、builder 注入 seam、strict typed error 映射。 |
| `public/typesetting.html` | 元信息独立复制按钮、最小输出区、状态/错误提示。 |
| `public/typesetting.js` | output snapshot/version/cache、严格 bundle 校验、ClipboardItem/writeText、Blob 下载和 gate；不生成富文本 HTML。 |
| `public/style.css` | 输出区、按钮状态、焦点与窄屏换行；不重排完整工作台。 |
| `public/typesetting-theme.css` | 继续作为三套主题唯一固定 CSS 来源；只做输出确有需要且不改变 preview 语义的修正。 |
| `package.json` / `package-lock.json` | 精确加入 `juice@11.0.3`。 |
| `THIRD_PARTY_NOTICES.md` | 记录 doocs 三个函数、固定 SHA/许可/适配/偏离，以及 Juice 版本、SHA、MIT、Node 与 API 范围。 |
| `test/typesetting-output.test.js` | 深模块、HTTP、schema、安全、Markdown、HTML、CSS、plain、failed target 和 failure seam。 |
| `test/typesetting-output-ui.test.js` | Clipboard/Blob、UI、blocker/advisory、缓存失效和竞态浏览器验收。 |
| 既有 typesetting 测试 | 仅补必要回归断言，不搬迁或重写 #3～#6 测试。 |

明确不修改 `src/article.js`、`src/exporter.js`、`public/app.js`、文章批量下载、文稿持久化 schema、四键 RenderResult、根 `CONTEXT.md` 或 ADR。

## 任务拆分与依赖顺序

```text
T0 冻结 OutputRequest / OutputBundle / error / gate / fixture
  ↓
T1 精确加入 juice + 深模块红测
  ↓
T2 服务端重新渲染、failed target、Markdown 与 blocked bundle
  ↓
T3 Juice、doocs 三 helper、白名单、plain 与完整 HTML
  ↓
T4 HTTP 严格接线与 typed error
  ↓
T5 客户端 snapshot/version/cache 与严格响应校验
  ↓
T6 UI、ClipboardItem、元信息 writeText、Blob 下载
  ↓
T7 浏览器竞态/降级验收、notice、全量回归与独立终审
```

- T0 完成前不得并行实现服务端和客户端，否则 nested key/MIME/status 容易漂移。
- T2/T3 由同一深模块所有者连续完成，防止安全 DOM 与后处理出现两个实现。
- T4 只接线已通过纯测试的 builder，不在路由中补业务逻辑。
- T5 完成严格 schema 与竞态门禁后再做 T6，避免 UI 直接消费未验证 bundle。
- T7 发现生产缺陷时回交对应所有者修复；测试文件不得形成第二套生成算法。唯一允许的客户端重复算法是明确要求的 Markdown fallback，并必须用共享 fixture 保持字节一致。

## 风险与防线

| 风险 | 影响 | 防线 |
| --- | --- | --- |
| 复制当前预览 DOM | XSS/篡改、旧响应、运行时状态和服务端事实分叉 | 输出接口只接收源字段/设置/target，服务端重新 renderer。 |
| failed target 伪造 | 任意节点被删除或变占位 | 本次重渲染唯一受控 `<img>` + 顺序校验；其余 400。 |
| Juice 静默失败 | 用户复制无内联样式 HTML却看到成功 | 任意内联/后校验失败返回 500；不返回 partial bundle。 |
| style 白名单过宽 | CSS 资源请求、注入或客户端差异 | 无用户 style；固定 property/value；拒绝 URL/变量/未知函数；sanitizer 一致性检查。 |
| HTML 与 plain 来源不同 | 双 MIME 语义漂移 | 同一 post-fix DOM，固定块语义遍历。 |
| 元信息污染正文 | 微信正文混入标题/作者 | clipboard 仅正文；元信息 writeText 独立；只在 full HTML/Markdown 合并。 |
| 旧 bundle 被使用 | 复制/下载的字段、主题或坏图已过期 | render/output version + exact snapshot + 点击时复检。 |
| clipboard fallback 误报 | 实际只写纯文本却显示富文本成功 | rich path 禁止 writeText/execCommand；仅 write resolve 成功。 |
| blocker 把源内容锁死 | 用户无法带走 Markdown | blocked bundle 始终含 Markdown，客户端还有同规范本地 fallback。 |
| 声称微信兼容过度 | 自动化证据超出实际覆盖 | 完成定义明确限定为本地契约；真实微信另行验收。 |

## 完成定义

Issue #7 只有在以下条件全部满足时，才可声明本规格范围完成：

- strict request/response/error、ready/blocked 判别和全部竞态规则有可复现测试；
- 富文本只在双 MIME `clipboard.write()` resolve 后成功，所有拒绝/不支持路径不伪成功；
- 元信息与正文边界、Markdown front matter/LF、完整 HTML 安全壳和文件名规则全部按本规格实现；
- 三个主题、脚注、静态占位、运行时坏图、列表、表格、代码、图片尺寸和块级 plain text 通过结构断言；
- Juice 任意失败均无富文本/HTML partial success；
- `juice@11.0.3` 精确锁定，doocs/Juice 来源、许可证、复制/调用范围及主动偏离已写入 `THIRD_PARTY_NOTICES.md`；
- #3～#6 相关回归、全量测试、语法检查和 diff 检查通过；
- 交付说明明确写“未完成真实微信公众号兼容验收”，不把本地自动化结果扩大为真实平台保证。
