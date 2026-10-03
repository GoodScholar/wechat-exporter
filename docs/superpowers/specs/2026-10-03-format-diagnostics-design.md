# 格式检查、外链和图片诊断设计规格

## 目标

在现有公众号排版工作台中增加统一格式检查，使用户在后续复制富文本之前能够明确区分：

- 会阻止生成的正文问题；
- 已由系统执行的安全清理或格式转换；
- 不阻断使用、但需要人工复核的图片问题。

本规格实现 GitHub Issue #6，并保持 #3～#5 已交付的文章导入、富文本粘贴、Markdown 编辑、三套主题、自动保存、修订冲突和原子恢复语义。格式检查是当前 Markdown 正文和浏览器图片状态的派生投影，不成为第二份正文。

本次同时增加默认关闭的文稿级“外链转脚注”开关。开启后，普通 HTTP/HTTPS 外链按规范化 URL 去重生成尾注；符合严格规则的微信公众号文章链接继续保持普通可点击链接。

## 已确认的产品裁决

以下裁决已经确认，实施不得自行改写：

1. 富文本安全清理产生的 `removed` 审计不持久化；它保留到正文下一次人工编辑、成功程序化替换或页面关闭，正文版本变化时立即清除，避免定位到错误范围。
2. 微信公众号文章链接只指 `https://mp.weixin.qq.com/s` 或 `https://mp.weixin.qq.com/s/...`。其他 `mp.weixin.qq.com` 页面不豁免，`mp.weixin.qq.com.evil.test` 等伪域名按普通外链处理。
3. 普通外链即使链接文字本身等于 URL，开启开关后仍生成尾注；不继承上游把裸 URL 降为纯文本的行为。
4. 导入的微信图片没有协议特例，也不自动把 HTTP 升级为 HTTPS。只有符合本规格的绝对 HTTPS 图片可以加载，其余来源显示占位和非阻断诊断。
5. 被安全移除的内容不写入正文占位。诊断定位到本次富文本插入后的正文范围；该范围失效时清除诊断。
6. 渲染采用 `src/typesetting-render.js` 深模块；`src/typesetting.js` 继续只负责文稿模型、严格校验和原子持久化。
7. 最大化复用已审计源码：最小移植 doocs/md 的脚注编号与去重算法，只调用现有 `marked`、`sanitize-html` 的公开接口并复用本项目 `rich-text.js` 审计事实；其余缺失领域逻辑以最薄的本地适配实现。
8. 不新增运行时依赖、前端框架、第二套 Markdown 解析器、第二套 sanitizer、图片上传器或懒加载状态机。

## 来源、许可和复用边界

### 直接复制并最小适配

固定参考 [doocs/md](https://github.com/doocs/md/tree/a7c17fc4cda92e3c13aa7e24f06615cfa4219b31) 提交 `a7c17fc4cda92e3c13aa7e24f06615cfa4219b31`，许可证为 WTFPL v2。只复制并适配以下局部逻辑：

- `packages/core/src/renderer/renderer-impl.ts` 的 `addFootnote()`：首次出现编号、重复 URL 复用编号；
- 同文件 `buildFootnoteArray()` / `buildFootnotes()` 的尾注输出结构；
- 同文件 `renderer.link()` 中“先判断微信链接例外，再处理普通外链”的主流程。

适配后的输出必须通过本项目统一转义和最终 `sanitize-html` 清理。微信链接判断改用 URL 解析后的协议、主机和路径精确匹配；裸 URL 仍生成尾注；去重键改用本规格定义的 URL 规范化结果。

仓库继续保留 `LICENSES/DOOCS-MD-WTFPL-2.txt`。`THIRD_PARTY_NOTICES.md` 必须删除“未复制上游源码”的过时表述，记录固定提交、复制的函数、目标文件、修改范围和主动偏离。

### 只使用公开接口或本地现有能力

- 使用锁文件中的 `marked@18.0.14` 公开 renderer API，不复制 parser、lexer 或默认 renderer 源码。
- 使用锁文件中的 `sanitize-html@2.17.7` 公开 `transformTags`、`onOpenTag`、`allowedSchemesByTag` 和 `allowProtocolRelative` 等接口，不复制内部解析器。
- 复用 `src/rich-text.js` 已有的 `removed`、`downgraded`、特殊媒体识别和失败原子性；只补图片占位事实及结构化原因。
- 图片运行时状态只使用浏览器原生 `load`、`error`、`complete` 和 `naturalWidth`。

### 不复制或集成

- Article Tools：虽为 Apache-2.0，但图片失败会被静默吞掉或保留原 URL，且 data URL 路径不符合本规格。
- Yituo：AGPL-3.0-or-later，且只有无定位的两级字符串检查。
- mdnice：GPL-3.0，脚注不按 URL 去重且依赖不同解析栈。
- wechat-format：固定提交没有许可证授权。
- vanilla-lazyload：只作为事件清理方式的行为参考，不引入其完整懒加载状态机。

本规格的三类诊断、定位 target、图片来源分类和原位失败占位没有可直接复制且同时满足许可与契约的实现，仅实现必要的项目领域逻辑。

## 非目标

- 不实现 Issue #7 的“复制到微信”、HTML/Markdown 下载、CSS 内联或 Clipboard API 流程。
- 不实现 Issue #8 的完整三栏重排、面板折叠、移动端单视图或全屏设置抽屉。
- 不提供图床、图片上传、远程图片重托管、HTTP 自动升级或第三方图片代理。
- 不支持任意 CSS、任意诊断规则、用户自定义脚注模板或新的 Markdown 脚注语法。
- 不持久化预览 HTML、诊断、定位 target、图片加载状态或富文本清理审计。
- 不移植 doocs/md 的 Vue、Pinia、DOMPurify、图床、完整编辑器、`markedFootnotes()` 或复制管线。
- 不修改文章导出领域，也不把当前浏览器预览或自动化测试描述为“公众号兼容”。

## 架构选择

采用“服务端深渲染模块 + 浏览器运行时图片状态”方案：

```text
严格 HTTP 输入
  → src/typesetting-render.js
      → marked 解析及受控 renderer
      → 规范特殊内容/图片占位 token 识别
      → 外链判断、脚注编号与尾注
      → 图片来源分类、静态占位和 target
      → 最终 sanitize-html
      → 静态 diagnostics 与 blocked
  → 浏览器原子应用完整 RenderResult
      → HTTPS 图片 pending → loaded / load-failed
      → 合并动态图片 advisory
      → 合并短生命周期富文本 conversion audit
      → 三组格式检查和定位
```

模块边界如下：

- `src/typesetting.js`：文稿 schema、旧文稿兼容、内容相等、revision 和原子保存；不承载链接、图片、诊断或 DOM 细节。
- `src/typesetting-render.js`：唯一服务端渲染 interface；内部 helper 均保持私有，避免拆成脚注、图片、诊断等浅服务。
- `src/rich-text.js`：富文本输入清理和转换事实；不负责服务端 Markdown 预览。
- 浏览器：不重算静态脚注或静态图片分类，只补真实图片加载结果与本页短生命周期审计。

## 排版文稿模型

文稿新增一个且仅一个持久化字段：

```js
{
  title: string,
  author: string,
  account: string,
  publishedAt: string,
  body: string,
  theme: 'default' | 'grace' | 'simple',
  themeSettings: {
    default: ThemeSettings,
    grace: ThemeSettings,
    simple: ThemeSettings
  },
  convertExternalLinksToFootnotes: boolean,
  revision: nonNegativeSafeInteger,
  savedAt: string
}
```

`convertExternalLinksToFootnotes` 是文稿级选项，不属于任何主题：

- 默认值为 `false`；旧文稿缺失该字段时在读取和规范化时补 `false`，不修改正文、主题或既有 revision。
- 保存后随完整文稿自然进入新结构，不创建独立迁移任务或独立设置文件。
- 用户切换开关时立即刷新预览，并走现有 500 ms 自动保存。revision 按成功持久化提交计数，不按浏览器 change 事件计数：防抖窗口内的多次切换合并为一次提交并只增加一次 revision；即使最终值回到保存前状态，只要本轮已经标记 dirty，仍沿用现有保存语义提交一次完整文稿并增加一次 revision。
- 同一 revision 上仅该字段不同也属于冲突，返回 409；完全相同的文稿仍保持现有幂等 no-op。
- 该字段与正文、元信息、主题和三套设置共用 current、recovery、manifest 和同一次原子提交。
- current/recovery/manifest 任一提交前步骤失败，不得在内存或重启后暴露半保存的新值。
- 文章导入替换正文和元信息时保留当前值；富文本粘贴只改变正文，也保留当前值。
- 切换主题、修改或重置主题设置均不改变该字段。

`diagnostics`、`blocked`、预览 HTML、图片 `pending/loaded/load-failed` 状态、target 和 `removed` 审计均不持久化，也不增加 revision。

## 深渲染模块 interface

`src/typesetting-render.js` 对生产调用者提供一个深 interface：

```js
renderTypesettingMarkdown({
  body,
  presentation: {
    theme,
    settings: { primaryColor, fontSize, lineHeight, blockSpacing }
  },
  convertExternalLinksToFootnotes
}) => ({
  html,
  presentation,
  diagnostics,
  blocked
})
```

约束：

- `body` 为字符串；`presentation` 继续使用 #5 的严格主题和有界设置；开关必须是布尔值。
- 每次调用创建独立的脚注、target 和诊断状态；多次渲染之间不得继承编号或节点 ID。
- 输出 `html` 只能包含最终白名单允许的安全节点和属性。
- 空正文是有效输入，返回 `EMPTY_BODY` blocker 和空正文 HTML，不制造示例正文。
- 合法输入在 Markdown 解析、清理或后处理阶段异常时，捕获为 `RENDER_FAILED` blocker，返回安全、可见但不含堆栈或原始异常文本的失败占位。
- URL 分类、脚注、图片占位、诊断生成和 target 分配均为模块私有实现，不额外导出。

### 可控异常测试 seam

深模块通过 `createTypesettingRenderer({ parseMarkdown })` 建立一个内部组装 seam，并导出该 factory 与默认实例 `renderTypesettingMarkdown`。生产调用者只使用默认实例；测试可提供一个抛错的 `parseMarkdown` adapter，仍然通过同一个 RenderResult interface 验证 `RENDER_FAILED`，不读取或调用任何私有 helper。

`createApp()` 接受可选的 `typesettingRenderer` adapter，默认使用 `renderTypesettingMarkdown`。真实 HTTP 异常测试把上述失败 renderer 注入应用组装层，因此不依赖病理 Markdown、全局 monkey patch 或测试专用输入标记。这个 seam 只改变依赖组装，不把 parser、sanitizer 或后处理步骤暴露给普通调用者。

## 严格 HTTP 契约

`POST /api/typesetting/render` 严格要求恰好四个顶层字段：

```json
{
  "body": "Markdown",
  "theme": "default",
  "settings": {
    "primaryColor": "#0F4C81",
    "fontSize": "16px",
    "lineHeight": "1.75",
    "blockSpacing": "1"
  },
  "convertExternalLinksToFootnotes": false
}
```

缺失或额外顶层键、非字符串正文、未知主题、非法设置、非布尔开关返回 400，并且不改变内存或磁盘文稿。非法请求不是文稿 blocker，不返回伪造的诊断结果。

合法请求返回且只返回：

```js
{
  html: string,
  presentation: {
    theme: 'default' | 'grace' | 'simple',
    settings: { primaryColor, fontSize, lineHeight, blockSpacing }
  },
  diagnostics: Diagnostic[],
  blocked: boolean
}
```

浏览器必须在替换任何 DOM 或状态前整体校验响应：顶层键、字段类型、presentation、diagnostic、target、code/severity 对应关系和 `blocked` 均合法后，才能一次性应用 `html + presentation + diagnostics + blocked`。

浏览器另维护当前请求版本和 `renderFresh`：正文、主题、主题设置或脚注开关变化时立即令 `renderFresh=false` 并显示“正在重新检查”；只有与最新请求版本和当前输入快照一致的完整合法 RenderResult 才能把它恢复为 `true`。畸形 200、网络错误、非 2xx 和过期响应可以保留上一份成功 HTML 供视觉参考，但必须标为“预览不是当前内容”，检查结果不可被当成当前投影。后续 Issue #7 的生成门禁固定为 `renderFresh === true && blocked === false`；pending、失败或 stale 状态均不得使用旧 `blocked=false` 放行。

## 诊断模型

### 数据结构

```js
SourceTarget = { kind: 'source', start: nonNegativeInteger, end: nonNegativeInteger }
PreviewTarget = { kind: 'preview', id: nonEmptyString }
Target = SourceTarget | PreviewTarget

Diagnostic =
  | { id: nonEmptyString, code: 'EMPTY_BODY', severity: 'blocker', message: nonEmptyString,
      targets: [SourceTarget] }
  | { id: nonEmptyString, code: 'RENDER_FAILED', severity: 'blocker', message: nonEmptyString,
      targets: [SourceTarget] }
  | { id: nonEmptyString, code: 'EXTERNAL_LINK_TO_FOOTNOTE', severity: 'conversion',
      message: nonEmptyString,
      targets: [PreviewTarget, ...], meta: { footnote: positiveInteger, occurrences: positiveInteger } }
  | { id: nonEmptyString, code: 'SPECIAL_CONTENT_PLACEHOLDER', severity: 'conversion',
      message: nonEmptyString,
      targets: [PreviewTarget], meta: { type: SpecialContentType } }
  | { id: nonEmptyString, code: 'UNSAFE_RICH_TEXT_REMOVED', severity: 'conversion',
      message: nonEmptyString,
      targets: [SourceTarget], meta: { types: [SafeRemovedType, ...] } }
  | { id: nonEmptyString, code: ImageDiagnosticCode, severity: 'advisory',
      message: nonEmptyString,
      targets: [PreviewTarget] }
```

其中 `SpecialContentType` 固定为 `video | audio | embed | mini-program | poll`，`SafeRemovedType` 固定为 `script | style | form | event-handler | unsafe-url`，`ImageDiagnosticCode` 固定为 `IMAGE_LOAD_FAILED | IMAGE_UNSUPPORTED_SCHEME | IMAGE_LOCAL_PATH | IMAGE_LOCAL_BINARY | IMAGE_MISSING_SOURCE`。本 Issue 不定义没有实际生产者的通用 `RICH_TEXT_DOWNGRADED`；未来出现新的降级类型时必须先扩展判别联合和测试。

本判别联合和下表是严重度的最终权威定义；早期分析材料若把特殊媒体占位归入“建议复核”，以本规格固定的 `conversion / 已执行转换` 为准。

- source 的 `start/end` 是当前 textarea 字符串的零基、半开 UTF-16 区间，且 `start <= end <= body.length`。
- preview target 的 `id` 只对应同一次成功渲染中的受控 `data-format-target`；不得返回任意 CSS selector。
- `id` 在一次合并后的检查结果中唯一，但不要求跨响应稳定。
- `message` 使用固定安全文案，不回显原始危险 URL、data URI、blob URL、完整本地路径或异常堆栈。
- `EXTERNAL_LINK_TO_FOOTNOTE` 每个规范化 URL 恰好一条；`SPECIAL_CONTENT_PLACEHOLDER` 和各图片 code 每个占位恰好一条；`UNSAFE_RICH_TEXT_REMOVED` 每次成功富文本插入最多一条，并把去重、按固定枚举顺序排列的类型放入 `meta.types`。
- 没有在判别联合中声明 `meta` 的 code 必须省略该字段，不接受空对象或额外键。所有对象，包括 Target 与 meta，都拒绝额外键；客户端不得把 meta 解释成 DOM、HTML 或 selector。

### 固定 code、严重度和阻断规则

| severity | code | 生成位置 | target / meta | 阻断 |
| --- | --- | --- | --- | --- |
| `blocker` | `EMPTY_BODY` | 服务端，`body.trim()` 为空 | source `[0,0]` | 是 |
| `blocker` | `RENDER_FAILED` | 服务端，合法请求渲染异常 | source 全正文 | 是 |
| `conversion` | `EXTERNAL_LINK_TO_FOOTNOTE` | 服务端，普通外链进入尾注 | 同 URL 的一个或多个 preview targets；`meta.footnote`、`meta.occurrences` | 否 |
| `conversion` | `SPECIAL_CONTENT_PLACEHOLDER` | 服务端，规范特殊媒体占位 | 恰好一个 preview target；`meta.type` | 否 |
| `conversion` | `UNSAFE_RICH_TEXT_REMOVED` | 浏览器，富文本转换返回 `removed` | 恰好一个本次插入 source target；`meta.types` | 否 |
| `advisory` | `IMAGE_LOAD_FAILED` | 浏览器，合法 HTTPS 图片加载失败 | 原图相同 preview target | 否 |
| `advisory` | `IMAGE_UNSUPPORTED_SCHEME` | 服务端，HTTP、协议相对或其他未允许协议 | 原位占位 preview target | 否 |
| `advisory` | `IMAGE_LOCAL_PATH` | 服务端，file、绝对/相对/Windows/`~` 路径 | 原位占位 preview target | 否 |
| `advisory` | `IMAGE_LOCAL_BINARY` | 服务端，data/blob 或规范剪贴板图片占位 | 恰好一个原位占位 preview target | 否 |
| `advisory` | `IMAGE_MISSING_SOURCE` | 服务端，图片来源缺失或为空 | 原位占位 preview target | 否 |

唯一阻断公式是：

```js
blocked = diagnostics.some(item => item.severity === 'blocker')
```

conversion、advisory、图片 pending 和图片失败都不得额外产生 blocker。Issue #7 只消费当前且完整验证通过的 RenderResult；门禁为 `renderFresh === true && blocked === false`，不能从旧结果或 UI 文案另建判断规则。

浏览器按固定标题展示：

- `blocker` → “阻断问题”；
- `conversion` → “已执行转换”；
- `advisory` → “建议复核”。

三组始终显示标题、数量和条目；空组显示“暂无”，不能隐藏整个分组。

## 外链转脚注

### 开关关闭

- 不改变安全链接结构，不追加尾注，不生成 `EXTERNAL_LINK_TO_FOOTNOTE`。
- `mailto:` 继续按现有安全策略处理，不参与脚注。
- Markdown body 保持字节不变。

### 开关开启

1. 只处理通过 URL 解析且协议为 `http:` 或 `https:` 的普通外链。
2. 去重键使用 `new URL(href).href`；不主动删除 fragment、不重排 query、不执行产品自定义重写。
3. 按正文首次出现顺序从 1 编号；同一规范化 URL 的每个出现位置引用同一编号，尾注只生成一条。
4. 每个唯一普通 URL 生成一条 `EXTERNAL_LINK_TO_FOOTNOTE`，`targets` 包含所有出现位置，`meta.footnote` 为编号，`meta.occurrences` 为出现次数。
5. 链接文字等于 URL 时仍保留可识别引用并生成尾注，不降为无尾注纯文本。
6. 脚注区只在至少存在一个普通外链时出现；正文、引用和尾注一起经过最终安全清理。
7. 关闭开关后，尾注和对应 conversion 立即消失，Markdown body 不变。
8. 渲染器在普通链接处理之前识别下文定义的完整规范特殊内容占位；占位中的安全来源 URL 保持可见和可点击，但不生成外链尾注，也不额外生成 `EXTERNAL_LINK_TO_FOOTNOTE`。一个特殊媒体占位只生成一条 `SPECIAL_CONTENT_PLACEHOLDER`。

### 微信公众号文章链接例外

只有同时满足以下条件的 URL 保持普通可点击链接且不占用尾注编号：

- 协议严格为 `https:`；
- `hostname === 'mp.weixin.qq.com'`；
- pathname 严格等于 `/s` 或以 `/s/` 开头。
- `username === ''`、`password === ''` 且 `port === ''`；显式默认 443 由 URL parser 规范化为空端口后可以匹配，其他端口不能匹配。

HTTP 微信链接、其他微信页面、带用户名密码的地址、其他主机、子域名和伪域名均不享受例外。主机大小写由 URL parser 规范化后比较。

## 图片分类与状态

### 静态来源分类

图片来源必须在最终 sanitizer 剥离 URL 之前分类。Markdown 图片使用 Marked renderer；raw HTML 图片使用 `sanitize-html` 公开变换接口。两条路径产生相同状态和诊断：

```text
图片来源
  ├─ 绝对 HTTPS 且无用户名/密码 → pending <img>
  │    ├─ load 且 naturalWidth > 0 → loaded，无诊断
  │    └─ error 或 complete && naturalWidth === 0
  │         → load-failed 原位占位 + IMAGE_LOAD_FAILED
  ├─ data: / blob: → local-binary 原位占位 + IMAGE_LOCAL_BINARY
  ├─ file: / 绝对路径 / 相对路径 / Windows 路径 / ~ 路径
  │    → local-path 原位占位 + IMAGE_LOCAL_PATH
  ├─ http: / 协议相对 / 其他 scheme
  │    → unsupported-scheme 原位占位 + IMAGE_UNSUPPORTED_SCHEME
  └─ 缺失或空 src → missing-source 原位占位 + IMAGE_MISSING_SOURCE
```

只有无用户名和密码的绝对 HTTPS URL 可保留为真实 `<img>`。导入的 `mmbiz.qpic.cn` 或其他微信图片与普通图片使用完全相同的规则，没有域名或来源豁免。

保留的图片至少带：

```html
<img src="https://..."
     referrerpolicy="no-referrer"
     data-image-state="pending"
     data-format-target="format-target-image-N">
```

排版页继续返回 `Referrer-Policy: no-referrer`，并将排版页 CSP 的图片来源收紧为仅 `self` 与 `https:`。不得为了 favicon、预览或粘贴放开 `http:`、`data:` 或 `blob:`；现有 data favicon 应删除或改为同源静态资源。其他页面的 CSP 不得被扩大。

### 原位占位

静态不支持来源和动态加载失败均在原图片位置显示可见、可聚焦的安全占位：

- 保留经过转义的图片 alt（如有）；
- 显示固定原因与修复建议；
- 带 `role="note"`、键盘可达属性和原图片的 `data-format-target`；
- 不显示完整 URL、本地路径、文件内容、data URI、blob URL 或凭据；
- 不发起对静态不支持来源的网络请求；
- 始终是 advisory，`blocked=false`。

### 浏览器动态状态

浏览器对本次成功渲染中的 pending 图片注册 `load/error` 后，立即检查 `complete/naturalWidth`，避免错过缓存图片的早发事件。成功时仅把状态改为 loaded，不生成诊断；失败时使用同一个 target 原位替换占位，并合并一条 `IMAGE_LOAD_FAILED`。

每次预览都有单调递增的 `previewVersion`。只有当前版本的 DOM 和事件可以更新图片状态与检查列表；旧预览的迟到响应、load/error 回调和 target 全部丢弃。

## 富文本转换审计

继续使用现有 `POST /api/typesetting/rich-text` 和 `convertRichText()`，不增加第二个转换 endpoint。成功结果继续包含：

```js
{
  markdown: string,
  removed: SafeRemovedType[],
  downgraded: StructuredDowngrade[],
  block: boolean
}

StructuredDowngrade =
  | { type: SpecialContentType, sourceUrl?: SafeHttpUrl }
  | { type: 'image', reason: 'local-binary' | 'local-path' | 'unsupported-scheme' | 'missing-source' }
```

返回对象、`removed` 项和每个 `StructuredDowngrade` 都是严格白名单；未知值、重复 removed 类型、额外键或不安全 `sourceUrl` 令客户端把转换结果视为畸形并保持现状。图片 downgrade 不携带原始 URL、路径或二进制内容。

### 被移除内容

- `removed` 按安全类型去重映射为 `UNSAFE_RICH_TEXT_REMOVED`；不得把原恶意值、脚本、路径或 URL 放入文案或 meta。
- 被移除内容不写入 Markdown 占位，也不创建预览节点。
- 成功插入后，以实际插入字符串在 textarea 中的半开范围创建 source target；前后为保持块边界而插入的换行属于该次插入范围。
- 浏览器最多保留一条当前正文版本的短生命周期 `UNSAFE_RICH_TEXT_REMOVED`。正文下一次人工 `input` 后立即清除；任何成功且实际改变正文的程序化正文替换也必须在新正文生效的同一原子步骤清除，包括成功导入、body 实际变化的重新水合/恢复，以及下一次成功富文本插入。下一次成功插入只建立它自己的新审计，不保留旧范围；普通保存响应若水合结果与当前 body 相同，不清除审计。
- 切换主题、修改脚注开关、图片 load/error 或仅重新渲染不得清除当前有效审计。失败导入、失败转换、过期响应或未应用的水合既不改变正文，也保留原审计。
- 转换失败、选区变化、正文变化、过期响应或原生插入失败时，不修改正文，也不创建或替换任何转换诊断。

### 规范占位语法

为保证刷新后能重新生成诊断，富文本转换器和本地图片粘贴只写入以下保留语法。渲染器在 blockquote token 层按完整单段块匹配，不对普通正文做子串猜测；用户手写完全相同的保留语法时也会被解释为占位，这是该语法的明确含义。

特殊媒体沿用现有可见形式，标签只能是 `视频 | 音频 | 嵌入内容 | 小程序卡片 | 投票`：

```markdown
> [特殊内容：视频]
> [特殊内容：视频] 来源：https://example.test/video
```

来源部分可省略；存在时必须是现有 `safeUrl` 接受的无凭据 HTTP/HTTPS URL。特殊媒体 block 优先于普通 link renderer，来源 URL 不参与脚注转换。

不可发布图片使用以下四个固定 reason token：

```markdown
> [图片占位：local-binary] 本地图片不可发布。请先上传图片并替换为 HTTPS 地址。
> [图片占位：local-path] 本地路径图片不可发布。请先上传图片并替换为 HTTPS 地址。
> [图片占位：unsupported-scheme] 图片协议不受支持。请替换为 HTTPS 地址。
> [图片占位：missing-source] 图片缺少来源。请补充 HTTPS 地址。
```

若原图片有 alt，在固定句末追加 `替代文本：ALT`。ALT 必须去除换行、折叠空白、限制为 200 个 Unicode code point，并转义 Markdown 控制字符；来源 URL、本地路径和二进制内容永不写入规范占位。每个规范图片占位只生成一个对应 advisory 和一个 preview target。

### 特殊媒体与结构化降级

- 视频、音频、嵌入内容、小程序卡片和投票继续转换成现有规范 Markdown 占位；渲染器从当前 Markdown 的规范占位形式生成 `SPECIAL_CONTENT_PLACEHOLDER`，因此刷新和重启后可重建。
- 只识别完整规范占位块，不根据任意正文中出现的局部显示文字猜测媒体类型；用户手写完整保留语法时按同一规则处理。
- 每个顶层特殊媒体产生一个占位和一条 conversion；嵌套媒体不得重复计数。
- 安全来源 URL 继续遵循现有 `safeUrl` 规则；危险或本地来源不得回显。
- 本 Issue 没有除特殊媒体、图片和 `removed` 之外的结构化降级类型；`downgraded` 只能使用已声明的特殊媒体或图片 reason。出现未知类型时客户端把响应视为畸形转换结果，并保持正文和既有检查状态不变。

### 富文本和剪贴板图片

- 富文本 HTML 中的 data/blob 图片转为规范的“本地图片不可发布”Markdown 占位，并携带结构化 `local-binary` downgrade，不再静默删除。
- 富文本中的 file/本地路径图片转为规范本地路径占位；HTTP、协议相对或其他不支持协议图片转为规范不支持协议占位。占位不得包含完整来源。
- textarea 粘贴事件若含 `clipboardData.files` 中的 image `File`，优先拦截二进制图片路径，不生成 blob URL。使用现有原生插入路径写入：

```markdown
> [图片占位：local-binary] 本地图片不可发布。请先上传图片并替换为 HTTPS 地址。
```

- 上述规范占位由渲染器生成可见图片占位和 `IMAGE_LOCAL_BINARY`，因此刷新后仍能重新识别；插入操作保留原生 textarea 撤销、选区和键盘行为。

## 格式检查 UI 与定位

工作台增加：

- 文稿级“外链转脚注”复选框；
- 固定格式检查区，包含“阻断问题、已执行转换、建议复核”三组；
- 各组数量、空状态和可点击条目。

交互要求：

- source target：聚焦正文 textarea，并通过 `setSelectionRange(start, end)` 选择当前有效范围；`[0,0]` 聚焦空正文输入位置。
- preview target：在当前预览根节点内按受控 `data-format-target` 查找，滚动到可见区域、聚焦可聚焦节点并短暂高亮。
- 同 URL 多个 target 的最小行为是定位第一处；数据结构保留全部 target，后续无需改变服务端契约即可扩展循环定位。
- 所有开关、分组和诊断条目有正确 label、键盘可达和可见焦点；临时高亮遵守 `prefers-reduced-motion`。
- target 仅在当前预览或当前插入范围有效，不写回文稿，不跨响应复用。

## 并发、失败与原子性

- 预览继续使用现有版本门禁。只有最新请求可原子替换 `html + presentation + diagnostics + blocked`，并建立对应图片监听。
- 过期成功响应、过期失败响应和旧 DOM 图片事件不能修改当前预览、主题、检查分组、blocked 或 target。
- 任一影响渲染的输入变化都先把现有结果标记 stale。畸形 200、网络错误或非 2xx 响应可保留上一份完整成功预览供视觉参考，但 `renderFresh` 保持 false，UI 明确显示“预览不是当前内容”，不得应用未经服务端规范化的主题、HTML 或诊断，也不得让后续生成使用旧 blocked。
- 合法请求内部渲染失败由当前成功响应中的 `RENDER_FAILED` 取代当前结果；它不是网络失败，也不能泄漏异常细节。
- 富文本转换只有在请求版本、正文、选区和 changeVersion 均仍匹配时才可一次性插入正文并建立本次审计。
- 文稿保存失败或 409 继续显示“未保存”及可操作提示，保留用户当前脚注选择供人工处理，不伪装为已保存。
- 导入期间脚注开关与现有正文、主题控件一起禁用；导入成功或失败后恢复，并保持导入前的开关值。

## 安全边界

- 不使用字符串正则改写最终 HTML；链接与 Markdown 图片使用 Marked renderer，raw HTML 图片使用 `sanitize-html` 公开变换接口。
- 最终 sanitizer 只允许渲染模块生成所需的最小标签和属性，例如 `figure`、`figcaption`、`small`、受控 class、`data-format-target`、`data-image-state`、`referrerpolicy`、`tabindex` 和 `role`；不开放任意 `data-*`、任意 style 或事件属性。
- 所有占位和脚注文案使用安全文本构造或显式转义，并在最终返回前再次通过统一清理。
- 不支持来源的图片在渲染阶段成为占位，不依赖 CSP 或 sanitizer 的静默删除作为产品行为。
- 服务端异常日志可保留内部信息，但 HTTP 响应和 UI 不包含堆栈、文件路径或原始异常。
- 后续复制、下载若使用本模块，必须消费相同的安全 HTML、diagnostics 和 blocked 语义，不能绕过渲染边界。

## 文件职责和修改边界

| 文件 | 本 Issue 的职责 |
| --- | --- |
| `src/typesetting.js` | 新增脚注开关默认值、严格规范化、旧文稿兼容、same-content 比较和原子持久化；移出或重导出现有 renderer。 |
| `src/typesetting-render.js` | 新增深渲染 interface、默认 renderer 和可注入 parse adapter 的 factory；私有实现脚注、链接例外、图片分类/占位、静态诊断、target、失败 blocker。 |
| `src/typesetting-import.js` | 导入候选保留当前脚注开关。 |
| `src/rich-text.js` | 不可发布图片转规范占位与结构化 downgrade；保留既有安全清理和失败原子性。 |
| `src/server.js` | `/render` 四键严格契约、新 RenderResult 和排版页 CSP/no-referrer 接线。 |
| `public/typesetting.html` | 脚注复选框和最小三组格式检查区。 |
| `public/typesetting.js` | 字段水合/保存、RenderResult 整体校验、诊断合并/定位、图片状态机、二进制粘贴和版本门禁。 |
| `public/typesetting-theme.css` | 预览正文内脚注、图片占位、特殊内容占位和 target 高亮的作用域样式。 |
| `public/style.css` | 检查面板、严重度、焦点和最小窄屏可操作布局；不实现 #8 重排。 |
| `THIRD_PARTY_NOTICES.md` | 固定 doocs 来源、复制函数、修改范围、WTFPL 和主动偏离。 |
| `test/typesetting.test.js` | 文稿 shape、开关 revision/冲突/原子恢复、客户端水合与既有回归。 |
| `test/typesetting-import.test.js` | 导入成功、失败和冲突时保留脚注开关。 |
| `test/rich-text.test.js` | 安全审计、特殊媒体、图片占位和转换失败原子性。 |
| `test/typesetting-diagnostics.test.js` | 纯渲染与真实 HTTP 的脚注、诊断、图片分类、target 和渲染失败。 |
| `test/typesetting-diagnostics-ui.test.js` | 浏览器三组检查、定位、动态图片、竞态、持久化和窄屏验收。 |

明确不修改 `src/article.js`、`src/exporter.js`、`public/app.js`、复制/下载管线、完整 V2 布局，以及本分支不存在的根 `CONTEXT.md` 或 ADR。

## AC-01～AC-07 验收矩阵

### AC-01：三组诊断和定位

- 服务端和浏览器合并后只存在 `blocker | conversion | advisory` 三类，code 与 severity 映射固定。
- 三组始终显示标题、数量和空状态；blocker 存在时也不隐藏 conversion 或 advisory。
- 每条诊断含唯一 id、至少一个有效 target；source 定位选中正确范围，preview 定位滚动、聚焦并高亮正确链接或占位。
- 诊断条目和定位操作可用键盘完成。
- 慢旧响应不能覆盖新 HTML、presentation、diagnostics、blocked、target 或图片状态。
- “非空成功 → 正文改为空 → 最新请求 pending/网络失败/畸形 200”时，旧内容可以留作参考但 `renderFresh=false`，检查区显示 stale，后续生成门禁不得读取旧 `blocked=false`。

### AC-02：阻断和非阻断规则

- 空字符串和全空白正文返回 `EMPTY_BODY`、`blocked=true`，且不显示伪正文。
- 可控渲染异常返回安全失败占位、`RENDER_FAILED`、`blocked=true`，不泄漏堆栈。
- 外链转换、安全清理和特殊媒体占位属于 conversion，均不阻断。
- 坏图、不支持协议、本地路径和本地二进制属于 advisory，均不阻断。
- `blocked` 与 blocker 是否存在严格等价。

### AC-03：HTTPS/微信图片和 no-referrer

- HTTPS Markdown 图片、raw HTML 图片和导入的微信 HTTPS 图片保留 src，带 `referrerpolicy="no-referrer"`、pending state 和 target，且无静态图片错误诊断。
- 本地 HTTPS fixture 成功加载后变为 loaded，不产生 advisory；记录到的 Referer 为空。
- 排版页响应头为 `Referrer-Policy: no-referrer`，CSP 允许 `self`/`https:` 图片而拒绝 http/data/blob；其他页面 CSP 不扩大。
- 非 HTTPS 微信图片没有例外，也不自动升级。

### AC-04：图片失败和不支持来源

固定覆盖正常 HTTPS、404/中断 HTTPS、HTTP、协议相对、`file:///tmp/a.png`、`/tmp/a.png`、`C:\\a.png`、`./a.png`、`data:image/...`、`blob:...` 和空 src：

- 正常图显示；动态失败图在相同 target 原位变成占位。
- 每个静态不支持来源只生成一个正确 code，不发起网络请求。
- 占位可见、可读、可聚焦、可定位，不泄漏完整来源。
- 富文本 HTML 中的不可发布图片和剪贴板 image File 同样产生规范占位，不静默消失，不生成 blob 预览。
- 全部图片问题保持 `blocked=false`；旧图片事件不能污染新预览。

### AC-05：外链脚注、去重和微信例外

固定正文包含：同一普通 URL 两次、另一普通 URL、带 fragment URL、`mailto:`、合法 `https://mp.weixin.qq.com/s`、合法 `/s/...`、其他微信页面、伪域名、带 userinfo、非默认端口和链接文字等于 URL：

- 默认及旧文稿开关为 false；不产生尾注，刷新/重启仍为 false。
- 开启后普通 URL 按规范化 URL 和首次出现顺序编号，重复 URL 共用编号和一条尾注。
- 裸 URL 文字也生成尾注。
- 两类合法、无凭据、无非默认端口的微信文章 URL 保持 `<a>` 且不占编号；其他微信页面、userinfo、非默认端口和伪域名进入普通外链尾注。
- 关闭后尾注和 conversion 立即消失，Markdown body 字节不变。
- 防抖窗口内多次 toggle 合并为一次完整文稿提交和一次 revision 增长；最终回到原值但已 dirty 仍提交一次。快速双切换不得产生多个并发保存；同 revision 不同值返回 409，原子写失败只暴露旧值。
- 导入和富文本粘贴保留开关；慢旧渲染不能覆盖新开关对应结果。

### AC-06：安全清理、降级和特殊内容检查

- script、style、事件属性、表单和不安全 URL 不进入正文/预览；安全可读文字保留。
- `removed` 每次成功插入最多产生一条短生命周期 `UNSAFE_RICH_TEXT_REMOVED`，`meta.types` 使用固定枚举和顺序，target 为实际插入范围；正文人工编辑、成功导入、body 实际变化的水合/恢复或下一次成功插入时清除旧审计。
- 被移除内容不写正文占位；主题、脚注和图片状态变化不清除该审计。
- 视频、音频、embed、小程序和投票形成持久可见的规范特殊内容占位和 `SPECIAL_CONTENT_PLACEHOLDER`；嵌套媒体不重复。
- 脚注开关开启且特殊媒体占位含安全来源 URL 时，只产生一条特殊内容 conversion，来源 URL 不进入脚注。
- 本地/危险富文本图片形成规范图片占位及对应 advisory；不会泄漏来源。
- 成功导入清除旧短生命周期审计；失败导入、转换失败、正文/选区变化和旧响应不修改正文、元信息、主题、脚注开关或检查结果。

### AC-07：集成覆盖和回归门槛

- 正常图片、坏图、不安全协议、本地路径、本地二进制、重复外链、微信公众号文章链接和三类严重度均有固定本地 fixture，不访问实时微信或第三方服务。
- 测试断言结构和行为，不快照整页 HTML，也不依赖私有 helper 名称。
- Issue #3～#5 的相关既有测试继续通过；最终 `npm test` 零新增失败。
- `node --check` 覆盖所有改动的服务端和浏览器 JavaScript，`git diff --check` 通过。
- 自动化结果只声明格式检查和后续富文本生成前置契约成立，不声明“公众号兼容”。

## 测试策略

### 纯渲染测试

- 诊断 schema、固定 code/severity、blocked 公式、target 唯一性和状态隔离。
- 脚注默认关闭、首次编号、规范化 URL 去重、尾注转义、裸 URL、微信精确例外和伪域名。
- Markdown/raw HTML 图片的全部静态分类、no-referrer 属性、占位安全和特殊媒体重建。
- 空正文，以及通过 `createTypesettingRenderer()` 的失败 parse adapter 稳定触发的渲染异常。

### 真实 HTTP 与持久化测试

- `/render` 恰好四键、非法请求 400；通过应用组装层注入失败 renderer 验证合法异常 blocker，以及响应不泄漏内部信息。
- 旧文稿迁移、toggle revision、同 revision 冲突、幂等保存、重启恢复和 current/recovery/manifest 故障注入。
- 导入成功/失败/冲突均保持脚注开关。
- 排版页 CSP 与 Referrer-Policy，其他页面策略不扩大。

### 富文本测试

- removed 类型去重、安全文字保留、插入失败原子性。
- 特殊媒体顶层去重、危险来源隐藏和规范占位。
- data/blob/file/本地路径/不支持协议图片转可见占位及结构化 downgrade。
- 转换错误继续保持现有 typed error 和当前文稿不变。

### Playwright 集成测试

- 三组检查、空状态、数量、键盘访问、source/preview 定位和 reduced-motion。
- 正常本地 HTTPS 图片、失败图片、早发 complete 状态、原位替换、Referer 为空。
- 快速连续预览时的响应竞态和旧图片事件隔离。
- 成功预览后修改为空正文，并令最新请求 pending、网络失败或返回畸形 200，验证旧结果只能作为 stale 参考且不能提供可消费的 `blocked=false`。
- 脚注开关即时预览、自动保存、刷新恢复、导入保留和主题独立。
- 脚注开关在 500 ms 内快速双切换只形成一次串行提交和一次 revision 增长，包括最终回到原值的 dirty 情况。
- 富文本清理审计的建立、非正文变更保留、正文人工编辑清除、成功导入、body 实际变化的水合/恢复或下一次成功粘贴替换旧审计，以及失败导入和 body 未变化的普通保存响应保留原审计。
- 剪贴板 image File 插入规范占位、原生撤销和不生成 blob URL。
- 窄屏下开关、三组列表和诊断定位仍可操作，但不验收 #8 的完整移动布局。

建议验证顺序：

```bash
node --check src/typesetting.js
node --check src/typesetting-render.js
node --check src/typesetting-import.js
node --check src/rich-text.js
node --check src/server.js
node --check public/typesetting.js

node --test test/typesetting-diagnostics.test.js test/rich-text.test.js
node --test test/typesetting-import.test.js test/typesetting.test.js
node --test test/typesetting-diagnostics-ui.test.js
npm test
git diff --check
```

## 任务拆分与依赖

```text
T0 冻结 schema、code、severity、target 和开关契约
├─ T1 文稿脚注开关持久化 ───────────┐
├─ T2 富文本图片占位与审计 ─────────┤
└─ T3 深渲染模块与纯渲染测试 ───────┘
                  ↓
T4 HTTP 严格接线与 CSP
                  ↓
T5 检查 UI、定位、图片运行时状态
                  ↓
T6 浏览器集成验收
                  ↓
T7 第三方说明、全量回归和独立终审
```

- T1、T2、T3 只有在 T0 冻结后才可并行，且必须拥有不重叠的生产文件。
- T4 依赖 T1/T3，统一修改 `src/server.js`；不得由多个任务同时接线。
- T5 依赖 T1/T2/T4，并由单一所有者同时维护 `public/typesetting.js`、HTML 和两类 CSS，避免状态与 DOM 契约分裂。
- T6 发现实现缺陷时回交 T5 所有者修复，不让测试任务形成第二套产品逻辑。
- T7 在所有实现与回归通过后更新 notice、审查范围并执行独立验收；不得顺手进入 #7/#8。

## 风险与防线

| 风险 | 影响 | 防线 |
| --- | --- | --- |
| sanitizer 先剥离图片 URL | file/data/blob 原因丢失并静默消失 | 在最终清理前通过 renderer/transform 分类；覆盖全部来源 fixture。 |
| 浏览器重算静态诊断 | 预览与后续复制规则漂移 | 服务端深模块是唯一静态语义来源；浏览器只补图片真实状态和短期审计。 |
| 旧响应或旧图片事件生效 | 新正文被旧诊断污染 | 对响应、DOM、target 和图片回调使用同一个 previewVersion 门禁。 |
| 图片事件早于监听 | 坏图漏报 | 注册监听后立即检查 `complete/naturalWidth`。 |
| removed source range 失真 | 点击诊断跳到错误正文 | 正文人工编辑或成功程序化替换时原子清除；不持久化或猜测重定位。 |
| 微信域名前缀误判 | 伪域名绕过普通外链处理 | URL parser + HTTPS + hostname 精确匹配 + `/s` 路径规则。 |
| 脚注开关独立保存 | revision、导入和恢复状态分叉 | 纳入完整文稿和同一 manifest 原子事务。 |
| data/blob 被当作可发布图片 | 用户误判产物能力 | 固定占位 + advisory；CSP 拒绝 data/blob；绝不创建 blob 预览。 |
| 占位或诊断回显来源 | 路径隐私泄漏或 DOM 注入 | 固定 code/文案，只保留安全 alt，统一转义与最终清理。 |
| 上游源码/notice 不一致 | 许可证追踪失真 | 固定 SHA、函数、目标文件和主动偏离；保留 WTFPL 全文。 |
| #6 顺手实现 #7/#8 | 范围膨胀与后续冲突 | 文件边界、AC 和终审明确排除复制/下载及完整布局改造。 |

## 完成定义

Issue #6 只有在以下条件全部满足时才可标记完成：

- AC-01～AC-07 全部有可复现证据；
- 所有脚注、图片、清理和定位行为符合本规格的已确认裁决；
- doocs 脚注算法的固定来源、许可、复制范围和主动偏离已记录；
- 没有新增运行时依赖，也没有复制 GPL、AGPL 或无许可证源码；
- 全量测试、语法检查和 diff 检查通过；
- 独立审查未发现未解决的阻断或重要问题；
- 交付说明不声称已完成真实微信公众号兼容验收。
