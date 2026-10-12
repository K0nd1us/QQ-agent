// 静态 DOM 解析：不运行网页脚本，不加载图片、iframe 或其它子资源。
import { JSDOM, VirtualConsole } from 'jsdom';
import { Readability } from '@mozilla/readability';

function clipText(text, limit) {
  let end = Math.min(text.length, limit);
  if (end > 0 && end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--;
  return text.slice(0, end);
}

export function normalizePageText(text) {
  return String(text ?? '').replace(/[\t\r\f\v \u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function visibleText(root) {
  const copy = root.cloneNode(true);
  // Wiki 经常用人物头像加链接 title 表示名字；纯 textContent 会丢失干员名。
  for (const image of copy.querySelectorAll('img')) {
    const label = image.closest('a')?.getAttribute('title') || image.getAttribute('alt') || '';
    image.replaceWith(label ? ` ${label} ` : '');
  }
  for (const node of copy.querySelectorAll('br')) node.replaceWith('\n');
  for (const node of copy.querySelectorAll('p,div,section,h1,h2,h3,h4,li,tr,blockquote,pre')) {
    node.append('\n');
  }
  return normalizePageText(copy.textContent);
}

/** 正文在截断之前提取。日期保留页面原文，发布时间和更新时间分开。 */
export function extractWebPage(body, url, { contentType = '', maxChars = 20000 } = {}) {
  const raw = String(body ?? '');
  const cap = Math.max(200, Math.min(20000, Number(maxChars) || 20000));
  const isHtml = /(?:text\/html|application\/xhtml\+xml)/i.test(contentType)
    || (!contentType && /<(?:!doctype\s+html|html|head|body|main|article|p|div)\b/i.test(raw));
  if (!isHtml) return { title: '', publishedTime: '', modifiedTime: '', extraction: 'text',
    body: clipText(raw, cap), truncated: raw.length > cap };

  const dom = new JSDOM(raw, { url, virtualConsole: new VirtualConsole() });
  try {
    const doc = dom.window.document;
    const meta = (names) => {
      for (const name of names) {
        const value = doc.querySelector(`meta[property="${name}"],meta[name="${name}"],meta[itemprop="${name}"]`)?.getAttribute('content');
        if (value?.trim()) return value.trim().slice(0, 120);
      }
      return '';
    };
    const title = normalizePageText(doc.querySelector('h1')?.textContent || meta(['og:title']) || doc.title).slice(0, 300);
    let publishedTime = meta(['article:published_time', 'datePublished', 'pubdate', 'publishdate', 'date']);
    let modifiedTime = meta(['article:modified_time', 'dateModified', 'last-modified']);
    for (const script of [...doc.querySelectorAll('script[type="application/ld+json"]')].slice(0, 10)) {
      try {
        const scan = (value, depth = 0) => {
          if (!value || typeof value !== 'object' || depth > 5) return;
          if (Array.isArray(value)) { value.slice(0, 30).forEach(v => scan(v, depth + 1)); return; }
          if (/(?:Article|BlogPosting|WebPage)/i.test(String(value['@type'] || ''))) {
            if (!publishedTime && typeof value.datePublished === 'string') publishedTime = value.datePublished.slice(0, 120);
            if (!modifiedTime && typeof value.dateModified === 'string') modifiedTime = value.dateModified.slice(0, 120);
          }
          if (value['@graph']) scan(value['@graph'], depth + 1);
        };
        scan(JSON.parse(script.textContent));
      } catch { /* 无效 JSON-LD 不影响正文 */ }
    }
    // time 必须明确标识日期用途；不把正文任意事件时间误当文章发布日期。
    publishedTime ||= doc.querySelector('time[itemprop="datePublished"]')?.getAttribute('datetime') || '';
    modifiedTime ||= doc.querySelector('time[itemprop="dateModified"]')?.getAttribute('datetime') || '';
    let article = null;
    try {
      article = new Readability(doc.cloneNode(true), { maxElemsToParse: 30000, charThreshold: 100 }).parse();
    } catch { /* 超复杂页面退回确定性正文选择 */ }
    publishedTime ||= article?.publishedTime || '';
    for (const node of doc.querySelectorAll('script,style,noscript,nav,header,footer,aside,form,iframe,svg,canvas,template,[hidden],[aria-hidden="true"],[style*="display:none"],[style*="display: none"],.mw-editsection,.toc,.navbox')) node.remove();
    // MediaWiki 的正文容器比阅读器对表格/干员列表的判断更可靠。
    const explicit = doc.querySelector('.mw-parser-output')
      || doc.querySelector('article,main,[role="main"],#article-content,.article-content,.post-content,.entry-content');
    let text = explicit ? visibleText(explicit) : '';
    let extraction = explicit ? 'main' : 'readability';
    if (!text && article?.textContent) text = normalizePageText(article.textContent);
    if (!text) { text = visibleText(doc.body); extraction = 'body'; }
    return { title: title || article?.title || '', publishedTime, modifiedTime, extraction,
      body: clipText(text, cap), truncated: text.length > cap };
  } finally {
    dom.window.close();
  }
}
