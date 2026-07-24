// ============================================================
// Core Data Models for AI Agent Coordinator
// ============================================================

// --- Task ---

export type TaskStatus = 'pending' | 'ready' | 'in_progress' | 'blocked' | 'done' | 'failed';
export type TaskPriority = 'critical' | 'high' | 'medium' | 'low';

export interface Task {
  id: string;
  project: string;
  title: string;
  description: string;
  status: TaskStatus;
  assignee: string;
  dependencies: string[];
  dependents: string[];
  inputs: Record<string, any>;
  outputs: Record<string, any>;
  contractRefs: string[];
  priority: TaskPriority;
  version: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  metadata: Record<string, any>;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  assignee: string;
  dependencies?: string[];
  contractRefs?: string[];
  priority?: TaskPriority;
  inputs?: Record<string, any>;
  metadata?: Record<string, any>;
}

// --- Contract ---

export type ContractType = 'api' | 'data_model' | 'event' | 'config';
export type ContractStatus = 'draft' | 'proposed' | 'agreed' | 'implemented' | 'deprecated';

export interface Contract {
  id: string;
  project: string;
  name: string;
  type: ContractType;
  version: number;
  status: ContractStatus;
  producer: string;
  consumers: string[];
  schema: Record<string, any>;
  examples: Record<string, any>[];
  breakingChanges: BreakingChange[];
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, any>;
}

export interface BreakingChange {
  version: number;
  description: string;
  affectedConsumers: string[];
  migrateGuide: string;
  timestamp: string;
}

export interface CreateContractInput {
  name: string;
  type: ContractType;
  status?: ContractStatus;
  producer: string;
  consumers?: string[];
  schema: Record<string, any>;
  examples?: Record<string, any>[];
  metadata?: Record<string, any>;
}

// --- Memory ---

export type MemoryCategory = 'decision' | 'convention' | 'architecture' | 'lesson' | 'note';

export interface Memory {
  id: string;
  project: string;
  category: MemoryCategory;
  title: string;
  content: string;
  tags: string[];
  scope: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  references: string[];
}

export interface CreateMemoryInput {
  category: MemoryCategory;
  title: string;
  content: string;
  tags?: string[];
  scope?: string;
  createdBy: string;
  references?: string[];
}

// --- Event ---

export type EventType =
  | 'task.created'
  | 'task.status_changed'
  | 'task.completed'
  | 'task.blocked'
  | 'task.ready'
  | 'contract.created'
  | 'contract.updated'
  | 'contract.breaking_change'
  | 'contract.agreed'
  | 'agent.connected'
  | 'agent.disconnected'
  | 'agent.context_stale'
  | 'system.conflict_detected'
  | 'system.sync_completed'
  // 会话间任务派发
  | 'session_task.dispatched'
  | 'session_task.aligned'
  | 'session_task.clarify_requested'
  | 'session_task.supplemented'
  | 'session_task.accepted'
  | 'session_task.in_progress'
  | 'session_task.completed'
  | 'session_task.cancelled'
  | 'session_task.rejected';

export interface CoordinatorEvent {
  id: string;
  project: string;
  type: EventType;
  source: string;
  target?: string;
  payload: any;
  timestamp: string;
}

// --- Agent ---

export interface Agent {
  project: string;
  role: string;
  instanceId: string;
  status: 'online' | 'offline';
  lastSeen: string;
  lastEventId?: number;
  metadata: Record<string, any>;
}

// --- Context ---

export interface ContextRequest {
  agentRole: string;
  project?: string;
  tokenBudget?: number;
  focusTaskId?: string;
  includeHistory?: boolean;
  format?: 'markdown' | 'json';
}

export interface CompiledContext {
  agentRole: string;
  generatedAt: string;
  tokenEstimate: number;
  sections: {
    currentTask: string;
    dependencies: string;
    contracts: string;
    decisions: string;
    conventions: string;
    warnings: string;
  };
}

// ============================================================
// 插件新增模型
// ============================================================

// --- Workspace（工作区 = 项目文件夹）---

export interface Workspace {
  id: string;
  name: string;
  folderPath: string;
  dbPath: string;
  createdAt: string;
  lastActiveAt?: string;
}

export interface CreateWorkspaceInput {
  name: string;
  folderPath: string;
}

// --- Role（会话角色）---

export type RoleCategory = 'engineering' | 'product' | 'design' | 'qa' | 'custom';

/**
 * 角色级 LLM 配置。所有字段可选——留空则回退到全局配置（coordinator.llm.*）。
 * 允许不同角色走不同模型（如前端角色用 Claude，后端角色用 GPT）。
 */
export interface RoleLLMConfig {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  temperature?: number;
}

export interface Role {
  id: string;
  name: string;
  category: RoleCategory;
  description: string;
  skillSlug: string;
  skills: string[];
  skillContent: string;
  systemPrompt: string;
  icon?: string;
  builtIn: boolean;
  sortOrder: number;
  /** 角色级 LLM 配置（可选，留空字段回退全局） */
  llmConfig?: RoleLLMConfig;
  /** 允许使用的工具名称白名单（空=继承默认全部工具） */
  allowedTools?: string[];
  /** 禁止使用的工具名称黑名单（优先于 allowedTools） */
  deniedTools?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateRoleInput {
  name: string;
  category: RoleCategory;
  description?: string;
  skillSlug?: string;
  skills?: string[];
  skillContent?: string;
  systemPrompt?: string;
  icon?: string;
  llmConfig?: RoleLLMConfig;
  allowedTools?: string[];
  deniedTools?: string[];
}

export const ROLE_CATEGORY_LABELS: Record<RoleCategory, string> = {
  engineering: '工程研发',
  product: '产品',
  design: '设计',
  qa: '质量保障',
  custom: '自定义',
};

// --- Session（AI 会话）---

export interface Session {
  id: string;
  workspaceId: string;
  roleId: string;
  title: string;
  /** 会话绑定的模型预设 ID（指向 ModelStore）。空则用默认模型预设 */
  modelId?: string;
  createdAt: string;
  updatedAt: string;
}

// --- Message（会话消息）---

export type MessageRole = 'user' | 'assistant' | 'system';

export interface Message {
  id: string;
  sessionId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
}

// ============================================================
// 会话间任务派发 (Session Task Dispatch) + 上下文对齐
// ============================================================

/** 对齐握手状态：派发后接收方需先对齐上下文再开工 */
export type SessionTaskAlignment = 'pending' | 'aligned' | 'clarify' | 'rejected';

/** 会话任务生命周期 */
export type SessionTaskStatus =
  | 'proposed'    // 已派发，待接收方对齐/接受
  | 'accepted'    // 已接受
  | 'in_progress' // 进行中
  | 'completed'   // 已完成
  | 'cancelled'   // 已取消
  | 'failed';     // 失败

/**
 * 派发方打包的对齐上下文载荷。
 * 接收方 reviewContext 时，系统会把里面的 related* 引用解析成实际内容，
 * 编译成双方共享的完整对齐文档 —— 这是"两个会话对齐任务上下文"的核心。
 */
export interface TaskContextPayload {
  /** 派发方角色快照 */
  sourceRole: { id: string; name: string; category: string };
  /** 任务目标（一句话说清要干什么） */
  objective: string;
  /** 验收标准 */
  acceptanceCriteria: string[];
  /** 派发方当前进展摘要（让接收方知道上游做到哪了） */
  progressSummary: string;
  /** 相关协调器任务引用 (tasks.id) — review 时拉取实际内容 */
  relatedTasks: string[];
  /** 相关契约引用 (contracts.id) — review 时拉取实际 schema */
  relatedContracts: string[];
  /** 相关记忆引用 (memories.id) — review 时拉取实际内容 */
  relatedMemories: string[];
  /** 派发方关键对话摘要（来龙去脉，避免接收方重复提问） */
  conversationDigest: string;
  /** 期望产出格式 */
  expectedOutput: string;
  /** 约束 / 注意事项 */
  constraints: string[];
}

export interface SessionTask {
  id: string;
  workspaceId: string;
  sourceSessionId: string;
  targetSessionId: string;
  sourceRoleId: string;
  targetRoleId: string;
  title: string;
  brief: string;
  contextPayload: TaskContextPayload;
  alignmentStatus: SessionTaskAlignment;
  alignmentNote: string;
  status: SessionTaskStatus;
  result: string;
  parentTaskId?: string;
  priority: TaskPriority;
  createdAt: string;
  alignedAt?: string;
  acceptedAt?: string;
  completedAt?: string;
  metadata: Record<string, any>;
  version: number;
}

export interface DispatchSessionTaskInput {
  sourceSessionId: string;
  targetSessionId: string;
  title: string;
  brief?: string;
  contextPayload: TaskContextPayload;
  parentTaskId?: string;
  priority?: TaskPriority;
  metadata?: Record<string, any>;
}

/**
 * reviewContext 编译出的完整对齐上下文。
 * 双方基于这一份文档协作 —— 派发方打包引用，系统解析成实际内容。
 */
export interface AlignedContextView {
  taskId: string;
  title: string;
  // 派发方 / 接收方会话与角色
  source: { sessionId: string; roleId: string; roleName: string };
  target: { sessionId: string; roleId: string; roleName: string };
  // 派发方原始 payload
  payload: TaskContextPayload;
  // 解析引用后拉取的实际内容
  resolved: {
    tasks: Task[];
    contracts: Contract[];
    memories: Memory[];
  };
  // 编译成 Markdown 的完整对齐文档（双方共享同一份）
  document: string;
  generatedAt: string;
}

// ============================================================
// Orchestrator — 自动编排（P2-13）
// ============================================================

/** LLM 调用接口（由调用方注入实现，core 层不依赖具体 LLM service） */
export interface LLMCallFunction {
  (messages: Array<{ role: string; content: string }>, options?: { temperature?: number; maxTokens?: number }): Promise<string>;
}

/** 编排子任务（LLM 拆解输出） */
export interface SubTask {
  /** 子任务在编排计划中的索引（0-based），用于依赖引用 */
  index: number;
  title: string;
  objective: string;
  /** 目标角色 ID 或角色名称关键词（用于自动匹配角色） */
  targetRole: string;
  /** 依赖的子任务索引列表 */
  dependencies: number[];
  /** 验收标准 */
  acceptanceCriteria: string[];
  /** 期望产出 */
  expectedOutput: string;
}

/** 编排计划 */
export interface OrchestrationPlan {
  /** 原始任务描述 */
  description: string;
  /** 拆解出的子任务列表 */
  subTasks: SubTask[];
  /** 编排摘要（LLM 生成的计划说明） */
  summary: string;
}

/** 编排输入参数 */
export interface OrchestrateInput {
  /** 任务描述 */
  description: string;
  /** 上下文摘要（可选） */
  context?: string;
  /** 源会话 ID（编排发起方） */
  sourceSessionId: string;
  /** 工作区 ID */
  workspaceId: string;
  /** 最大子任务数（默认 5） */
  maxSubTasks?: number;
  /** 编排深度（默认 2，防止递归编排） */
  maxDepth?: number;
  /** 当前编排深度（内部递归追踪，外部调用不传） */
  currentDepth?: number;
  /** 等待子任务完成的超时时间（毫秒，默认 120000） */
  timeoutMs?: number;
}

/** 单个子任务的执行结果 */
export interface SubTaskResult {
  index: number;
  title: string;
  targetRole: string;
  targetSessionId: string;
  taskId: string;
  status: 'completed' | 'cancelled' | 'failed' | 'timeout';
  result: string;
}

/** 编排最终结果 */
export interface OrchestrationResult {
  plan: OrchestrationPlan;
  subTaskResults: SubTaskResult[];
  /** LLM 生成的汇总报告 */
  summary: string;
  /** 整体状态 */
  status: 'completed' | 'partial' | 'failed';
  /** 编排 ID */
  orchestrationId: string;
}
