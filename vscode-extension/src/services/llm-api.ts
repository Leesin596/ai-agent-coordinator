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
  tools?: LLMToolDefinition[];
}

export interface PreparedLLMRequest {
  format: ModelApiFormat;
  url: URL;
  headers: Record<string, string>;
  body: string;
}

export interface LLMToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LLMToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  argumentsDelta?: string;
  legacy?: boolean;
}

export const COORDINATOR_LLM_TOOLS: LLMToolDefinition[] = [
  {
    name: 'dispatch_session_task',
    description: '向当前工作区的另一个 AI 角色会话派发任务。target 使用团队上下文中标注的会话 ID。',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '目标会话的完整 ID 或唯一短 ID' },
        title: { type: 'string', description: '简洁明确的任务标题' },
        objective: { type: 'string', description: '任务目标、范围和预期结果' },
      },
      required: ['target', 'title', 'objective'],
      additionalProperties: false,
    },
  },
  {
    name: 'workspace_list_files',
    description: '列出当前工作区目录中的文件。忽略依赖、构建产物和受保护目录。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '工作区相对目录，默认 .' },
        limit: { type: 'integer', minimum: 1, maximum: 1000 },
        maxDepth: { type: 'integer', minimum: 0, maximum: 12 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'workspace_read_file',
    description: '读取当前工作区中的文本文件，可限制行范围。返回 sha256，覆盖文件时必须使用。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '工作区相对文件路径' },
        startLine: { type: 'integer', minimum: 1 },
        endLine: { type: 'integer', minimum: 1 },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'workspace_search',
    description: '在当前工作区文本文件中搜索固定字符串，返回文件、行号和匹配行。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        path: { type: 'string', description: '工作区相对目录，默认 .' },
        maxResults: { type: 'integer', minimum: 1, maximum: 100 },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'workspace_write_file',
    description: '创建文本文件，或在提供最近 read_file 返回的 expectedSha256 后覆盖现有文件。执行前需要用户批准。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
        expectedSha256: { type: 'string' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'workspace_replace',
    description: '在文本文件中精确替换内容。默认要求 oldText 唯一，执行前需要用户批准。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        oldText: { type: 'string' },
        newText: { type: 'string' },
        replaceAll: { type: 'boolean' },
      },
      required: ['path', 'oldText', 'newText'],
      additionalProperties: false,
    },
  },
  {
    name: 'workspace_delete',
    description: '删除当前工作区中的单个文件。执行前需要用户批准。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'git_status',
    description: '读取当前工作区的 Git 分支和简短状态，不修改仓库。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'git_diff',
    description: '读取当前工作区的 Git diff，可查看暂存区或限定文件，不修改仓库。',
    parameters: {
      type: 'object',
      properties: {
        staged: { type: 'boolean' },
        path: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'run_command',
    description: '在当前工作区执行用户批准的命令，用于构建、测试和诊断。命令有超时和输出上限，禁止静默执行。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeoutSeconds: { type: 'integer', minimum: 1, maximum: 300 },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
];

export interface ParsedStreamData {
  textDelta?: string;
  reasoningDelta?: string;
  toolCallDeltas?: LLMToolCallDelta[];
  reasoningSignatureDelta?: string;
  outputItem?: Record<string, unknown>;
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
      messages: toAnthropicMessages(messages),
      max_tokens: maxTokens,
      stream,
      ...(system ? { system } : {}),
      ...(config.tools?.length ? {
        tools: config.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.parameters,
        })),
      } : {}),
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
  } else {
    headers.Authorization = `Bearer ${config.apiKey}`;
    payload = {
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
  }

  const body = JSON.stringify(payload);
  headers['Content-Length'] = String(Buffer.byteLength(body));
  return { format, url, headers, body };
}

function extractText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const text = value.map((item) => extractText(item)).filter(Boolean).join('');
    return text || undefined;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return extractText(record.text) || extractText(record.content) || extractText(record.summary);
  }
  return undefined;
}

export function parseStreamData(format: ModelApiFormat, data: string): ParsedStreamData {
  if (data === '[DONE]') return { done: true };
  try {
    const json = JSON.parse(data);
    if (format === 'anthropic-messages') {
      if (json.type === 'error') return { error: json.error?.message || 'Anthropic 流式请求失败' };
      if (json.type === 'message_stop') return { done: true };
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
    }
    if (format === 'responses') {
      if (json.type === 'response.failed') {
        return { error: json.response?.error?.message || json.error?.message || 'Responses API 请求失败' };
      }
      if (json.type === 'response.incomplete') {
        return { error: `模型输出未完成: ${json.response?.incomplete_details?.reason || '未知原因'}` };
      }
      if (json.type === 'response.completed') return { done: true };
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
    }
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

export function extractApiError(body: string): string {
  try {
    const json = JSON.parse(body);
    return json.error?.message || json.message || body.slice(0, 300);
  } catch {
    return body.slice(0, 300);
  }
}
