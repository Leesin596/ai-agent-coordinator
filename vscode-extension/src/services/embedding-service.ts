// ============================================================
// EmbeddingService — Embedding API 调用层
// 复用 ModelStore 的 API Key / baseURL，独立于 chat provider 系统。
// 支持：OpenAI 兼容 /v1/embeddings、Ollama /api/embeddings
// ============================================================
import * as vscode from 'vscode';
import type { ModelStore, ModelPreset } from './model-store';

const MAX_BATCH_SIZE = 64;
const MAX_TEXT_LENGTH = 8000;
const REQUEST_TIMEOUT_MS = 30000;

export interface EmbeddingConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  isOllama: boolean;
}

export class EmbeddingService {
  private config: EmbeddingConfig | null = null;
  private modelStore: ModelStore | null = null;

  constructor(modelStore?: ModelStore) {
    if (modelStore) {
      this.modelStore = modelStore;
      this.refreshConfig();
    }
  }

  setModelStore(store: ModelStore): void {
    this.modelStore = store;
    this.refreshConfig();
  }

  /** 从 ModelStore 默认预设 + VSCode 配置解析 embedding 配置 */
  refreshConfig(): void {
    const config = vscode.workspace.getConfiguration('coordinator.indexing');
    const enabled = config.get<boolean>('enabled', true);
    if (!enabled) {
      this.config = null;
      return;
    }

    const embeddingModel = config.get<string>('embeddingModel', 'text-embedding-3-small');

    // 优先从 ModelStore 默认预设获取凭据
    const preset = this.modelStore?.getDefault();
    if (preset && preset.apiKey) {
      const isOllama = /localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(preset.baseURL);
      this.config = {
        apiKey: preset.apiKey,
        baseURL: preset.baseURL,
        model: embeddingModel,
        isOllama,
      };
      return;
    }

    // 回退到 VSCode configuration
    const llmConfig = vscode.workspace.getConfiguration('coordinator.llm');
    const apiKey = llmConfig.get<string>('apiKey', '');
    const baseURL = llmConfig.get<string>('baseURL', 'https://api.openai.com/v1');
    const isOllama = /localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(baseURL);
    this.config = {
      apiKey,
      baseURL,
      model: embeddingModel,
      isOllama,
    };
  }

  isConfigured(): boolean {
    return this.config !== null && (this.config.apiKey.length > 0 || this.config.isOllama);
  }

  getConfig(): EmbeddingConfig | null {
    return this.config;
  }

  /** 单条文本 embedding */
  async embedOne(text: string): Promise<Float32Array> {
    const results = await this.embed([text]);
    return results[0];
  }

  /** 批量 embedding，自动分批 */
  async embed(texts: string[]): Promise<Float32Array[]> {
    if (!this.config) {
      throw new Error('Embedding 服务未配置，请在模型设置中添加模型预设');
    }
    if (texts.length === 0) return [];

    const results: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
      const batch = texts.slice(i, i + MAX_BATCH_SIZE);
      const batchResults = await this.embedBatch(batch);
      results.push(...batchResults);
    }
    return results;
  }

  private async embedBatch(texts: string[]): Promise<Float32Array[]> {
    if (!this.config) throw new Error('Embedding 服务未配置');

    const truncated = texts.map((t) => t.slice(0, MAX_TEXT_LENGTH));

    let url: string;
    let body: string;
    let headers: Record<string, string>;

    if (this.config.isOllama) {
      // Ollama embedding API: POST /api/embeddings
      const base = this.config.baseURL.replace(/\/v1\/?$/, '').replace(/\/+$/, '');
      url = `${base}/api/embeddings`;
      // Ollama 不支持批量，逐条请求
      const results: Float32Array[] = [];
      for (const text of truncated) {
        body = JSON.stringify({ model: this.config.model, prompt: text });
        headers = { 'Content-Type': 'application/json' };
        const resp = await this.fetchWithTimeout(url, headers, body);
        const json = await resp.json() as { embedding?: number[]; error?: { message?: string } };
        if (json.error) throw new Error(json.error.message || 'Ollama embedding 请求失败');
        if (!json.embedding) throw new Error('Ollama embedding 响应缺少 embedding 字段');
        results.push(Float32Array.from(json.embedding));
      }
      return results;
    }

    // OpenAI 兼容: POST /v1/embeddings (或 baseURL 已含 /v1)
    const base = this.config.baseURL.replace(/\/+$/, '');
    if (base.endsWith('/v1')) {
      url = `${base}/embeddings`;
    } else if (base.endsWith('/embeddings')) {
      url = base;
    } else {
      url = `${base}/v1/embeddings`;
    }
    body = JSON.stringify({
      model: this.config.model,
      input: truncated,
    });
    headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.config.apiKey}`,
    };

    const resp = await this.fetchWithTimeout(url, headers, body);
    const json = await resp.json() as {
      data?: Array<{ embedding?: number[] }>;
      error?: { message?: string };
    };

    if (json.error) throw new Error(json.error.message || 'Embedding API 请求失败');
    if (!json.data || json.data.length === 0) throw new Error('Embedding API 响应缺少 data');

    return json.data.map((item) => {
      if (!item.embedding) throw new Error('Embedding API 响应缺少 embedding 字段');
      return Float32Array.from(item.embedding);
    });
  }

  private async fetchWithTimeout(url: string, headers: Record<string, string>, body: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
      if (!resp.ok) {
        const errBody = await resp.text().catch(() => '');
        throw new Error(`Embedding API ${resp.status}: ${errBody.slice(0, 300)}`);
      }
      return resp;
    } finally {
      clearTimeout(timer);
    }
  }
}
