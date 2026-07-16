// ============================================================
// LLMService — OpenAI 兼容 API 客户端（流式）
// 用 Node.js 原生 https 模块，零额外依赖，保持 VSIX 体积小。
// 支持 baseURL 自定义（兼容 OpenAI / Azure / 本地模型）。
// ============================================================
import * as https from 'https';
import * as http from 'http';
import type { ModelApiFormat } from './model-store';
import type { LLMToolDefinition } from './llm-api';
import { extractApiError, parseStreamData, prepareLLMRequest } from './llm-api';

export interface LLMToolCall {
  id: string;
  name: string;
  arguments: string;
  legacy?: boolean;
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool' | 'function';
  content: string;
  toolCallId?: string;
  toolCallName?: string;
  toolCalls?: LLMToolCall[];
  reasoningContent?: string;
  reasoningSignature?: string;
  providerItems?: Array<Record<string, unknown>>;
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
  tools?: LLMToolDefinition[];
}

export function estimateMessageTokens(messages: Array<{ content: string }>): number {
  return messages.reduce((total, message) => total + Math.ceil(message.content.length / 4), 0);
}

export interface LLMStreamCallbacks {
  onChunk: (delta: string) => void;
  onReasoningChunk?: (delta: string) => void;
  onToolCall?: (call: LLMToolCall) => Promise<string>;
  onToolStatus?: (call: LLMToolCall, status: 'running' | 'completed' | 'failed', detail?: string) => void;
  onDone: (fullText: string, reasoningText: string) => void;
  onError: (err: Error, fullText: string, reasoningText: string) => void;
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
    let fullText = '';
    let reasoningText = '';
    let aborted = false;
    let settled = false;
    let totalToolCalls = 0;
    let req: http.ClientRequest | null = null;

    const fail = (err: Error): void => {
      if (settled || aborted) return;
      settled = true;
      callbacks.onError(err, fullText, reasoningText);
    };

    const runRound = (roundMessages: LLMMessage[], round: number): void => {
      if (aborted || settled) return;
      let prepared;
      try {
        prepared = prepareLLMRequest(roundMessages, config, true);
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)));
        return;
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
      let buffer = '';
      let roundText = '';
      let roundFinished = false;
      let roundReasoning = '';
      let reasoningSignature = '';
      const providerItems: Array<Record<string, unknown>> = [];
      const pendingCalls = new Map<number, LLMToolCall>();

      const finishRound = async (): Promise<void> => {
        if (roundFinished || aborted || settled) return;
        roundFinished = true;
        const allToolCalls = [...pendingCalls.entries()]
          .sort(([left], [right]) => left - right)
          .map(([, call]) => call);
        const toolCalls = allToolCalls.filter((call) => call.name);
        if (toolCalls.length !== allToolCalls.length) {
          fail(new Error('模型返回了缺少工具名称的调用'));
          return;
        }
        if (new Set(toolCalls.map((call) => call.id)).size !== toolCalls.length) {
          fail(new Error('模型返回了重复的工具调用 ID'));
          return;
        }
        if (toolCalls.length === 0) {
          settled = true;
          callbacks.onDone(fullText, reasoningText);
          return;
        }
        if (!callbacks.onToolCall) {
          fail(new Error(`模型请求调用工具 ${toolCalls.map((call) => call.name).join(', ')}，但当前会话未提供工具执行器`));
          return;
        }
        if (toolCalls.length > 8 || totalToolCalls + toolCalls.length > 50) {
          fail(new Error('模型请求的工具调用数量超过安全上限'));
          return;
        }
        totalToolCalls += toolCalls.length;

        const nextMessages: LLMMessage[] = [
          ...roundMessages,
          {
            role: 'assistant',
            content: roundText,
            toolCalls,
            reasoningContent: roundReasoning,
            reasoningSignature,
            providerItems,
          },
        ];
        for (const call of toolCalls) {
          if (aborted) return;
          callbacks.onToolStatus?.(call, 'running');
          try {
            const result = await callbacks.onToolCall(call);
            if (aborted) return;
            callbacks.onToolStatus?.(call, 'completed', result);
            nextMessages.push(call.legacy
              ? { role: 'function', content: result, toolCallName: call.name }
              : { role: 'tool', content: result, toolCallId: call.id });
          } catch (err) {
            if (aborted) return;
            const message = err instanceof Error ? err.message : String(err);
            callbacks.onToolStatus?.(call, 'failed', message);
            nextMessages.push(call.legacy
              ? {
                  role: 'function',
                  content: JSON.stringify({ ok: false, error: message }),
                  toolCallName: call.name,
                }
              : {
                  role: 'tool',
                  content: JSON.stringify({ ok: false, error: message }),
                  toolCallId: call.id,
                });
          }
        }
        runRound(nextMessages, round + 1);
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
          roundReasoning += parsed.reasoningDelta;
          reasoningText += parsed.reasoningDelta;
          callbacks.onReasoningChunk?.(parsed.reasoningDelta);
        }
        if (parsed.reasoningSignatureDelta) reasoningSignature += parsed.reasoningSignatureDelta;
        if (parsed.outputItem) providerItems.push(parsed.outputItem);
        if (parsed.textDelta) {
          roundText += parsed.textDelta;
          fullText += parsed.textDelta;
          callbacks.onChunk(parsed.textDelta);
        }
        for (const delta of parsed.toolCallDeltas || []) {
          const current = pendingCalls.get(delta.index) || {
            id: delta.id || `tool_call_${round}_${delta.index}`,
            name: '',
            arguments: '',
            legacy: delta.legacy,
          };
          if (delta.id) current.id = delta.id;
          if (delta.legacy) current.legacy = true;
          if (delta.name && delta.name !== current.name) {
            current.name += delta.name.startsWith(current.name) ? delta.name.slice(current.name.length) : delta.name;
          }
          if (delta.argumentsDelta) current.arguments += delta.argumentsDelta;
          pendingCalls.set(delta.index, current);
        }
        if (parsed.done) void finishRound();
      };

      req = lib.request(options, (res) => {
        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          let errBody = '';
          res.on('data', (chunk) => (errBody += chunk.toString()));
          res.on('end', () => {
            fail(new Error(`LLM API 返回 ${res.statusCode}: ${extractApiError(errBody) || res.statusMessage}`));
          });
          return;
        }

        res.setEncoding('utf-8');
        res.on('data', (chunk: string) => {
          if (aborted || settled || roundFinished) return;
          buffer += chunk;
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) processSSELine(line);
        });
        res.on('end', () => {
          if (aborted || settled || roundFinished) return;
          if (buffer.trim()) processSSELine(buffer);
          void finishRound();
        });
        res.on('error', (err) => fail(err));
      });

      req.on('error', (err) => fail(err));
      req.setTimeout(0);
      req.setNoDelay(true);
      req.write(body);
      req.end();
    };

    runRound(messages, 0);

    // 返回 abort 函数
    return () => {
      aborted = true;
      req?.destroy();
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
