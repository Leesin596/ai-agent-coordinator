import type { ModelApiFormat } from './model-store';

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
    name: 'workspace_apply_diff',
    description: '对文本文件应用 unified diff 格式的行级补丁，适合多行多处精确修改。执行前需要用户批准。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '工作区相对文件路径' },
        diff: { type: 'string', description: 'Unified diff 格式补丁内容，包含 @@ hunk 头和 +/- 行' },
      },
      required: ['path', 'diff'],
      additionalProperties: false,
    },
  },
  {
    name: 'workspace_search_replace',
    description: '在文本文件中搜索并替换首个匹配（或设置 replaceAll 替换全部）。不要求 searchText 唯一。执行前需要用户批准。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '工作区相对文件路径' },
        searchText: { type: 'string', description: '要搜索的文本' },
        replaceText: { type: 'string', description: '替换后的文本' },
        replaceAll: { type: 'boolean', description: '是否替换所有匹配，默认 false（仅替换首个）' },
      },
      required: ['path', 'searchText', 'replaceText'],
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
  {
    name: 'todo_list_create',
    description: '为当前会话创建多步任务清单（替换原有清单）。复杂任务应先创建清单再逐步执行。',
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          minItems: 1,
          maxItems: 50,
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: '任务步骤描述' },
              priority: { type: 'string', enum: ['high', 'medium', 'low'] },
            },
            required: ['content'],
            additionalProperties: false,
          },
        },
      },
      required: ['items'],
      additionalProperties: false,
    },
  },
  {
    name: 'todo_list_update',
    description: '更新当前会话 todo 清单中某一项的状态或内容。开始执行某步时标记 in_progress，完成后标记 completed。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'todo 项 ID（由 todo_list_create 返回）' },
        status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'failed'] },
        content: { type: 'string', description: '更新后的任务步骤描述（可选）' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'todo_list_read',
    description: '读取当前会话的完整 todo 清单，查看各步骤状态和进度。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'todo_list_delete',
    description: '删除当前会话 todo 清单中的指定项。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '要删除的 todo 项 ID' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'workspace_semantic_search',
    description: '基于语义搜索工作区代码，适合用自然语言描述查找相关代码位置。比 workspace_search 的字符串匹配更适合大代码库。返回文件路径、行号范围、代码片段和相似度分数。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '自然语言查询描述，例如"用户认证逻辑"或"数据库连接池配置"' },
        topK: { type: 'integer', minimum: 1, maximum: 50, description: '返回结果数，默认 10' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'orchestrate_task',
    description: '自动编排：将复杂任务拆解为子任务，自动分配给合适的角色会话执行，等待结果并生成汇总报告。适用于需要多角色协作的复杂任务。执行后会自动创建/复用目标角色会话、派发任务并等待完成。',
    parameters: {
      type: 'object',
      properties: {
        description: { type: 'string', description: '要编排的复杂任务描述，应包含任务目标、范围和预期产出' },
        context: { type: 'string', description: '任务上下文摘要（可选），提供已有进展、约束等信息帮助 LLM 更准确拆解' },
        maxSubTasks: { type: 'integer', minimum: 1, maximum: 10, description: '最大子任务数，默认 5' },
      },
      required: ['description'],
      additionalProperties: false,
    },
  },
  {
    name: 'history_search',
    description: '搜索当前会话被上下文压缩归档的历史消息。当对话较长、早期内容被自动压缩后，可用此工具检索之前讨论过的关键信息、决策或代码片段。使用自然语言关键词搜索。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词或自然语言描述，例如"用户认证方案"或"数据库迁移决策"' },
        topK: { type: 'integer', minimum: 1, maximum: 20, description: '返回结果数，默认 5' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
];

/** API 返回的真实 token 用量 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** 缓存命中的 input tokens（DeepSeek prompt_cache_hit_tokens / OpenAI cached_tokens / Anthropic cache_read_input_tokens） */
  cacheHitTokens?: number;
  /** 缓存未命中的 input tokens（DeepSeek prompt_cache_miss_tokens） */
  cacheMissTokens?: number;
}

export interface ParsedStreamData {
  textDelta?: string;
  reasoningDelta?: string;
  toolCallDeltas?: LLMToolCallDelta[];
  reasoningSignatureDelta?: string;
  outputItem?: Record<string, unknown>;
  usage?: TokenUsage;
  done?: boolean;
  error?: string;
}

export const FORMAT_ALIASES: Record<string, ModelApiFormat> = {
  'anthropic-messages': 'anthropic-messages',
  anthropic: 'anthropic-messages',
  'chat-completions': 'chat-completions',
  'openai-compatible': 'chat-completions',
  responses: 'responses',
  custom: 'chat-completions',
  ollama: 'chat-completions',
  openrouter: 'chat-completions',
  deepseek: 'chat-completions',
  gemini: 'chat-completions',
  'google': 'chat-completions',
};

export function normalizeApiFormat(format?: string): ModelApiFormat {
  return FORMAT_ALIASES[format || ''] || 'chat-completions';
}

// ============================================================
// Backward-compat wrappers: delegate to Provider classes
// ============================================================

import type { LLMMessage } from './llm-service';
import { createProvider } from './providers';
import { ChatCompletionsProvider } from './providers/chat-completions-provider';

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

export function prepareLLMRequest(
  messages: LLMMessage[],
  config: LLMRequestConfig,
  stream: boolean,
): PreparedLLMRequest {
  const provider = createProvider(config.apiFormat);
  const prepared = provider.prepareRequest(messages, {
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    model: config.model,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    contextWindow: config.contextWindow,
    thinkingStrength: config.thinkingStrength,
    tools: config.tools,
  }, stream);
  return {
    format: normalizeApiFormat(config.apiFormat),
    url: new URL(prepared.url),
    headers: prepared.headers,
    body: prepared.body,
  };
}

export function parseStreamData(format: ModelApiFormat, data: string): ParsedStreamData {
  const provider = createProvider(format);
  return provider.parseStreamData(data);
}

export function extractApiError(body: string): string {
  return new ChatCompletionsProvider().extractApiError(body);
}