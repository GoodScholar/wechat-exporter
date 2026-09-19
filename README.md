# 留篇 · 公众号文章导出

在本机浏览器中粘贴微信公众号文章链接，导出 Markdown、HTML、PDF 和图片。项目仓库：[GoodScholar/wechat-exporter](https://github.com/GoodScholar/wechat-exporter)。

## 安装与启动

需要 Node.js 22 或更高版本，以及 Playwright 支持的 Chromium。

```bash
git clone https://github.com/GoodScholar/wechat-exporter.git
cd wechat-exporter
npm ci
npm run setup:browser
npm start
```

打开 <http://127.0.0.1:4318>。后续启动只需 `npm start`。端口冲突时可运行 `PORT=4319 npm start`；如需使用已安装的 Chrome 或 Chromium，可将 `CHROME_PATH` 设置为其可执行文件路径。

## 工作方式

后端是仅监听 `127.0.0.1` 的 Node.js/Express 服务，负责文章抓取、格式转换、任务历史和本地归档；`public/` 中的静态前端通过本地 API 提交与查看任务。工具不需要 API Key，也不调用第三方导出服务。

1. 粘贴文章链接（每行一篇，也支持含链接的分享文本），每批最多 50 篇。
2. 选择 Markdown、HTML、PDF 中的一种或多种格式，点击「开始导出」。
3. 在导出记录中下载单篇 ZIP，或打包下载当前批次中已成功的文章。
4. 遇到微信访问验证时，点击「浏览器验证」，在打开的独立浏览器中自行完成验证并保持文章页面打开，然后回到工具点击「重试失败项」。工具不会自动处理验证码，也不会读取日常浏览器的登录信息。

每篇 ZIP 可包含 `article.md`、`article.html`、`article.pdf`、下载成功的 `images/` 和 `metadata.json`；仅生成所选格式。`.data/exports/` 存储导出包，`.data/jobs.json` 保存任务历史，`.data/browser-profile/` 保存独立验证浏览器的 profile。关闭服务和验证浏览器后删除 `.data/`，即可清除全部本地数据。

同一批次会合并重复链接；已有完整导出且格式组合相同的文章会复用本地文件。这是本地归档缓存，不会检测原文更新。

## 支持范围与限制

- 支持 `mp.weixin.qq.com/s/短链接` 和含 `__biz`、`mid`、`idx`、`sn` 的长链接。
- 仅支持能访问到正文的图文文章。删除、付费受限、账号迁移、风控验证或特殊消息类型可能无法导出。
- 保留正文常见结构、表格、代码、链接和部分文字样式；HTML/PDF 采用阅读排版，不保证与微信原排版完全一致。
- 不导出音视频、评论、阅读量、互动组件和公众号历史文章列表。
- 图片下载失败时会保留提示及资源地址；只下载微信常用图片域名的 JPEG、PNG、GIF、WebP，单张最多 15 MB、单篇最多 150 张，累计 60 MB 后停止后续图片下载。
- 文章顺序处理，两篇之间间隔 1.5 秒；请求超时或失败后需手动重试，避免连续自动请求。

## 测试

安装 Chromium 后运行：

```bash
npm test
```

测试覆盖链接校验、去重、正文清理、验证/删除/迁移页面识别、离线图片、PDF 生成、任务失败重试和持久化，以及浏览器中的提交与下载流程。自动化测试使用固定文章输入；真实微信文章的可访问性需另外实测。

## 许可证

本项目采用 [MIT License](LICENSE)。
