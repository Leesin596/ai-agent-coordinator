// ============================================================
// WebToolExecutor — 内置联网工具（零 Key 零配置开箱即用）
// web_search: Jina Search API → Bing HTML → DuckDuckGo Lite 降级
// web_fetch:  Jina Reader → 本地 htmlToMarkdown 降级
// 安全: 域名黑名单 + 协议限制 + 超时控制
// ============================================================
import * as vscode from 'vscode';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /** 深度抓取的网页正文（可选，fetchContent=true 时填充） */
  content?: string;
}

export interface FetchResult {
  url: string;
  content: string;
  truncated: boolean;
  format: 'markdown' | 'text';
}

type SearchProvider = 'bing' | 'duckduckgo' | 'baidu' | 'mojeek' | 'searxng' | 'tavily' | 'brave';

interface WebToolConfig {
  searchProvider: SearchProvider;
  searchApiKey: string;
  searxngUrl: string;
  jinaReaderEnabled: boolean;
  denyDomains: string[];
  maxFetchSize: number;
  requestTimeoutMs: number;
  searchFetchCount: number;
  searchFetchLength: number;
}

const DEFAULT_DENY_DOMAINS = ['localhost', '127.0.0.1', '0.0.0.0'];
const MAX_QUERY_LENGTH = 500;
const MAX_URL_LENGTH = 2000;
const MAX_SEARCH_RESULTS = 10;
const DEFAULT_SEARCH_RESULTS = 5;
const MAX_FETCH_LENGTH = 50000;
const DEFAULT_FETCH_LENGTH = 8000;
const MIN_FETCH_LENGTH = 500;

function readConfig(): WebToolConfig {
  const config = vscode.workspace.getConfiguration('coordinator.web');
  return {
    searchProvider: (config.get<SearchProvider>('searchProvider', 'bing')),
    searchApiKey: config.get<string>('searchApiKey', ''),
    searxngUrl: config.get<string>('searxngUrl', ''),
    jinaReaderEnabled: config.get<boolean>('jinaReaderEnabled', true),
    denyDomains: config.get<string[]>('denyDomains', DEFAULT_DENY_DOMAINS),
    maxFetchSize: config.get<number>('maxFetchSize', 50000),
    requestTimeoutMs: config.get<number>('requestTimeoutMs', 10000),
    searchFetchCount: config.get<number>('searchFetchCount', 3),
    searchFetchLength: config.get<number>('searchFetchLength', 4000),
  };
}

function requiredString(values: Record<string, unknown>, key: string, maxLength: number): string {
  const value = typeof values[key] === 'string' ? (values[key] as string).trim() : '';
  if (!value) throw new Error(`${key} 必须是非空字符串`);
  if (value.length > maxLength) throw new Error(`${key} 超过允许长度`);
  return value;
}

function optionalInteger(values: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const value = values[key];
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${key} 必须是 ${min}-${max} 的整数`);
  }
  return value as number;
}

/** HTML 实体解码（零依赖） */
function decodeEntities(text: string): string {
  const entities: Record<string, string> = {
    '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
    '&nbsp;': ' ', '&#x27;': "'", '&apos;': "'", '&copy;': '©', '&reg;': '®',
  };
  return text
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&[a-zA-Z]+;/g, (match) => entities[match] || match);
}

/** HTML 转 Markdown（零依赖，保留标题/列表/链接/加粗结构） */
function htmlToMarkdown(html: string): string {
  return html
    // 移除 script/style/nav/header/footer/noscript/aside 内容
    .replace(/<(script|style|nav|header|footer|noscript|aside|iframe|svg)[^>]*>[\s\S]*?<\/\1>/gi, '')
    // 移除 HTML 注释
    .replace(/<!--[\s\S]*?-->/g, '')
    // 标题 → Markdown 标题
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n')
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n')
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n')
    .replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '\n#### $1\n')
    .replace(/<h[56][^>]*>([\s\S]*?)<\/h[56]>/gi, '\n##### $1\n')
    // 加粗/斜体
    .replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**')
    .replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*')
    // 链接 → [text](url)
    .replace(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
    // 代码块
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '\n```\n$1\n```\n')
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
    // 引用
    .replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, '\n> $1\n')
    // <br> / <p> / <div> 转换行
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|section|article|tr|table)>/gi, '\n')
    // <li> 前缀
    .replace(/<li[^>]*>/gi, '- ')
    // 移除所有剩余标签
    .replace(/<[^>]+>/g, '')
    // 解码 HTML 实体
    .replace(/&[a-zA-Z]+;|&#\d+;|&#x[0-9a-fA-F]+;/g, (match) => {
      if (match.startsWith('&#')) return decodeEntities(match);
      const named: Record<string, string> = {
        '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&nbsp;': ' ',
        '&apos;': "'", '&copy;': '©', '&reg;': '®',
      };
      return named[match] || match;
    })
    // 压缩空白
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 从长文本中截取与 prompt 最相关的段落（简单关键词匹配） */
function extractRelevantSection(content: string, prompt: string, maxLength: number): string {
  if (content.length <= maxLength) return content;
  // 提取 prompt 中的关键词
  const keywords = prompt.toLowerCase().split(/[\s,，。、;；]+/).filter(k => k.length > 2).slice(0, 10);
  if (keywords.length === 0) return content.slice(0, maxLength);
  // 按段落分割
  const paragraphs = content.split(/\n{2,}/);
  // 给每个段落打分
  const scored = paragraphs.map((p, i) => {
    const lower = p.toLowerCase();
    let score = 0;
    for (const kw of keywords) {
      if (lower.includes(kw)) score += kw.length;
    }
    return { text: p, index: i, score };
  });
  // 按分数降序，取 top 段落直到达到 maxLength
  scored.sort((a, b) => b.score - a.score);
  const selected: string[] = [];
  let totalLen = 0;
  for (const s of scored) {
    if (totalLen + s.text.length > maxLength) break;
    selected.push(s.text);
    totalLen += s.text.length;
  }
  // 如果没选到任何段落（所有段落都超长），取前面的
  if (selected.length === 0) return content.slice(0, maxLength);
  // 按原始顺序排列
  selected.sort((a, b) => {
    const ia = paragraphs.indexOf(a);
    const ib = paragraphs.indexOf(b);
    return ia - ib;
  });
  return selected.join('\n\n');
}

/** 带超时的 HTTP GET（零依赖，使用 Node.js 内置 fetch + AbortController） */
async function httpGet(url: string, timeoutMs: number, headers?: Record<string, string>): Promise<{ status: number; statusText: string; body: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        ...headers,
      },
    });
    const body = await response.text();
    return { status: response.status, statusText: response.statusText, body };
  } catch (err: any) {
    if (err.name === 'AbortError') throw new Error(`请求超时 (${timeoutMs}ms)`);
    throw new Error(`网络请求失败: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

/** 带超时的 HTTP POST（用于 Tavily/Brave API） */
async function httpPost(url: string, body: string, timeoutMs: number, headers?: Record<string, string>): Promise<{ status: number; statusText: string; body: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body,
    });
    const text = await response.text();
    return { status: response.status, statusText: response.statusText, body: text };
  } catch (err: any) {
    if (err.name === 'AbortError') throw new Error(`请求超时 (${timeoutMs}ms)`);
    throw new Error(`网络请求失败: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

/** 解析 Bing 搜索结果页 HTML */
function parseBingResults(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];
  // Bing 结果块: <li class="b_algo">...</li>
  const blockRegex = /<li[^>]*class="[^"]*b_algo[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
  let blockMatch: RegExpExecArray | null;
  while ((blockMatch = blockRegex.exec(html)) !== null && results.length < maxResults) {
    const block = blockMatch[1];
    // 标题+URL: <h2><a href="...">title</a></h2>
    const linkMatch = block.match(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;
    const url = linkMatch[1];
    const title = htmlToMarkdown(linkMatch[2]);
    if (!title || !url || !url.startsWith('http')) continue;
    // 摘要: 第一个 <p> 或 class 含 snippet 的标签
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i) || block.match(/class="[^"]*b_caption[^"]*"[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = snippetMatch ? htmlToMarkdown(snippetMatch[1]) : '';
    results.push({ title, url, snippet });
  }
  return results;
}

/** 解析 DuckDuckGo Lite 搜索结果页 HTML */
function parseDuckDuckGoLite(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];
  // DDG Lite: 结果链接 class="result-link"，摘要 class="result-snippet"
  const linkRegex = /<a[^>]+class="[^"]*result-link[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let linkMatch: RegExpExecArray | null;
  const links: Array<{ url: string; title: string }> = [];
  while ((linkMatch = linkRegex.exec(html)) !== null) {
    const url = linkMatch[1];
    const title = htmlToMarkdown(linkMatch[2]);
    if (title && url) links.push({ url, title });
  }
  // 摘要
  const snippetRegex = /<td[^>]+class="[^"]*result-snippet[^"]*"[^>]*>([\s\S]*?)<\/td>/gi;
  const snippets: string[] = [];
  let snippetMatch: RegExpExecArray | null;
  while ((snippetMatch = snippetRegex.exec(html)) !== null) {
    snippets.push(htmlToMarkdown(snippetMatch[1]));
  }
  for (let i = 0; i < links.length && results.length < maxResults; i++) {
    results.push({
      title: links[i].title,
      url: links[i].url,
      snippet: snippets[i] || '',
    });
  }
  return results;
}

/** 解析 Baidu 搜索结果页 HTML */
function parseBaiduResults(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];
  // 百度结果块: <div class="result ..."> 或 <div class="c-container ...">
  const blockRegex = /<div[^>]*class="[^"]*(?:result|c-container)[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]*class="[^"]*(?:result|c-container)|$)/gi;
  let blockMatch: RegExpExecArray | null;
  while ((blockMatch = blockRegex.exec(html)) !== null && results.length < maxResults) {
    const block = blockMatch[1];
    const linkMatch = block.match(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;
    const url = linkMatch[1];
    const title = htmlToMarkdown(linkMatch[2]);
    if (!title || !url) continue;
    // 百度摘要: class 含 "content-right" 或第二个 <span>
    const snippetMatch = block.match(/class="[^"]*content-right[^"]*"[^>]*>([\s\S]*?)</i) || block.match(/<span[^>]*>([\s\S]*?)<\/span>/i);
    const snippet = snippetMatch ? htmlToMarkdown(snippetMatch[1]) : '';
    results.push({ title, url: url.startsWith('http') ? url : `https://www.baidu.com${url}`, snippet });
  }
  return results;
}

/** 解析 Mojeek 搜索结果页 HTML */
function parseMojeekResults(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];
  // Mojeek: <a class="ob-title" href="...">title</a> + <p class="s">snippet</p>
  const blockRegex = /<a[^>]+class="[^"]*ob-title[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<p[^>]*class="[^"]*s[^"]*"[^>]*>([\s\S]*?)<\/p>)?/gi;
  let match: RegExpExecArray | null;
  while ((match = blockRegex.exec(html)) !== null && results.length < maxResults) {
    const url = match[1];
    const title = htmlToMarkdown(match[2]);
    const snippet = match[3] ? htmlToMarkdown(match[3]) : '';
    if (title && url) results.push({ title, url, snippet });
  }
  return results;
}

/** 计算 N 天前的 ISO 日期字符串 (YYYYMMDD)，用于 Bing 时间过滤 */
function isoDateDaysAgo(days: number): string {
  const d = new Date(Date.now() - days * 86400000);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

/** 验证 URL 安全性 */
function validateUrl(url: string, denyDomains: string[]): { protocol: string; hostname: string } {
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    throw new Error('URL 必须以 http:// 或 https:// 开头');
  }
  if (url.length > MAX_URL_LENGTH) throw new Error('URL 超过允许长度');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('URL 格式无效');
  }
  const hostname = parsed.hostname.toLowerCase();
  for (const denied of denyDomains) {
    if (hostname === denied.toLowerCase() || hostname.endsWith(`.${denied.toLowerCase()}`)) {
      throw new Error(`域名被安全策略禁止: ${hostname}`);
    }
  }
  return { protocol: parsed.protocol, hostname };
}

export class WebToolExecutor {
  private config: WebToolConfig;

  constructor() {
    this.config = readConfig();
  }

  /** 刷新配置（用户修改设置后调用） */
  refreshConfig(): void {
    this.config = readConfig();
  }

  async search(values: Record<string, unknown>): Promise<{ results: SearchResult[]; provider: string }> {
    // 支持 queries 数组（多查询并行搜索）或单个 query
    const queries: string[] = [];
    if (Array.isArray(values.queries)) {
      for (const q of values.queries) {
        if (typeof q === 'string' && q.trim()) queries.push(q.trim().slice(0, MAX_QUERY_LENGTH));
      }
    }
    if (queries.length === 0 && typeof values.query === 'string' && values.query.trim()) {
      queries.push(values.query.trim().slice(0, MAX_QUERY_LENGTH));
    }
    if (queries.length === 0) throw new Error('query 或 queries 必须提供至少一个非空搜索关键词');
    if (queries.length > 5) throw new Error('最多支持 5 个并行搜索关键词');

    const maxResults = optionalInteger(values, 'maxResults', DEFAULT_SEARCH_RESULTS, 1, MAX_SEARCH_RESULTS);
    const fetchContent = typeof values.fetchContent === 'boolean' ? values.fetchContent : true;
    const recencyDays = typeof values.recencyDays === 'number' && values.recencyDays > 0
      ? Math.min(Math.floor(values.recencyDays), 365)
      : 0;

    // 多查询并行搜索
    if (queries.length > 1) {
      const searchTasks = queries.map(q => this.searchSingle(q, maxResults, fetchContent, recencyDays));
      const searchResults = await Promise.all(searchTasks);
      // 合并去重（按 URL 去重）
      const seen = new Set<string>();
      const merged: SearchResult[] = [];
      let usedProvider = '';
      for (const { results, provider } of searchResults) {
        usedProvider = usedProvider || provider;
        for (const r of results) {
          if (!seen.has(r.url)) {
            seen.add(r.url);
            merged.push(r);
          }
        }
      }
      return { results: merged.slice(0, maxResults * 2), provider: usedProvider };
    }

    return this.searchSingle(queries[0], maxResults, fetchContent, recencyDays);
  }

  private async searchSingle(query: string, maxResults: number, fetchContent: boolean, recencyDays: number): Promise<{ results: SearchResult[]; provider: string }> {
    const provider = this.config.searchProvider;

    // API 引擎（Tavily / Brave / SearXNG）直接返回，不走深度抓取
    if (provider === 'tavily') {
      if (!this.config.searchApiKey) throw new Error('Tavily 搜索需要配置 coordinator.web.searchApiKey');
      return this.searchTavily(query, maxResults);
    }
    if (provider === 'brave') {
      if (!this.config.searchApiKey) throw new Error('Brave 搜索需要配置 coordinator.web.searchApiKey');
      return this.searchBrave(query, maxResults);
    }
    if (provider === 'searxng') {
      if (!this.config.searxngUrl) throw new Error('SearXNG 搜索需要配置 coordinator.web.searxngUrl');
      return this.searchSearXNG(query, maxResults);
    }

    // ┌─────────────────────────────────────────────────────────────┐
    // │ 第 1 优先: Jina Search API (s.jina.ai)                      │
    // │ 零配置，一次请求返回搜索结果 + 页面正文，无需深度抓取        │
    // └─────────────────────────────────────────────────────────────┘
    if (this.config.jinaReaderEnabled && provider !== 'baidu' && provider !== 'mojeek') {
      try {
        const jinaResults = await this.searchJina(query, maxResults, recencyDays);
        if (jinaResults.length > 0) {
          return { results: jinaResults, provider: 'jina' };
        }
      } catch {
        // 降级到 HTML 引擎
      }
    }

    // ┌─────────────────────────────────────────────────────────────┐
    // │ 第 2 优先: HTML 引擎降级链                                  │
    // │ 指定引擎 → DuckDuckGo → 空结果                              │
    // └─────────────────────────────────────────────────────────────┘
    // 构建 Bing 时间过滤参数 (recencyDays)
    const bingFilters = recencyDays > 0
      ? `&filters=ex1%3a%22ez5_${isoDateDaysAgo(recencyDays)}%22`
      : '';

    const parsers: Record<string, { url: (q: string, n: number) => string; parse: (html: string, n: number) => SearchResult[] }> = {
      bing: {
        url: (q, n) => `https://www.bing.com/search?q=${encodeURIComponent(q)}&count=${n}${bingFilters}`,
        parse: parseBingResults,
      },
      baidu: {
        url: (q, n) => `https://www.baidu.com/s?wd=${encodeURIComponent(q)}&rn=${n}${recencyDays > 0 ? '&gpc=stf%3D' + Math.floor(Date.now() / 1000 - recencyDays * 86400) + '%2C' + Math.floor(Date.now() / 1000) : ''}`,
        parse: parseBaiduResults,
      },
      mojeek: {
        url: (q, n) => `https://www.mojeek.com/search?q=${encodeURIComponent(q)}&count=${n}`,
        parse: parseMojeekResults,
      },
      duckduckgo: {
        url: (q) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`,
        parse: parseDuckDuckGoLite,
      },
    };

    let results: SearchResult[] = [];
    let usedProvider = provider;

    const primary = parsers[provider];
    if (primary) {
      try {
        const { status, body } = await httpGet(primary.url(query, maxResults), this.config.requestTimeoutMs);
        if (status >= 200 && status < 300) {
          results = primary.parse(body, maxResults);
        }
      } catch {
        // 降级到 DuckDuckGo
      }
      // 降级到 DuckDuckGo（如果主引擎不是 DDG 本身）
      if (results.length === 0 && provider !== 'duckduckgo') {
        try {
          const { status, body } = await httpGet(parsers.duckduckgo.url(query, maxResults), this.config.requestTimeoutMs);
          if (status >= 200 && status < 300) {
            results = parseDuckDuckGoLite(body, maxResults);
            usedProvider = 'duckduckgo';
          }
        } catch {
          // 最终降级
        }
      }
    }

    if (results.length === 0) return { results, provider: usedProvider };

    // 深度抓取 Top N 结果的网页正文，让 LLM 拿到完整内容而非仅摘要
    if (fetchContent && this.config.searchFetchCount > 0) {
      const fetchCount = Math.min(this.config.searchFetchCount, results.length);
      const fetchTasks = results.slice(0, fetchCount).map(async (r) => {
        try {
          r.content = await this.fetchUrlContent(r.url, this.config.searchFetchLength);
        } catch {
          // 抓取失败不影响搜索结果本身
        }
      });
      await Promise.all(fetchTasks);
    }

    return { results, provider: usedProvider };
  }

  /** Jina Search API: 一次请求返回搜索结果 + 页面正文 */
  private async searchJina(query: string, maxResults: number, _recencyDays: number): Promise<SearchResult[]> {
    const searchUrl = `https://s.jina.ai/${encodeURIComponent(query)}`;
    const headers: Record<string, string> = {
      'Accept': 'application/json',
      'X-Retain-Images': 'none',
      'X-Max-Tokens': String(this.config.searchFetchLength * maxResults),
    };

    const { status, body } = await httpGet(searchUrl, Math.min(this.config.requestTimeoutMs, 12000), headers);
    if (status < 200 || status >= 300) throw new Error(`Jina Search HTTP ${status}`);

    let results: SearchResult[] = [];

    try {
      const json = JSON.parse(body);
      if (json.data && Array.isArray(json.data)) {
        results = json.data.slice(0, maxResults).map((item: any) => ({
          title: item.title || 'Untitled',
          url: item.url || '',
          snippet: (item.description || '').slice(0, 300),
          content: item.content
            ? (item.content.length > this.config.searchFetchLength
              ? item.content.slice(0, this.config.searchFetchLength)
              : item.content)
            : undefined,
        })).filter((r: SearchResult) => r.url);
      }
    } catch {
      // 非 JSON，尝试解析 Markdown 格式
      results = this.parseJinaMarkdown(body, maxResults);
    }

    return results;
  }

  /** 解析 Jina Search 的 Markdown 格式输出（fallback） */
  private parseJinaMarkdown(markdown: string, maxResults: number): SearchResult[] {
    const results: SearchResult[] = [];
    const blockRegex = /^##\s+\[([^\]]+)\]\(([^)]+)\)\s*\n([\s\S]*?)(?=^##\s+\[|$)/gm;
    let match: RegExpExecArray | null;
    while ((match = blockRegex.exec(markdown)) !== null && results.length < maxResults) {
      const title = match[1].trim();
      const url = match[2].trim();
      const content = match[3].trim();
      if (title && url && url.startsWith('http')) {
        results.push({
          title,
          url,
          snippet: content.slice(0, 300),
          content: content.length > this.config.searchFetchLength
            ? content.slice(0, this.config.searchFetchLength)
            : content,
        });
      }
    }
    return results;
  }

  /** 抓取单个 URL 的正文内容（内部复用，不暴露为工具） */
  private async fetchUrlContent(url: string, maxLength: number): Promise<string> {
    validateUrl(url, this.config.denyDomains);

    // Jina Reader 优先
    if (this.config.jinaReaderEnabled) {
      try {
        const jinaUrl = `https://r.jina.ai/${url}`;
        const { status, body } = await httpGet(jinaUrl, this.config.requestTimeoutMs, {
          'Accept': 'text/markdown',
        });
        if (status >= 200 && status < 300 && body.trim()) {
          return body.length > maxLength ? body.slice(0, maxLength) : body;
        }
      } catch {
        // 降级本地解析
      }
    }

    // 降级: 直接抓取，本地 htmlToMarkdown
    const { status, statusText, body } = await httpGet(url, this.config.requestTimeoutMs);
    if (status < 200 || status >= 300) throw new Error(`HTTP ${status} ${statusText}`);
    const isHtml = /<html|<!doctype html/i.test(body);
    const content = isHtml ? htmlToMarkdown(body) : body;
    return content.length > maxLength ? content.slice(0, maxLength) : content;
  }

  async fetch(values: Record<string, unknown>): Promise<FetchResult> {
    const url = requiredString(values, 'url', MAX_URL_LENGTH);
    const maxLength = optionalInteger(values, 'maxLength', DEFAULT_FETCH_LENGTH, MIN_FETCH_LENGTH, this.config.maxFetchSize);
    const prompt = typeof values.prompt === 'string' ? values.prompt.trim().slice(0, 500) : '';

    validateUrl(url, this.config.denyDomains);

    // Jina Reader 优先
    if (this.config.jinaReaderEnabled) {
      try {
        const jinaUrl = `https://r.jina.ai/${url}`;
        const { status, body } = await httpGet(jinaUrl, this.config.requestTimeoutMs, {
          'Accept': 'text/markdown',
        });
        if (status >= 200 && status < 300 && body.trim()) {
          const content = prompt
            ? extractRelevantSection(body, prompt, maxLength)
            : (body.length > maxLength ? body.slice(0, maxLength) : body);
          return {
            url,
            content,
            truncated: body.length > maxLength,
            format: 'markdown',
          };
        }
        // 429 限流或其他错误 → 降级本地解析
      } catch {
        // 降级本地解析
      }
    }

    // 降级: 直接抓取目标 URL，本地 htmlToMarkdown
    const { status, statusText, body } = await httpGet(url, this.config.requestTimeoutMs);
    if (status < 200 || status >= 300) {
      throw new Error(`HTTP ${status} ${statusText}`);
    }

    const isHtml = /<html|<!doctype html/i.test(body);
    const rawContent = isHtml ? htmlToMarkdown(body) : body;
    const content = prompt
      ? extractRelevantSection(rawContent, prompt, maxLength)
      : (rawContent.length > maxLength ? rawContent.slice(0, maxLength) : rawContent);
    return {
      url,
      content,
      truncated: rawContent.length > maxLength,
      format: isHtml ? 'markdown' : 'text',
    };
  }

  private async searchTavily(query: string, maxResults: number): Promise<{ results: SearchResult[]; provider: string }> {
    const body = JSON.stringify({
      query,
      max_results: maxResults,
      include_answer: false,
    });
    const { status, statusText, body: responseBody } = await httpPost(
      'https://api.tavily.com/search',
      body,
      this.config.requestTimeoutMs,
      { 'Authorization': `Bearer ${this.config.searchApiKey}` },
    );
    if (status < 200 || status >= 300) throw new Error(`Tavily API 错误: HTTP ${status} ${statusText}`);
    const data = JSON.parse(responseBody) as { results?: Array<{ title: string; url: string; content: string }> };
    return {
      results: (data.results || []).slice(0, maxResults).map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.content?.slice(0, 500) || '',
      })),
      provider: 'tavily',
    };
  }

  private async searchBrave(query: string, maxResults: number): Promise<{ results: SearchResult[]; provider: string }> {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`;
    const { status, statusText, body } = await httpGet(url, this.config.requestTimeoutMs, {
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': this.config.searchApiKey,
    });
    if (status < 200 || status >= 300) throw new Error(`Brave API 错误: HTTP ${status} ${statusText}`);
    const data = JSON.parse(body) as { web?: { results?: Array<{ title: string; url: string; description: string }> } };
    return {
      results: (data.web?.results || []).slice(0, maxResults).map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.description?.slice(0, 500) || '',
      })),
      provider: 'brave',
    };
  }

  private async searchSearXNG(query: string, maxResults: number): Promise<{ results: SearchResult[]; provider: string }> {
    const baseUrl = this.config.searxngUrl.replace(/\/$/, '');
    const url = `${baseUrl}/search?q=${encodeURIComponent(query)}&format=json&pageno=1`;
    const { status, statusText, body } = await httpGet(url, this.config.requestTimeoutMs, {
      'Accept': 'application/json',
    });
    if (status < 200 || status >= 300) throw new Error(`SearXNG 错误: HTTP ${status} ${statusText}`);
    const data = JSON.parse(body) as { results?: Array<{ title: string; url: string; content: string }> };
    return {
      results: (data.results || []).slice(0, maxResults).map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.content?.slice(0, 500) || '',
      })),
      provider: 'searxng',
    };
  }
}
