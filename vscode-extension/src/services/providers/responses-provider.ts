import type { LLMMessage } from '../llm-service';
import type { ParsedStreamData, TokenUsage } from '../llm-api';
import type { LLMProvider, ProviderRequestConfig, PreparedRequest } from './base-provider';
import { extractText, normalizeReasoningEffort, supportsOpenAIReasoningControls as supportsReasoningControls } from './provider-utils';

function toResponsesInput(messages: LLMMessage[]): Array<Record<string, unknown>> {
  return messages.flatMap((message) => {
    if (message.role === 'tool') {
      return [{ type: 'function_call_output', call_id: message.toolCallId, output: message.content }];
    }
    if (message.providerItems?.length) return message.providerItems;
    const items: Array<Record<string, unknown>> = [];
    if (message.content) items.push({ role: message.role, content: message.content });
    if (message.toolCalls?.length) {
      items.push(...message.toolCalls.map((call) => ({
        type: 'function_call',
        call_id: call.id,
        name: call.name,
        arguments: call.arguments,
      })));
    }
    return items;
  });
}

export class ResponsesProvider implements LLMProvider {
  readonly format = 'responses';

  prepareRequest(messages: LLMMessage[], config: ProviderRequestConfig, stream: boolean): PreparedRequest {
    const baseURL = config.baseURL.trim().replace(/\/+$/, '');
    const url = baseURL.endsWith('/responses') ? baseURL : `${baseURL}/responses`;

    const maxTokens = config.maxTokens ?? Math.min(16384, Math.max(1024, Math.floor((config.contextWindow ?? 65536) / 4)));
    const reasoningEnabled = supportsReasoningControls(config.model);

    const payload: Record<string, unknown> = {
      model: config.model,
      input: toResponsesInput(messages),
      stream,
      max_output_tokens: maxTokens,
      ...(config.tools?.length ? {
        tools: config.tools.map((tool) => ({ type: 'function', ...tool, strict: true })),
      } : {}),
      ...(reasoningEnabled
        ? { reasoning: { effort: normalizeReasoningEffort(config.thinkingStrength), summary: 'auto' } }
        : config.temperature !== undefined ? { temperature: config.temperature } : {}),
    };

    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: stream ? 'text/event-stream' : 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Length': String(Buffer.byteLength(body)),
    };

    return { url, headers, body };
  }

  parseStreamData(data: string): ParsedStreamData {
    if (data === '[DONE]') return { done: true };
    try {
      const json = JSON.parse(data);
      if (json.type === 'response.failed') {
        return { error: json.response?.error?.message || json.error?.message || 'Responses API 请求失败' };
      }
      if (json.type === 'response.incomplete') {
        return { error: `模型输出未完成: ${json.response?.incomplete_details?.reason || '未知原因'}` };
      }
      if (json.type === 'response.completed') {
        const usage = json.response?.usage;
        if (usage) {
          const promptTokens = Number(usage.input_tokens) || 0;
          const completionTokens = Number(usage.output_tokens) || 0;
          if (promptTokens || completionTokens) {
            return {
              done: true,
              usage: {
                promptTokens,
                completionTokens,
                totalTokens: Number(usage.total_tokens) || promptTokens + completionTokens,
                cacheHitTokens: Number(usage.input_tokens_details?.cached_tokens) || undefined,
              },
            };
          }
        }
        return { done: true };
      }
      if (json.type === 'response.output_item.done' && json.item) return { outputItem: json.item };
      if (json.type === 'response.output_text.delta') return { textDelta: extractText(json.delta) };
      if (json.type === 'response.reasoning_summary_text.delta' || json.type === 'response.reasoning_text.delta') {
        return { reasoningDelta: extractText(json.delta) };
      }
      if (json.type === 'response.output_item.added' && json.item?.type === 'function_call') {
        return {
          toolCallDeltas: [{
            index: json.output_index ?? 0,
            id: json.item.call_id || json.item.id,
            name: json.item.name,
            argumentsDelta: json.item.arguments || '',
          }],
        };
      }
      if (json.type === 'response.function_call_arguments.delta') {
        return {
          toolCallDeltas: [{
            index: json.output_index ?? 0,
            id: json.call_id || json.item_id,
            argumentsDelta: json.delta || '',
          }],
        };
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
