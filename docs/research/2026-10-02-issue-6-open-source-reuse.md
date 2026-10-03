# Issue #6 可直接复用开源源码审计

> 审计日期：2026-10-03
>
> 项目基线：`GoodScholar/wechat-exporter@282c83e423980e009fe5576fe7a2bbd2bbd5364e`，分支 `codex/issue-6-format-diagnostics`
>
> 目标 Issue：[格式检查、外链和图片诊断 #6](https://github.com/GoodScholar/wechat-exporter/issues/6)

## 结论

Issue #6 不需要引入新的运行时依赖或整套前端框架。可复用范围很窄，但足以避免最关键的一处从零实现：

1. **外链转脚注**：从固定的 `doocs/md` 提交最小移植“按首次出现编号、按 URL 去重”的 `addFootnote()` 状态算法，并借用其 `buildFootnotes()` / `renderer.link()` 的输出结构；必须修正域名判断、转义与清理顺序。许可证为 WTFPL v2，兼容本项目。
2. **Markdown 链接/图片接入**：只使用项目已经依赖的 `marked` 18.0.14 公开 renderer API，不复制 parser 源码。
3. **图片协议拦截、HTML 变换与安全审计**：只使用项目已经依赖的 `sanitize-html` 2.17.7 的 `transformTags`、`onOpenTag`、`allowedSchemesByTag`、`allowProtocolRelative` 等公开 API；保留并扩展本项目现有 `convertRichText()` 审计结果，不换 sanitizer。
4. **图片加载失败**：没有发现能同时提供“原位占位 + 结构化诊断 + 稳定 target”且值得引入的兼容实现。成熟 MIT 库 `vanilla-lazyload` 只提供 load/error 状态和回调，加入整个懒加载状态机的成本超过本项目用原生事件实现的成本。
5. **三分组诊断与可定位 target**：固定候选均无满足 Issue #6 契约的实现。Yituo 最接近，但只有 `errors/warnings` 两组、纯字符串结果、无定位，而且是 AGPL-3.0-or-later；只能参考行为，必须由本项目实现领域模型。
6. **Article Tools** 虽为 Apache-2.0，但相关图片代码会把远程图转成 `data:`，失败时静默忽略；服务端接受 HTTP/data 图片并在失败时保留原图。它与 #6 的安全分类、可见失败和诊断要求相反，不应复制。
7. **mdnice**（GPL-3.0）和 **Yituo**（AGPL-3.0-or-later）不能在维持本项目 MIT 分发的前提下复制或集成；**wechat-format** 固定提交没有许可证，不能复制、修改或分发其源码。三者最多作为行为对照。

最终工程决策是：**只最小移植 doocs 的脚注去重算法；其余能力复用本项目现有代码及已安装依赖的公开 API，用少量原生 JS 完成。**

## 1. 审计方法与判定口径

本报告只把以下内容当作实现证据：固定 commit 的真实源码、根许可证/包许可证、测试源码、当前仓库源码和锁文件。README 仅用于找到入口，不作为能力成立的证据。

复用等级定义：

| 等级 | 含义 |
| --- | --- |
| 可直接复制/最小适配 | 许可证允许，代码边界足够小，技术栈匹配，适配成本低于自行实现。 |
| 只可依赖其公开 API | 使用已经安装或可独立引入的包接口；不复制其内部源码。 |
| 只能行为参考 | 许可证不适合、技术栈过重，或实现不满足契约；可以观察行为，不能复制实现。 |
| 不存在合适实现 | 在本次固定候选和补充成熟项目中，没有同时满足功能、许可证与工程边界的实现。 |

“许可证兼容”在本文中特指：能继续把 `wechat-exporter` 作为 MIT 项目分发，而不要求整个组合作品改用 GPL/AGPL。本文不是法律意见；结论采用保守的工程合规口径。

## 2. 当前项目边界与已有资产

当前项目是 Node.js 22 + Express + 原生浏览器 JS，不使用 React/Vue/Pinia。`package.json` 只有 8 个直接运行时依赖；与 #6 直接相关的是 `marked ^18.0.14` 和 `sanitize-html ^2.17.0`，锁文件实际解析为 `marked 18.0.14` 与 `sanitize-html 2.17.7`（[package.json](https://github.com/GoodScholar/wechat-exporter/blob/282c83e423980e009fe5576fe7a2bbd2bbd5364e/package.json#L16-L30)、[package-lock.json](https://github.com/GoodScholar/wechat-exporter/blob/282c83e423980e009fe5576fe7a2bbd2bbd5364e/package-lock.json#L767-L779)、[sanitize-html 锁定项](https://github.com/GoodScholar/wechat-exporter/blob/282c83e423980e009fe5576fe7a2bbd2bbd5364e/package-lock.json#L1203-L1220)）。

与 #6 可直接复用的本地能力：

- [`renderTypesettingMarkdown()`](https://github.com/GoodScholar/wechat-exporter/blob/282c83e423980e009fe5576fe7a2bbd2bbd5364e/src/typesetting.js#L157-L166) 已经固定 `marked -> sanitize-html` 边界，并禁用协议相对 URL；不应换渲染栈。
- [`safeUrl()`、`removeUnsafeContent()`、`convertRichText()`](https://github.com/GoodScholar/wechat-exporter/blob/282c83e423980e009fe5576fe7a2bbd2bbd5364e/src/rich-text.js#L68-L159) 已经产生 `removed`、`downgraded`，并把特殊媒体转成可见块；这是安全清理审计的首选事实来源。
- 排版页已经由 [`Referrer-Policy: no-referrer`](https://github.com/GoodScholar/wechat-exporter/blob/282c83e423980e009fe5576fe7a2bbd2bbd5364e/src/server.js#L45-L50) 覆盖所有子资源请求，并只为排版页 CSP 增加 HTTPS 图片（[CSP 定义](https://github.com/GoodScholar/wechat-exporter/blob/282c83e423980e009fe5576fe7a2bbd2bbd5364e/src/server.js#L16-L20)、[排版页路由](https://github.com/GoodScholar/wechat-exporter/blob/282c83e423980e009fe5576fe7a2bbd2bbd5364e/src/server.js#L130-L131)）。
- 浏览器已经消费富文本转换返回的 `removed/downgraded`，但目前只显示瞬时计数（[`public/typesetting.js`](https://github.com/GoodScholar/wechat-exporter/blob/282c83e423980e009fe5576fe7a2bbd2bbd5364e/public/typesetting.js#L175-L199)）；#6 应把这些事实映射进统一诊断，而不是新增第二套清理器。

因此，引入 Vue/React、另一套 Markdown parser、DOMPurify/jsdom 或图片上传框架，都会扩大边界而没有必要。

## 3. 固定候选审计

### 3.1 doocs/md：唯一推荐复制的上游片段

- 固定提交：[`a7c17fc4cda92e3c13aa7e24f06615cfa4219b31`](https://github.com/doocs/md/tree/a7c17fc4cda92e3c13aa7e24f06615cfa4219b31)
- 许可证：[WTFPL v2](https://github.com/doocs/md/blob/a7c17fc4cda92e3c13aa7e24f06615cfa4219b31/LICENSE)，与仓库现有 `LICENSES/DOOCS-MD-WTFPL-2.txt` 内容一致。
- 技术栈：TypeScript + Vue 3 + Pinia，但核心 renderer 使用同大版本 `marked`，小型纯算法可移植。

可复用源码：

- [`addFootnote()`](https://github.com/doocs/md/blob/a7c17fc4cda92e3c13aa7e24f06615cfa4219b31/packages/core/src/renderer/renderer-impl.ts#L222-L230)：按完全相同的 href 查找既有条目，首次出现才递增编号。**可直接复制/最小适配**。
- [`buildFootnoteArray()`](https://github.com/doocs/md/blob/a7c17fc4cda92e3c13aa7e24f06615cfa4219b31/packages/core/src/renderer/renderer-impl.ts#L67-L75) 与 [`buildFootnotes()`](https://github.com/doocs/md/blob/a7c17fc4cda92e3c13aa7e24f06615cfa4219b31/packages/core/src/renderer/renderer-impl.ts#L269-L279)：可复用输出结构，但不能原样复制字符串拼接。
- [`renderer.link()`](https://github.com/doocs/md/blob/a7c17fc4cda92e3c13aa7e24f06615cfa4219b31/packages/core/src/renderer/renderer-impl.ts#L396-L409)：提供微信链接例外、开关和脚注引用的组合顺序。**只移植主流程**。
- 默认开关为 false 的配置证据：[`defaultStyleConfig.isCiteStatus`](https://github.com/doocs/md/blob/a7c17fc4cda92e3c13aa7e24f06615cfa4219b31/packages/shared/src/configs/style.ts#L370-L384)。

必须适配而不能照搬：

1. `MP_WEIXIN_LINK_REGEX = /^https?:\/\/mp\.weixin\.qq\.com/`（[源码](https://github.com/doocs/md/blob/a7c17fc4cda92e3c13aa7e24f06615cfa4219b31/packages/core/src/renderer/renderer-impl.ts#L44-L46)）会把 `mp.weixin.qq.com.evil.example` 当成微信域名；本项目必须用 `new URL()` 后精确比较 `protocol/hostname/pathname`。
2. 上游在 `href === text` 时删除链接，不符合 #6“普通外链转脚注”的完整语义，不能继承。
3. `buildFootnoteArray()` 直接把 title/link 拼入 HTML；而上游先清理基础 HTML、后追加脚注（[`renderMarkdown()` / `postProcessHtml()`](https://github.com/doocs/md/blob/a7c17fc4cda92e3c13aa7e24f06615cfa4219b31/packages/core/src/utils/markdownHelpers.ts#L48-L78)）。本项目必须对字段转义并让最终结果经过同一 sanitizer。
4. doocs 普通图片 renderer 只输出 `<img>` 和尺寸（[`renderer.image()`](https://github.com/doocs/md/blob/a7c17fc4cda92e3c13aa7e24f06615cfa4219b31/packages/core/src/renderer/renderer-impl.ts#L378-L394)），没有协议分类、referrer 属性、load/error、占位或诊断。
5. [`urlToFile()`](https://github.com/doocs/md/blob/a7c17fc4cda92e3c13aa7e24f06615cfa4219b31/apps/web/src/composables/useImageUploader.ts#L34-L70) 的 `referrerPolicy: 'no-referrer'` 属于“下载后上传到图床”流程，并会调用第三方代理；它不是预览图片加载实现，不应复制。
6. [`detectLocalImagePaths()`](https://github.com/doocs/md/blob/a7c17fc4cda92e3c13aa7e24f06615cfa4219b31/apps/web/src/components/editor/dialogs/ImportMarkdownDialog.vue#L14-L30) 是正则扫描 Markdown，不能正确覆盖嵌套括号/title/转义，也没有区分 blob/file/data/危险 scheme；不应复制。

许可/notice：WTFPL 没有署名保留义务，但本仓库已经建立固定来源追踪。若实施者直接复制上述函数，必须修改 `THIRD_PARTY_NOTICES.md` 中当前的 “No upstream source file is copied or vendored”，明确列出复制/修改的函数、目标文件和固定 SHA；继续保留 `LICENSES/DOOCS-MD-WTFPL-2.txt`。

### 3.2 eternityspring/article-tools：许可证兼容，但行为不适用

- 固定提交：[`b3f3876019400edd6f4ee25fc7d8d9a8254b09c2`](https://github.com/eternityspring/article-tools/tree/b3f3876019400edd6f4ee25fc7d8d9a8254b09c2)
- 许可证：[Apache-2.0](https://github.com/eternityspring/article-tools/blob/b3f3876019400edd6f4ee25fc7d8d9a8254b09c2/LICENSE)；固定树没有 `NOTICE` 文件。
- 技术栈：单文件浏览器工具 + 可选 Node 服务，表面上可适配原生 JS。

源码证据：

- [`toBase64()` / `inlineImages()`](https://github.com/eternityspring/article-tools/blob/b3f3876019400edd6f4ee25fc7d8d9a8254b09c2/md-to-wechat.html#L406-L427) 用 `Image.onload/onerror` 和 Canvas 转 `data:`；调用者 `catch (_) {}` 静默吞掉失败，没有原位占位、原因或诊断。
- [`render()`](https://github.com/eternityspring/article-tools/blob/b3f3876019400edd6f4ee25fc7d8d9a8254b09c2/md-to-wechat.html#L483-L505) 把 CDN 的 `marked@9` 输出直接写入 `innerHTML`，没有安全清理边界；不能进入本项目可信渲染链。
- [`srcToBlob()`](https://github.com/eternityspring/article-tools/blob/b3f3876019400edd6f4ee25fc7d8d9a8254b09c2/server/publish-wechat.mjs#L92-L109) 接受 `data:` 和 `http/https`，没有 no-referrer、内容长度限制、目标网络限制或结构化分类。
- [`rewriteImages()`](https://github.com/eternityspring/article-tools/blob/b3f3876019400edd6f4ee25fc7d8d9a8254b09c2/server/publish-wechat.mjs#L130-L147) 用正则取 HTML `src`；上传失败只写 console 并保留原图，与 #6“不可静默隐藏或冒充可发布图片”冲突。

决策：**只能行为参考，不复制/不集成**。即使 Apache-2.0 允许复制，修正安全、协议、target 和诊断的改动量已经超过重新用现有 `marked/sanitize-html` API 实现的成本。

若未来复制其他独立片段，需保存 Apache-2.0 许可证副本、在修改文件显著标记已修改、保留原有版权/署名，并在 `THIRD_PARTY_NOTICES.md` 固定 SHA；上游没有 NOTICE，因此无额外 NOTICE 文本可传递。

### 3.3 yan9651688/yituo-hub-studio：最接近检查面板，但许可证和契约均不合适

- 固定提交：[`4405245e4fe2cd16b737b498206d2565d62d3df5`](https://github.com/yan9651688/yituo-hub-studio/tree/4405245e4fe2cd16b737b498206d2565d62d3df5)
- 许可证：[`AGPL-3.0-or-later`](https://github.com/yan9651688/yituo-hub-studio/blob/4405245e4fe2cd16b737b498206d2565d62d3df5/LICENSE)，`package.json` 也声明相同许可证（[源码](https://github.com/yan9651688/yituo-hub-studio/blob/4405245e4fe2cd16b737b498206d2565d62d3df5/package.json#L1-L16)）。
- 技术栈：原生浏览器 JS，但其高级排版/模板/验证是一个完整产品边界，开发测试另依赖 jsdom。

源码证据：

- [`validate()`](https://github.com/yan9651688/yituo-hub-studio/blob/4405245e4fe2cd16b737b498206d2565d62d3df5/validator.js#L11-L61) 只返回 `{ errors, warnings, ok }`，条目只是字符串；没有第三组“已执行转换”、稳定 code、target 或源范围。
- [`commitHtml()`](https://github.com/yan9651688/yituo-hub-studio/blob/4405245e4fe2cd16b737b498206d2565d62d3df5/app.js#L184-L197) 把两组字符串直接拼成 HTML 面板，不能定位正文/占位，也没有把结果绑定到一次 render revision。
- [`renderFailure()`](https://github.com/yan9651688/yituo-hub-studio/blob/4405245e4fe2cd16b737b498206d2565d62d3df5/app.js#L199-L217) 有可见失败 UI，可作为行为参考，但不是 #6 的结构化 blocker 契约。
- [`waitForPreviewAssets()`](https://github.com/yan9651688/yituo-hub-studio/blob/4405245e4fe2cd16b737b498206d2565d62d3df5/app.js#L642-L654) 对 load/error 都只 resolve，用于等待长图导出；它没有区分成功/失败，更不替换占位或生成诊断。

决策：**只能行为参考**。复制或链接 AGPL 代码会把组合作品带入 AGPL 的强 copyleft/网络源码提供义务，不符合继续 MIT 分发的项目边界；同时其两级字符串模型仍需重写成 #6 的三严重度与 target 模型。

### 3.4 mdnice/markdown-nice：有脚注实现，但 GPL、旧栈且语义不匹配

- 固定提交：[`6525a5aba371209c2840593e8f537b4a69137a4b`](https://github.com/mdnice/markdown-nice/tree/6525a5aba371209c2840593e8f537b4a69137a4b)
- 许可证：[GPL-3.0](https://github.com/mdnice/markdown-nice/blob/6525a5aba371209c2840593e8f537b4a69137a4b/LICENSE)，`package.json` 同时显示 React 16、MobX、markdown-it 8 和整套构建依赖（[源码](https://github.com/mdnice/markdown-nice/blob/6525a5aba371209c2840593e8f537b4a69137a4b/package.json#L1-L55)）。

源码证据：

- [`parseLinkToFoot()`](https://github.com/mdnice/markdown-nice/blob/6525a5aba371209c2840593e8f537b4a69137a4b/src/utils/editorKeyEvents.js#L7-L77) 用正则改写 Markdown，把普通链接标题补成脚注触发器；它不能可靠解析完整 Markdown，微信公众号例外也是字符串/正则判断。
- [`linkFoot()`](https://github.com/mdnice/markdown-nice/blob/6525a5aba371209c2840593e8f537b4a69137a4b/src/utils/markdown-it-linkfoot.js#L77-L266) 只有链接带 title 时才创建脚注；每次出现都用 `list.length` 新建条目，没有按 URL 去重。
- [`footnoteTail()`](https://github.com/mdnice/markdown-nice/blob/6525a5aba371209c2840593e8f537b4a69137a4b/src/utils/markdown-it-linkfoot.js#L268-L353) 深度依赖 markdown-it token 模型，不能无成本接到本项目 `marked` 18。

决策：**只能行为参考**。GPL 源码不能复制进继续以 MIT 分发的项目；即使忽略许可证，迁移 parser/React/MobX 栈的成本也远高于移植 doocs 的小算法，而且仍不满足 URL 去重。

### 3.5 lyricat/wechat-format：无许可证，不可复用

- 固定提交：[`76886cfa1637b5fd40939722618012f93a494f70`](https://github.com/lyricat/wechat-format/tree/76886cfa1637b5fd40939722618012f93a494f70)
- 许可证：固定树只有 README 与 `src/`，不存在 `LICENSE`、`LICENCE`、`COPYING` 或 `NOTICE`。GitHub 官方说明指出，无许可证时默认版权法生效，公开仓库只自动允许查看和 fork，不自动授予复制、修改和再分发权（[GitHub Docs](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository)）。

源码证据：

- [`addFootnote()` / `buildFootnotes()`](https://github.com/lyricat/wechat-format/blob/76886cfa1637b5fd40939722618012f93a494f70/src/assets/scripts/renderers/wx-renderer.js#L53-L67) 每次出现都递增，没有 URL 去重，且直接拼接未转义 title/link。
- [`renderer.link()`](https://github.com/lyricat/wechat-format/blob/76886cfa1637b5fd40939722618012f93a494f70/src/assets/scripts/renderers/wx-renderer.js#L135-L151) 用字符串前缀识别微信链接，默认强制脚注，均不符合 #6。
- [`renderWeChat()`](https://github.com/lyricat/wechat-format/blob/76886cfa1637b5fd40939722618012f93a494f70/src/assets/scripts/editor.js#L64-L70) 依赖仓库内旧版 bundled `marked` 与 Vue 页面，无安全清理和诊断。

决策：**只能观察行为，禁止复制/集成**。功能上 doocs 已提供更好且有兼容许可证的固定实现，法律和工程上都没有使用该源码的理由。

### 3.6 引入成本对比

| 候选 | 若整体引入的成本 | 是否超过原生 JS + Express 边界 |
| --- | --- | --- |
| doocs/md | Vue 3、Pinia、Vite、同构 DOMPurify、juice、上传 provider 和大量编辑器状态；只有 renderer 内的几个纯函数与本项目同为 Marked 18。 | 整体引入明显超过；只允许复制脚注小算法。 |
| Article Tools | 单文件 UI 可运行，但绑定 CDN `marked@9`、Canvas data URL、可选发布服务和未经过本项目 sanitizer 的 `innerHTML`。 | 整体或单页集成都超过；修安全边界后没有复用收益。 |
| Yituo | 原生 UI 之外还包含完整主题/动效/导出体系；许可证要求 AGPL-3.0-or-later。 | 技术范围和许可证成本都超过。 |
| mdnice | React 16、MobX、Ant Design、markdown-it 8、juice 5、图床和旧构建链；GPL-3.0。 | 明显超过，且会改变项目分发许可。 |
| wechat-format | Vue + bundled CodeMirror/Marked；无许可证授权。 | 技术收益不足，许可成本不可接受。 |
| vanilla-lazyload | 体积不大，但带 IntersectionObserver、取消/恢复、计数器和一套元素状态；#6 只需要两种事件与占位。 | 依赖、状态与测试成本高于原生实现。 |
| Marked / sanitize-html | 已在 lockfile，公开扩展 API 能覆盖 renderer 与安全变换。 | 不增加边界，是推荐接入点。 |

## 4. 补充成熟项目与现有公开 API

### 4.1 marked 18.0.14：只用公开 renderer API

- 固定提交：[`ef0704c58459e927c805b92a5cc7d0c629e6fe43`](https://github.com/markedjs/marked/tree/ef0704c58459e927c805b92a5cc7d0c629e6fe43)，即 npm `marked@18.0.14` 的 `gitHead`。
- 许可证：[MIT（并包含其列明的历史第三方许可）](https://github.com/markedjs/marked/blob/ef0704c58459e927c805b92a5cc7d0c629e6fe43/LICENSE)。
- [`Renderer.link()` / `Renderer.image()`](https://github.com/markedjs/marked/blob/ef0704c58459e927c805b92a5cc7d0c629e6fe43/src/Renderer.ts#L161-L196) 已经完成 URI 编码与 HTML entity 转义；[`marked.use()`](https://github.com/markedjs/marked/blob/ef0704c58459e927c805b92a5cc7d0c629e6fe43/src/marked.ts#L57-L67) 支持只覆盖少数 renderer 方法。协议安全仍由本项目分类和最终 sanitizer 负责。

决策：**只依赖公开 API**。为脚注和图片 target 覆盖 `link/image` renderer 即可；不要复制 Marked parser、Lexer 或默认 renderer 内部源码。由于它已经是直接依赖，不增加包、框架或许可证种类。

### 4.2 sanitize-html 2.17.7：只用公开变换/审计 API

- 固定提交：[`apostrophecms/apostrophe@72f4531e7b491738049eec423d0c1c2342828e5f`](https://github.com/apostrophecms/apostrophe/tree/72f4531e7b491738049eec423d0c1c2342828e5f)，标签 `sanitize-html@2.17.7`。
- 许可证：[MIT](https://github.com/apostrophecms/apostrophe/blob/72f4531e7b491738049eec423d0c1c2342828e5f/packages/sanitize-html/LICENSE)。
- [`transformTags` 与 `onOpenTag`](https://github.com/apostrophecms/apostrophe/blob/72f4531e7b491738049eec423d0c1c2342828e5f/packages/sanitize-html/index.js#L214-L269) 能在 URL 属性被剥离前观察原始标签/属性，并可改标签、属性和安全文本；适合将 raw HTML 的不可用 `<img>` 变成原位占位并记录审计事实。
- [`allowedSchemesByTag` / `allowProtocolRelative`](https://github.com/apostrophecms/apostrophe/blob/72f4531e7b491738049eec423d0c1c2342828e5f/packages/sanitize-html/index.js#L775-L784) 提供最终安全兜底；默认选项位置见[源码](https://github.com/apostrophecms/apostrophe/blob/72f4531e7b491738049eec423d0c1c2342828e5f/packages/sanitize-html/index.js#L1019-L1045)。

决策：**只依赖公开 API**。分类、诊断 code/target 和占位文案是项目领域逻辑，不能从 sanitizer 自动推导；但无需再引入 DOMPurify 或复制 sanitize-html 内部 parser。

### 4.3 vanilla-lazyload 19.1.3：成熟兼容，但不值得引入

- 固定审计提交：[`20047633c17b331578d6f0c55cb5528fb87399df`](https://github.com/verlok/vanilla-lazyload/tree/20047633c17b331578d6f0c55cb5528fb87399df)，即 npm `vanilla-lazyload@19.1.3` 的 `gitHead`。
- 许可证：[MIT](https://github.com/verlok/vanilla-lazyload/blob/20047633c17b331578d6f0c55cb5528fb87399df/LICENSE)。
- [`addOneShotEventListeners()` / `loadHandler()` / `errorHandler()`](https://github.com/verlok/vanilla-lazyload/blob/20047633c17b331578d6f0c55cb5528fb87399df/src/event.js#L61-L95) 提供 load/error 状态 class 与回调；[默认配置](https://github.com/verlok/vanilla-lazyload/blob/20047633c17b331578d6f0c55cb5528fb87399df/src/defaults.js#L3-L39) 还引入 IntersectionObserver、懒加载、取消、恢复属性等完整状态机。

决策：**不引入；只能参考事件清理方式**。#6 不需要懒加载，库也不提供协议分类、诊断合并、render version、稳定 target 或原位占位。用两类原生监听器加 `img.complete && img.naturalWidth === 0` 能更直接地满足需求；新增依赖反而增加测试面和许可证清单。

## 5. 逐能力最终复用决策

| Issue #6 能力 | 最终等级 | 复用来源 | 决策与最小适配 |
| --- | --- | --- | --- |
| 三分组：阻断问题 / 已执行转换 / 建议复核 | 不存在合适实现 | Yituo `validator.js` 仅行为参考 | 本地定义 `blocker/conversion/advisory`、稳定 code、message、targets；不要复制 Yituo 的两组字符串模型。 |
| 可定位 target（source range / preview id） | 不存在合适实现 | 无候选实现 | renderer 在一次响应内分配 `data-format-target`；诊断返回显式 target。浏览器只用受控 ID 查找，且随 render version 一起淘汰。 |
| 空正文与渲染失败 blocker | 不存在合适实现 | Article Tools/Yituo 仅有展示行为 | 由本地渲染边界捕获并返回结构化 blocker；不能从 toast/字符串面板复制。 |
| 外链转脚注、按 URL 去重 | 可直接复制/最小适配 | doocs `addFootnote()`、`buildFootnotes()`、`renderer.link()` | 复制去重编号小算法；输出通过本地 `marked` renderer 和最终 sanitizer；微信域名用 URL 精确判断；默认 false；同 URL 诊断聚合所有 targets。 |
| 微信公众号文章链接保留 | 可直接复制/最小适配 | doocs link 主流程 | 只借用“先判断微信链接、再做普通外链转换”的顺序；拒绝前缀正则。建议限制 `https:` + `hostname === 'mp.weixin.qq.com'` + `/s` 路径。 |
| HTTPS 图片 + `no-referrer` | 只可依赖其公开 API | 本地响应头、Marked renderer、浏览器属性 | 保留页面级响应头；HTTPS `<img>` 再显式输出 `referrerpolicy="no-referrer"`。无需复制 doocs 上传器，也无需新库。 |
| 图片加载失败原位占位 | 不存在合适实现 | vanilla-lazyload 仅行为参考 | 原生 `load/error`，注册后检查 `complete/naturalWidth`；失败时在同 target 原位替换占位并合并 advisory。库的懒加载状态机超出范围。 |
| 本地/危险图片来源分类 | 只可依赖其公开 API | Marked token、sanitize-html transform/hooks、本地 `safeUrl()` | 在 sanitizer 剥离前分类：HTTPS、HTTP/协议相对/其他 scheme、file/绝对/相对/Windows/`~`、data/blob、空 src；不可用项直接生成安全占位，不回显完整敏感 URL。 |
| 富文本安全清理审计 | 只可依赖其公开 API | 本地 `convertRichText()`、sanitize-html | 把现有 `removed/downgraded` 映射成 conversion diagnostics；图片的 data/blob/file/危险 URL 改成可见占位事实。不要换 DOMPurify，不复制 doocs sanitizer。 |
| 特殊媒体占位进入检查 | 不存在合适实现 | 复用本地 `replaceSpecialContent()` / `downgraded` | renderer 识别本项目生成的结构化占位或在转换结果中携带可重定位事实；不要从可伪造的显示文本反推类型。 |

## 6. 推荐实施边界

建议实施者只引入以下上游/公开接口：

1. 在本地 renderer 中用 `new Marked()` 或 `marked.use({ renderer: { link, image } })`，不要替换 Markdown parser。
2. 复制并适配 doocs `addFootnote()` 的局部数组/编号逻辑；脚注 HTML 必须经过本地转义与最终 `sanitize-html`。
3. 对 Markdown 图片在 renderer 阶段分类；对 raw HTML 图片用 `sanitize-html.transformTags.img` 在 scheme 被丢弃前分类和替换。
4. 浏览器预览只添加原生图片事件状态机；用 render version 防止旧 DOM 的 load/error 污染新诊断。
5. 直接复用 `convertRichText()` 的 `removed/downgraded`，把它们作为短生命周期转换审计合入统一面板。
6. 不新增 `DOMPurify`、`jsdom`、`markdown-it`、React、Vue、Pinia、图片上传器或 lazy-load 依赖。

### 6.1 许可证/notice 落地清单

| 实施动作 | 必须处理 |
| --- | --- |
| 复制/改写 doocs `addFootnote` 等源码 | 保留现有 WTFPL 文件；更新 `THIRD_PARTY_NOTICES.md`，删除“未复制源码”的过时表述，标注固定 SHA、上游函数、目标文件和修改范围。 |
| 仅调用 Marked/sanitize-html 公开 API | 不需要把上游源文件 vendoring 进仓库；继续由 `package-lock.json` 固定版本并随依赖分发其许可证。 |
| 复制 Article Tools 源码（本报告不建议） | 新增 Apache-2.0 全文，标记修改文件，保留版权/署名，并在第三方说明中固定 SHA；上游无 NOTICE 文件。 |
| 参考 Yituo/mdnice/wechat-format 行为 | 不复制表达性源码、CSS、模板或测试；无需新增其许可证，但实施说明不得声称复用了它们的代码。 |
| 引入 vanilla-lazyload（本报告不建议） | 增加运行时依赖并保留 MIT copyright/license；同时承担懒加载状态机的集成测试。 |

## 7. 排除项的具体证据

以下结论不是“没在 README 看到”，而是对固定树源码的负向核查：

- doocs 固定树的普通 Markdown 图片 renderer 没有 `referrerpolicy`、加载状态、error handler、占位或诊断；`no-referrer` 只存在于上传器 fetch。
- Article Tools 的预览图片失败由空 catch 吞掉，服务端上传失败保留原 URL；没有三分组、target 或 sanitizer。
- Yituo 校验器只返回 `errors/warnings/ok`；图片 error 只被当作“等待结束”，没有失败结果。
- mdnice 固定树的脚注列表按出现次数追加，没有 URL 去重；其主要 UI/状态依赖 React/MobX/markdown-it。
- wechat-format 固定树没有许可证文件；脚注同样不去重，且默认总是启用。
- vanilla-lazyload 能发出 `callback_error`，但没有原位占位、诊断模型或 URL 来源分类。

所以，除 doocs 脚注小算法外，任何“直接复制整块实现”的方案都会至少违反一个硬条件：许可证、三分组与定位契约、安全分类、原位可见失败，或原生 JS + Express 的最小边界。

## 8. 最终建议

Issue #6 的复用策略应写成：

> 固定复用 `doocs/md@a7c17fc...` 的外链脚注去重编号算法；使用现有 `marked@18.0.14` 与 `sanitize-html@2.17.7` 公开 API 完成 renderer、图片分类和安全变换；复用本项目 `rich-text.js` 的审计事实；图片运行时失败和统一诊断/定位由原生 JS 以项目领域模型实现。Article Tools、Yituo、mdnice、wechat-format 与 vanilla-lazyload 均不复制或集成。

这条边界能避免脚注从零实现，同时不为几行事件处理和分类逻辑引入框架、第二套 sanitizer 或额外运行时状态机。
