import type { LLMProvider, ProviderRequestConfig } from './base-provider';
export type { LLMProvider, ProviderRequestConfig };
import { AnthropicProvider } from './anthropic-provider';
import { ChatCompletionsProvider } from './chat-completions-provider';
import { ResponsesProvider } from './responses-provider';
import { normalizeApiFormat } from '../llm-api';

export { normalizeApiFormat };

export function createProvider(apiFormat?: string): LLMProvider {
  const format = normalizeApiFormat(apiFormat);
  switch (format) {
    case 'anthropic-messages':
      return new AnthropicProvider();
    case 'responses':
      return new ResponsesProvider();
    default:
      return new ChatCompletionsProvider();
  }
}
