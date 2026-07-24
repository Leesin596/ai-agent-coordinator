// ============================================================
// LLMService — LLM API 客户端（流式）
// 使用 fetch API + Provider Handler 架构。
// 支持 Anthropic / OpenAI Chat Completions / OpenAI Responses。
//
// 架构（P2-08 重构）:
//   streamChatGenerator  — 核心 async generator，yield StreamChunk
//   streamChat           — callback 兼容层，消费 generator 分发到回调
//   streamChatAsync      — yield* generator 的薄包装
//   chat                 — Promise 版，包装 streamChat
// ============================================================
import type { ModelApiFormat } from './model-store';
import type { LLMToolDefinition, TokenUsage } from './llm-api';
import { createProvider, type ProviderRequestConfig } from './providers';
import { trimPreviousToolResults } from './context-manager';

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
  apiKeyRequired?: boolean;
}

export function estimateMessageTokens(messages: Array<{ content: string }>): number {
  return messages.reduce((total, message) => total + estimateTextTokens(message.content), 0);
}

/**
 * 估算文本的 token 数。
 * CJK 字符 ≈ 1.5 tokens/字，ASCII ≈ 0.25 tokens/char (4 chars/token)。
 * 混合内容按字符类型分别计算后求和。
 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  let cjkCount = 0;
  let asciiCount = 0;
  for (const ch of text) {
    if (/[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u30ff\uac00-\ud7af]/.test(ch)) {
      cjkCount++;
    } else {
      asciiCount++;
    }
  }
  return Math.ceil(cjkCount * 1.5 + asciiCount / 4);
}

export interface LLMStreamCallbacks {
  onChunk: (delta: string) => void;
  onReasoningChunk?: (delta: string) => void;
  onToolCall?: (call: LLMToolCall) => Promise<string>;
  onToolStatus?: (call: LLMToolCall, status: 'running' | 'completed' | 'failed', detail?: string) => void;
  onToolEvent?: (call: LLMToolCall, result?: string) => void;
  onDone: (fullText: string, reasoningText: string, usage?: TokenUsage) => void;
  onError: (err: Error, fullText: string, reasoningText: string) => void;
}

const MAX_RETRIES = 1;
const RETRY_DELAY_MS = 1000;
const MAX_TOOL_CALLS_PER_ROUND = 16;
const CONSECUTIVE_IDENTICAL_LIMIT = 3;

/** HTTP 级别错误（4xx/5xx），不重试 */
export class LLMHttpError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
    this.name = 'LLMHttpError';
  }
}

/** 流式解析错误，可重试 */
export class LLMStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LLMStreamError';
  }
}

export type StreamChunk =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'toolCall'; call: LLMToolCall }
  | { type: 'toolResult'; call: LLMToolCall; result: string }
  | { type: 'toolStatus'; call: LLMToolCall; status: 'running' | 'completed' | 'failed'; detail?: string }
  | { type: 'done'; fullText: string; reasoningText: string; usage?: TokenUsage }
  | { type: 'error'; error: Error; fullText: string; reasoningText: string };

export interface StreamGeneratorOptions {
  toolExecutor?: (call: LLMToolCall) => Promise<string>;
  abortController?: AbortController;
}

/** 合并多次 partial usage（Anthropic 流式分 message_start 和 message_delta 两次返回） */
function mergeUsage(prev: TokenUsage | undefined, next: TokenUsage): TokenUsage {
  if (!prev) return next;
  return {
    promptTokens: next.promptTokens || prev.promptTokens,
    completionTokens: next.completionTokens || prev.completionTokens,
    totalTokens: next.totalTokens || prev.totalTokens,
    cacheHitTokens: next.cacheHitTokens ?? prev.cacheHitTokens,
    cacheMissTokens: next.cacheMissTokens ?? prev.cacheMissTokens,
  };
}

interface RoundContext {
  fullText: string;
  reasoningText: string;
  previousToolCallSignature: string | null;
  consecutiveIdenticalCount: number;
  aborted: boolean;
  usage: TokenUsage | undefined;
}

interface RoundResult {
  toolCalls: LLMToolCall[];
  roundText: string;
  roundReasoning: string;
  reasoningSignature: string;
  providerItems: Array<Record<string, unknown>>;
}

export class LLMService {
  /**
   * 核心流式对话补全 — async generator。
   * yield StreamChunk，消费方用 for-await-of 迭代。
   * 工具调用循环在 generator 内部完成。
   * 通过 abortController.abort() 取消，generator 干净退出。
   */
  async *streamChatGenerator(
    messages: LLMMessage[],
    config: LLMConfig,
    options: StreamGeneratorOptions = {},
  ): AsyncGenerator<StreamChunk> {
    const { toolExecutor, abortController } = options;
    const controller = abortController ?? new AbortController();

    const provider = createProvider(config.apiFormat);
    const providerConfig: ProviderRequestConfig = {
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      model: config.model,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      contextWindow: config.contextWindow,
      thinkingStrength: config.thinkingStrength,
      tools: config.tools,
    };

    const ctx: RoundContext = {
      fullText: '',
      reasoningText: '',
      previousToolCallSignature: null,
      consecutiveIdenticalCount: 0,
      aborted: false,
      usage: undefined,
    };
    const isAborted = (): boolean => ctx.aborted || controller.signal.aborted;

    try {
      yield* this.runRounds(messages, provider, providerConfig, toolExecutor, controller, ctx, isAborted);
      if (!isAborted()) {
        yield { type: 'done', fullText: ctx.fullText, reasoningText: ctx.reasoningText, usage: ctx.usage };
      }
    } catch (err) {
      if (isAborted()) return;
      const error = err instanceof Error ? err : new Error(String(err));
      yield { type: 'error', error, fullText: ctx.fullText, reasoningText: ctx.reasoningText };
    }
  }

  /**
   * 多轮工具调用循环。每轮：fetch SSE → 解析 → 工具执行 → 递归下一轮。
   */
  private async *runRounds(
    messages: LLMMessage[],
    provider: ReturnType<typeof createProvider>,
    providerConfig: ProviderRequestConfig,
    toolExecutor: ((call: LLMToolCall) => Promise<string>) | undefined,
    controller: AbortController,
    ctx: RoundContext,
    isAborted: () => boolean,
  ): AsyncGenerator<StreamChunk> {
    let roundMessages = messages;
    let round = 0;

    while (true) {
      if (isAborted()) return;

      let prepared;
      try {
        prepared = provider.prepareRequest(roundMessages, providerConfig, true);
      } catch (err) {
        throw err instanceof Error ? err : new Error(String(err));
      }

      const holder: { result: RoundResult | null } = { result: null };
      yield* this.fetchAndParse(prepared, provider, controller, ctx, isAborted, round, holder);

      if (isAborted() || !holder.result) return;

      const roundResult = holder.result;

      if (roundResult.toolCalls.length === 0) {
        return;
      }

      if (!toolExecutor) {
        throw new Error(
          `模型请求调用工具 ${roundResult.toolCalls.map((c) => c.name).join(', ')}，但当前会话未提供工具执行器`,
        );
      }

      if (roundResult.toolCalls.length > MAX_TOOL_CALLS_PER_ROUND) {
        throw new Error(`模型单轮请求了 ${roundResult.toolCalls.length} 个工具调用，超过安全上限`);
      }

      const currentSignature = JSON.stringify(
        roundResult.toolCalls.map((c) => ({ name: c.name, args: c.arguments })),
      );
      if (ctx.previousToolCallSignature === currentSignature) {
        ctx.consecutiveIdenticalCount++;
      } else {
        ctx.consecutiveIdenticalCount = 1;
        ctx.previousToolCallSignature = currentSignature;
      }
      if (ctx.consecutiveIdenticalCount >= CONSECUTIVE_IDENTICAL_LIMIT) {
        throw new Error(
          `模型连续 ${ctx.consecutiveIdenticalCount} 次以相同参数调用相同工具，可能陷入循环。请尝试换一种提问方式或提供更多上下文。`,
        );
      }

      const nextMessages: LLMMessage[] = [
        ...roundMessages,
        {
          role: 'assistant',
          content: roundResult.roundText,
          toolCalls: roundResult.toolCalls,
          reasoningContent: roundResult.roundReasoning,
          reasoningSignature: roundResult.reasoningSignature,
          providerItems: roundResult.providerItems,
        },
      ];

      const processedToolIds = new Set<string>();
      const validCalls = roundResult.toolCalls.filter((call) => {
        if (processedToolIds.has(call.id)) {
          nextMessages.push({
            role: 'tool',
            content: JSON.stringify({ ok: false, error: 'duplicate tool_use_id skipped' }),
            toolCallId: call.id,
          });
          return false;
        }
        processedToolIds.add(call.id);
        return true;
      });

      // 并行执行所有工具调用（像 Windsurf 一样）
      for (const call of validCalls) {
        yield { type: 'toolStatus', call, status: 'running' };
        yield { type: 'toolCall', call };
      }

      const results = await Promise.all(
        validCalls.map(async (call) => {
          try {
            const result = await toolExecutor(call);
            return { call, result, error: null as string | null };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { call, result: null, error: message };
          }
        }),
      );

      if (isAborted()) return;

      // 按原始顺序处理结果
      for (const { call, result, error } of results) {
        if (error) {
          yield { type: 'toolStatus', call, status: 'failed', detail: error };
          nextMessages.push(
            call.legacy
              ? { role: 'function', content: JSON.stringify({ ok: false, error }), toolCallName: call.name }
              : { role: 'tool', content: JSON.stringify({ ok: false, error }), toolCallId: call.id },
          );
        } else {
          yield { type: 'toolResult', call, result: result! };
          yield { type: 'toolStatus', call, status: 'completed', detail: result! };
          nextMessages.push(
            call.legacy
              ? { role: 'function', content: result!, toolCallName: call.name }
              : { role: 'tool', content: result!, toolCallId: call.id },
          );
        }
      }

      // P0: 截短之前轮次的工具结果，防止多轮工具调用上下文膨胀
      const currentRoundStart = roundMessages.length;
      const { messages: trimmedMessages } = trimPreviousToolResults(nextMessages, currentRoundStart);
      roundMessages = trimmedMessages;
      round++;
    }
  }

  /**
   * 单轮 fetch + SSE 解析。yield text/reasoning chunks，通过 holder 返回工具调用结果。
   */
  private async *fetchAndParse(
    prepared: { url: string; headers: Record<string, string>; body: string },
    provider: ReturnType<typeof createProvider>,
    controller: AbortController,
    ctx: RoundContext,
    isAborted: () => boolean,
    round: number,
    holder: { result: RoundResult | null },
  ): AsyncGenerator<StreamChunk> {
    let retryCount = 0;
    let roundText = '';
    let roundReasoning = '';

    for (;;) {
      if (isAborted()) {
        holder.result = { toolCalls: [], roundText: '', roundReasoning: '', reasoningSignature: '', providerItems: [] };
        return;
      }

      try {
        const res = await fetch(prepared.url, {
          method: 'POST',
          headers: prepared.headers,
          body: prepared.body,
          signal: controller.signal,
        });

        if (res.status < 200 || res.status >= 300) {
          const errBody = await res.text();
          const apiErr = provider.extractApiError(errBody) || res.statusText || '';
          if (retryCount < MAX_RETRIES && (res.status === 429 || res.status >= 500)) {
            await sleep(RETRY_DELAY_MS);
            if (isAborted()) {
              holder.result = { toolCalls: [], roundText: '', roundReasoning: '', reasoningSignature: '', providerItems: [] };
              return;
            }
            retryCount++;
            continue;
          }
          throw new LLMHttpError(res.status, `LLM API 返回 ${res.status}: ${apiErr}`);
        }

        const reader = res.body?.getReader();
        if (!reader) throw new Error('响应体不可读');

        const decoder = new TextDecoder('utf-8');
        let buffer = '';
        roundText = '';
        roundReasoning = '';
        let reasoningSignature = '';
        const providerItems: Array<Record<string, unknown>> = [];
        const pendingCalls = new Map<number, LLMToolCall>();
        let streamDone = false;

        for (;;) {
          if (isAborted() || streamDone) break;
          const { done, value } = await reader.read();
          if (done) break;
          if (isAborted()) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data:')) continue;
            const parsed = provider.parseStreamData(trimmed.slice(5).trim());

            if (parsed.error) {
              controller.abort();
              throw new Error(parsed.error);
            }

            if (parsed.reasoningDelta) {
              roundReasoning += parsed.reasoningDelta;
              ctx.reasoningText += parsed.reasoningDelta;
              yield { type: 'reasoning', delta: parsed.reasoningDelta };
            }
            if (parsed.reasoningSignatureDelta) reasoningSignature += parsed.reasoningSignatureDelta;
            if (parsed.outputItem) providerItems.push(parsed.outputItem);
            if (parsed.usage) ctx.usage = mergeUsage(ctx.usage, parsed.usage);

            if (parsed.textDelta) {
              roundText += parsed.textDelta;
              ctx.fullText += parsed.textDelta;
              yield { type: 'text', delta: parsed.textDelta };
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
                current.name += delta.name.startsWith(current.name)
                  ? delta.name.slice(current.name.length)
                  : delta.name;
              }
              if (delta.argumentsDelta) current.arguments += delta.argumentsDelta;
              pendingCalls.set(delta.index, current);
            }
            if (parsed.done) { streamDone = true; break; }
          }
        }

        if (!isAborted() && !streamDone && buffer.trim()) {
          const parsed = provider.parseStreamData(buffer.trim().slice(5).trim());
          if (parsed.error) throw new Error(parsed.error);
          if (parsed.reasoningDelta) {
            roundReasoning += parsed.reasoningDelta;
            ctx.reasoningText += parsed.reasoningDelta;
            yield { type: 'reasoning', delta: parsed.reasoningDelta };
          }
          if (parsed.textDelta) {
            roundText += parsed.textDelta;
            ctx.fullText += parsed.textDelta;
            yield { type: 'text', delta: parsed.textDelta };
          }
          if (parsed.usage) ctx.usage = mergeUsage(ctx.usage, parsed.usage);
        }

        const allToolCalls = [...pendingCalls.entries()]
          .sort(([left], [right]) => left - right)
          .map(([, call]) => call);
        const toolCalls = allToolCalls.filter((call) => call.name);
        if (toolCalls.length !== allToolCalls.length) {
          throw new Error('模型返回了缺少工具名称的调用');
        }
        const seenToolCallIds = new Set<string>();
        const dedupedToolCalls = toolCalls.filter((call) => {
          if (seenToolCallIds.has(call.id)) return false;
          seenToolCallIds.add(call.id);
          return true;
        });

        holder.result = { toolCalls: dedupedToolCalls, roundText, roundReasoning, reasoningSignature, providerItems };
        return;
      } catch (err) {
        if (isAborted()) {
          holder.result = { toolCalls: [], roundText: '', roundReasoning: '', reasoningSignature: '', providerItems: [] };
          return;
        }
        if (retryCount < MAX_RETRIES && !(err instanceof LLMHttpError)) {
          // 回滚 ctx 中已追加的本轮内容，避免重试后重复输出
          if (roundText) ctx.fullText = ctx.fullText.slice(0, -roundText.length);
          if (roundReasoning) ctx.reasoningText = ctx.reasoningText.slice(0, -roundReasoning.length);
          await sleep(RETRY_DELAY_MS);
          if (isAborted()) {
            holder.result = { toolCalls: [], roundText: '', roundReasoning: '', reasoningSignature: '', providerItems: [] };
            return;
          }
          retryCount++;
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * 流式对话补全（callback 兼容层）。
   * 内部消费 streamChatGenerator，将 chunk 分发到对应 callback。
   * 返回 abort 函数。现有调用方无需改动。
   */
  streamChat(
    messages: LLMMessage[],
    config: LLMConfig,
    callbacks: LLMStreamCallbacks,
  ): () => void {
    const controller = new AbortController();
    let aborted = false;

    const toolExecutor = callbacks.onToolCall
      ? async (call: LLMToolCall): Promise<string> => callbacks.onToolCall!(call)
      : undefined;

    void (async () => {
      try {
        for await (const chunk of this.streamChatGenerator(messages, config, {
          toolExecutor,
          abortController: controller,
        })) {
          if (aborted) break;
          switch (chunk.type) {
            case 'text':
              callbacks.onChunk(chunk.delta);
              break;
            case 'reasoning':
              callbacks.onReasoningChunk?.(chunk.delta);
              break;
            case 'toolStatus':
              callbacks.onToolStatus?.(chunk.call, chunk.status, chunk.detail);
              break;
            case 'toolCall':
              callbacks.onToolEvent?.(chunk.call);
              break;
            case 'toolResult':
              callbacks.onToolEvent?.(chunk.call, chunk.result);
              break;
            case 'done':
              callbacks.onDone(chunk.fullText, chunk.reasoningText, chunk.usage);
              break;
            case 'error':
              callbacks.onError(chunk.error, chunk.fullText, chunk.reasoningText);
              break;
          }
        }
      } catch (err) {
        if (aborted) return;
        const error = err instanceof Error ? err : new Error(String(err));
        callbacks.onError(error, '', '');
      }
    })();

    return () => {
      aborted = true;
      controller.abort();
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

  /**
   * 流式对话补全（async generator 版本）。
   * 直接 yield* streamChatGenerator，无 queue 中间层。
   */
  async *streamChatAsync(
    messages: LLMMessage[],
    config: LLMConfig,
    toolExecutor?: (call: LLMToolCall) => Promise<string>,
  ): AsyncGenerator<StreamChunk> {
    const controller = new AbortController();
    try {
      yield* this.streamChatGenerator(messages, config, {
        toolExecutor,
        abortController: controller,
      });
    } finally {
      controller.abort();
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
