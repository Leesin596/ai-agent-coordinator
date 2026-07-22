import type { LLMMessage } from '../llm-service';
import type { LLMToolDefinition, ParsedStreamData, TokenUsage } from '../llm-api';
import type { LLMProvider, ProviderRequestConfig, PreparedRequest } from './base-provider';
import { extractText, normalizeReasoningEffort } from './provider-utils';

function parseToolArguments(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function toAnthropicMessages(messages: LLMMessage[]): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'tool') {
      const toolResult = { type: 'tool_result', tool_use_id: message.toolCallId, content: message.content };
      const previous = result[result.length - 1];
      if (previous?.role === 'user' && Array.isArray(previous.content)) {
        previous.content.push(toolResult);
      } else {
        result.push({ role: 'user', content: [toolResult] });
      }
      continue;
    }
    if (message.toolCalls?.length) {
      result.push({
        role: 'assistant',
        content: [
          ...(message.reasoningContent && message.reasoningSignature ? [{
            type: 'thinking',
            thinking: message.reasoningContent,
            signature: message.reasoningSignature,
          }] : []),
          ...(message.content ? [{ type: 'text', text: message.content }] : []),
          ...message.toolCalls.map((call) => ({
            type: 'tool_use',
            id: call.id,
            name: call.name,
            input: parseToolArguments(call.arguments),
          })),
        ],
      });
      continue;
    }
    result.push({ role: message.role, content: message.content });
  }
  return result;
}

function supportsReasoningControls(model: string): boolean {
  return /claude-(?:3[-.]?7|(?:sonnet|opus|haiku)-?4|4|(?:sonnet|fable)-5)/i.test(model);
}

function usesAdaptiveThinking(model: string): boolean {
  return /claude-(?:sonnet-5|fable-5|opus-4-(?:6|7|8))(?:$|-)/i.test(model);
}

function getThinkingBudget(value: string | undefined, maxTokens: number): number {
  const requested = value === 'low' ? 1024 : value === 'medium' ? 4096 : value === 'high' ? 8192 : 12288;
  return Math.max(1024, Math.min(requested, maxTokens - 1));
}


export class AnthropicProvider implements LLMProvider {
  readonly format = 'anthropic-messages';

  prepareRequest(messages: LLMMessage[], config: ProviderRequestConfig, stream: boolean): PreparedRequest {
    const baseURL = config.baseURL.trim().replace(/\/+$/, '');
    let url = baseURL;
    if (!url.endsWith('/v1/messages')) {
      url = url.endsWith('/v1') ? `${url}/messages` : `${url}/v1/messages`;
    }

    const maxTokens = config.maxTokens ?? Math.min(16384, Math.max(1024, Math.floor((config.contextWindow ?? 65536) / 4)));
    const reasoningEnabled = supportsReasoningControls(config.model) && maxTokens > 1024;
    const adaptive = usesAdaptiveThinking(config.model);
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');

    const anthropicMessages = toAnthropicMessages(messages);
    // Prompt 缓存：在 system prompt 和最后一条非 tool_result 的 user 消息上设置 cache_control
    // 避免缓存最后一条消息（工具调用场景下每轮都变），提高 cache hit rate
    const cacheControl = { type: 'ephemeral' };
    if (anthropicMessages.length > 0) {
      // 从后往前找第一条非 tool_result 的 user 消息
      for (let idx = anthropicMessages.length - 1; idx >= 0; idx--) {
        const msg = anthropicMessages[idx];
        if (msg.role !== 'user') continue;
        // 检查是否为 tool_result 消息（content 为数组且含 tool_result 类型）
        const isToolResult = Array.isArray(msg.content) &&
          msg.content.some((c: any) => c?.type === 'tool_result');
        if (isToolResult) continue;
        // 找到非 tool_result 的 user 消息，设置 cache_control
        if (typeof msg.content === 'string') {
          msg.content = [{ type: 'text', text: msg.content, cache_control: cacheControl }];
        } else if (Array.isArray(msg.content) && msg.content.length > 0) {
          const lastContent = msg.content[msg.content.length - 1];
          if (typeof lastContent === 'object' && lastContent !== null) {
            (lastContent as Record<string, unknown>).cache_control = cacheControl;
          }
        }
        break;
      }
    }

    const payload: Record<string, unknown> = {
      model: config.model,
      messages: anthropicMessages,
      max_tokens: maxTokens,
      stream,
      ...(system ? { system: [{ text: system, type: 'text', cache_control: cacheControl }] } : {}),
      ...(config.tools?.length ? {
        tools: config.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.parameters,
        })),
      } : {}),
      ...(reasoningEnabled
        ? adaptive
          ? {
              thinking: { type: 'adaptive' },
              output_config: { effort: normalizeReasoningEffort(config.thinkingStrength) },
            }
          : { thinking: { type: 'enabled', budget_tokens: getThinkingBudget(config.thinkingStrength, maxTokens) } }
        : config.temperature !== undefined ? { temperature: config.temperature } : {}),
    };

    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: stream ? 'text/event-stream' : 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Length': String(Buffer.byteLength(body)),
    };

    return { url, headers, body };
  }

  parseStreamData(data: string): ParsedStreamData {
    if (data === '[DONE]') return { done: true };
    try {
      const json = JSON.parse(data);
      if (json.type === 'error') return { error: json.error?.message || 'Anthropic 流式请求失败' };
      if (json.type === 'message_stop') return { done: true };
      // message_start: input_tokens + cache tokens
      if (json.type === 'message_start' && json.message?.usage) {
        const u = json.message.usage;
        const promptTokens = Number(u.input_tokens) || 0;
        if (promptTokens) {
          return {
            usage: {
              promptTokens,
              completionTokens: 0,
              totalTokens: promptTokens,
              cacheHitTokens: Number(u.cache_read_input_tokens) || undefined,
              cacheMissTokens: Number(u.cache_creation_input_tokens) || undefined,
            },
          };
        }
      }
      // message_delta: output_tokens (cumulative)
      if (json.type === 'message_delta' && json.usage) {
        const completionTokens = Number(json.usage.output_tokens) || 0;
        if (completionTokens) {
          return {
            usage: {
              promptTokens: 0,
              completionTokens,
              totalTokens: completionTokens,
            },
          };
        }
      }
      if (json.type === 'content_block_start' && json.content_block?.type === 'tool_use') {
        return {
          toolCallDeltas: [{
            index: json.index ?? 0,
            id: json.content_block.id,
            name: json.content_block.name,
          }],
        };
      }
      if (json.type !== 'content_block_delta') return {};
      if (json.delta?.type === 'text_delta') return { textDelta: extractText(json.delta.text) };
      if (json.delta?.type === 'thinking_delta') return { reasoningDelta: extractText(json.delta.thinking) };
      if (json.delta?.type === 'signature_delta') return { reasoningSignatureDelta: json.delta.signature || '' };
      if (json.delta?.type === 'input_json_delta') {
        return { toolCallDeltas: [{ index: json.index ?? 0, argumentsDelta: json.delta.partial_json || '' }] };
      }
      return {};
    } catch {
      return {};
    }
  }

  extractApiError(body: string): string {
    try {
      const json = JSON.parse(body);
      return json.error?.message || json.message || body.slice(0, 300);
    } catch {
      return body.slice(0, 300);
    }
  }
}
