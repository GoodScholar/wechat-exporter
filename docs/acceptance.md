# 场景验收清单

验收日期：2026-09-19。产品代码基线：`b245606`。本轮仅增加验收测试和清单，未修改产品行为。

## 结论与范围

已为下表列出的核心功能场景建立自动化验收，真实文章、全新安装和网页下载流程也已实测。以下“通过”仅对应列出的输入、平台和检查，不代表任意外部服务、微信页面或操作系统都已验收。外部条件未满足的项目明确列为待验收。

运行全部自动化验收：

```bash
npm ci
npm run setup:browser
npm test
```

本轮本地全量执行 62 项测试，62 项通过、0 项失败、0 项跳过。所有自动化测试使用临时目录，不改动日常使用的 `.data` 或历史归档。

## 自动化验收矩阵

| 场景 | 覆盖与成功标准 | 证据文件 |
| --- | --- | --- |
| 链接输入 | 短/长链接规范化、混合分享文字、重复及非法输入、空输入、50 篇允许而 51 篇拒绝 | `article.test.js`、`deep-boundaries.test.js`、`acceptance-matrix.test.js` |
| 格式选择 | Markdown、HTML、PDF 全部 7 种非空组合；仅包含选择的文件；真实 Chromium 生成 PDF | `acceptance-matrix.test.js` |
| 正文与元数据 | 标题、作者、公众号、日期，脚本清理，空正文拒绝，删除/迁移/验证错误识别 | `article.test.js` |
| 图片与离线阅读 | Markdown 本地图片、HTML 内嵌图片、图片文件一致性、缺图提示 | `exporter.test.js`、`acceptance-matrix.test.js` |
| 资源限制 | 单图 15 MiB、文章响应 8 MiB 的等于/超出边界；累计图片 60 MiB、最多 150 张、重复图片复用 | `acceptance-matrix.test.js`、`deep-boundaries.test.js` |
| 导出排版 | 深色背景白字可读、禁止外部背景，窄屏表格短值完整、键盘横向滚动、打印宽度适配 | `ui.test.js`、`reading-layout.test.js` |
| 整批执行 | 50 篇全部保存真实 ZIP、内容与 URL 对应、批内去重、后续重复批次复用 | `acceptance-matrix.test.js` |
| 导出失败与重试 | 部分成功保留下载、仅补失败格式，重启后保留正文和图片缓存 | `backend-upgrades.test.js`、`integration-upgrades.test.js`、`retry-regressions.test.js` |
| PDF 环境缺失 | 真实浏览器启动失败保留其他格式，恢复环境后用缓存生成 PDF | `acceptance-matrix.test.js` |
| 取消与并发 | 排队/进行中取消、迟到结果不落盘、重复取消及重试、阶段成果保留、全部格式完成时成功 | `deep-boundaries.test.js`、`retry-regressions.test.js` |
| 进程异常退出 | 子进程在导出中被 SIGKILL；重启将运行/排队任务标记中断，重试恢复全部 ZIP | `acceptance-matrix.test.js` |
| 保存目录 | 修改/恢复默认目录、新旧目录兼容、长中文文件名、非法目录拒绝、目录被文件占用后恢复 | `backend-upgrades.test.js`、`integration-upgrades.test.js`、`deep-boundaries.test.js` |
| 文件丢失 | 缺失 ZIP 后移除下载入口，单篇/整批恢复，部分格式缓存继续有效 | `archive-availability.test.js`、`retry-regressions.test.js` |
| 下载 | 浏览器实际下载单篇与批量 ZIP、归档内容校验、无文件返回错误 | `ui.test.js`、`deep-boundaries.test.js` |
| 历史记录 | 跨批次标题/公众号搜索、状态组合、空结果、清空、轮询保留、新建任务清空 | `history-filter.test.js` |
| 恢复提示 | 文件缺失、PDF 缺浏览器、微信验证、不支持消息、网络失败显示对应操作 | `recovery-guidance.test.js` |
| RSS / Atom | 两种格式、链接回退、去重、日期、500 条上限、DTD/实体拒绝 | `feeds.test.js` |
| RSS 网络 | 真实本地 HTTP、同源跳转、跨源/凭据拒绝、401/403/404/500、跳转循环、超时、gzip 解压后 5 MiB 限制 | `feed-network.test.js`、`acceptance-matrix.test.js` |
| RSS 页面 | 预览不导出、标题/日期筛选、最多勾选 50 篇、换源和旧请求隔离、所选原文进入导出队列 | `rss-ui.test.js`、`rss-integration.test.js` |
| 常用订阅源 | 保存/改名/去重/切换/删除/重启持久化；失败不覆盖原值、删除不删归档 | `saved-feeds.test.js`、`saved-feeds-ui.test.js` |
| API 异常输入与访问边界 | JSON 错误、错误类型和过大请求不创建任务、不改变目录，之后仍可正常导出；跨站写请求和非微信资源拒绝 | `deep-boundaries.test.js`、`feed-network.test.js`、`ui.test.js`、`exporter.test.js` |
| 手机页面 | 390px 下主要输入、记录、RSS、恢复按钮无整页横向溢出 | 多个浏览器 UI 测试 |

证据文件均位于 `test/`。网络边界测试会替换外部传输响应；正文解析、流读取、归档生成和容量检查使用真实代码。RSS 网络测试运行真实本地 HTTP 服务。固定文章样本不等同于微信当前可访问性测试。

## 已完成的真实环境实测（复用本次会话结果）

| 项目 | 已验证结果 |
| --- | --- |
| macOS / Node.js 24 | 从已提交代码解包到全新临时目录，`npm ci`、`npm start` 成功 |
| 全新服务网页导出 | 通过页面提交真实微信文章，三种格式成功；浏览器下载有效 ZIP；重启后历史记录和下载正常 |
| 长文、表格、多图 | 三篇真实样本；PDF 分别为 13、2、19 页，检查分页预览；5 张 Markdown 表格和 16 处图片引用有对应内容/文件 |
| 窄屏阅读 | 320px、390px 与 1280px 下检查真实文章；修复表格短值拆行后复查，通过 |
| 日常服务只读检查 | 历史记录、搜索、RSS 模式切换、单篇与整批下载正常；无页面脚本错误；原有 2 项任务、2 个 ZIP 内容未变 |
| Linux / Node.js 22 | GitHub Actions 执行全新依赖安装、Chromium 安装与全量测试；以对应提交的绿色 CI 为准 |

## 尚未完成或不作保证的场景

| 项目 | 原因与后续验收所需条件 |
| --- | --- |
| 第三方订阅服务端到端 | 尚无用户实际 RSS 地址；未验收其部署、微信扫码登录、授权过期及历史文章同步。标准 RSS 接口及本地服务测试已完成 |
| 微信人工访问验证 | 未具备可稳定复现且可人工完成的验证挑战；错误识别和恢复入口已测，实际完成验证码后继续导出仍待该条件出现时实测 |
| 系统交互 | 系统文件管理器打开、剪贴板权限提示、浏览器自定义保存对话框未逐个平台人工验收；部分自动化使用系统接口替身 |
| 其他平台 | Windows、原生 Linux 桌面、Safari、Firefox、iOS/Android 真机未进行完整人工验收；Chromium 手机视口模拟不能代替真机 |
| 外部内容可用性 | 删除、付费受限、平台风控、特殊消息类型和网络中断不承诺成功导出；工具应提供相应失败信息 |
| 长期及物理故障 | 未进行数日持续负载、磁盘真正耗尽、断电、硬件损坏或任意手工破坏 JSON/ZIP 的恢复验收；目录故障和进程强杀已覆盖 |

不在产品支持范围内：音视频、评论、互动组件、阅读量、自动补齐公众号全部历史文章、自动破解验证码，以及与微信原版逐像素一致的排版。
