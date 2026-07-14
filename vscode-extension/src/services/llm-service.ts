// ============================================================
// LLMService — OpenAI 兼容 API 客户端（流式）
// 用 Node.js 原生 https 模块，零额外依赖，保持 VSIX 体积小。
// 支持 baseURL 自定义（兼容 OpenAI / Azure / 本地模型）。
// ============================================================
import * as https from 'https';
import * as http from 'http';
import type { ModelApiFormat } from './model-store';
import { extractApiError, parseStreamData, prepareLLMRequest } from './llm-api';

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  apiFormat?: ModelApiFormat;
  temperature?: number;
  maxTokens?: number;
  contextWindow?: number;
  thinkingStrength?: string;
}

export function estimateMessageTokens(messages: Array<{ content: string }>): number {
  return messages.reduce((total, message) => total + Math.ceil(message.content.length / 4), 0);
}

export interface LLMStreamCallbacks {
  onChunk: (delta: string) => void;
  onReasoningChunk?: (delta: string) => void;
  onDone: (fullText: string, reasoningText: string) => void;
  onError: (err: Error) => void;
}

export class LLMService {
  /**
   * 流式对话补全。逐 chunk 回调，支持中途取消。
   * 返回一个 abort 函数，调用即中断请求。
   */
  streamChat(
    messages: LLMMessage[],
    config: LLMConfig,
    callbacks: LLMStreamCallbacks,
  ): () => void {
    let prepared;
    try {
      prepared = prepareLLMRequest(messages, config, true);
    } catch (err) {
      callbacks.onError(err instanceof Error ? err : new Error(String(err)));
      return () => undefined;
    }
    const { format, url, headers, body } = prepared;
    const lib = url.protocol === 'https:' ? https : http;

    const options: https.RequestOptions = {
      hostname: url.hostname,
      port: url.port || undefined,
      path: url.pathname + url.search,
      method: 'POST',
      headers,
    };

    let fullText = '';
    let reasoningText = '';
    let buffer = '';
    let aborted = false;
    let settled = false;
    let req: http.ClientRequest | null = null;

    const finish = (): void => {
      if (settled || aborted) return;
      settled = true;
      callbacks.onDone(fullText, reasoningText);
    };

    const fail = (err: Error): void => {
      if (settled || aborted) return;
      settled = true;
      callbacks.onError(err);
    };

    const processSSELine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data:')) return;
      const parsed = parseStreamData(format, trimmed.slice(5).trim());
      if (parsed.error) {
        fail(new Error(parsed.error));
        req?.destroy();
        return;
      }
      if (parsed.reasoningDelta) {
        reasoningText += parsed.reasoningDelta;
        callbacks.onReasoningChunk?.(parsed.reasoningDelta);
      }
      if (parsed.textDelta) {
        fullText += parsed.textDelta;
        callbacks.onChunk(parsed.textDelta);
      }
      if (parsed.done) finish();
    };

    req = lib.request(options, (res) => {
      if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
        let errBody = '';
        res.on('data', (c) => (errBody += c.toString()));
        res.on('end', () => {
          fail(new Error(`LLM API 返回 ${res.statusCode}: ${extractApiError(errBody) || res.statusMessage}`));
        });
        return;
      }

      res.setEncoding('utf-8');
      res.on('data', (chunk: string) => {
        if (aborted) return;
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // 保留不完整的最后一行

        for (const line of lines) {
          processSSELine(line);
          if (settled) return;
        }
      });

      res.on('end', () => {
        if (aborted) return;
        // 处理 buffer 残留
        if (buffer.trim()) processSSELine(buffer);
        finish();
      });

      res.on('error', (err) => fail(err));
    });

    req.on('error', (err) => fail(err));
    req.setTimeout(0);
    req.setNoDelay(true);

    req.write(body);
    req.end();

    // 返回 abort 函数
    return () => {
      aborted = true;
      if (req) req.destroy();
    };
  }

  /**
   * 非流式对话补全（一次性返回完整结果）。
   */
  async chat(messages: LLMMessage[], config: LLMConfig): Promise<string> {
    return new Promise((resolve, reject) => {
      let full = '';
      this.streamChat(messages, config, {
        onChunk: (delta) => { full += delta; },
        onDone: (text) => resolve(text),
        onError: (err) => reject(err),
      });
    });
  }
}
