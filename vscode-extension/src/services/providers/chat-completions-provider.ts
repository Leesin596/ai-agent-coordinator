import type { LLMMessage } from '../llm-service';
import type { ParsedStreamData } from '../llm-api';
import type { LLMProvider, ProviderRequestConfig, PreparedRequest } from './base-provider';
import { extractText, normalizeReasoningEffort, supportsOpenAIReasoningControls as supportsReasoningControls } from './provider-utils';

function toChatMessages(messages: LLMMessage[]): Array<Record<string, unknown>> {
  return messages.map((message) => {
    const legacyCall = message.toolCalls?.find((call) => call.legacy);
    if (message.role === 'function') {
      return { role: 'function', name: message.toolCallName, content: message.content };
    }
    return {
      role: message.role,
      content: message.content,
      ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
      ...(legacyCall ? {
        function_call: { name: legacyCall.name, arguments: legacyCall.arguments },
      } : message.toolCalls?.length ? {
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        })),
      } : {}),
    };
  });
}

export class ChatCompletionsProvider implements LLMProvider {
  readonly format = 'chat-completions';

  prepareRequest(messages: LLMMessage[], config: ProviderRequestConfig, stream: boolean): PreparedRequest {
    const baseURL = config.baseURL.trim().replace(/\/+$/, '');
    const url = baseURL.endsWith('/chat/completions') ? baseURL : `${baseURL}/chat/completions`;

    const maxTokens = config.maxTokens ?? Math.min(16384, Math.max(1024, Math.floor((config.contextWindow ?? 65536) / 4)));
    const reasoningEnabled = supportsReasoningControls(config.model);

    const payload: Record<string, unknown> = {
      model: config.model,
      messages: toChatMessages(messages),
      stream,
      ...(config.tools?.length ? {
        tools: config.tools.map((tool) => ({ type: 'function', function: tool })),
        tool_choice: 'auto',
      } : {}),
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

    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: stream ? 'text/event-stream' : 'application/json',
      'Content-Length': String(Buffer.byteLength(body)),
    };
    if (config.apiKey) {
      headers['Authorization'] = `Bearer ${config.apiKey}`;
    }

    return { url, headers, body };
  }

  parseStreamData(data: string): ParsedStreamData {
    if (data === '[DONE]') return { done: true };
    try {
      const json = JSON.parse(data);
      const choice = json.choices?.[0];
      if (json.error) return { error: json.error.message || 'Chat Completions 请求失败' };
      const delta = choice?.delta || {};
      const toolCalls = Array.isArray(delta.tool_calls)
        ? delta.tool_calls.map((call: any) => ({
            index: call.index ?? 0,
            id: call.id,
            name: call.function?.name,
            argumentsDelta: call.function?.arguments,
          }))
        : delta.function_call
          ? [{
              index: 0,
              id: 'legacy_function_call',
              name: delta.function_call.name,
              argumentsDelta: delta.function_call.arguments,
              legacy: true,
            }]
          : undefined;
      return {
        textDelta: extractText(delta.content),
        reasoningDelta:
          extractText(delta.reasoning_content) ||
          extractText(delta.reasoning) ||
          extractText(delta.thinking) ||
          extractText(delta.reasoning_details),
        toolCallDeltas: toolCalls,
        done: Boolean(choice?.finish_reason),
      };
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
