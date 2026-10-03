# 复制公众号富文本并下载 HTML 与 Markdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为现有公众号排版工作台增加可信的正文双 MIME 复制、四项元信息独立复制、完整 HTML 下载和规范 Markdown 复制/下载，并保证输出只对应最新、已通过格式门禁的服务端重渲染结果。

**Architecture:** 新建 `src/typesetting-output.js` 深模块，严格规范化源字段、presentation、脚注开关和运行时坏图 target，重新调用现有 renderer，再按“安全 DOM → Juice → doocs 局部修正 → 双 MIME/完整 HTML”生成六键 `OutputBundle`。`src/server.js` 只负责 exact endpoint 与 typed error 映射；浏览器只验证、缓存当前 snapshot 对应的 bundle，并在点击瞬间重新检查 render/output 双版本门禁，绝不读取预览 DOM 来生成富文本。

**Tech Stack:** Node.js 22+、Express 5、Marked 18、sanitize-html 2、Cheerio 1、`juice@11.0.3`、原生 Clipboard/Blob API、Playwright、`node:test`。

**Spec:** `docs/superpowers/specs/2026-10-03-copy-export-design.md`

## Global Constraints

- 只实现 GitHub Issue #7；不得进入 #8 的三栏重排、面板折叠、移动端单视图或完整设置抽屉。
- 不扩展四键 `RenderResult`：`{ html, presentation, diagnostics, blocked }`；格式检查 UI 继续只消费 `/api/typesetting/render` 的 diagnostics。
- `POST /api/typesetting/output` 顶层恰好四键；成功 `OutputBundle` 顶层恰好六键；所有层级都拒绝未知、缺失或错误类型字段。
- 输出服务端必须基于源 Markdown 重新调用 `renderTypesettingMarkdown()`；禁止接收、复制或信任浏览器 preview DOM、CSS、diagnostics、blocked、文件名或 MIME。
- `failedImageTargets` 仅接受本次重新渲染中唯一、受控、无凭据绝对 HTTPS `<img>` 的 target，按 DOM 顺序提交；未知、重复、乱序、静态占位、链接、非图片或旧 nonce 均拒绝。
- blocker 仍返回规范 Markdown；只有 ready 返回 clipboard 和完整 HTML。静态占位、运行时坏图、conversion 与 advisory 不阻断。
- 固定复制并适配 `doocs/md@a7c17fc4cda92e3c13aa7e24f06615cfa4219b31`（WTFPL v2）的 `solveWeChatImage()`、`modifyHtmlStructure()`、`createEmptyNode()`；不复制其 Vue/Pinia/store、DOM clone、图床、远程资源或失败降级。
- 精确依赖 `"juice": "11.0.3"`（git `ce15687713507252813744b0daaa70d4549527d1`，MIT）；只调用字符串公开 API，禁止 `juiceResources()`、`juiceFile()` 和未内联 HTML fallback。
- 富文本路径只允许一个 `ClipboardItem`、恰好 `text/html` 与 `text/plain` 两个 MIME、一次 `navigator.clipboard.write([item])`；仅 Promise resolve 才显示成功，任何失败都不得调用 `writeText` 或 `execCommand` 冒充富文本成功。
- 四项元信息各自使用一次 `navigator.clipboard.writeText(currentValue)`，空字符串也原样写入；正文两个 MIME 不得包含元信息。
- HTML/Markdown 下载只由客户端基于当前 artifact 创建 Blob；HTML 只能来自 fresh ready bundle，Markdown 可来自 fresh bundle 或与服务端同算法的当前源字段 fallback。
- 所有 output 非 2xx 都使用 exact typed error；不得暴露堆栈、路径、CSS parser 文本、HTML、正文或半成品。
- 不修改 `src/article.js`、`src/exporter.js`、`public/app.js`、文章批量导出、文稿持久化 schema、根 `CONTEXT.md` 或 ADR。
- 测试不访问真实微信或第三方图片，不对整份 HTML 做 snapshot；自动化结论不得扩大为真实微信公众号兼容保证。

## File Structure

- Create `src/typesetting-output.js`：唯一输出语义边界；公开 `buildTypesettingOutput()` 与 `createTypesettingOutputBuilder()`，其余规范化、Markdown、filename、DOM 修正、plain text、安全校验和文档壳 helper 全部私有。
- Modify `src/server.js`：注入 `typesettingOutputBuilder`，接线 exact output path，统一该路径的 guard/parser/domain/generation typed error。
- Modify `public/typesetting.js`：snapshot/version/cache/schema、预生成和失效、Clipboard/Blob 操作、本地 Markdown fallback；不生成富文本 HTML。
- Modify `public/typesetting.html`：四项元信息复制按钮、最小输出 fieldset、status/alert。
- Modify `public/style.css`：输出区、disabled/focus、窄屏换行；不重排工作台。
- Preserve `public/typesetting-theme.css`：继续作为唯一固定主题 CSS；仅在输出结构测试证明必需且不改变 preview 语义时才修改。
- Create `test/typesetting-output.test.js`：深模块、artifact、CSS/DOM/plain/full HTML、failed target、HTTP 与 typed error。
- Create `test/typesetting-output-ui.test.js`：strict bundle、cache/gate、Clipboard/Blob、fallback、竞态与 server restart。
- Create `test/fixtures/typesetting-output-artifacts.json`：服务端和客户端测试共同读取的完整 Markdown artifact fixture。
- Modify `package.json` / `package-lock.json`：精确加入 Juice 11.0.3。
- Modify `THIRD_PARTY_NOTICES.md`：记录 doocs 三个函数与主动偏离、Juice 固定版本/SHA/许可/API 边界。

## Review Focus

- 非空 `failedImageTargets` 在服务端重启后因 target nonce 失配时，客户端必须同时让 render/output stale 并重新 render；空集合跨重启仍应接受。由 Task 2、Task 6 的 restart 测试固定。
- Juice 输出新增未知 style、`url()`、CSS variable、非法属性/标签，或防御性 sanitizer 改变 DOM 时，必须整包失败而非尽量保留。由 Task 3 的 failure seam/白名单测试固定。
- 已有 ready bundle 后任一元信息、主题设置、脚注或坏图集合变化，慢旧 success/failure 都不得恢复旧 gate 或下载旧文件名。由 Task 5、Task 7 的完整 snapshot/竞态测试固定。
- Clipboard API 不支持、非 secure context、`supports()` 拒绝、write pending/reject 时，不能提前或错误显示富文本成功，也不能触发纯文本 fallback。由 Task 6、Task 7 的浏览器测试固定。
- 本地 Markdown fallback 必须把 filename、mimeType、content 作为同一当前 artifact 计算；引号、冒号、井号、反斜线、多行元信息、CRLF、emoji/CJK 与 80 code point filename 不得和服务端漂移。由 Task 1、Task 5 的共享 fixture 测试固定。

## 执行与审查协议

任务必须按 Task 1 → Task 8 串行执行；Task 2 与 Task 3 由同一个 executor 连续负责 `src/typesetting-output.js`，Task 4 才允许把 builder 暴露为 HTTP，Task 5 完成 strict cache/gate 后 Task 6 才接 UI 操作。任何时候只允许一个 executor 修改共享生产文件。

每个任务固定执行以下门禁：

1. executor 按 RED → 最小实现 → GREEN → commit 完成本任务；
2. Orchestrator 派一个未参与实现的 reviewer，只审当前任务首个 commit 到最终 commit 的 diff、规格覆盖与测试证据；
3. reviewer 只返回 `PASS` 或 `REWORK` 及可复现问题；
4. `REWORK` 必须回交原 executor，在同一任务上下文修复、重跑聚焦检查并追加 fix commit，再交独立 reviewer 复验；
5. 只有 `PASS` 才能开始下一任务。Task 8 PASS 后再做一次相对 Issue #7 基线 `c58f7cbcbe7a2985e5a4874e6776d231226da36c` 的 whole-branch review。

---

### Task 1: 锁定 Juice 依赖与共享 Markdown artifact 契约

**Files:**
- Create: `test/fixtures/typesetting-output-artifacts.json`
- Create: `test/typesetting-output.test.js`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces: 精确运行时依赖 `juice@11.0.3`。
- Produces: fixture 数组项 `{ name, document, artifact }`；`document` 恰好五个字符串，`artifact` 恰好 `{ mimeType, filename, content }`。
- Freezes: `mimeType === 'text/markdown;charset=utf-8'`，front matter 顺序 `title/author/account/publishedAt`，JSON 双引号标量、LF、唯一最终 LF 与 basename 规则。
- Consumers: Task 2 的服务端 builder 测试与 Task 5 的浏览器 fallback 测试都读取同一 fixture，不另写期望算法。

- [ ] **Step 1: 写失败的依赖与 fixture 契约测试**

在 `test/typesetting-output.test.js` 添加 `输出依赖和共享 Markdown fixture 固定版本与完整 artifact shape`：读取 `package.json`、`package-lock.json` 和 fixture，断言：

```js
assert.equal(packageJson.dependencies.juice, '11.0.3');
assert.equal(lock.packages['node_modules/juice'].version, '11.0.3');
assert.deepEqual(Object.keys(item.document).sort(), ['account', 'author', 'body', 'publishedAt', 'title']);
assert.deepEqual(Object.keys(item.artifact).sort(), ['content', 'filename', 'mimeType']);
assert.equal(item.artifact.mimeType, 'text/markdown;charset=utf-8');
assert.match(item.artifact.content, /^---\ntitle: /u);
assert.equal(item.artifact.content.endsWith('\n'), true);
assert.equal(item.artifact.content.endsWith('\n\n'), false);
```

Fixture 至少包含：普通中文、四项空值、引号/冒号/`#`/反斜线/多行元信息、CRLF 与裸 CR 正文、全点/禁用字符标题、emoji/CJK、超过 80 Unicode code point 标题。

- [ ] **Step 2: 运行测试确认 RED**

Run: `node --test --test-name-pattern='输出依赖和共享 Markdown fixture' test/typesetting-output.test.js`

Expected: FAIL，因为 Juice 精确依赖和 fixture 尚不存在。

- [ ] **Step 3: 精确安装 Juice 并写入固定 fixture**

Run: `npm install --save-exact juice@11.0.3`

确认 `package.json` 没有 `^`/`~`，lockfile 的 Juice 版本为 `11.0.3` 且 Node engine 与项目 `>=22` 兼容。按规格逐字节写入 fixture expected artifact；本任务不创建生产 Markdown helper。

- [ ] **Step 4: 运行 GREEN 与依赖审计**

Run: `node --test --test-name-pattern='输出依赖和共享 Markdown fixture' test/typesetting-output.test.js`

Run: `npm ls juice`

Expected: 测试 PASS；依赖树显示 `juice@11.0.3`。

- [ ] **Step 5: 提交契约基线**

```bash
git add package.json package-lock.json test/fixtures/typesetting-output-artifacts.json test/typesetting-output.test.js
git commit -m "test: freeze typesetting output artifacts"
```

- [ ] **Step 6: 独立 review gate**

reviewer 核对 fixture 的 YAML 1.2/JSON 双引号语义、Unicode code point 截断和 lockfile 精确版本；`REWORK` 交回原 executor 修复，`PASS` 后进入 Task 2。

### Task 2: 建立严格输出深模块、Markdown/blocked bundle 与 failed target 所有权

**Files:**
- Create: `src/typesetting-output.js`
- Modify: `test/typesetting-output.test.js`

**Interfaces:**
- Produces: `buildTypesettingOutput({ document, presentation, convertExternalLinksToFootnotes, failedImageTargets }) -> Promise<OutputBundle>`。
- Produces: `createTypesettingOutputBuilder({ renderTypesetting = renderTypesettingMarkdown, inlineCss = defaultJuiceAdapter, themeCss = fixedTypesettingThemeCss } = {}) -> buildTypesettingOutput`。
- Uses: `normalizeTypesettingPresentation()` 与现有 `renderTypesettingMarkdown({ body, presentation, convertExternalLinksToFootnotes })`；不调用 Marked、不重算脚注。
- Throws: 带固定 `code` 的安全错误，仅 `OUTPUT_REQUEST_INVALID`、`OUTPUT_FAILED_IMAGE_TARGET_INVALID`、`OUTPUT_GENERATION_FAILED`；helper 和错误构造保持模块私有。
- Produces: blocker 六键 bundle，其中 `markdown` 完整存在而 `clipboard/html` 为 `null`；ready 分支在本任务不接 HTTP，Task 3 完成完整产物后才允许被生产路由调用。

- [ ] **Step 1: 写失败的 exact input、Markdown、RenderResult 与 blocked 测试**

添加以下测试：

- `输出 builder 只接受 exact 四键请求和 exact 五键 document`
- `服务端 Markdown artifact 与共享 fixture 逐字节一致`
- `blocked bundle 恰好六键并跳过 Juice`
- `输出 builder 拒绝畸形四键 RenderResult 且不泄漏内部错误`

核心断言：

```js
assert.deepEqual(Object.keys(bundle).sort(), ['clipboard', 'html', 'markdown', 'schemaVersion', 'snapshot', 'status']);
assert.equal(bundle.schemaVersion, 1);
assert.equal(bundle.status, 'blocked');
assert.equal(bundle.clipboard, null);
assert.equal(bundle.html, null);
assert.deepEqual(bundle.markdown, fixture.artifact);
assert.equal(inlineCalls, 0);
await assert.rejects(build({ ...valid, extra: true }), error => error.code === 'OUTPUT_REQUEST_INVALID');
```

覆盖缺失/额外键、非字符串字段、非法 presentation、非 boolean、failed target 非数组/空字符串/重复，并断言 renderer 收到的参数恰好 `{ body, presentation, convertExternalLinksToFootnotes }`。

- [ ] **Step 2: 写失败的 target 所有权和顺序测试**

用 injected renderer 返回带受控 target 的 HTML，添加：

- `failed target 仅接受当前唯一受控 HTTPS 图片并按 DOM 顺序回显`
- `failed target 拒绝未知链接静态占位重复 DOM target 乱序与旧 nonce`
- `空 failed target 跨 renderer nonce 正常且 bundle 不泄漏新 target`

用 `blocked: true` 的 injected renderer 证明唯一图片 target 可通过所有权检查并按请求顺序进入 snapshot；其余输入全部拒绝。响应 snapshot 只回显请求且已验证的 targets，不返回 diagnostics/blocked/新 target。图片的可见占位产物在 Task 3 的 ready pipeline 测试中断言。

- [ ] **Step 3: 运行聚焦测试确认 RED**

Run: `node --test --test-name-pattern='输出 builder|服务端 Markdown|blocked bundle|failed target|空 failed target' test/typesetting-output.test.js`

Expected: FAIL，因为深模块不存在。

- [ ] **Step 4: 实现严格规范化、Markdown、renderer 校验和 blocked 路径**

在 `src/typesetting-output.js`：

- 模块加载时只读取同仓库 `public/typesetting-theme.css`；默认 Juice adapter 仅封装 `juice(htmlWithStyleTag, fixedOptions)`，不使用资源型 API；
- 用 exact-key helper 规范化请求，五个字符串先规范 CRLF/CR；presentation 只经现有 normalizer；
- 私有 `safeOutputBaseName(title)` 与 `buildNormalizedMarkdown(document)` 精确实现规格和 fixture；
- 调用 renderer 后校验四键、presentation、diagnostics 数组、boolean blocked 且 `blocked === any blocker`；畸形结果统一安全 generation error；
- 在 Cheerio fragment 中建立 target → elements 索引，验证请求唯一性/顺序/元素类型/HTTPS 无凭据/referrer policy/runtime 属性；
- 把 failed 图片替换为固定可见占位，移除 target/runtime attrs；
- blocker 立即返回六键 bundle，并保证不调用 inlineCss。

ready 分支可以暂时停在模块内部的安全 generation error；因为本任务不接 endpoint，不能返回占位 clipboard/HTML 或不完整成功 bundle。Task 3 必须完成 ready 分支后 Task 4 才可接线。

- [ ] **Step 5: 运行 GREEN 与语法检查**

Run: `node --test --test-name-pattern='输出 builder|服务端 Markdown|blocked bundle|failed target|空 failed target' test/typesetting-output.test.js`

Run: `node --check src/typesetting-output.js`

Expected: 所选测试 PASS；语法检查退出 0。

- [ ] **Step 6: 提交深模块核心**

```bash
git add src/typesetting-output.js test/typesetting-output.test.js
git commit -m "feat: build strict typesetting output core"
```

- [ ] **Step 7: 独立 review gate**

reviewer 重点验证请求/响应 exact shape、renderer 四键不被扩展、target nonce/顺序、blocked 不调用 Juice、Markdown fixture 全等；`PASS` 后才进入 Task 3。

### Task 3: 完成安全内联、doocs 兼容修正、plain text 与完整 HTML

**Files:**
- Modify: `src/typesetting-output.js`
- Modify: `test/typesetting-output.test.js`

**Interfaces:**
- Completes: Task 2 builder 的 ready 分支，返回非 null `clipboard` 与 `html`。
- Consumes: `inlineCss(cleanFragment, fixedThemeCss, fixedOptions) -> string | Promise<string>`；非字符串、throw/reject 均为 `OUTPUT_GENERATION_FAILED`。
- Preserves: `canonicalInlineBody` 只供完整 HTML；clipboard 从其 clone 派生，不把列表/图片/边界修正回写 canonical body。
- Adapts privately: doocs `modifyHtmlStructure()`、`solveWeChatImage()`、`createEmptyNode()`；不导出这些 helper。

- [ ] **Step 1: 写失败的 Juice 固定调用和 canonical 白名单测试**

添加：

- `三个主题和四项设置经固定 Juice options 形成无 class 变量 style 标签的 canonical body`
- `输出标签集合精确覆盖 previewAllowedTags 且白名单外标签失败`
- `anchor URL 分类与 renderer 一致并保留合法 relative fragment credentials`
- `table span 作为 renderer 已保留的不透明字符串输出`
- `Juice throw 非字符串非法 style 属性标签与 sanitizer 差异均整包失败`

断言 `inlineCss` 只调用一次，CSS 参数等于仓库固定主题 CSS，options 恰好为规格列出的 12 项；产物无 `<style>`、class、id、CSS variable、`data-*`、媒体查询、font-face、远程 CSS 或 `url()`。逐一覆盖 71 个 preview allowed tags；`a.href` 覆盖控制字符/comment laundering、协议相对和未知 scheme；`th/td` 覆盖非数字、0、负数、前导零和超大 span。

- [ ] **Step 2: 写失败的 doocs 三 helper、图片与 plain text 测试**

添加：

- `clipboard 嵌套列表按 doocs 规则外移且同一 li 多子列表不反转`
- `clipboard 图片尺寸按 solveWeChatImage 收窄规则转 style`
- `运行时失败图片原位变成无 src 可见占位且不泄漏 URL`
- `clipboard 首尾各一个 createEmptyNode 且完整 HTML 和 plain 不含边界`
- `plain text 保留块列表表格pre图片和占位语义且不含元信息`

覆盖 width/height 的整数、`px/%/em/rem`、height auto、负数/NaN/未知单位；默认图片固定 `display:block;max-width:100%;height:auto`。plain 断言标题/段落/`br`、两级 ul/ol、`ol[start]`、table tab、pre 空白、inline code、脚注、图片 alt、静态/运行时占位、空行压缩和无末尾 LF。

- [ ] **Step 3: 写失败的完整 HTML 安全壳和元信息边界测试**

添加 `完整 HTML 有固定安全文档壳四项元信息和同一 canonical 正文`，用 Cheerio 解析断言：

```js
assert.match(bundle.html.content, /^<!doctype html>/iu);
assert.equal($('html').attr('lang'), 'zh-CN');
assert.equal($('head').children().first().is('meta[charset="utf-8"]'), true);
assert.equal($('meta[http-equiv="Referrer-Policy"]').attr('content'), 'no-referrer');
assert.equal($('meta[http-equiv="Content-Security-Policy"]').attr('content'), "default-src 'none'; img-src https:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
assert.equal($('header h1').text(), document.title);
assert.equal($('header dl dd').length, 3);
```

元信息包含 HTML 字符时必须作为 text node 可见但不能形成节点/属性；完整 HTML 无边界节点，无 script/link/base/form/iframe/SVG/未知 scheme/非 HTTPS 或带凭据图片。

- [ ] **Step 4: 运行测试确认 RED**

Run: `node --test --test-name-pattern='三个主题|输出标签集合|anchor URL|table span|Juice|clipboard|plain text|完整 HTML' test/typesetting-output.test.js`

Expected: FAIL，因为 ready 分支尚未生成完整安全产物。

- [ ] **Step 5: 按固定顺序完成 ready pipeline**

实现且保持以下顺序：

1. 将 Task 2 的安全 fragment 放入唯一主题根，主题名/变量只来自 normalized presentation；
2. 用固定 options 调一次 `inlineCss`；任何异常/非字符串立即失败；
3. 移除 class/id/runtime attrs/CSS variables，逐节点验证固定标签、属性、URL、style property/value；
4. 用独立 sanitize-html 输出策略清理并比较规范化 DOM；任何差异失败；
5. 保存不可变 canonical section，生成完整 HTML 安全壳和 metadata header；
6. clone canonical section，依次调用本地适配的 `modifyHtmlStructure()`、`solveWeChatImage()`、图片默认样式和第二次最终校验；
7. 从修正后 section 进行块语义 plain traversal；
8. plain 完成后才在 section 外调用两次 `createEmptyNode()`，生成 clipboard HTML。

三个 doocs helper 的结构和目的应能追溯到固定 commit；只作规格要求的服务端 DOM、长度白名单、列表顺序与 plain 边界适配。

- [ ] **Step 6: 运行 GREEN 与深模块全测**

Run: `node --test test/typesetting-output.test.js`

Run: `node --check src/typesetting-output.js`

Expected: 全部已有 output 单元测试 PASS；语法检查退出 0。

- [ ] **Step 7: 提交完整深模块**

```bash
git add src/typesetting-output.js test/typesetting-output.test.js
git commit -m "feat: generate safe rich typesetting artifacts"
```

- [ ] **Step 8: 独立 review gate**

reviewer 对照固定 doocs 源码与 Juice 公开 API，检查处理顺序、主动偏离、安全白名单、canonical/clipboard 分叉和 plain 语义；任何 partial success、资源抓取或未内联 fallback 均为 `REWORK`。

### Task 4: 接线 strict output endpoint 与全路径 typed errors

**Files:**
- Modify: `src/server.js`
- Modify: `test/typesetting-output.test.js`

**Interfaces:**
- Extends: `createApp({ ..., typesettingOutputBuilder = buildTypesettingOutput } = {})`；现有 `typesettingRenderer` 仍只服务 `/render`。
- Produces: `POST /api/typesetting/output`，请求 body 原样交给 builder，成功原样返回 strict bundle。
- Produces exact errors: `OUTPUT_REQUEST_FORBIDDEN` 403、`OUTPUT_METHOD_NOT_ALLOWED` 405、`OUTPUT_JSON_INVALID` 400、`OUTPUT_REQUEST_TOO_LARGE` 413、`OUTPUT_REQUEST_INVALID` 400、`OUTPUT_FAILED_IMAGE_TARGET_INVALID` 400、`OUTPUT_GENERATION_FAILED` 500。
- Preserves: 其他 endpoint 的现有 guard/error JSON 和行为。

- [ ] **Step 1: 写失败的 endpoint 成功与 domain error 测试**

添加 `output endpoint 只调用注入 builder 并原样返回 bundle`，断言 builder 只收到 exact body 且调用一次；添加 shape/failed target/generation 注入错误，逐个断言 status、exact 三键 error `{ code, message, retryable }`，响应不含 markdown/clipboard/html/内部 sentinel。

- [ ] **Step 2: 写失败的 transport typed error 矩阵**

添加真实 HTTP 测试覆盖：

- 非本机 Host、Origin mismatch、POST 非 JSON → 403；
- GET/PUT/DELETE 同 exact path，即使无 content-type → 405；
- malformed JSON → 400 JSON invalid；
- body 超过 `150kb` → 413；
- 路由后的 method fallback 不落入静态 HTML/404；
- 其他 endpoint 的既有 `{ error: string | object }` 不被全局改变。

每个 output 非 2xx 都断言 `Object.keys(body) === ['error']` 和 exact error 三键；message 为固定中文，不含原始 parser/body/path。

- [ ] **Step 3: 运行测试确认 RED**

Run: `node --test --test-name-pattern='output endpoint|transport typed error' test/typesetting-output.test.js`

Expected: FAIL，因为 endpoint/专属映射不存在。

- [ ] **Step 4: 最小接线并重排 exact-path guard/error 顺序**

在 `src/server.js`：

- 导入生产 builder，并给 `createApp()` 增加可选 adapter；
- 在通用 guard 最前先识别 exact output path：非 POST 直接 typed 405；POST 再检查 Host/Origin/content-type，失败 typed 403；其余路径保留现有逻辑；
- 保留全局 `express.json({ limit: '150kb' })`，在 final error middleware 对 exact path 映射 parse failed/entity too large/domain/generation/unexpected；
- output handler `await typesettingOutputBuilder(req.body)`，不拼 HTML、不改 bundle；
- 路由后加 exact-path method fallback 作为防御；
- unexpected output error 固定 500 generation failed，不泄漏内部值。

- [ ] **Step 5: 运行 GREEN、HTTP 全测和现有 endpoint 回归**

Run: `node --test test/typesetting-output.test.js`

Run: `node --test test/typesetting.test.js test/typesetting-import.test.js test/rich-text.test.js`

Run: `node --check src/server.js`

Expected: 全部 PASS；其他 API error shape 未漂移。

- [ ] **Step 6: 提交 HTTP 里程碑**

```bash
git add src/server.js test/typesetting-output.test.js
git commit -m "feat: expose strict typesetting output endpoint"
```

- [ ] **Step 7: 独立 review gate**

reviewer 重点核对 method-before-content-type、parser/limit 前置错误、unexpected 500 和其他 endpoint 隔离；`PASS` 后进入客户端状态任务。

### Task 5: 建立客户端 strict snapshot、缓存、失效与本地 Markdown fallback

**Files:**
- Create: `test/typesetting-output-ui.test.js`
- Modify: `public/typesetting.js`

**Interfaces:**
- Produces private state: `outputVersion`、`outputRequestVersion`、`outputFresh`、`outputPending`、`outputBundle`、`outputCache`、`failedImageTargets`。
- Produces: `outputSnapshot()`，精确返回五字段 document、最新 applied presentation、脚注 boolean、按当前 preview DOM 顺序投影的 failed target 数组。
- Produces: `sameOutputSnapshot(left, right)`、`isValidOutputBundle(value, snapshot)`、`invalidateOutput()`、`requestOutput()`、`hasFreshReadyOutput()`。
- Produces: `safeOutputBaseName(title)`、`buildNormalizedMarkdown(document)`、`currentMarkdownArtifact()`；仅这一组算法允许在客户端重复，并由 Task 1 fixture 锁定。
- Preserves: previewVersion/appliedRenderVersion/renderFresh/renderBlocked 的现有原子应用与 stale 语义。

- [ ] **Step 1: 写失败的 strict schema 与共享 fixture 浏览器测试**

Node 侧读取 `test/fixtures/typesetting-output-artifacts.json` 并把 case 传入页面；添加：

- `客户端本地 Markdown artifact 与服务端共享 fixture 深度相等`
- `客户端只接受 exact 六键 OutputBundle 和 exact nested snapshot/artifact`
- `未知 schema status MIME filename 键或 snapshot 差异保持 output stale`

fixture 测试必须逐项断言整个 `{ mimeType, filename, content }`，不能只比 content。

- [ ] **Step 2: 写失败的预生成、失效与接受条件测试**

用 Playwright route 记录 `/render` 与 `/output` 请求，覆盖：

- 最新 RenderResult 原子应用后立即 output 请求，blocker 也请求；
- 五字段、主题、四设置、脚注任一变化先失效，再进入 preview/save；
- output 请求 snapshot 不含 revision/savedAt/preview HTML；
- failed targets 按当前 DOM 顺序而非 error 到达顺序提交；loaded 不失效，首次 error 失效并重建，重复 error 不重建；
- 慢旧 success/failure、非 2xx、malformed 200、schema/snapshot/status 与 renderBlocked 不一致都不能缓存；
- 当前成功必须同时满足最新 request/output/render version、`renderFresh`、完整 snapshot 与 status 对应。

- [ ] **Step 3: 运行测试确认 RED**

Run: `node --test --test-name-pattern='客户端本地 Markdown|客户端只接受|未知 schema|预生成|失效|慢旧' test/typesetting-output-ui.test.js`

Expected: FAIL，因为 output 状态机不存在。

- [ ] **Step 4: 实现状态机但暂不接 UI 动作**

在 `public/typesetting.js`：

- 用递归 exact-key/value 比较，不用 JSON 子串或 revision 代替 snapshot；
- 所有输入 change handler 在现有 preview/save 前调用 `invalidateOutput()`；
- `applyRenderResult()` 清空旧 failed set、记录 applied render version 后触发 `requestOutput()`，包括 blocker；
- `settleImage()` 只有当前 DOM/current version 的首次 error 才加入 Set、失效、重建；
- 捕获 requestVersion/outputVersion/renderVersion/snapshot，并按规格八项接受条件原子缓存；
- 非 2xx typed error 保持 `outputFresh=false` 且不恢复旧 bundle；`OUTPUT_FAILED_IMAGE_TARGET_INVALID` 的 render stale 与重新 render 恢复由 Task 7 在真实 restart 场景实现；
- 本地 Markdown helper 逐条实现 Task 1 fixture 算法；fresh 且 snapshot 一致时 `currentMarkdownArtifact()` 直接返回 bundle artifact，不重算 filename。

本任务不创建 ClipboardItem、Blob 或按钮监听器；Task 6 只通过这些私有 gate/selector 接动作。

- [ ] **Step 5: 运行 GREEN 与现有 render/diagnostics 回归**

Run: `node --test test/typesetting-output-ui.test.js`

Run: `node --test test/typesetting-diagnostics-ui.test.js`

Run: `node --check public/typesetting.js`

Expected: 新状态测试与既有 diagnostics/图片状态测试 PASS；语法检查退出 0。

- [ ] **Step 6: 提交客户端状态里程碑**

```bash
git add public/typesetting.js test/typesetting-output-ui.test.js
git commit -m "feat: cache current typesetting output bundle"
```

- [ ] **Step 7: 独立 review gate**

reviewer 核对完整 snapshot、双版本、旧事件、blocker/status 对应与 shared fixture；任何旧 bundle fallback、preview DOM 生成或 silent target drop 都是 `REWORK`。

### Task 6: 增加最小输出 UI、双 MIME Clipboard、元信息复制与 Blob 下载

**Files:**
- Modify: `public/typesetting.html`
- Modify: `public/typesetting.js`
- Modify: `public/style.css`
- Modify: `test/typesetting-output-ui.test.js`

**Interfaces:**
- Adds controls: 四个 accessible name 含字段名的 metadata copy buttons；`#copy-wechat`、`#copy-markdown`、`#download-html`、`#download-markdown`、`#output-status[role=status]`、`#output-error[role=alert]`。
- Consumes: Task 5 `hasFreshReadyOutput()` 与 `currentMarkdownArtifact()`；所有点击在副作用前重新检查 current snapshot/gate。
- Produces: rich copy 一次 `ClipboardItem` + 一次 `clipboard.write`；metadata/Markdown 各自一次 `writeText`；download 使用 artifact 自身 mimeType/filename/content。

- [ ] **Step 1: 写失败的可访问 UI 和状态测试**

添加：

- `输出区保留现有 label 并提供四个元信息复制按钮和四个输出动作`
- `HTML gate disabled pending blocker stale error 且 Markdown 下载始终可用`
- `pending blocker success failure 文案分别进入 status 与 alert`

断言每个触控目标 computed height ≥ 42px；窄屏只换行，不改变 editor/proof 主体顺序。

- [ ] **Step 2: 写失败的富文本双 MIME 成功/失败测试**

在页面初始化前注入 Clipboard API spy，覆盖 secure context、`ClipboardItem.supports`、constructor、write pending/resolve/reject/throw：

```js
assert.equal(clipboardItems.length, 1);
assert.deepEqual(Object.keys(clipboardItems[0].types).sort(), ['text/html', 'text/plain']);
assert.equal(writeCalls.length, 1);
assert.equal(execCommandCalls, 0);
assert.equal(writeTextCalls, 0); // rich path
```

pending 不出现“已复制”；resolve 后才显示“已复制正文富文本”；不支持/reject 显示固定失败和 Markdown/HTML 替代入口，HTML bundle 仍可下载。

- [ ] **Step 3: 写失败的元信息、Markdown 与 Blob 下载测试**

覆盖：

- 四个元信息按钮各捕获点击时当前原字符串（含空值），各调用一次 writeText，accessible name 含字段名；拒绝不报成功；
- fresh ready/blocked bundle 的 Markdown 直接用 bundle artifact，不重算 filename；stale/pending/error/blocker 允许用当前本地 artifact；
- HTML 只用 fresh ready bundle；任何 gate 不满足不创建 Blob/anchor；
- Blob type/content、`download` filename 与选定 artifact 完全一致；临时 anchor click 后移除，object URL 在 `setTimeout(0)` revoke；不打开新页、不请求服务端文件。

- [ ] **Step 4: 运行测试确认 RED**

Run: `node --test --test-name-pattern='输出区|HTML gate|双 MIME|元信息|Markdown|Blob' test/typesetting-output-ui.test.js`

Expected: FAIL，因为 UI 与动作尚不存在。

- [ ] **Step 5: 实现最小 UI 和浏览器副作用**

- 把每个 metadata input 与小型复制按钮放入同一 field wrapper，保留原 label/input 关联；
- 正文后新增输出 fieldset、status 与 alert，不移动 preview/check 主体；
- rich copy 在 gate 后依次检查 secure context、write、ClipboardItem 和 supports，构造一个双 Blob item，只 await 一次 write；
- metadata/Markdown 只用 writeText，失败不触发 execCommand；rich 失败绝不调用 writeText；
- 下载 helper 只接收严格 artifact，不自行重命名；click 后异步 revoke/remove；
- 每次新动作先清旧成功提示，成功/失败分别写 status/alert；blocker 固定提示仍可复制/下载 Markdown；
- CSS 只增加输出区、按钮组、disabled/focus 和窄屏换行。

- [ ] **Step 6: 运行 GREEN、语法和静态 HTML 检查**

Run: `node --test test/typesetting-output-ui.test.js`

Run: `node --check public/typesetting.js`

Run: `git diff --check`

Expected: UI 测试 PASS；无语法/空白错误。

- [ ] **Step 7: 提交输出交互**

```bash
git add public/typesetting.html public/typesetting.js public/style.css test/typesetting-output-ui.test.js
git commit -m "feat: copy and download typesetting outputs"
```

- [ ] **Step 8: 独立 review gate**

reviewer 检查 rich 与 metadata/Markdown 副作用是否分离、点击时 gate、Blob artifact 一致性、无 execCommand/hidden textarea 和可访问命名；`PASS` 后进入竞态验收。

### Task 7: 补齐浏览器竞态、重启恢复和降级验收

**Files:**
- Modify: `test/typesetting-output-ui.test.js`
- Modify: `public/typesetting.js`（仅修复本任务测试暴露的状态缺陷）
- Modify: `public/typesetting.html` / `public/style.css`（仅修复本任务验收暴露的可访问性/状态缺陷）

**Interfaces:**
- Exercises: Task 5/6 的既有状态和操作接口，不创建第二套 production helper。
- Preserves: `failedImageTargets`、render diagnostics、output cache 都是内存派生状态，不写文稿或磁盘。

- [ ] **Step 1: 写失败的全输入竞态矩阵**

添加 `慢旧 output 成功失败均不能覆盖更新后的字段正文主题脚注与坏图 snapshot`：为五类变化分别延迟旧请求，在新请求接受后才 resolve/reject 旧请求；断言按钮状态、status/error、下载 filename/content、failed set 均保持新值。

添加 `render stale pending malformed 时旧 ready bundle 不能复制或下载 HTML`；快速重复点击时每次成功必须对应一次已 resolve write，pending 点击不能绕过 gate。

- [ ] **Step 2: 写失败的图片和 server restart 矩阵**

覆盖：

- 图片首次 error 立即禁用 ready gate；新 bundle 用无 src 占位恢复；旧 DOM 的 load/error 不改变当前 set；
- 非空 target 在 server restart 后得到 `OUTPUT_FAILED_IMAGE_TARGET_INVALID`，客户端同时 stale 并重新 render，不能删 target 后静默重试；
- 新 render 应用后旧 failed set 清空，由新 DOM 事件重建；
- failed target 空集合跨 server restart 正常接受，响应不泄漏新 nonce。

- [ ] **Step 3: 写失败的 blocker/advisory/clipboard 降级矩阵**

覆盖 EMPTY_BODY/RENDER_FAILED blocker、conversion、advisory、静态图片占位、运行时坏图；断言只有 blocker 禁止 rich/HTML，所有情况都有当前 Markdown。再覆盖非 secure context、无 ClipboardItem、supports false、write reject：均不调用 execCommand/writeText rich fallback，不隐藏已有 HTML 下载。

- [ ] **Step 4: 运行测试确认 RED**

Run: `node --test --test-name-pattern='慢旧 output|render stale|server restart|blocker|advisory|clipboard 降级' test/typesetting-output-ui.test.js`

Expected: FAIL，至少因为 Task 5 对 `OUTPUT_FAILED_IMAGE_TARGET_INVALID` 只按普通 output error 处理，尚未同时让 render stale 并触发新 preview；不得通过丢弃 failed target 或放宽 snapshot 来让测试变绿。

- [ ] **Step 5: 只修复测试证明的生产缺陷**

将修改限制在 Task 5/6 状态机和 UI；不重构 renderer/output module，不加入重试队列、持久化 cache、轮询或新的产品行为。每修一类 race 后重跑对应 test-name-pattern。

- [ ] **Step 6: 运行完整浏览器输出测试与相关 #3～#6 回归**

Run: `node --test test/typesetting-output-ui.test.js test/typesetting-diagnostics-ui.test.js test/typesetting-import.test.js test/typesetting.test.js`

Expected: 全部 PASS；无真实外网请求。

- [ ] **Step 7: 提交竞态验收**

```bash
git add test/typesetting-output-ui.test.js public/typesetting.js public/typesetting.html public/style.css
git commit -m "test: cover typesetting output races"
```

- [ ] **Step 8: 独立 review gate**

reviewer 必须检查 delayed route 的先后顺序确实能证明 stale response 无副作用，以及 restart 用新 server/nonce 而非伪造普通 400；`PASS` 后进入最终来源与回归任务。

### Task 8: 落地第三方来源、全量回归与 whole-branch 交付门禁

**Files:**
- Modify: `THIRD_PARTY_NOTICES.md`
- Modify: `test/typesetting-output.test.js`（只补静态来源/版本断言或终审发现的缺口）
- Modify: `test/typesetting-output-ui.test.js`（只补终审发现的验收缺口）
- Modify: Issue #7 相关生产文件（仅修复本任务验证或 review 发现的缺陷）

**Interfaces:**
- Documents: doocs fixed commit/WTFPL、三个复制函数、目标文件、服务端适配和主动偏离；Juice 11.0.3/fixed SHA/MIT/Automattic/Node `>=18.17`/字符串 API 范围。
- States explicitly: Clipboard/Blob/object URL 为浏览器标准 API；未复制 doocs 完整 pipeline；未采用其未内联/legacy copy fallback；自动化未完成真实微信公众号兼容验收。
- Delivers: 一个全量测试、语法、diff 检查均通过且可交 whole-branch review 的分支。

- [ ] **Step 1: 写失败的 notice 可追溯性测试**

添加 `第三方 notice 精确记录 doocs 三 helper 与 Juice 固定版本许可边界`，读取 notice 并断言包含：

```js
for (const token of [
  'a7c17fc4cda92e3c13aa7e24f06615cfa4219b31',
  'solveWeChatImage', 'modifyHtmlStructure', 'createEmptyNode',
  '11.0.3', 'ce15687713507252813744b0daaa70d4549527d1',
  'WTFPL', 'MIT', 'src/typesetting-output.js'
]) assert.match(notice, new RegExp(token));
```

测试还应断言现有 `LICENSES/DOOCS-MD-WTFPL-2.txt` 仍存在；不要复制 Juice 整份许可文件到仓库，package 自带 `LICENSE.md`，仓库 notice 记录来源即可。

- [ ] **Step 2: 运行 notice 测试确认 RED**

Run: `node --test --test-name-pattern='第三方 notice' test/typesetting-output.test.js`

Expected: FAIL，因为 notice 尚未记录 clipboard helper 与 Juice。

- [ ] **Step 3: 更新 notice，不夸大复用范围**

在现有 doocs 表格增加固定 `clipboard.ts` / `clipboard-dom.ts` 来源，明确只复制三 helper 并作服务端 DOM、长度、安全、顺序和边界适配；新增 Juice 独立小节，记录版本/SHA/许可/copyright/Node/API/禁止资源抓取。明确浏览器标准 API 不属于第三方复制，且富文本成功语义主动偏离 doocs fallback。

- [ ] **Step 4: 运行来源测试与完整验证**

Run: `node --test test/typesetting-output.test.js test/typesetting-output-ui.test.js`

Run: `node --check src/typesetting-output.js && node --check src/server.js && node --check public/typesetting.js`

Run: `npm test`

Run: `git diff --check c58f7cbcbe7a2985e5a4874e6776d231226da36c..HEAD`

Expected: output 聚焦测试 PASS；所有修改 JS 语法检查退出 0；全量测试 0 failure；diff check 无输出。

- [ ] **Step 5: 检查范围与最终产物**

Run: `git diff --name-only c58f7cbcbe7a2985e5a4874e6776d231226da36c..HEAD`

Expected: 只包含本计划 File Structure 中的文件，以及本 Issue 已批准的 `docs/research/2026-10-03-issue-7-open-source-reuse.md`、`docs/superpowers/specs/2026-10-03-copy-export-design.md` 和本计划文档；`src/article.js`、`src/exporter.js`、`public/app.js`、持久化 schema、`CONTEXT.md`、ADR 无变更。手工确认无 `execCommand`、`juiceResources`、`juiceFile`、preview `innerHTML` 复制或远程 fetch 进入输出路径。

- [ ] **Step 6: 提交来源与最终验收**

```bash
git add THIRD_PARTY_NOTICES.md test/typesetting-output.test.js test/typesetting-output-ui.test.js
git commit -m "docs: record typesetting output sources"
```

若 Step 4/5 证明必须修改生产文件，把对应文件一并加入该 fix commit，并在 commit message 中改用 `fix: harden typesetting output delivery`；不得把无关清理混入。

- [ ] **Step 7: Task 8 独立 review gate**

fresh reviewer 对照规格完成定义、研究文档、测试输出和 notice，返回 `PASS/REWORK`；`REWORK` 仍回交对应原 executor 修复并重跑全部检查。

- [ ] **Step 8: whole-branch review gate**

Task 8 PASS 后，再派未参与任一实现的 reviewer 审查 `c58f7cbcbe7a2985e5a4874e6776d231226da36c..HEAD`：规格一致性、安全、源码许可、测试质量、回归和非目标。只有 whole-branch `PASS`、全量 CI 通过且无未解决 review comment，Issue #7 才能进入 merge-ready；交付说明必须写明“尚未完成真实微信公众号编辑器兼容验收”。
