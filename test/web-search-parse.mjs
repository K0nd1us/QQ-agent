import assert from 'node:assert/strict';
import {
  buildSiteSearchUrl,
  extractImageUrls,
  extractPageDigest,
  sanitizeQuery,
  queryKeywords,
  simplifyQuery
} from '../src/web-search.js';

let pass = 0;
let fail = 0;

function test(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  PASS ${name}`);
  } catch (error) {
    fail++;
    console.error(`  FAIL ${name}: ${error.message}`);
  }
}

test('buildSiteSearchUrl 替换模板并编码关键词', () => {
  assert.equal(
    buildSiteSearchUrl('https://example.com/search?q={query}', 'C++ 教程'),
    'https://example.com/search?q=C%2B%2B%20%E6%95%99%E7%A8%8B'
  );
});

test('buildSiteSearchUrl 无占位符时追加 q 参数（保留已有参数）', () => {
  // 当前实现契约：模板无占位符时拼 &q=（已实现且文档化；不是"原样保留"）
  assert.equal(
    buildSiteSearchUrl('https://example.com/search?type=post', 'ignored'),
    'https://example.com/search?type=post&q=ignored'
  );
});

test('buildSiteSearchUrl 裸地址补充 q 参数（URL 编码）', () => {
  assert.equal(buildSiteSearchUrl('https://example.com/search', 'hello world'), 'https://example.com/search?q=hello%20world');
});

test('extractImageUrls 补全相对路径并去重（返回字符串数组）', () => {
  // 当前实现契约：返回绝对 URL 字符串数组（不带 alt；og:image 暂不提取）
  const images = extractImageUrls(`
    <img src="images/a.png" alt="A">
    <img data-src="images/a.png" alt="duplicate">
    <img srcset="/photo.webp 1x, /photo@2x.webp 2x" alt="P">
  `, 'https://example.com/articles/post');
  assert.deepEqual(images, [
    'https://example.com/articles/images/a.png',
    'https://example.com/photo.webp'
  ]);
});

test('extractImageUrls 限制结果数量', () => {
  const images = extractImageUrls('<img src="a.jpg"><img src="b.jpg">', 'https://example.com/', 1);
  assert.equal(images.length, 1);
  assert.equal(images[0], 'https://example.com/a.jpg');
});

test('extractPageDigest 提炼正文（maxChars 有 200 下限，超下限才截断）', () => {
  // 当前实现契约：截断下限 200 字符（Math.max(200, maxChars)），防止把正文截成残句
  const digest = extractPageDigest('<script>ignore()</script><p>第一段正文</p><p>第二段正文</p>', 'https://example.com/', { maxChars: 5 });
  assert.equal(digest.text, '第一段正文 第二段正文');   // 12 字符 < 200 下限，不截断
  assert.equal(digest.images.length, 0);
});

test('sanitizeQuery 清除 CQ 码和控制字符', () => {
  assert.equal(sanitizeQuery('[CQ:image,file=x]  hello\nworld\u0000'), 'hello world');
});

test('simplifyQuery 去除时间与搜索口语', () => {
  assert.equal(simplifyQuery('帮我搜一下 今日 AI 新闻'), 'AI 新闻');
});

test('queryKeywords 提取拉丁词和中文二元词', () => {
  const keywords = queryKeywords('今日 OpenAI 人工智能新闻');
  assert.deepEqual(keywords.latin, ['OpenAI']);
  assert.ok(keywords.bigrams.includes('人工'));
  assert.ok(keywords.bigrams.includes('智能'));
});

if (fail) {
  console.error(`失败 ${fail} 项，通过 ${pass} 项`);
  process.exit(1);
}
console.log(`全部 ${pass} 项通过`);
