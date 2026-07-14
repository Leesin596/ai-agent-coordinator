import type { ModelApiFormat } from './model-store';
import type { LLMMessage } from './llm-service';

export interface LLMRequestConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  apiFormat?: ModelApiFormat;
  temperature?: number;
  maxTokens?: number;
  contextWindow?: number;
  thinkingStrength?: string;
}

export interface PreparedLLMRequest {
  format: ModelApiFormat;
  url: URL;
  headers: Record<string, string>;
  body: string;
}

export interface ParsedStreamData {
  textDelta?: string;
  reasoningDelta?: string;
  done?: boolean;
  error?: string;
}

const FORMAT_ALIASES: Record<string, ModelApiFormat> = {
  'anthropic-messages': 'anthropic-messages',
  anthropic: 'anthropic-messages',
  'chat-completions': 'chat-completions',
  'openai-compatible': 'chat-completions',
  responses: 'responses',
  custom: 'chat-completions',
};

const FORMAT_ENDPOINTS: Record<ModelApiFormat, string> = {
  'anthropic-messages': '/v1/messages',
  'chat-completions': '/chat/completions',
  responses: '/responses',
};

export function normalizeApiFormat(format?: string): ModelApiFormat {
  return FORMAT_ALIASES[format || ''] || 'chat-completions';
}

export function resolveApiURL(baseURL: string, format?: string): URL {
  const normalizedFormat = normalizeApiFormat(format);
  const url = new URL(baseURL.trim());
  const endpoint = FORMAT_ENDPOINTS[normalizedFormat];
  const pathname = url.pathname.replace(/\/+$/, '');
  if (!pathname.endsWith(endpoint)) {
    const suffix = normalizedFormat === 'anthropic-messages' && pathname.endsWith('/v1')
      ? '/messages'
      : endpoint;
    url.pathname = `${pathname}${suffix}`.replace(/\/{2,}/g, '/');
  }
  return url;
}

function getOutputTokenLimit(config: LLMRequestConfig): number {
  if (config.maxTokens) return config.maxTokens;
  const contextWindow = config.contextWindow ?? 65536;
  return Math.min(16384, Math.max(1024, Math.floor(contextWindow / 4)));
}

function supportsReasoningControls(format: ModelApiFormat, model: string): boolean {
  if (format === 'anthropic-messages') {
    return /claude-(?:3[-.]?7|(?:sonnet|opus|haiku)-?4|4|(?:sonnet|fable)-5)/i.test(model);
  }
  return /(?:^|[-_.])(?:o1|o3|o4)(?:[-_.]|$)|gpt-5|codex|deepseek-(?:r1|reasoner)|qwq|qwen.*(?:thinking|reason)/i.test(model);
}

function usesAdaptiveAnthropicThinking(model: string): boolean {
  return /claude-(?:sonnet-5|fable-5|opus-4-(?:6|7|8))(?:$|-)/i.test(model);
}

function normalizeReasoningEffort(value?: string): 'low' | 'medium' | 'high' {
  if (value === 'low' || value === 'medium') return value;
  return 'high';
}

function getAnthropicThinkingBudget(value: string | undefined, maxTokens: number): number {
  const requested = value === 'low' ? 1024 : value === 'medium' ? 4096 : value === 'high' ? 8192 : 12288;
  return Math.max(1024, Math.min(requested, maxTokens - 1));
}

export function prepareLLMRequest(
  messages: LLMMessage[],
  config: LLMRequestConfig,
  stream: boolean,
): PreparedLLMRequest {
  const format = normalizeApiFormat(config.apiFormat);
  const maxTokens = getOutputTokenLimit(config);
  const reasoningEnabled =
    supportsReasoningControls(format, config.model) &&
    (format !== 'anthropic-messages' || maxTokens > 1024);
  const adaptiveAnthropicThinking = format === 'anthropic-messages' && usesAdaptiveAnthropicThinking(config.model);
  const url = resolveApiURL(config.baseURL, format);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: stream ? 'text/event-stream' : 'application/json',
  };

  let payload: Record<string, unknown>;
  if (format === 'anthropic-messages') {
    headers['x-api-key'] = config.apiKey;
    headers['anthropic-version'] = '2023-06-01';
    const system = messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n\n');
    payload = {
      model: config.model,
      messages: messages.filter((message) => message.role !== 'system'),
      max_tokens: maxTokens,
      stream,
      ...(system ? { system } : {}),
      ...(reasoningEnabled
        ? adaptiveAnthropicThinking
          ? {
              thinking: { type: 'adaptive' },
              output_config: { effort: normalizeReasoningEffort(config.thinkingStrength) },
            }
          : { thinking: { type: 'enabled', budget_tokens: getAnthropicThinkingBudget(config.thinkingStrength, maxTokens) } }
        : config.temperature !== undefined ? { temperature: config.temperature } : {}),
    };
  } else if (format === 'responses') {
    headers.Authorization = `Bearer ${config.apiKey}`;
    payload = {
      model: config.model,
      input: messages,
      stream,
      max_output_tokens: maxTokens,
      ...(reasoningEnabled
        ? { reasoning: { effort: normalizeReasoningEffort(config.thinkingStrength), summary: 'auto' } }
        : config.temperature !== undefined ? { temperature: config.temperature } : {}),
    };
  } else {
    headers.Authorization = `Bearer ${config.apiKey}`;
    payload = {
      model: config.model,
      messages,
      stream,
      ...(reasoningEnabled
        ? {
            max_completion_tokens: maxTokens,
            reasoning_effort: normalizeReasoningEffort(config.thinkingStrength),
          }
        : {
            max_tokens: maxTokens,
            temperature: config.temperature ?? 0.7,
          }),
    };
  }

  const body = JSON.stringify(payload);
  headers['Content-Length'] = String(Buffer.byteLength(body));
  return { format, url, headers, body };
}

export function parseStreamData(format: ModelApiFormat, data: string): ParsedStreamData {
  if (data === '[DONE]') return { done: true };
  try {
    const json = JSON.parse(data);
    if (format === 'anthropic-messages') {
      if (json.type === 'error') return { error: json.error?.message || 'Anthropic 流式请求失败' };
      if (json.type === 'message_stop') return { done: true };
      if (json.type !== 'content_block_delta') return {};
      if (json.delta?.type === 'text_delta') return { textDelta: json.delta.text };
      if (json.delta?.type === 'thinking_delta') return { reasoningDelta: json.delta.thinking };
      return {};
    }
    if (format === 'responses') {
      if (json.type === 'response.failed') {
        return { error: json.response?.error?.message || json.error?.message || 'Responses API 请求失败' };
      }
      if (json.type === 'response.incomplete') {
        return { error: `模型输出未完成: ${json.response?.incomplete_details?.reason || '未知原因'}` };
      }
      if (json.type === 'response.completed') return { done: true };
      if (json.type === 'response.output_text.delta') return { textDelta: json.delta };
      if (json.type === 'response.reasoning_summary_text.delta' || json.type === 'response.reasoning_text.delta') {
        return { reasoningDelta: json.delta };
      }
      return {};
    }
    const choice = json.choices?.[0];
    if (json.error) return { error: json.error.message || 'Chat Completions 请求失败' };
    const delta = choice?.delta || {};
    return {
      textDelta: typeof delta.content === 'string' ? delta.content : undefined,
      reasoningDelta:
        typeof delta.reasoning_content === 'string' ? delta.reasoning_content
          : typeof delta.reasoning === 'string' ? delta.reasoning
            : typeof delta.thinking === 'string' ? delta.thinking
              : undefined,
      done: Boolean(choice?.finish_reason),
    };
  } catch {
    return {};
  }
}

export function extractApiError(body: string): string {
  try {
    const json = JSON.parse(body);
    return json.error?.message || json.message || body.slice(0, 300);
  } catch {
    return body.slice(0, 300);
  }
}
