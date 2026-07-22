// ============================================================
// ModelStore — 统一模型预设库
// 用 globalState 持久化，跨工作区共享。
// 取代旧的「全局 configuration + 角色级 llmConfig」分散配置：
//   - 左侧「模型设置」视图统一增删改模型预设
//   - 每个会话只从模型库选择一个模型，不再单独填表单
// ============================================================
import { randomUUID } from 'crypto';
import * as vscode from 'vscode';

export type ModelApiFormat = 'anthropic-messages' | 'chat-completions' | 'responses';

/** 单个模型预设 */
export interface ModelPreset {
  id: string;
  name: string;        // 档案名
  apiKey: string;
  baseURL: string;
  model: string;       // 模型标识
  apiFormat?: ModelApiFormat;
  thinkingStrength?: string; // 思考强度: low / medium / high / xhigh
  contextWindow?: number;    // 上下文窗口 (tokens)
  temperature?: number;
  apiKeyRequired?: boolean;  // 是否需要 API Key（本地模型如 Ollama 设为 false）
  createdAt: string;
}

/** 常用模型快捷预设（仅用于「新增」表单的快速填充，不强制） */
export const MODEL_QUICK_PRESETS: {
  name: string;
  model: string;
  baseURL: string;
  apiFormat: ModelApiFormat;
  apiKeyRequired: boolean;
}[] = [
  { name: 'GPT-5.6 Sol', model: 'gpt-5.6-sol', baseURL: 'https://api.openai.com/v1', apiFormat: 'responses', apiKeyRequired: true },
  { name: 'GPT-5.6 Terra', model: 'gpt-5.6-terra', baseURL: 'https://api.openai.com/v1', apiFormat: 'responses', apiKeyRequired: true },
  { name: 'Claude Sonnet 5', model: 'claude-sonnet-5', baseURL: 'https://api.anthropic.com', apiFormat: 'anthropic-messages', apiKeyRequired: true },
  { name: 'Claude Opus 4.8', model: 'claude-opus-4-8', baseURL: 'https://api.anthropic.com', apiFormat: 'anthropic-messages', apiKeyRequired: true },
  { name: 'DeepSeek V4 Pro', model: 'deepseek-v4-pro', baseURL: 'https://api.deepseek.com', apiFormat: 'chat-completions', apiKeyRequired: true },
  { name: 'DeepSeek Reasoner', model: 'deepseek-reasoner', baseURL: 'https://api.deepseek.com', apiFormat: 'chat-completions', apiKeyRequired: true },
  { name: 'GLM-5.2', model: 'glm-5.2', baseURL: 'https://open.bigmodel.cn/api/paas/v4', apiFormat: 'chat-completions', apiKeyRequired: true },
  { name: 'Ollama (local)', model: 'llama3.2', baseURL: 'http://localhost:11434/v1', apiFormat: 'chat-completions', apiKeyRequired: false },
  { name: 'OpenRouter Auto', model: 'auto', baseURL: 'https://openrouter.ai/api/v1', apiFormat: 'chat-completions', apiKeyRequired: true },
  { name: 'Gemini 2.5 Pro', model: 'gemini-2.5-pro', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', apiFormat: 'chat-completions', apiKeyRequired: true },
];

const KEY_MODELS = 'coordinator.models';
const KEY_DEFAULT = 'coordinator.defaultModelId';

export class ModelStore {
  constructor(private globalState: vscode.Memento) {}

  /** 列出全部模型预设（按创建时间升序） */
  list(): ModelPreset[] {
    const arr = this.globalState.get<ModelPreset[]>(KEY_MODELS, []);
    return [...arr].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(id: string): ModelPreset | undefined {
    return this.list().find((m) => m.id === id);
  }

  /** 新增模型预设 */
  async add(input: Omit<ModelPreset, 'id' | 'createdAt'>): Promise<ModelPreset> {
    const preset: ModelPreset = {
      apiFormat: 'chat-completions',
      thinkingStrength: 'xhigh',
      contextWindow: 128000,
      ...input,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    const arr = this.globalState.get<ModelPreset[]>(KEY_MODELS, []);
    arr.push(preset);
    await this.globalState.update(KEY_MODELS, arr);
    // 若是第一个，自动设为默认
    if (arr.length === 1) {
      await this.setDefault(preset.id);
    }
    return preset;
  }

  /** 更新模型预设 */
  async update(id: string, patch: Partial<Omit<ModelPreset, 'id' | 'createdAt'>>): Promise<ModelPreset | undefined> {
    const arr = this.globalState.get<ModelPreset[]>(KEY_MODELS, []);
    const idx = arr.findIndex((m) => m.id === id);
    if (idx < 0) return undefined;
    arr[idx] = { ...arr[idx], ...patch };
    await this.globalState.update(KEY_MODELS, arr);
    return arr[idx];
  }

  /** 删除模型预设；若删的是默认，则把第一个剩余的设为默认 */
  async delete(id: string): Promise<boolean> {
    const arr = this.globalState.get<ModelPreset[]>(KEY_MODELS, []);
    const next = arr.filter((m) => m.id !== id);
    if (next.length === arr.length) return false;
    await this.globalState.update(KEY_MODELS, next);
    const def = this.getDefaultId();
    if (def === id) {
      await this.setDefault(next.length > 0 ? next[0].id : '');
    }
    return true;
  }

  getDefaultId(): string {
    return this.globalState.get<string>(KEY_DEFAULT, '');
  }

  getDefault(): ModelPreset | undefined {
    const id = this.getDefaultId();
    if (!id) return this.list()[0]; // 无显式默认时取第一个
    return this.get(id);
  }

  async setDefault(id: string): Promise<void> {
    await this.globalState.update(KEY_DEFAULT, id);
  }

  /**
   * 首次迁移：若模型库为空，且旧的 VSCode configuration 有 apiKey，
   * 自动导入为一个「默认」预设，保证旧用户平滑升级。
   * 返回是否执行了迁移。
   */
  async migrateFromConfig(): Promise<boolean> {
    if (this.list().length > 0) return false;
    const cfg = vscode.workspace.getConfiguration('coordinator.llm');
    const apiKey = cfg.get<string>('apiKey', '');
    const baseURL = cfg.get<string>('baseURL', 'https://api.openai.com/v1');
    const model = cfg.get<string>('model', 'gpt-4o-mini');
    if (!apiKey) return false;
    await this.add({
      name: '默认模型',
      apiKey,
      baseURL,
      model,
      apiFormat: 'chat-completions',
      temperature: 0.7,
    });
    return true;
  }
}
