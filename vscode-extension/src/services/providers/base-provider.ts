import type { LLMMessage, LLMToolCall } from '../llm-service';
import type { LLMToolDefinition, ParsedStreamData } from '../llm-api';

export interface ProviderRequestConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  contextWindow?: number;
  thinkingStrength?: string;
  tools?: LLMToolDefinition[];
}

export interface PreparedRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface LLMProvider {
  format: string;
  prepareRequest(messages: LLMMessage[], config: ProviderRequestConfig, stream: boolean): PreparedRequest;
  parseStreamData(data: string): ParsedStreamData;
  extractApiError(body: string): string;
}
