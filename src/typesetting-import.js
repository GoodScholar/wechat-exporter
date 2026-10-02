import { getWeChatMessageType, normalizeUrl, parseArticle, renderArticleBodyMarkdown } from './article.js';

const fields = ['title', 'author', 'account', 'publishedAt', 'body'];

export class TypesettingImportError extends Error {
  constructor(code, status, message, action) {
    super(message);
    this.code = code;
    this.status = status;
    this.action = action;
  }

  toJSON() { return { code: this.code, message: this.message, action: this.action }; }
}

const fail = (code, status, message, action) => { throw new TypesettingImportError(code, status, message, action); };
const hasContent = document => fields.some(field => document[field].trim());

function normalizePublishedAt(value) {
  const match = String(value).match(/(\d{4})\s*(?:年|[-/.])\s*(\d{1,2})\s*(?:月|[-/.])\s*(\d{1,2})/);
  return match ? `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}` : '';
}

function mapArticleError(error) {
  const details = {
    ACCESS_VERIFICATION: [403, '微信要求访问验证，完成浏览器验证后重试。', '完成验证后重新导入。'],
    ARTICLE_UNAVAILABLE: [410, '文章已删除或不可查看，请确认链接仍可访问。', '在微信中确认原文后重试。'],
    EMPTY_BODY: [422, '文章正文为空，暂时无法导入编辑。', '请确认这是包含正文的普通文章。'],
    IMAGE_MESSAGE: [422, '图片消息暂不支持编辑。', '请返回文章导出功能查看原文。'],
    UNSUPPORTED_MESSAGE: [422, '该消息类型暂不支持导入编辑。', '请返回文章导出功能查看原文。']
  }[error.code];
  if (details) fail(error.code, ...details);
  fail('UNSUPPORTED_MESSAGE', 422, '该文章暂不支持导入编辑。', '请返回文章导出功能查看原文。');
}

export async function importTypesettingDocument({ typesetting, fetchArticle, url, revision, confirmed }) {
  const current = await typesetting.load();
  if (!Number.isSafeInteger(revision) || revision !== current.revision) fail('REVISION_CONFLICT', 409, '文稿已在其他页面更新，请刷新后重试。', '刷新页面后重新导入。');
  if (hasContent(current) && confirmed !== true) fail('CONFIRM_REQUIRED', 409, '当前文稿已有内容，请确认替换后再导入。', '确认替换当前文稿后重试。');
  let articleUrl;
  try { articleUrl = normalizeUrl(url); }
  catch { fail('INVALID_LINK', 400, '请输入完整的微信公众号文章链接。', '复制 mp.weixin.qq.com 的完整文章链接后重试。'); }
  let html;
  try { html = await fetchArticle(articleUrl); }
  catch { fail('NETWORK_READ', 502, '读取文章失败，请检查网络或稍后重试。', '确认文章可访问后重试。'); }
  const messageType = getWeChatMessageType(html);
  if (messageType === '8') fail('IMAGE_MESSAGE', 422, '图片消息暂不支持编辑。', '请返回文章导出功能查看原文。');
  if (messageType && messageType !== '0') fail('UNSUPPORTED_MESSAGE', 422, '该消息类型暂不支持导入编辑。', '请返回文章导出功能查看原文。');
  let article;
  try { article = parseArticle(html, articleUrl); }
  catch (error) {
    if (error.emptyBody) fail('EMPTY_BODY', 422, '文章正文为空，暂时无法导入编辑。', '请确认这是包含正文的普通文章。');
    mapArticleError(error);
  }
  const candidate = { title: article.title, author: article.author, account: article.account, publishedAt: normalizePublishedAt(article.date), body: renderArticleBodyMarkdown(article), revision: revision + 1 };
  try { return await typesetting.save(candidate); }
  catch (error) {
    if (error.status === 409) fail('REVISION_CONFLICT', 409, '文稿已在其他页面更新，请刷新后重试。', '刷新页面后重新导入。');
    throw error;
  }
}
