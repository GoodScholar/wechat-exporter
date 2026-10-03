# 格式检查、外链和图片诊断 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为公众号排版工作台增加严格、可定位且与当前正文版本绑定的三组格式诊断，并提供默认关闭、可持久化的外链转脚注能力和图片静态/动态失败占位。

**Architecture:** 将 Markdown 静态语义集中到新的 `src/typesetting-render.js` 深模块：每次调用独立生成安全 HTML、presentation、静态 diagnostics 与 blocked，浏览器仅整体校验并原子应用结果，再补充当前 DOM 的图片加载状态和本页富文本清理审计。脚注开关进入现有完整文稿、revision 与 current/recovery/manifest 原子事务；诊断、target、预览 HTML、图片状态和清理审计始终是非持久化派生状态。

**Tech Stack:** Node.js 22+、Express 5、Marked 18.0.14、sanitize-html 2.17.7、原生浏览器 JavaScript/CSS、Playwright 1.63.0、`node:test`。

**Spec:** `docs/superpowers/specs/2026-10-03-format-diagnostics-design.md`

## Global Constraints

- 只实现 GitHub Issue #6；不得进入 #7 的复制/下载流程或 #8 的完整三栏/移动布局改造。
- `src/typesetting-render.js` 是唯一静态渲染语义来源；`src/typesetting.js` 只保留文稿模型、严格校验和原子持久化，可为兼容现有调用者重导出 renderer。
- `POST /api/typesetting/render` 必须恰好接收 `body`、`theme`、`settings`、`convertExternalLinksToFootnotes` 四个顶层字段；合法响应也必须恰好返回 `html`、`presentation`、`diagnostics`、`blocked`。
- `convertExternalLinksToFootnotes` 是文稿级布尔字段，默认 `false`，与全文稿共用 revision、current、recovery、manifest 和一次原子提交；diagnostics、target、HTML、图片状态与 rich-text `removed` 审计均不得持久化或增加 revision。
- 诊断只允许规格中的 code/severity/meta/target 判别联合；所有层级对象拒绝额外键，`blocked === diagnostics.some(item => item.severity === 'blocker')` 是唯一阻断公式。
- 不定义无生产者的通用 `RICH_TEXT_DOWNGRADED`；特殊媒体、图片与 `removed` 只能映射到规格已声明的具体判别分支。
- 固定最小移植 `doocs/md@a7c17fc4cda92e3c13aa7e24f06615cfa4219b31`（WTFPL v2）的 `addFootnote()` 去重编号、`buildFootnoteArray()` / `buildFootnotes()` 输出结构及 `renderer.link()` 主流程；保留 `LICENSES/DOOCS-MD-WTFPL-2.txt`，在 `THIRD_PARTY_NOTICES.md` 记录复制函数、目标文件、修改范围和主动偏离。
- 只调用现有 `marked@18.0.14` 与 `sanitize-html@2.17.7` 的公开接口；不得复制它们的 parser/sanitizer 源码，不新增运行时依赖、前端框架、第二套 Markdown parser、第二套 sanitizer、图片上传器或懒加载状态机。
- 微信文章豁免仅限无凭据、无非默认端口的 `https://mp.weixin.qq.com/s` 或 `/s/...`；HTTP、其他路径、子域名、伪域名、userinfo 和非默认端口全部按普通外链处理。
- 只有无用户名/密码的绝对 HTTPS 图片可成为 pending `<img>`；不得升级 HTTP，不得为微信图片设协议或域名特例，不得回显危险 URL、data/blob 内容、完整本地路径、凭据或异常文本。
- 不修改 `src/article.js`、`src/exporter.js`、`public/app.js`、文章导出领域、复制/下载管线、根 `CONTEXT.md` 或 ADR。
- 所有集成 fixture 必须完全本地或由 Playwright 本地路由满足，不访问实时微信或第三方服务；测试断言结构与行为，不快照整页 HTML。

## Review Focus

- 畸形 200 或富文本转换结果包含额外键、重复 `removed`、未知 downgrade、错误 code/severity/meta 或越界 target 时，客户端必须保持正文、上一份完整预览和检查状态不变；由 Task 7、Task 8、Task 10 的严格 schema 测试固定。
- 已有非空成功预览后把正文改为空，而最新请求 pending、网络失败、非 2xx 或畸形 200 时，旧 HTML 只能作为 stale 参考，`renderFresh` 必须保持 false 且不能沿用旧 `blocked=false`；由 Task 8 的 freshness/竞态测试固定。
- URL parser 边界（大小写主机、显式默认 443、userinfo、非默认端口、伪域名、fragment 与链接文字等于 URL）不得误用微信豁免或错误合并脚注；由 Task 5 的完整 URL 矩阵测试固定。
- pending 图片在监听前已经 complete、或旧 preview 的 load/error 在新 preview 后到达时，必须正确得到当前 loaded/load-failed 状态且不得污染新 diagnostics；由 Task 9 的早发事件与 previewVersion 测试固定。
- 短生命周期 `removed` 审计必须精确绑定实际插入 UTF-16 范围：正文真实变化时清除，主题/脚注/图片状态及 body 未变化的保存水合时保留，失败/过期转换不得替换；由 Task 10 的审计生命周期测试固定。

---

### Task 1: 将外链脚注开关纳入原子文稿模型

**Files:**
- Modify: `src/typesetting.js:7-154`
- Modify: `test/typesetting.test.js:23-318`

**Interfaces:**
- Extends: `TypesettingStore.load() -> Promise<TypesettingDocument>` 与 `TypesettingStore.save(input) -> Promise<TypesettingDocument>` 的文稿对象，新增 `convertExternalLinksToFootnotes: boolean`。
- Preserves: `createDefaultThemeSettings()`、`normalizeTypesettingPresentation(value)`、revision 冲突、幂等 no-op、current/recovery/manifest 提交顺序。
- Produces: `emptyDocument()` 与旧文稿规范化结果中的开关固定为 `false`；提供该字段时只接受布尔值。

- [ ] **Step 1: 写失败的文稿迁移、严格校验和原子性测试**

在 `test/typesetting.test.js` 添加：

- `旧文稿默认关闭外链脚注并在下次保存后跨重启持久化`
- `外链脚注开关参与内容相等、revision 冲突和幂等判断`
- `外链脚注开关写入任一提交阶段失败时旧值仍唯一可见`

核心断言：

```js
assert.equal(legacy.convertExternalLinksToFootnotes, false);
assert.equal(legacy.revision, 0);
const saved = await store.save({ ...legacy, convertExternalLinksToFootnotes: true, revision: 1 });
assert.equal(saved.revision, 1);
await assert.rejects(store.save({ ...saved, convertExternalLinksToFootnotes: false, revision: 1 }), error => error.status === 409);
await assert.rejects(store.save({ ...saved, convertExternalLinksToFootnotes: 'true', revision: 2 }), error => error.status === 400);
assert.equal((await restarted.load()).convertExternalLinksToFootnotes, false); // 每个注入失败阶段仍只暴露旧值
```

覆盖缺字段旧 current/recovery/legacy 主备文件、显式非布尔值、同 revision 仅开关不同、完整相同 no-op，以及 current-version、recovery-version、manifest 三个失败点。

- [ ] **Step 2: 运行聚焦测试确认 RED**

Run: `node --test --test-name-pattern='旧文稿默认关闭外链脚注|外链脚注开关参与|外链脚注开关写入' test/typesetting.test.js`

Expected: FAIL，因为当前文稿 shape、严格校验和 `sameContent` 均没有该字段。

- [ ] **Step 3: 最小实现文稿字段**

在 `src/typesetting.js`：

- 让 `emptyDocument()` 返回 `convertExternalLinksToFootnotes: false`；
- `normalizeDocument(value)` 对缺字段旧文稿补 `false`，对存在字段要求 `typeof value.convertExternalLinksToFootnotes === 'boolean'`；
- 将该布尔值加入 `sameContent`，但不改变 revision、savedAt、版本文件、manifest、恢复与清理算法；
- 保持正文、主题、三套设置与开关仍序列化在同一个文稿 JSON 中。

- [ ] **Step 4: 运行 GREEN 与现有存储回归**

Run: `node --test --test-name-pattern='排版文稿|主题|recovery|manifest|外链脚注开关|旧文稿默认关闭' test/typesetting.test.js test/typesetting-import.test.js`

Expected: 所选测试 PASS，现有 atomic current/recovery 语义不变。

- [ ] **Step 5: 提交文稿模型里程碑**

```bash
git add src/typesetting.js test/typesetting.test.js
git commit -m "feat: persist external link footnote setting"
```

### Task 2: 导入路径保留脚注开关

**Files:**
- Modify: `src/typesetting-import.js:3-75`
- Modify: `test/typesetting-import.test.js:28-204`

**Interfaces:**
- Consumes: Task 1 完整 `TypesettingDocument`。
- Preserves: `importTypesettingDocument({ typesetting, fetchArticle, url, revision, confirmed })` 签名和 typed error。
- Changes: 成功导入 candidate 除 `theme`、`themeSettings` 外显式复制 `current.convertExternalLinksToFootnotes`。

- [ ] **Step 1: 写失败的导入保留测试**

添加 `文章导入成功失败冲突和原子恢复均保留外链脚注开关`。先保存开关为 `true` 的文稿，再分别执行成功导入、未确认替换、抓取失败、revision 冲突和三类持久化故障；断言每次可见文稿的开关都仍为 `true`，成功导入只替换正文与元信息。

- [ ] **Step 2: 运行聚焦测试确认 RED**

Run: `node --test --test-name-pattern='文章导入成功失败冲突和原子恢复均保留' test/typesetting-import.test.js`

Expected: FAIL，因为当前 candidate 未携带开关，会被规范化为 `false`。

- [ ] **Step 3: 在导入 candidate 中复制当前开关**

只修改 `src/typesetting-import.js` 的 candidate 构造：增加 `convertExternalLinksToFootnotes: current.convertExternalLinksToFootnotes`；不改变抓取、解析、revision 或错误映射。

- [ ] **Step 4: 运行 GREEN 与全部导入测试**

Run: `node --test test/typesetting-import.test.js`

Expected: PASS。

- [ ] **Step 5: 提交导入保留里程碑**

```bash
git add src/typesetting-import.js test/typesetting-import.test.js
git commit -m "fix: preserve footnote setting during import"
```

### Task 3: 富文本图片生成持久规范占位与结构化事实

**Files:**
- Modify: `src/rich-text.js:18-160`
- Modify: `test/rich-text.test.js:21-205`

**Interfaces:**
- Preserves: `convertRichText(html) -> { markdown, removed, downgraded, block }` 与现有 `RichTextError`。
- Extends: `StructuredDowngrade`，允许 `{ type: 'image', reason: 'local-binary' | 'local-path' | 'unsupported-scheme' | 'missing-source' }`，禁止原始来源字段。
- Produces: 四种固定 Markdown 图片占位语法；alt 经折叠空白、去换行、最多 200 个 Unicode code point、Markdown 控制字符转义后才可追加。

- [ ] **Step 1: 写失败的图片分类、占位安全与审计测试**

添加：

- `富文本图片按 HTTPS 本地二进制本地路径不支持协议和缺失来源分类`
- `富文本图片占位保留安全截断 alt 但不泄漏来源`
- `富文本 removed 固定去重排序且现有特殊媒体结构保持严格`

用同一 HTML 覆盖 HTTPS、HTTP、协议相对、`file:///tmp/a.png`、`/tmp/a.png`、`C:\\a.png`、`./a.png`、`~/a.png`、`data:image/...`、`blob:...`、空/缺失 `src`。断言只有 HTTPS 留作 Markdown image；其余每个只产生一个规范 blockquote 与一个 image downgrade，正文和 JSON 中均不出现原 URL/path/data/blob；`removed` 精确按 `script, style, form, event-handler, unsafe-url` 的固定枚举顺序去重。

- [ ] **Step 2: 运行聚焦测试确认 RED**

Run: `node --test --test-name-pattern='富文本图片按|富文本图片占位|富文本 removed' test/rich-text.test.js`

Expected: FAIL，因为当前非法图片被静默删除且没有 image downgrade。

- [ ] **Step 3: 最小实现图片替换与固定审计顺序**

在 `src/rich-text.js` 内新增私有图片分类/alt/占位 helper，并在 `sanitize-html` 剥离来源前完成替换：

- 无凭据绝对 HTTPS 保留；
- data/blob → `local-binary`；file/绝对、相对、Windows、`~` 路径 → `local-path`；HTTP、协议相对、其他 scheme → `unsupported-scheme`；空/缺失 → `missing-source`；
- 图片 placeholder 只写固定文案与安全 alt；
- 每张被替换图片只追加一个 `{ type: 'image', reason }`；
- 先把顶层特殊媒体整体替换为一个规范占位，再分类其余图片，确保媒体内部 thumbnail/子资源不额外产生 image downgrade；
- 返回前按固定安全枚举排列并去重 `removed`，保持现有特殊媒体顶层去重、安全来源与 typed error 行为。

- [ ] **Step 4: 运行 GREEN 与全部富文本测试**

Run: `node --test test/rich-text.test.js`

Run: `node --check src/rich-text.js`

Expected: 测试 PASS，语法检查退出 0。

- [ ] **Step 5: 提交富文本占位里程碑**

```bash
git add src/rich-text.js test/rich-text.test.js
git commit -m "feat: preserve unpublishable rich text images"
```

### Task 4: 建立深渲染模块、严格诊断骨架与失败 seam

**Files:**
- Create: `src/typesetting-render.js`
- Create: `test/typesetting-diagnostics.test.js`
- Modify: `src/typesetting.js:1-6,157-167`
- Modify: `src/server.js:12,76-80`
- Modify: `test/typesetting.test.js:9,55-110`

**Interfaces:**
- Produces: `createTypesettingRenderer({ parseMarkdown } = {}) -> renderTypesettingMarkdown`。
- Produces: `renderTypesettingMarkdown({ body, presentation, convertExternalLinksToFootnotes }) -> { html, presentation, diagnostics, blocked }`。
- Defines test seam: `parseMarkdown(body, options) -> string`，默认 adapter 调用现有 Marked 公开 parse API；测试可注入抛错 adapter，生产调用者不接触任何私有 helper。
- Compatibility: `src/typesetting.js` 重导出 `createTypesettingRenderer` 与 `renderTypesettingMarkdown`，现有 imports 无需一次性迁移。
- Transitional integration: Task 7 冻结四键 HTTP 之前，`src/server.js` 仍接受现有三键请求，但在调用深模块时显式组装对象参数并传 `convertExternalLinksToFootnotes: false`，保证每个中间提交可运行。

- [ ] **Step 1: 写失败的 RenderResult、空正文、失败与隔离测试**

在新测试文件添加：

- `深渲染接口只返回四键 RenderResult 且 blocked 严格等价于 blocker`
- `空字符串和全空白正文返回 EMPTY_BODY 与 source 0 到 0`
- `可控 parse 异常返回安全 RENDER_FAILED 且不泄漏异常`
- `多次渲染不继承 diagnostic id target 或内部状态`

关键断言：

```js
assert.deepEqual(Object.keys(result).sort(), ['blocked', 'diagnostics', 'html', 'presentation']);
const [diagnostic] = empty.diagnostics;
assert.equal(diagnostic.code, 'EMPTY_BODY');
assert.equal(diagnostic.severity, 'blocker');
assert.ok(diagnostic.id.length > 0 && diagnostic.message.length > 0);
assert.deepEqual(diagnostic.targets, [{ kind: 'source', start: 0, end: 0 }]);
assert.equal(failed.blocked, true);
assert.doesNotMatch(failed.html + JSON.stringify(failed.diagnostics), /sentinel stack|\/Users\//);
assert.equal(result.blocked, result.diagnostics.some(item => item.severity === 'blocker'));
```

测试应按结构断言安全固定文案，不依赖私有 helper 名称；ID 只需在单次结果内唯一，不要求跨调用稳定。

- [ ] **Step 2: 运行新测试确认 RED**

Run: `node --test test/typesetting-diagnostics.test.js`

Expected: FAIL，因为模块不存在。

- [ ] **Step 3: 实现最小深模块与 factory**

- 从 `src/typesetting.js` 移出 Marked/sanitize-html 渲染代码；该文件只重导出公开 renderer；
- 在 `src/typesetting-render.js` 严格校验对象参数、body 字符串、presentation 与布尔开关；
- 先完成输入校验，再只捕获合法输入的 parse/sanitize/post-process 异常，避免把非法请求伪装成 blocker；
- 每次 render 创建局部 diagnostic/target/footnote 状态；
- 空正文返回 `html: ''`、`EMPTY_BODY`、`blocked: true`；
- 捕获合法输入在 parse/sanitize/post-process 中的异常，返回不含异常内容的可见安全失败占位、全文 `[0, body.length]` source target、`RENDER_FAILED` 与 `blocked: true`；
- 非空正常正文先维持当前 Marked → 最终 sanitize-html 行为，并返回空 diagnostics、`blocked: false`；
- 最终 sanitizer 仅开放后续脚注/占位需要的精确标签、class 与属性，不开放任意 style、`data-*` 或事件属性。
- 临时把现有三键 `/render` handler 改为调用 `renderTypesettingMarkdown({ body, presentation, convertExternalLinksToFootnotes: false })`；不在本 Task 提前改变 HTTP 入参契约。

- [ ] **Step 4: 运行 GREEN、现有主题渲染回归和语法检查**

Run: `node --test test/typesetting-diagnostics.test.js`

Run: `node --test --test-name-pattern='三套主题对代表性|预览 presentation|预览 API' test/typesetting.test.js`

Run: `node --check src/typesetting-render.js && node --check src/typesetting.js`

Expected: 全部 PASS/退出 0。

- [ ] **Step 5: 提交渲染边界里程碑**

```bash
git add src/typesetting-render.js src/typesetting.js src/server.js test/typesetting-diagnostics.test.js test/typesetting.test.js
git commit -m "refactor: isolate typesetting renderer"
```

### Task 5: 最小移植 doocs 脚注算法并重建特殊内容诊断

**Files:**
- Modify: `src/typesetting-render.js`
- Modify: `test/typesetting-diagnostics.test.js`
- Modify: `THIRD_PARTY_NOTICES.md:3-28`
- Modify: `test/typesetting.test.js:123-135`
- Verify unchanged: `LICENSES/DOOCS-MD-WTFPL-2.txt`

**Interfaces:**
- Consumes: Task 4 的单次 render 局部状态与 RenderResult。
- Produces: 每个规范化普通 URL 一条 `EXTERNAL_LINK_TO_FOOTNOTE`，`targets: PreviewTarget[]`，`meta: { footnote: positiveInteger, occurrences: positiveInteger }`。
- Produces: 每个完整规范媒体 blockquote 一条 `SPECIAL_CONTENT_PLACEHOLDER`，`meta.type` 只允许 `video | audio | embed | mini-program | poll`。
- Preserves: body 字节不变；关闭开关时无尾注/脚注 conversion；特殊内容来源不参与脚注。

- [ ] **Step 1: 写失败的脚注、微信例外、特殊占位与 notice 测试**

添加：

- `外链脚注按规范化 URL 和首次出现去重聚合全部 targets`
- `链接文字等于 URL 仍生成尾注且关闭开关不改变链接或正文`
- `微信公众号文章链接只豁免严格 HTTPS 主机文章路径和无凭据端口`
- `特殊内容完整规范块重建单条 conversion 且来源不进入脚注`
- `脚注与特殊占位经过最终清理且多次 render 编号重置`
- 扩展 notice 测试为 `第三方说明记录主题与 doocs 脚注最小移植来源许可和偏离`

URL fixture 必须含：重复普通 URL、另一 URL、同 URL 带 fragment、`mailto:`、合法 `/s`、合法 `/s/...`、大写主机、显式 `:443`、HTTP 微信链接、其他微信页面、userinfo、非默认端口、子域名、`mp.weixin.qq.com.evil.test`、链接文字等于 href。断言 `new URL(href).href` 相同才去重，fragment 不删除，普通 URL 首次出现顺序从 1 编号。

- [ ] **Step 2: 运行聚焦测试确认 RED**

Run: `node --test --test-name-pattern='外链脚注按|链接文字等于|微信公众号文章链接|特殊内容完整规范块|脚注与特殊占位|doocs 脚注最小移植' test/typesetting-diagnostics.test.js test/typesetting.test.js`

Expected: FAIL，因为 renderer 尚无脚注与特殊块语义，notice 仍写着未复制源码。

- [ ] **Step 3: 仅移植允许的 doocs 小算法并做本地安全适配**

在 `src/typesetting-render.js`：

- 仅以局部数组/Map 适配 doocs `addFootnote()` 的“首次编号、重复复用”，并借用 `buildFootnoteArray()` / `buildFootnotes()` 的尾注结构与 `renderer.link()` 的“先微信例外、后普通外链”流程；
- 不复制 Vue、Pinia、完整 renderer、上传、DOMPurify、`markedFootnotes()` 或复制管线；
- 使用 URL parser 精确判定微信例外，拒绝前缀正则；去重键固定为 `new URL(href).href`；裸 URL/autolink 也走脚注；
- 用 Marked 公开 renderer 生成安全链接/引用 target，尾注、标题与 URL 先显式转义，再进入统一 final sanitizer；
- 在 blockquote token 层只匹配完整单段规范特殊内容块，安全来源继续可点击但绕过脚注 renderer；嵌套/局部文本不误判；
- 每个 conversion 创建唯一受控 `data-format-target` 和严格 meta。

在 `THIRD_PARTY_NOTICES.md` 删除 “No upstream source file is copied or vendored”，记录固定 SHA、上游三个函数/主流程、目标 `src/typesetting-render.js`、URL parser/裸 URL/统一 sanitizer 等主动偏离；保留既有主题说明和 WTFPL 文件。

- [ ] **Step 4: 运行 GREEN 与安全回归**

Run: `node --test --test-name-pattern='外链脚注|链接文字等于|微信公众号文章链接|特殊内容|第三方说明' test/typesetting-diagnostics.test.js test/typesetting.test.js`

Run: `node --check src/typesetting-render.js && git diff --check && git diff --exit-code -- LICENSES/DOOCS-MD-WTFPL-2.txt`

Expected: 所选测试 PASS；notice 不再声称未复制；语法/diff 检查退出 0。

- [ ] **Step 5: 提交合规脚注里程碑**

```bash
git add src/typesetting-render.js test/typesetting-diagnostics.test.js test/typesetting.test.js THIRD_PARTY_NOTICES.md
git commit -m "feat: add audited external link footnotes"
```

### Task 6: 在深渲染器中统一图片静态分类与安全占位

**Files:**
- Modify: `src/typesetting-render.js`
- Modify: `test/typesetting-diagnostics.test.js`

**Interfaces:**
- Consumes: Task 4 RenderResult 与 Task 3 四种规范图片 placeholder。
- Produces: 合法 HTTPS `<img src referrerpolicy="no-referrer" data-image-state="pending" data-format-target>`。
- Produces: `IMAGE_UNSUPPORTED_SCHEME | IMAGE_LOCAL_PATH | IMAGE_LOCAL_BINARY | IMAGE_MISSING_SOURCE` advisory；每个不可用图片恰好一个 preview target、一条 diagnostic、一个原位可聚焦占位。

- [ ] **Step 1: 写失败的 Markdown/raw HTML 全分类测试**

添加：

- `Markdown 与 raw HTML 图片使用相同的严格静态分类`
- `HTTPS 及微信 HTTPS 图片保留 pending no-referrer target 且无静态错误`
- `不可发布图片原位占位可聚焦且不泄漏来源或发起请求`
- `规范富文本图片占位刷新后重建唯一 advisory`
- `图片 alt 折叠截断转义后仍不能突破 sanitizer`

两条路径都覆盖 HTTPS、带凭据 HTTPS、HTTP、协议相对、file、Unix 绝对/相对、Windows、`~`、data、blob、空/缺失 src；断言 diagnostics 的 exact keys/code/severity/targets、target 单次唯一、占位固定文案和 `blocked === false`。`mmbiz.qpic.cn` 只按普通 HTTPS 规则处理，HTTP 微信图不得升级。

- [ ] **Step 2: 运行聚焦测试确认 RED**

Run: `node --test --test-name-pattern='Markdown 与 raw HTML 图片|HTTPS 及微信 HTTPS|不可发布图片|规范富文本图片占位|图片 alt' test/typesetting-diagnostics.test.js`

Expected: FAIL，因为当前 sanitizer 会剥离/静默删除部分来源，且没有图片诊断与占位。

- [ ] **Step 3: 通过公开 renderer/transform API 实现一次分类**

- Markdown image 只通过 Marked 18 renderer API 分类；raw HTML `<img>` 只通过 `sanitize-html` 的 `transformTags`/`onOpenTag` 等公开接口，在 URL 被剥离前分类；
- 两条路径调用同一私有分类/占位事实，不用正则改写最终 HTML；
- 支持来源直接变为安全 `figure`/等价可见占位，带 `role="note"`、`tabindex="0"` 和原图片 target，不保留 `src`；
- HTTPS 图片带明确 pending/referrerpolicy/target；final sanitizer 只允许这些精确属性和值；
- 识别 Task 3 的完整规范图片 blockquote，使重启/刷新仍生成同 code advisory，不对普通正文子串猜测。

- [ ] **Step 4: 运行 GREEN 与全部纯渲染测试**

Run: `node --test test/typesetting-diagnostics.test.js`

Run: `node --check src/typesetting-render.js`

Expected: PASS/退出 0。

- [ ] **Step 5: 提交静态图片里程碑**

```bash
git add src/typesetting-render.js test/typesetting-diagnostics.test.js
git commit -m "feat: diagnose static image sources"
```

### Task 7: 严格接线 `/render`、可注入失败 renderer 与页面策略

**Files:**
- Modify: `src/server.js:12-19,30-80,130-139`
- Modify: `public/typesetting.html:3`
- Modify: `public/typesetting.js:9-10,32-41,71-87`
- Modify: `test/typesetting-diagnostics.test.js`
- Modify: `test/typesetting-import.test.js:466-473`
- Modify: `test/typesetting.test.js:55-110,144-186`
- Modify: `test/rich-text.test.js:131-153`

**Interfaces:**
- Changes: `createApp({ ..., typesettingRenderer = renderTypesettingMarkdown } = {})`。
- Consumes: Task 4 的对象参数 renderer。
- Changes: `POST /api/typesetting/render` 只接受四键请求，并只返回四键 RenderResult。
- Changes transitional browser request: 工作台在 Task 8 增加可见开关前，先从已水合文稿读取布尔值并发送第四键；现有 `html/presentation` 原子应用继续可运行。
- Preserves: 其他页面 CSP `img-src 'self' data:`；排版页专用 CSP 改为 `img-src 'self' https:`，继续设置 `Referrer-Policy: no-referrer`。

- [ ] **Step 1: 写失败的真实 HTTP strict schema、失败 seam 与 header 测试**

添加：

- `渲染 HTTP 恰好接受四键并拒绝全部缺失额外和类型错误`
- `渲染 HTTP 注入失败 renderer 返回安全 RENDER_FAILED 而非 400`
- `非法渲染请求不改变内存或磁盘文稿`
- `仅排版页 CSP 允许 self 与 HTTPS 图片并拒绝 http data blob`

对 body/theme/settings/开关逐一测试缺失、额外键、错误类型与非法枚举；成功响应断言 exact top-level keys。注入 `createTypesettingRenderer({ parseMarkdown: () => { throw new Error('internal sentinel /Users/...'); } })`，断言 HTTP 200 blocker 且 body/response 不含 sentinel。排版页还断言 `Referrer-Policy: no-referrer`，普通导出页策略不扩大。

- [ ] **Step 2: 运行聚焦测试确认 RED**

Run: `node --test --test-name-pattern='渲染 HTTP|非法渲染请求|仅排版页 CSP' test/typesetting-diagnostics.test.js test/typesetting-import.test.js`

Expected: FAIL，因为 server 仍使用三键契约、不可注入 renderer，排版 CSP 仍允许 data 且 favicon 为 data URL。

- [ ] **Step 3: 完成最薄应用组装**

- `src/server.js` 从 `src/typesetting-render.js` 导入默认 renderer，并为 `createApp` 增加可选 adapter；
- 在调用 renderer 前用 exact-key 与现有 presentation validator 验证四键输入，所有非法请求返回 400 且不调用 store/renderer；
- 合法渲染内部失败由 renderer 自己转为当前 200 RenderResult；
- 在 `public/typesetting.js` 的默认 document/完整文稿校验中加入布尔字段，并让现有 preview 请求发送第四键；此处不提前实现诊断面板或可见 toggle；
- 把既有直接 `/render` 测试 fixture 全部补上显式布尔第四键，不能用 server 默认值掩盖契约；
- 排版页专用 CSP 只允许 `self https:` 图片，普通页面保留原 CSP；
- 删除 `public/typesetting.html` 的 data favicon（不为它放宽策略）。

- [ ] **Step 4: 运行 GREEN、相关 HTTP 回归和语法检查**

Run: `node --test test/typesetting-diagnostics.test.js test/typesetting-import.test.js test/rich-text.test.js`

Run: `node --test --test-name-pattern='工作台切换|慢的旧预览|自动保存' test/typesetting.test.js`

Run: `node --check src/server.js && node --check src/typesetting-render.js`

Expected: PASS/退出 0。

- [ ] **Step 5: 提交 HTTP 边界里程碑**

```bash
git add src/server.js public/typesetting.html public/typesetting.js test/typesetting-diagnostics.test.js test/typesetting-import.test.js test/typesetting.test.js test/rich-text.test.js
git commit -m "feat: expose strict diagnostics render API"
```

### Task 8: 原子应用 RenderResult、三组检查、定位与脚注开关 UI

**Files:**
- Create: `test/typesetting-diagnostics-ui.test.js`
- Modify: `public/typesetting.html:6`
- Modify: `public/typesetting.js:1-139,202-228`
- Modify: `public/style.css:10`
- Modify: `public/typesetting-theme.css:1-55`

**Interfaces:**
- Consumes: 四键 `/render` 与完整文稿 `convertExternalLinksToFootnotes`。
- Produces internal state: `renderFresh: boolean`、`renderBlocked: boolean`、`appliedRenderVersion: number`、当前静态 diagnostics 与请求输入 snapshot。
- Produces private validators: `isValidRenderResult(value, body) -> boolean`、`isValidDiagnostic(value, body, detachedPreview) -> boolean`；所有对象 exact-key 校验，code 决定 severity/target/meta shape。
- Produces UI: `#convert-external-links`、`#render-status`、固定 `#format-checks` 三组及每组 count/list；条目使用 button 定位第一 target。

- [ ] **Step 1: 写失败的 UI strict schema、分组、定位、freshness 与持久化测试**

添加：

- `格式检查始终显示三组数量空状态并支持 source 与 preview 键盘定位`
- `客户端只在完整严格 RenderResult 合法时原子应用 HTML presentation diagnostics blocked`
- `输入变化立即标记正在重新检查且网络非二百和畸形响应只保留 stale 参考`
- `非空成功后正文改为空时旧 blocked false 不得在 pending 或失败期间变为当前`
- `脚注开关即时刷新预览并经单次 500ms 自动保存跨刷新重启恢复`
- `脚注开关快速双切换最终回原值仍只串行提交一次并增长一次 revision`
- `格式检查与定位在键盘 reduced-motion 和 390px 窄屏下可操作`

畸形矩阵覆盖额外顶层/嵌套键、重复 diagnostic id、空 targets、越界 source、不存在或不唯一的 preview target、code/severity 不匹配、meta 缺失/多余、`blocked` 与 blocker 不一致、presentation 不完整。另用 blocker/conversion/advisory 同时存在的合法结果断言三组都保持可见。定位断言 source 使用 UTF-16 半开范围 `setSelectionRange(start,end)`；preview 只在 `#preview [data-format-target]` 中按属性值精确匹配，调用 scroll/focus 并加临时高亮。

- [ ] **Step 2: 运行 UI 测试确认 RED**

Run: `node --test test/typesetting-diagnostics-ui.test.js`

Expected: FAIL，因为页面没有控件/检查区，客户端请求仍缺第四键且没有 strict diagnostic/freshness 状态。

- [ ] **Step 3: 实现文稿开关与 strict 原子 render 状态机**

在 `public/typesetting.js`：

- 将开关加入默认 document、`isCompleteDocument`、hydrate、collect/save 与 500ms dirty 流程；开关变化立即 `renderFresh=false`、schedule preview/save；导入期间与其他控件一起禁用并恢复；
- `/render` 请求携带 body/theme/current settings/布尔开关与不可变 snapshot；只有最新 version 且 snapshot 仍等于当前输入的成功响应可继续；
- 先把 `html` 放入 detached 容器，完整验证 exact RenderResult、diagnostic 判别联合、id 唯一、source 边界、preview target 对应节点和 blocked 公式，再一次性替换 HTML/presentation/静态 diagnostics/blocked/version 并设 fresh；
- pending、网络错误、非 2xx、JSON/strict schema 失败或过期响应都不部分应用，保留旧 DOM 但显示“预览不是当前内容”，保持 `renderFresh=false`；
- 三组始终渲染固定标题、数量与“暂无”；diagnostic button 聚焦 source 或当前 preview 第一个 target，preview 查找不得拼接任意 selector；
- 导入/成功水合仅在完整文稿 strict 合法时原子应用开关，不引入单独设置文件。

在 HTML/CSS 中加入有 label、键盘焦点和 status 的最小 UI；高亮动画只置于 `prefers-reduced-motion: no-preference`，窄屏仅保证控件和列表可操作，不实现 #8 布局。

- [ ] **Step 4: 运行 GREEN、既有 autosave/import/theme 回归和语法检查**

Run: `node --test test/typesetting-diagnostics-ui.test.js`

Run: `node --test --test-name-pattern='自动保存|并发保存|慢的旧预览|畸形的预览|文章导入和富文本|窄屏' test/typesetting.test.js test/typesetting-import.test.js`

Run: `node --check public/typesetting.js`

Expected: PASS/退出 0。

- [ ] **Step 5: 提交 UI 基础里程碑**

```bash
git add public/typesetting.html public/typesetting.js public/style.css public/typesetting-theme.css test/typesetting-diagnostics-ui.test.js
git commit -m "feat: add format diagnostics workbench"
```

### Task 9: 绑定当前 previewVersion 的图片加载状态与失败占位

**Files:**
- Modify: `public/typesetting.js`
- Modify: `public/typesetting-theme.css:1-55`
- Modify: `test/typesetting-diagnostics-ui.test.js`

**Interfaces:**
- Consumes: Task 8 当前成功 preview version、静态 diagnostics 与受控 pending `<img>`。
- Produces private behavior: `attachPendingImageHandlers(previewRoot, version)`、`settleImage(img, version)`；loaded 只更新 `data-image-state`，failed 用同 target 原位替换占位并加入一条 `IMAGE_LOAD_FAILED` advisory。
- Preserves: 静态 diagnostics 不由浏览器重算；动态 diagnostics 只与当前静态结果合并展示，不修改 server `blocked`。

- [ ] **Step 1: 写失败的真实图片状态、早发事件、无 Referer 与竞态测试**

添加：

- `本地 HTTPS 图片成功加载为 loaded 且请求不含 Referer`
- `HTTPS 404 或中断在相同 target 原位变为可定位 load-failed advisory`
- `监听注册后立即处理 complete naturalWidth 避免缓存早发事件`
- `旧 preview 图片 load error 和过期响应不能污染新 HTML diagnostics blocked target`
- `静态不支持图片不发起网络请求且全部图片问题保持非阻断`

使用 `page.route('https://fixture.invalid/**')` 返回内存 1×1 PNG、404 或中断并记录请求头，作为固定本地 HTTPS fixture；不得访问真实网络。对早发状态用页面内可控 image property/event seam；断言失败占位保留原 `data-format-target`、`role="note"`、`tabindex="0"`，不含完整 URL。

- [ ] **Step 2: 运行聚焦 UI 测试确认 RED**

Run: `node --test --test-name-pattern='本地 HTTPS 图片|HTTPS 404|监听注册后|旧 preview 图片|静态不支持图片' test/typesetting-diagnostics-ui.test.js`

Expected: FAIL，因为客户端没有 pending image listeners 或动态 advisory。

- [ ] **Step 3: 实现当前版本专属原生图片状态机**

- 每次原子应用成功 RenderResult 后，仅对该 DOM 中 `data-image-state="pending"` 的图片注册一次 `load`/`error`；注册后立即检查 `complete` 与 `naturalWidth`；
- `load && naturalWidth > 0` → loaded、无诊断；`error` 或 `complete && naturalWidth === 0` → 同 target 安全原位占位 + 唯一 `IMAGE_LOAD_FAILED`；
- 每个 callback 先核对 `version === appliedRenderVersion`、节点仍属于当前 preview、target 仍对应当前节点；旧事件静默丢弃；
- 动态诊断 ID 与服务端/富文本 ID 在当前合并列表唯一，severity 固定 advisory，不改变 `renderBlocked`；
- 清理已结算节点 listeners，避免重复事件或诊断。

- [ ] **Step 4: 运行 GREEN 与全部 diagnostics UI 测试**

Run: `node --test test/typesetting-diagnostics-ui.test.js`

Run: `node --check public/typesetting.js`

Expected: PASS/退出 0。

- [ ] **Step 5: 提交动态图片里程碑**

```bash
git add public/typesetting.js public/typesetting-theme.css test/typesetting-diagnostics-ui.test.js
git commit -m "feat: surface runtime image failures"
```

### Task 10: 合并富文本 removed 审计、二进制粘贴与最终竞态回归

**Files:**
- Modify: `public/typesetting.js:140-228`
- Modify: `public/style.css:10`
- Modify: `test/typesetting-diagnostics-ui.test.js`
- Modify: `test/typesetting.test.js:699-951`
- Modify: `test/typesetting-import.test.js:322-465`

**Interfaces:**
- Consumes: Task 3 strict rich-text result、Task 8/9 诊断合并与当前 body/changeVersion。
- Produces private validator: `isValidRichTextResult(value) -> boolean`，严格校验 exact top-level、唯一且属于固定枚举的 `removed`、每个 exact `StructuredDowngrade`，以及特殊媒体可选的无凭据 HTTP/HTTPS `sourceUrl`；图片 downgrade 禁止 `sourceUrl`；生成 diagnostic 时再按固定枚举顺序排列 `meta.types`。
- Produces: 每次成功富文本插入最多一条 `UNSAFE_RICH_TEXT_REMOVED`，`targets: [{ kind: 'source', start, end }]`，`meta.types` 为固定去重顺序。
- Produces: image `File` paste 固定插入 local-binary blockquote，不创建 blob URL，沿用 `execCommand('insertText')` 原生撤销路径。

- [ ] **Step 1: 写失败的 strict conversion、审计生命周期、二进制粘贴与导入竞态测试**

添加：

- `富文本 removed 合并为单条 conversion 并定位实际插入 UTF-16 范围`
- `富文本审计仅在人工或成功正文替换时清除且非正文变化继续保留`
- `成功下一次粘贴替换旧审计而失败过期选区正文竞态保持原审计`
- `客户端拒绝额外键重复 removed 未知 downgrade 和不安全 sourceUrl`
- `剪贴板 image File 插入 local-binary 规范占位支持原生撤销且不创建 blob URL`
- `成功导入清除审计而失败导入冲突及 body 未变化水合保留审计和脚注开关`
- `导入期间脚注开关禁用恢复且成功失败都保留原选择`

实际插入范围必须包括 `preserveBlockBoundaries()` 为块边界补的换行。生命周期矩阵：人工 body input、成功导入、body 实际变化的 hydrate/recovery、下一次成功 paste 清除；主题/主题设置/脚注 toggle、图片 load/error、纯 rerender、body 相同的普通保存响应保留。失败转换、旧响应、选区变化、正文变化、插入失败均不改变正文、文稿字段、既有检查或审计。

扩展测试 helper 以构造含 `new File([...], 'paste.png', { type: 'image/png' })` 的 `DataTransfer`；spy `URL.createObjectURL` 保证调用次数为 0；撤销快捷键继续复用现有宿主平台 helper。

- [ ] **Step 2: 运行聚焦测试确认 RED**

Run: `node --test --test-name-pattern='富文本 removed|富文本审计|成功下一次粘贴|客户端拒绝额外键|剪贴板 image File|成功导入清除审计|导入期间脚注开关' test/typesetting-diagnostics-ui.test.js test/typesetting.test.js test/typesetting-import.test.js`

Expected: FAIL，因为客户端目前只显示瞬时计数，不严格校验 rich result、不保留 audit，也不优先处理 clipboard image File。

- [ ] **Step 3: 实现最小审计合并与二进制 paste**

- 在应用转换前 strict 校验完整 result；未知/重复/额外/不安全字段一律当作畸形失败，不插入、不改状态；
- 在 `execCommand('insertText')` 成功后，用实际插入字符串长度计算 UTF-16 `[start,end)`，先清除旧 audit，再仅在 `removed.length > 0` 时创建一条新 conversion；不为被移除内容写正文占位；
- 将 audit 作为第三层 diagnostics 合并：静态 server + 当前动态图片 + 当前 rich audit；合并时保证 ID 唯一但不持久化/不跨 body 版本猜测重定位；
- 把“应用新 body”集中到一个最小私有路径：只有实际 body 变化且成功应用才原子清 audit；人工 input 立即清除；非正文状态变化不清除；
- paste handler 首先检测 `clipboardData.files` 中 image File，阻止默认并通过现有原生插入路径插入固定 local-binary 规范块；不得读取二进制、生成 data/blob URL 或走 rich endpoint；
- 导入锁定/恢复开关；成功导入应用新 body 并清审计，失败/冲突不改任何状态。

- [ ] **Step 4: 运行 GREEN、全套相关集成和语法检查**

Run: `node --test test/typesetting-diagnostics-ui.test.js test/typesetting.test.js test/typesetting-import.test.js test/rich-text.test.js test/typesetting-diagnostics.test.js`

Run: `node --check public/typesetting.js && node --check src/rich-text.js`

Expected: PASS/退出 0。

- [ ] **Step 5: 提交富文本审计与集成里程碑**

```bash
git add public/typesetting.js public/style.css test/typesetting-diagnostics-ui.test.js test/typesetting.test.js test/typesetting-import.test.js
git commit -m "feat: merge rich text conversion audits"
```

## AC Coverage Map

| Acceptance criterion | Implementing tasks | Primary evidence |
| --- | --- | --- |
| AC-01 三组诊断、严格 target、键盘定位、旧响应/stale | Tasks 4, 8, 9, 10 | `test/typesetting-diagnostics.test.js` schema/ID tests；`test/typesetting-diagnostics-ui.test.js` 分组、source/preview 定位、freshness 与竞态 tests |
| AC-02 blocker 与非阻断公式 | Tasks 4, 5, 6, 7, 10 | EMPTY_BODY/RENDER_FAILED、conversion/advisory、真实 HTTP failure seam、merged diagnostics blocked 等价测试 |
| AC-03 HTTPS/微信图片/no-referrer/CSP | Tasks 6, 7, 9 | Markdown/raw HTML/微信 HTTPS 静态测试；header/CSP 测试；本地 HTTPS route 成功与无 Referer 测试 |
| AC-04 图片失败及所有不支持来源 | Tasks 3, 6, 9, 10 | rich-text 分类、renderer 全来源矩阵、load failure/旧事件、clipboard File/undo 测试 |
| AC-05 外链脚注、去重、微信例外、持久化/revision | Tasks 1, 2, 5, 8, 10 | store 原子/冲突、import 保留、完整 URL 矩阵、toggle autosave/double-toggle/reload/import tests |
| AC-06 安全清理、降级、特殊内容与短期 audit | Tasks 3, 5, 6, 10 | removed 固定类型、图片/媒体规范块、special conversion、audit range/lifecycle/strict rich result tests |
| AC-07 本地 fixture、集成与回归门槛 | Tasks 4-10 + Final Verification | 两个新 diagnostics test 文件、既有 #3-#5 tests、语法/full suite/diff/dependency checks |

## Final Verification

- [ ] **Step 1: 运行所有改动 JavaScript 的语法检查**

```bash
node --check src/typesetting.js
node --check src/typesetting-render.js
node --check src/typesetting-import.js
node --check src/rich-text.js
node --check src/server.js
node --check public/typesetting.js
```

Expected: 每条命令退出 0。

- [ ] **Step 2: 按依赖顺序运行聚焦套件**

```bash
node --test test/typesetting-diagnostics.test.js test/rich-text.test.js
node --test test/typesetting-import.test.js test/typesetting.test.js
node --test test/typesetting-diagnostics-ui.test.js
```

Expected: 全部 PASS，fixture 不访问实时第三方。

- [ ] **Step 3: 运行全量回归和工作树检查**

```bash
npm test
git diff --check
git diff --exit-code cbb62ae..HEAD -- package.json package-lock.json
git status --short
```

Expected: `npm test` 零新增失败；diff 检查退出 0；相对本计划基线 `cbb62ae` 的依赖清单无变更；全部计划内提交完成后工作树 clean。

- [ ] **Step 4: 完成规格逐项审查**

逐条对照 AC-01～AC-07、Global Constraints 与五项 Review Focus，确认每一项都有上述可复现测试证据；确认 `THIRD_PARTY_NOTICES.md` 与 `LICENSES/DOOCS-MD-WTFPL-2.txt` 一致，且没有 GPL/AGPL/无许可证源码、实时网络、#7/#8 功能或“公众号兼容”宣称。
