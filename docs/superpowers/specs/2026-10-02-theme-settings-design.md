# 三套主题及独立主题设置设计规格

## 目标

在现有公众号排版工作台中提供“默认、雅致、简洁”三套主题，并让每套主题分别记忆主色、字号、行距和段间距。主题和设置属于当前排版文稿，与正文、元信息和修订号一起原子保存；切换主题只能改变表现，不能重写 Markdown 或改变渲染后的语义结构。

本规格实现 GitHub Issue #5，并保持 #2～#4 已交付的编辑、预览、自动保存、文章导入、富文本粘贴、修订冲突和恢复行为。

## 来源和许可

固定参考 [doocs/md](https://github.com/doocs/md/tree/a7c17fc4cda92e3c13aa7e24f06615cfa4219b31) 提交 `a7c17fc4cda92e3c13aa7e24f06615cfa4219b31`，许可证为 WTFPL v2。

本次只适配以下源码中的必要部分：

- `packages/shared/src/configs/theme-css/default.css`
- `packages/shared/src/configs/theme-css/grace.css`
- `packages/shared/src/configs/theme-css/simple.css`
- `packages/shared/src/configs/style.ts`
- `apps/web/src/stores/theme.ts`

沿用仓库已有的 `LICENSES/DOOCS-MD-WTFPL-2.txt`，并在 `THIRD_PARTY_NOTICES.md` 中补充雅致、简洁主题以及四项设置的来源和适配范围。不得引入 doocs 的 Vue 编辑器、Pinia、主题市场、自定义 CSS、字体选择、代码主题或其他未在 Issue #5 中要求的能力。

## 方案选择

采用“文稿内原子持久化”方案：主题选择和三套主题设置直接成为 `TypesettingDocument` 的一部分，复用现有 revision、双版本文件和 manifest 原子提交。

不采用以下方案：

- `localStorage`：无法满足随文稿保存以及服务重启后恢复的要求，也会产生浏览器与服务端状态分叉。
- 独立主题设置文件或 API：会把一次用户操作拆成两个持久化事务，增加正文与主题版本不一致的风险。
- 任意颜色输入、CSS 编辑器或自由数值：超出“有界设置”和本 Issue 范围，并扩大样式注入面。

## 文稿模型

文稿新增两个字段：

```js
{
  theme: 'default',
  themeSettings: {
    default: { primaryColor: '#0F4C81', fontSize: '16px', lineHeight: '1.75', blockSpacing: '1' },
    grace:   { primaryColor: '#0F4C81', fontSize: '16px', lineHeight: '1.75', blockSpacing: '1' },
    simple:  { primaryColor: '#0F4C81', fontSize: '16px', lineHeight: '1.75', blockSpacing: '1' }
  }
}
```

`theme` 只能是 `default`、`grace`、`simple`。`themeSettings` 在规范化后始终包含三个主题，各主题对象始终包含四个字段。切换主题只更新 `theme`；修改设置只更新当前主题对应的对象；“恢复默认”只用上述默认值替换当前主题的对象。

旧文稿缺少这两个字段时，在读取和规范化时补齐默认值，不改变正文、元信息或现有 revision。保存后自然写入新结构，不单独执行不可逆迁移。

文章链接导入只替换文章元信息和 Markdown 正文，保留当前主题和三套设置。富文本粘贴仍只修改正文。

## 有界设置

所有值使用固定选项，不接受自由文本：

| 设置 | 允许值 | 默认值 |
| --- | --- | --- |
| 主色 | `#0F4C81`、`#009874`、`#FA5151`、`#FECE00`、`#92617E`、`#55C9EA`、`#B76E79`、`#556B2F`、`#333333`、`#A9A9A9`、`#FFB7C5` | `#0F4C81` |
| 字号 | `14px`、`15px`、`16px`、`17px`、`18px` | `16px` |
| 行距 | `1.5`、`1.65`、`1.75`、`1.9`、`2.05` | `1.75` |
| 段间距 | `0.75`、`0.9`、`1`、`1.15`、`1.35` | `1` |

段间距对应 doocs 的 `blockSpacing`：它缩放主题已有的纵向节奏，而不是把所有块设置成同一个固定 margin。服务端对文稿保存和预览请求都使用同一套白名单校验；未知主题、缺失字段、额外字段或不在枚举中的值返回 400，且不得改变内存或磁盘文稿。

## 渲染边界

Markdown 仍只经过现有 `marked -> sanitize-html` 管线生成正文 HTML。主题不得参与 Markdown 解析，也不得增删、包裹或重排正文节点。

预览接口接收 `body`、`theme` 和当前主题设置，返回：

```js
{
  html,
  presentation: {
    theme,
    settings: { primaryColor, fontSize, lineHeight, blockSpacing }
  }
}
```

服务端先规范化主题和设置，客户端只使用服务端返回的 `presentation`。客户端把主题映射为预览根节点上的 `typeset-theme-default`、`typeset-theme-grace` 或 `typeset-theme-simple` 类，并设置以下四个 CSS 变量：

- `--md-primary-color`
- `--md-font-size`
- `--md-line-height`
- `--md-block-spacing`

`public/typesetting-theme.css` 继续以 `.typeset-preview` 为作用域：共用基础排版规则，默认主题保留现有行为，雅致和简洁只覆盖固定上游主题中与当前渲染器实际支持的标题、段落、引用、列表、代码、图片、链接、分隔线和表格规则。不得加载网络字体、远程 CSS 或脚本。

相同 Markdown 在三个主题下返回的 `html` 字符串必须完全一致；差异只能存在于 `presentation`、预览根类和 CSS 变量中。

## 工作台交互

在编辑区增加一个主题设置区：

- 主题选择：默认、雅致、简洁。
- 当前主题的主色、字号、行距和段间距选择器。
- “恢复当前主题默认值”按钮。

启动时从文稿加载当前主题及其设置。主题或设置变化后立即刷新预览，并复用现有 500ms 自动保存、保存状态、失败提示和 revision 冲突处理。切换主题后四个设置控件立即显示目标主题自己的值；切回时恢复之前的值。重置必须经过与普通设置修改相同的输入、预览和保存路径。

文章导入期间主题控件和重置按钮与正文控件一起禁用，防止导入事务与设置编辑交错；导入完成后显示原主题和设置。窄屏下设置区采用单列或可换行布局，不新增独立页面。

## 持久化与并发

现有 `TypesettingStore` 的原子版本写入、manifest 提交和 recovery 语义保持不变。内容相等判断扩展到主题及三套设置；任何主题变化都需要递增 revision。

同一 revision 上主题或设置不同，和正文冲突一样返回 409。保存失败、冲突或 manifest 提交失败时，内存、当前版本和 recovery 都不得暴露半保存的主题状态。刷新或服务重启后必须从已提交文稿恢复同一主题和三套设置。

## 错误处理

- 文稿或预览中的主题配置不合法：返回 400，不回退到攻击者提供的值，不持久化。
- 旧文稿缺少新字段：视为兼容迁移并补默认值，不报错。
- UI 保存失败或 409：沿用现有“未保存”和冲突提示，保留用户当前选择供人工处理。
- 预览失败：保留上一份成功预览，不把未经服务端规范化的设置应用到 DOM。

## 测试与验收

测试必须全部本地执行，不访问外网：

1. 单元测试验证默认模型、旧文稿迁移、严格枚举校验、当前主题重置以及深度内容相等判断。
2. HTTP 测试验证主题文稿保存、非法设置原子失败、刷新/重启恢复、导入保留主题，以及预览返回规范化 presentation。
3. 结构测试用包含标题、段落、强调、列表、引用、代码、图片、链接、分隔线和表格的代表性 Markdown，断言三个主题的 `html` 完全一致。
4. 浏览器测试验证主题即时切换、四项设置隔离、切回恢复、仅重置当前主题、自动保存状态和窄屏可用性。
5. 故障注入测试验证版本候选或 manifest 写入失败时，旧主题配置仍是内存与重启后的唯一可见状态。
6. 回归测试覆盖文章导入和富文本粘贴，确认它们不重置或污染主题设置。
7. 第三方说明测试或静态断言验证固定 commit、三套主题文件及 WTFPL 许可证记录存在。

## 文件职责

- `src/typesetting.js`：主题常量、严格规范化、文稿 schema、原子持久化比较和主题无关的 Markdown 渲染。
- `src/typesetting-import.js`：导入新文章内容时保留当前文稿的主题和三套设置。
- `src/server.js`：文稿与预览 API 的主题参数传递和错误响应。
- `public/typesetting.html`：固定主题及设置控件。
- `public/typesetting.js`：主题状态装载、切换、重置、预览和自动保存衔接。
- `public/typesetting-theme.css`：三套作用域主题和四个 CSS 变量。
- `public/style.css`：设置区工作台布局及窄屏适配，不承担文章主题规则。
- `test/typesetting.test.js`：模型、HTTP、浏览器、故障注入和回归证据。
- `test/typesetting-import.test.js`：文章导入保留主题设置以及既有导入错误路径的回归证据。
- `THIRD_PARTY_NOTICES.md`：固定来源、许可和适配范围。

## 非目标

- 任意 CSS、自由颜色或自由数值输入。
- 字体族、链接色、引用背景、代码主题、标题样式或主题市场。
- 修改文章导出流程、复制/下载、诊断、V2 工作台布局或真实微信公众号验收。
- 对 doocs/md 完整渲染器或 Vue 前端进行移植。
