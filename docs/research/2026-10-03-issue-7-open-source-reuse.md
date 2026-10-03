# Issue #7 复制与下载输出源码复用调研

## 1. 结论

Issue #7 应采用“本项目服务端重新渲染 + 固定 CSS 内联 + 浏览器标准剪贴板/下载 API”的实现，不应读取、信任或复制当前预览 DOM。

建议的最小复用边界为：

1. 固定参考 `doocs/md@a7c17fc4cda92e3c13aa7e24f06615cfa4219b31`，复制并适配 `solveWeChatImage()`、`modifyHtmlStructure()`、`createEmptyNode()` 三个局部 DOM 变换，并沿用其“受控 DOM → Juice 内联 → 结构/图片修正 → 剪贴板双 MIME”的顺序。
2. 新增并精确锁定 `juice@11.0.3`，只调用其公开 CSS 内联 API。该版本为 MIT，要求 Node.js `>=18.17`，与本项目 Node.js `>=22` 兼容。
3. 参考 doocs 的 `ClipboardItem` 双 MIME 写入方式，但不复制其“失败后降级为纯文本并视为成功”的行为。富文本路径只在一次 `navigator.clipboard.write()` 真正写入 `text/html` 与 `text/plain` 且 Promise resolve 后成功。
4. 输出 HTML、纯文本、完整 HTML 和 Markdown 的契约、安全白名单、元信息边界、运行时坏图同步及竞态门禁均由本项目实现；这些能力在固定上游中没有可直接复制且满足本 Issue 契约的完整实现。

这一裁决只建立自动化可验证的输出管线，不等同于已完成真实微信公众号编辑器兼容验收。

## 2. 调研基线与固定版本

| 对象 | 固定版本 | 许可证 | 一手证据 | 裁决 |
| --- | --- | --- | --- | --- |
| 本项目 | [`c58f7cbcbe7a2985e5a4874e6776d231226da36c`](https://github.com/GoodScholar/wechat-exporter/tree/c58f7cbcbe7a2985e5a4874e6776d231226da36c) | MIT | [`src/typesetting-render.js`](https://github.com/GoodScholar/wechat-exporter/blob/c58f7cbcbe7a2985e5a4874e6776d231226da36c/src/typesetting-render.js)、[`public/typesetting.js`](https://github.com/GoodScholar/wechat-exporter/blob/c58f7cbcbe7a2985e5a4874e6776d231226da36c/public/typesetting.js) | 复用现有严格渲染、诊断、target 和图片运行时状态，不扩展 `RenderResult`。 |
| doocs/md | [`a7c17fc4cda92e3c13aa7e24f06615cfa4219b31`](https://github.com/doocs/md/tree/a7c17fc4cda92e3c13aa7e24f06615cfa4219b31) | [WTFPL v2](https://github.com/doocs/md/blob/a7c17fc4cda92e3c13aa7e24f06615cfa4219b31/LICENSE) | [`clipboard.ts`](https://github.com/doocs/md/blob/a7c17fc4cda92e3c13aa7e24f06615cfa4219b31/apps/web/src/services/export/clipboard.ts)、[`clipboard-dom.ts`](https://github.com/doocs/md/blob/a7c17fc4cda92e3c13aa7e24f06615cfa4219b31/apps/web/src/services/export/clipboard-dom.ts)、[`clipboard.ts` 浏览器封装](https://github.com/doocs/md/blob/a7c17fc4cda92e3c13aa7e24f06615cfa4219b31/apps/web/src/lib/browser/clipboard.ts) | 复制三个纯 DOM helper 并适配服务端 DOM；只参考总流程与双 MIME 写入。 |
| Juice | npm `11.0.3`；git [`ce15687713507252813744b0daaa70d4549527d1`](https://github.com/Automattic/juice/tree/ce15687713507252813744b0daaa70d4549527d1) | [MIT](https://github.com/Automattic/juice/blob/ce15687713507252813744b0daaa70d4549527d1/LICENSE.md) | [`package.json`](https://github.com/Automattic/juice/blob/ce15687713507252813744b0daaa70d4549527d1/package.json)、[公开 Options/API](https://github.com/Automattic/juice/blob/ce15687713507252813744b0daaa70d4549527d1/README.md#options) | 新增精确版本运行时依赖，内联失败即整个富文本/HTML 输出失败。 |
| Clipboard API | 当前 W3C Clipboard API 规范 | W3C 文档许可 | [`ClipboardItem`](https://www.w3.org/TR/clipboard-apis/#clipboarditem)、[`Clipboard.write()`](https://www.w3.org/TR/clipboard-apis/#dom-clipboard-write) | 只依赖标准 API；不以 `execCommand` 或 `writeText` 冒充富文本成功。 |

固定 doocs commit 的 `apps/web/package.json` 当前使用 `juice` 的另一个版本范围；本项目不继承其依赖范围，而是按本项目 Node 版本、锁文件和审计结果固定 `11.0.3`。

## 3. 本项目已有边界

Issue #5 与 #6 已经提供输出必须复用的事实：

- `src/typesetting-render.js` 的生产 interface 只返回 `{ html, presentation, diagnostics, blocked }`，并对输入、最终 HTML、诊断和 target 建立严格契约。输出功能不应向该四键结果塞入 clipboard 或下载字段。
- renderer 使用一次渲染内唯一的受控 `data-format-target`。图片 target 只有两类：可加载 HTTPS `<img>` 和静态占位；浏览器不得自行伪造静态分类。
- `public/typesetting.js` 用 `previewVersion`、`appliedRenderVersion` 和 `renderFresh` 防止旧响应生效，并在图片真实加载失败时把同一 target 的 `<img>` 原位替换成占位，追加非阻断 `IMAGE_LOAD_FAILED`。
- 当前主题由 `presentation.theme` 和四项严格枚举设置决定；主题 CSS 位于 `public/typesetting-theme.css`，不是用户可编辑 CSS。
- 诊断 blocker 只表示内容不能生成富文本/完整 HTML；Markdown 源文件仍可导出。静态图片占位和运行时坏图都是 advisory，不应无理由阻止输出。

因此，Issue #7 必须新增独立的 `src/typesetting-output.js` 深模块，让它重新调用同一 renderer，并以请求中的运行时坏图 target 集合修正重新渲染出的受控图片。直接克隆 `#preview` 会同时绕过服务端 sanitizer、响应版本门禁和 target 所有权校验，不能采用。

## 4. doocs/md 源码级核查

### 4.1 总体处理顺序

[`processClipboardContent()`](https://github.com/doocs/md/blob/a7c17fc4cda92e3c13aa7e24f06615cfa4219b31/apps/web/src/services/export/clipboard.ts#L45-L126) 的主流程为：

1. 从当前输出节点复制 DOM；
2. 加入受控样式并调用 Juice；
3. 调用 `modifyHtmlStructure()`；
4. 替换有限的主题变量及结构；
5. 调用 `solveWeChatImage()`；
6. 在首尾插入两个 `createEmptyNode()`；
7. 从同一处理后 DOM 读取 HTML 与纯文本。

其中第 2～7 步的顺序有复用价值；第 1 步不适合本项目。doocs 可以从自身受控渲染 store 克隆 DOM，本项目则已经明确把浏览器预览视为服务端响应的易失投影，还叠加了运行时替换，必须改为服务端重新渲染。

### 4.2 `solveWeChatImage()`

[`solveWeChatImage()`](https://github.com/doocs/md/blob/a7c17fc4cda92e3c13aa7e24f06615cfa4219b31/apps/web/src/services/export/clipboard-dom.ts#L140-L160) 遍历 `<img>`：

- 移除 `width` / `height` 属性；
- 纯数字值转成 `px` 内联样式；
- 非数字值原样转成内联样式。

决策：**复制并最小适配**。服务端版本只接受本项目样式白名单允许的长度，非法尺寸不得原样进入 style；当前 renderer 没有输出尺寸属性时，主题仍保证 `display:block;max-width:100%;height:auto`。不读取图片自然尺寸，不发起图片下载。该修正只作用于 clipboard 派生 DOM，不回写 renderer 的安全 HTML 或完整 HTML 的 canonical 正文。

### 4.3 `modifyHtmlStructure()`

[`modifyHtmlStructure()`](https://github.com/doocs/md/blob/a7c17fc4cda92e3c13aa7e24f06615cfa4219b31/apps/web/src/services/export/clipboard-dom.ts#L162-L170) 把 `li > ul` / `li > ol` 移到父 `li` 之后，用来规避微信编辑器对嵌套列表结构的处理差异。

决策：**复制并最小适配**。在 clipboard 派生 DOM 上执行，保持节点顺序和全部文本；为有序、无序、多层嵌套及同一 `li` 的多个直接子列表建立结构测试。上游逐项 `insertAdjacentElement('afterend')` 可能反转同一父节点下多个直接子列表，本地适配必须保持原相对顺序，并在 notice 标明这一最小偏离。它只处理已通过本项目渲染白名单的列表，不成为任意 HTML 修复器，也不改写完整 HTML 的 canonical 列表结构。

### 4.4 `createEmptyNode()`

[`createEmptyNode()`](https://github.com/doocs/md/blob/a7c17fc4cda92e3c13aa7e24f06615cfa4219b31/apps/web/src/services/export/clipboard-dom.ts#L173-L179) 创建内容为 `&nbsp;`，且 `font-size`、`line-height`、`margin` 均为 `0` 的 `<p>`。上游将它放在 clipboard HTML 首尾，提供编辑器边界节点。

决策：**复制并最小适配**。只加入正文 clipboard HTML，不加入完整 HTML 的正文，也不计入 `text/plain`。边界节点的 style 仍须通过最终样式白名单。上游在插入边界后直接读取 `textContent`，会把 sentinel NBSP 带入 plain text；本项目必须主动偏离。

### 4.5 Juice 失败行为

doocs 的 [`mergeCss()`](https://github.com/doocs/md/blob/a7c17fc4cda92e3c13aa7e24f06615cfa4219b31/apps/web/src/services/export/clipboard.ts#L19-L39) 会多次尝试内联，全部失败后返回未内联的安全字符串。该行为不满足 Issue #7“富文本输出必须是内联样式”的成功定义。

决策：**只参考调用位置，不复制失败降级**。本项目中 Juice 抛错、输出无法通过白名单、或最终防御性 sanitizer 改变结构，均返回结构化 500，`clipboard` 和完整 HTML 不得作为成功产物出现。用户仍可复制或下载规范化 Markdown。

### 4.6 双 MIME 与错误降级

doocs 的 [`copyHtml()`](https://github.com/doocs/md/blob/a7c17fc4cda92e3c13aa7e24f06615cfa4219b31/apps/web/src/lib/browser/clipboard.ts#L37-L55) 使用一个 `ClipboardItem` 同时提供 `text/html` 与 `text/plain`，再执行一次 `navigator.clipboard.write()`；这是应保留的核心行为。

但它在写入失败后调用纯文本复制，调用者无法区分“HTML 已写入”和“只写入了纯文本”。Issue #7 明确禁止这种伪成功。

决策：**行为参考，主动偏离 fallback**。不复制 `legacyCopy()`，不调用 `document.execCommand('copy')`，也不在富文本失败后自动 `writeText()`。失败 UI 明确显示“未复制富文本”，并展示“复制 Markdown”“下载 HTML”替代入口；只有 `navigator.clipboard.write()` resolve 后才显示“已复制到微信”。

doocs 编辑器主操作同样会在 Clipboard API 失败后尝试 `execCommand`，再统一显示成功提示；源码见 [`editor-header/index.vue`](https://github.com/doocs/md/blob/a7c17fc4cda92e3c13aa7e24f06615cfa4219b31/apps/web/src/components/editor/editor-header/index.vue#L155-L193)。这进一步确认不能复制其上层成功语义。

### 4.7 doocs 下载实现

固定上游的 [HTML export](https://github.com/doocs/md/blob/a7c17fc4cda92e3c13aa7e24f06615cfa4219b31/apps/web/src/services/export/html.ts#L10-L31) 只组合 title、预览 clone 和固定 wrapper，没有本项目的 author/account/publishedAt 结构；[Markdown export](https://github.com/doocs/md/blob/a7c17fc4cda92e3c13aa7e24f06615cfa4219b31/apps/web/src/services/export/markdown.ts#L4-L8) 只保存 raw doc，没有规范 front matter。

决策：**只参考 Blob/download 行为，不复制产物模型**。四项元信息、安全文档壳、规范 YAML、LF 和文件名规则均由本项目实现。

## 5. Juice 11.0.3 核查

`juice@11.0.3` 的固定 git commit 为 [`ce15687713507252813744b0daaa70d4549527d1`](https://github.com/Automattic/juice/commit/ce15687713507252813744b0daaa70d4549527d1)。其 [`package.json`](https://github.com/Automattic/juice/blob/ce15687713507252813744b0daaa70d4549527d1/package.json) 明确记录：

- 版本 `11.0.3`；
- 许可证 MIT；
- Node.js `>=18.17`；
- 主入口 `index.js`；
- 直接依赖包含其自己的 Cheerio 版本，因此本项目只调用字符串级公开 API，不把 Juice 内部 DOM 与本项目 Cheerio 实例混用。

其公开选项支持 `applyStyleTags`、`removeStyleTags`、`inlinePseudoElements`、`preserveFontFaces`、`preserveMediaQueries`、`preserveImportant` 和 `resolveCSSVariables`。本项目应精确使用固定选项，禁止保留媒体查询、字体文件、关键帧和伪元素，并在 Juice 之后再次检查允许的标签、属性、URL 与 style property/value。

`package.json` 必须使用精确依赖 `"juice": "11.0.3"`，并提交对应 `package-lock.json`。不能写 `^11.0.3`，避免未重新审计的 minor 版本改变 CSS 解析和序列化行为。

## 6. 能力覆盖矩阵

| Issue #7 能力 | doocs 固定源码 | Juice 11.0.3 | 本项目既有能力 | 最终实现裁决 |
| --- | --- | --- | --- | --- |
| 从可信正文生成输出 | 克隆当前浏览器 DOM，不适用 | 不负责 Markdown/安全渲染 | 服务端 renderer 已有严格输入、sanitizer、diagnostics、blocked | 独立输出深模块在服务端重新调用 renderer；禁止复制预览 DOM。 |
| 主题 CSS 内联 | 有完整调用顺序 | 公开 API 可完成 | 当前三套固定主题和有界设置 | 使用固定主题 CSS + Juice；任何内联/校验失败都不产出富文本成功。 |
| 嵌套列表修正 | `modifyHtmlStructure()` | 不负责 | renderer 产出安全列表 | 复制 helper，Juice 后在服务端 DOM 上执行。 |
| 图片尺寸修正 | `solveWeChatImage()` | 可由 CSS 产生尺寸属性 | renderer 只允许 HTTPS 图片并有 target | 复制 helper 并收窄长度白名单；默认图片最大宽度 100%。 |
| 编辑器首尾边界 | `createEmptyNode()` | 不负责 | 尚无 | 复制 helper，只加入 clipboard HTML。 |
| 运行时坏图同步 | 无与本项目 target 契约兼容的实现 | 不负责 | 客户端已有唯一 target 和动态 advisory | 请求携带当前失败 target 集合；服务端只接受本次重渲染中的唯一受控 `<img>`。 |
| `text/html` + `text/plain` | 单个 `ClipboardItem` 已实现 | 不负责 | 尚无输出 bundle | 参考双 MIME；纯文本从同一修正后 DOM 按块语义生成。 |
| 真正的富文本成功判定 | 会自动退化为纯文本 | 不负责 | 现有 UI 尚无复制 | 主动偏离：只以 `clipboard.write()` resolve 为成功。 |
| 完整 HTML | 上游流程面向剪贴板，不符合本项目元信息契约 | 只内联 CSS | 元信息和 presentation 已有严格模型 | 本地生成无脚本、无外链样式的安全文档壳；正文复用同一内联结果。 |
| Markdown + YAML front matter | 固定流程不能直接满足 | 不负责 | 源文稿字段已存在 | 本地按固定字段顺序、JSON 双引号标量和 LF 生成。 |
| blocker 降级 | 上游无本项目三类诊断契约 | 不负责 | `blocked` 与 blocker 已严格等价 | blocked bundle 仍含 Markdown，clipboard/HTML 必须为 `null`。 |
| 竞态与缓存 | 上游 store 模型不同 | 不负责 | 已有 preview/render version 门禁 | 新增独立 output version/snapshot 门禁，并与最新 render version 绑定。 |
| 下载 | 无本项目要求的文件命名与 metadata 边界 | 不负责 | 浏览器可使用 Blob/object URL | 客户端只从当前严格 bundle 创建 Blob，不新增服务端文件。 |

## 7. 最终复用与排除清单

### 直接复制并适配

- doocs `solveWeChatImage()`：目标为 `src/typesetting-output.js` 内部私有 helper；增加长度白名单和非法值拒绝。
- doocs `modifyHtmlStructure()`：目标为同一深模块内部私有 helper；改用本项目服务端 DOM 操作。
- doocs `createEmptyNode()`：目标为同一深模块内部私有 helper；只服务 clipboard HTML 边界。

### 只参考行为/顺序

- `processClipboardContent()` 的安全 DOM → Juice → 修正 → HTML/plain 双产物顺序。
- `copyHtml()` 的单个 `ClipboardItem` 双 MIME 写入。
- 当前项目 `src/typesetting-render.js` 与浏览器图片状态机的 schema、target 和版本事实。

### 明确不复制/不采用

- doocs 对当前 `#output` DOM 的 clone；本项目不信任浏览器 DOM。
- doocs 的 Vue、Pinia、主题 store、异步图表、SVG、emoji base64、图床及深色模式重渲染。
- doocs Juice 全失败后返回未内联 HTML 的 fallback。
- doocs `legacyCopy()`、`execCommand('copy')` 以及把纯文本 fallback 当作富文本成功的行为。
- 任意用户 CSS、远程 CSS、字体、脚本、`@import`、`url()` 样式资源或第二套 Markdown parser/sanitizer。

## 8. 许可证与 notice 落地要求

实现 Issue #7 时必须更新 `THIRD_PARTY_NOTICES.md`：

1. 在现有 doocs 条目中增加固定 commit 下的 `clipboard.ts`、`clipboard-dom.ts`，列明复制的三个函数、目标文件、服务端适配范围及主动偏离；继续保留 `LICENSES/DOOCS-MD-WTFPL-2.txt`。
2. 新增 Juice 条目，记录精确版本 `11.0.3`、固定 git SHA `ce15687713507252813744b0daaa70d4549527d1`、MIT、Automattic copyright、公开 API 使用范围和 Node `>=18.17`。安装包自带 `LICENSE.md`；仓库 notice 必须保证源码分发时仍能追溯许可。
3. 说明 Web Clipboard、Blob 和 object URL 是浏览器标准 API，不是复制的第三方源码。
4. 不得声称复制了 doocs 完整 clipboard pipeline，也不得声称上游 fallback 符合本项目成功定义。

## 9. 风险与验证重点

| 风险 | 必须验证的防线 |
| --- | --- |
| 客户端篡改 DOM 或 failed target | 输出模块重新 renderer；failed target 必须在本次安全 HTML 中精确对应唯一 `<img>`，重复、未知、占位或非图片 target 返回 400。 |
| Juice 产出额外标签、属性或危险 style | Juice 前无用户 style；Juice 后按固定 property/value 白名单逐节点验证，再经过防御性 sanitizer；任何差异视为输出失败。 |
| 内联失败却误报成功 | 服务端不返回 clipboard/HTML；客户端不调用 Clipboard API；显示 Markdown fallback。 |
| 旧输出覆盖新正文/主题/坏图状态 | output request version、applied render version 和完整 snapshot 三重比较；任何输入变化立即失效。 |
| 纯文本与 HTML 语义不一致 | 从同一修正后 DOM 遍历生成，固定块、列表、表格、代码、换行和图片 alt 规则；不使用剥标签正则。 |
| 元信息混入正文剪贴板 | clipboard 两种 MIME 都只从正文 DOM生成；四项元信息分别 `writeText`；只有完整 HTML 和 Markdown 包含元信息。 |
| 自动化结果被夸大 | 测试只证明本地结构、安全、内联、MIME 与降级契约；真实微信粘贴仍需后续人工/真实环境验收。 |
