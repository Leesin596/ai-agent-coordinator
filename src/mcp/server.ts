import { randomUUID } from 'crypto';
import * as path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { CoordinatorDB } from '../db/database';
import { EventBus } from '../core/event-bus';
import { TaskManager } from '../core/task-manager';
import { ContractRegistry } from '../core/contract-registry';
import { MemoryStore } from '../core/memory-store';
import { ContextCompiler } from '../core/context-compiler';
import { SessionTaskDispatcher } from '../core/session-task-dispatcher';
import { RoleManager } from '../core/role-manager';
import { SessionManager } from '../core/session-manager';
import { resolveDBPath } from '../db/db-path';

// --- Bootstrap (same as index.ts but without HTTP/WS) ---
const DB_PATH = resolveDBPath();

// 模块级实例（main 中异步初始化 sql.js 后 setDB）
let db!: CoordinatorDB;
const eventBus = new EventBus();
const taskManager = new TaskManager(eventBus);
const contractRegistry = new ContractRegistry(eventBus);
const memoryStore = new MemoryStore();
const contextCompiler = new ContextCompiler(taskManager, contractRegistry, memoryStore);
const sessionTaskDispatcher = new SessionTaskDispatcher();
const roleManager = new RoleManager();
const sessionManager = new SessionManager();

// --- MCP Server ---
const server = new McpServer({
  name: 'ai-agent-coordinator',
  version: '0.1.0',
});

// ponytail: contain MCP SDK generic inference here; restore typed handlers if the SDK exposes a lightweight registration type.
const registerTool = (
  name: string,
  description: string,
  schema: Record<string, z.ZodTypeAny>,
  handler: (args: any) => any
): void => {
  server.tool(name, description, schema as any, handler as any);
};

// =============================================
// Tools
// =============================================

// --- Task tools ---

registerTool(
  'create_task',
  'Create a new task in the coordinator DAG',
  {
    title: z.string().describe('Task title'),
    description: z.string().optional().describe('Task description'),
    assignee: z.string().describe('Agent role assigned to this task (e.g. frontend, backend)'),
    dependencies: z.array(z.string()).optional().describe('IDs of tasks this depends on'),
    priority: z.enum(['critical', 'high', 'medium', 'low']).optional().describe('Task priority'),
    inputs: z.record(z.any()).optional().describe('Input data for the task'),
    metadata: z.record(z.any()).optional().describe('Additional metadata'),
    project: z.string().optional().describe('Project namespace (default: "default")'),
  },
  async (params) => {
    try {
      const task = taskManager.create(params);
      return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }
);

registerTool(
  'list_tasks',
  'List all tasks, optionally filtered by assignee or status',
  {
    assignee: z.string().optional().describe('Filter by agent role'),
    status: z.enum(['pending', 'ready', 'in_progress', 'blocked', 'done', 'failed']).optional().describe('Filter by status'),
    project: z.string().optional().describe('Project namespace'),
  },
  async (params) => {
    const tasks = taskManager.list(params);
    return { content: [{ type: 'text', text: JSON.stringify(tasks, null, 2) }] };
  }
);

registerTool(
  'get_task',
  'Get a single task by ID',
  { id: z.string().describe('Task ID') },
  async ({ id }) => {
    const task = taskManager.get(id);
    if (!task) return { content: [{ type: 'text', text: `Task not found: ${id}` }], isError: true };
    return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] };
  }
);

registerTool(
  'update_task_status',
  'Update a task\'s status (pending→ready→in_progress→done/failed). Cascades to dependents.',
  {
    id: z.string().describe('Task ID'),
    status: z.enum(['pending', 'ready', 'in_progress', 'blocked', 'done', 'failed']).describe('New status'),
    outputs: z.record(z.any()).optional().describe('Output data if completing'),
  },
  async ({ id, status, outputs }) => {
    try {
      const task = taskManager.updateStatus(id, status, outputs);
      return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }
);

registerTool(
  'get_ready_tasks',
  'Get tasks that are ready to be worked on, optionally for a specific agent',
  {
    assignee: z.string().optional().describe('Filter by agent role'),
    project: z.string().optional().describe('Project namespace'),
  },
  async ({ assignee, project }) => {
    const tasks = taskManager.getReadyTasks(assignee, project);
    return { content: [{ type: 'text', text: JSON.stringify(tasks, null, 2) }] };
  }
);

registerTool(
  'get_task_graph',
  'Get the full task dependency graph (nodes + edges)',
  { project: z.string().optional().describe('Project namespace') },
  async ({ project }) => {
    const graph = taskManager.getGraph(project);
    return { content: [{ type: 'text', text: JSON.stringify(graph, null, 2) }] };
  }
);

// --- Contract tools ---

registerTool(
  'create_contract',
  'Create an API contract between agents (producer↔consumer)',
  {
    name: z.string().describe('Contract name'),
    type: z.enum(['api', 'data_model', 'event', 'config']).describe('Contract type'),
    producer: z.string().describe('Agent role that produces this API'),
    consumers: z.array(z.string()).optional().describe('Agent roles consuming this API'),
    schema: z.record(z.any()).describe('API schema definition (JSON Schema style)'),
    examples: z.array(z.record(z.any())).optional().describe('Example payloads'),
    metadata: z.record(z.any()).optional().describe('Additional metadata'),
    project: z.string().optional().describe('Project namespace'),
  },
  async (params) => {
    try {
      const contract = contractRegistry.create(params);
      return { content: [{ type: 'text', text: JSON.stringify(contract, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }
);

registerTool(
  'list_contracts',
  'List all contracts, optionally filtered',
  {
    producer: z.string().optional().describe('Filter by producer'),
    consumer: z.string().optional().describe('Filter by consumer'),
    type: z.string().optional().describe('Filter by type'),
    status: z.enum(['draft', 'proposed', 'agreed', 'implemented', 'deprecated']).optional(),
    project: z.string().optional().describe('Project namespace'),
  },
  async (params) => {
    const contracts = contractRegistry.list(params);
    return { content: [{ type: 'text', text: JSON.stringify(contracts, null, 2) }] };
  }
);

registerTool(
  'get_contract',
  'Get a single contract by ID',
  { id: z.string().describe('Contract ID') },
  async ({ id }) => {
    const contract = contractRegistry.get(id);
    if (!contract) return { content: [{ type: 'text', text: `Contract not found: ${id}` }], isError: true };
    return { content: [{ type: 'text', text: JSON.stringify(contract, null, 2) }] };
  }
);

registerTool(
  'update_contract',
  'Update a contract\'s schema, status, or metadata. Detects breaking changes automatically.',
  {
    id: z.string().describe('Contract ID'),
    schema: z.record(z.any()).optional().describe('New schema'),
    status: z.enum(['draft', 'proposed', 'agreed', 'implemented', 'deprecated']).optional(),
    examples: z.array(z.record(z.any())).optional(),
    metadata: z.record(z.any()).optional(),
    project: z.string().optional().describe('Project namespace — if provided, verifies the contract belongs to this project'),
  },
  async ({ id, project, ...updates }) => {
    try {
      if (project) {
        const existing = contractRegistry.get(id);
        if (!existing) return { content: [{ type: 'text', text: `Contract not found: ${id}` }], isError: true };
        if (existing.project !== project) {
          return { content: [{ type: 'text', text: `Contract ${id} does not belong to project "${project}" (actual: "${existing.project}")` }], isError: true };
        }
      }
      const contract = contractRegistry.update(id, updates);
      return { content: [{ type: 'text', text: JSON.stringify(contract, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// --- Memory tools ---

registerTool(
  'store_memory',
  'Store a piece of project knowledge (decisions, conventions, lessons learned)',
  {
    category: z.enum(['decision', 'convention', 'architecture', 'lesson', 'note']).describe('Memory category'),
    title: z.string().describe('Short title'),
    content: z.string().describe('Detailed content'),
    tags: z.array(z.string()).optional().describe('Tags for search'),
    scope: z.string().optional().describe('Scope (global, module name, etc.)'),
    createdBy: z.string().describe('Agent role that created this'),
    references: z.array(z.string()).optional().describe('Related resource IDs'),
    project: z.string().optional().describe('Project namespace'),
  },
  async (params) => {
    const memory = memoryStore.create(params);
    return { content: [{ type: 'text', text: JSON.stringify(memory, null, 2) }] };
  }
);

registerTool(
  'search_memories',
  'Search stored project knowledge by keyword',
  {
    query: z.string().describe('Search query'),
    project: z.string().optional().describe('Project namespace'),
  },
  async ({ query, project }) => {
    const results = memoryStore.search(query, project);
    return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
  }
);

registerTool(
  'list_memories',
  'List all memories, optionally filtered',
  {
    category: z.enum(['decision', 'convention', 'architecture', 'lesson', 'note']).optional(),
    scope: z.string().optional(),
    tag: z.string().optional(),
    createdBy: z.string().optional(),
    project: z.string().optional().describe('Project namespace'),
  },
  async (params) => {
    const memories = memoryStore.list(params);
    return { content: [{ type: 'text', text: JSON.stringify(memories, null, 2) }] };
  }
);

// --- Context tool ---

registerTool(
  'compile_context',
  'Compile a tailored context snapshot for an agent within a token budget',
  {
    agentRole: z.string().describe('Target agent role'),
    tokenBudget: z.number().optional().describe('Max tokens (default 8000)'),
    focusTaskId: z.string().optional().describe('Specific task to focus on'),
    format: z.enum(['markdown', 'json']).optional().describe('Output format'),
    project: z.string().optional().describe('Project namespace'),
  },
  async (params) => {
    try {
      const ctx = contextCompiler.compile(params);
      if (params.format === 'json') {
        return { content: [{ type: 'text', text: JSON.stringify(ctx, null, 2) }] };
      }
      // Default: markdown
      const md = contextToMarkdown(ctx);
      return { content: [{ type: 'text', text: md }] };
    } catch (err: any) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// --- Event tools ---

registerTool(
  'get_events',
  'Get recent coordinator events (for catching up)',
  {
    since: z.number().optional().describe('Get events after this sequence number (default 0)'),
    project: z.string().optional().describe('Project namespace'),
  },
  async ({ since, project }) => {
    const events = eventBus.getEventsSince(since || 0, project);
    return { content: [{ type: 'text', text: JSON.stringify({ events, total: eventBus.getEventCount(project) }, null, 2) }] };
  }
);

// --- Agent tools ---

registerTool(
  'register_agent',
  'Register this AI agent with the coordinator',
  {
    role: z.string().describe('Agent role (frontend, backend, etc.)'),
    instanceId: z.string().optional().describe('Unique instance ID'),
    metadata: z.record(z.any()).optional().describe('Agent metadata'),
    project: z.string().optional().describe('Project namespace'),
  },
  async ({ role, instanceId, metadata, project }) => {
    const agent = {
      project: project || 'default',
      role,
      instanceId: instanceId || randomUUID(),
      status: 'online' as const,
      lastSeen: new Date().toISOString(),
      lastEventSeq: db.getMaxEventSeq(),
      metadata: metadata || {},
    };
    db.upsertAgent(agent);
    eventBus.emit('agent.connected', role, { role, instanceId: agent.instanceId });
    return { content: [{ type: 'text', text: JSON.stringify(agent, null, 2) }] };
  }
);

registerTool(
  'list_agents',
  'List all registered agents',
  { project: z.string().optional().describe('Project namespace') },
  async ({ project }) => {
    const agents = db.listAgents(project);
    return { content: [{ type: 'text', text: JSON.stringify(agents, null, 2) }] };
  }
);

// --- Health ---

registerTool(
  'health',
  'Check coordinator health status',
  { project: z.string().optional().describe('Project namespace') },
  async ({ project }) => {
    const status = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      project: project || 'default',
      agents: db.listAgents(project).length,
      tasks: taskManager.list({ project }).length,
      contracts: contractRegistry.list({ project }).length,
      events: eventBus.getEventCount(project),
      dbPath: DB_PATH,
    };
    return { content: [{ type: 'text', text: JSON.stringify(status, null, 2) }] };
  }
);

// =============================================
// Resources (read-only data exposed to AI)
// =============================================

server.resource(
  'task-graph',
  'coordinator://tasks/graph',
  async (uri) => ({
    contents: [{
      uri: uri.href,
      mimeType: 'application/json',
      text: JSON.stringify(taskManager.getGraph(), null, 2),
    }],
  })
);

server.resource(
  'all-contracts',
  'coordinator://contracts',
  async (uri) => ({
    contents: [{
      uri: uri.href,
      mimeType: 'application/json',
      text: JSON.stringify(contractRegistry.list(), null, 2),
    }],
  })
);

// --- Session Task tools ---

registerTool(
  'list_roles',
  'List all available AI agent roles (built-in and custom)',
  {},
  async () => {
    const roles = roleManager.list();
    return { content: [{ type: 'text', text: JSON.stringify(roles, null, 2) }] };
  }
);

registerTool(
  'get_role',
  'Get a single role by ID',
  { id: z.string().describe('Role ID') },
  async ({ id }) => {
    const role = roleManager.get(id);
    if (!role) return { content: [{ type: 'text', text: `Role not found: ${id}` }], isError: true };
    return { content: [{ type: 'text', text: JSON.stringify(role, null, 2) }] };
  }
);

registerTool(
  'list_sessions',
  'List all sessions in a workspace',
  { workspaceId: z.string().describe('Workspace ID') },
  async ({ workspaceId }) => {
    const sessions = sessionManager.list(workspaceId);
    return { content: [{ type: 'text', text: JSON.stringify(sessions, null, 2) }] };
  }
);

registerTool(
  'create_session',
  'Create a new AI conversation session in a workspace',
  {
    workspaceId: z.string().describe('Workspace ID'),
    roleId: z.string().describe('Role ID for this session'),
    title: z.string().optional().describe('Session title'),
    modelId: z.string().optional().describe('LLM model ID'),
  },
  async (params) => {
    try {
      const role = roleManager.get(params.roleId);
      if (!role) return { content: [{ type: 'text', text: `Role not found: ${params.roleId}` }], isError: true };
      const session = sessionManager.create(params.workspaceId, role, params.title);
      if (params.modelId) {
        sessionManager.setModel(session.id, params.modelId);
      }
      return { content: [{ type: 'text', text: JSON.stringify(session, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// --- Session Task dispatch tools ---

registerTool(
  'dispatch_session_task',
  'Dispatch a task from one session to another with aligned context payload',
  {
    sourceSessionId: z.string().describe('Source session ID (dispatcher)'),
    targetSessionId: z.string().describe('Target session ID (receiver)'),
    title: z.string().describe('Task title'),
    brief: z.string().optional().describe('Brief description'),
    contextPayload: z.record(z.any()).describe('Aligned context payload (TaskContextPayload)'),
    parentTaskId: z.string().optional().describe('Optional parent task ID in the DAG'),
    priority: z.enum(['critical', 'high', 'medium', 'low']).optional(),
    metadata: z.record(z.any()).optional(),
  },
  async (params) => {
    try {
      const task = sessionTaskDispatcher.dispatch(params);
      return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }
);

registerTool(
  'get_session_task',
  'Get a session task by ID',
  { id: z.string().describe('Session task ID') },
  async ({ id }) => {
    const task = sessionTaskDispatcher.get(id);
    if (!task) return { content: [{ type: 'text', text: `Session task not found: ${id}` }], isError: true };
    return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] };
  }
);

registerTool(
  'list_incoming_session_tasks',
  'List incoming session tasks for a session',
  { sessionId: z.string().describe('Session ID') },
  async ({ sessionId }) => {
    const tasks = sessionTaskDispatcher.listIncoming(sessionId);
    return { content: [{ type: 'text', text: JSON.stringify(tasks, null, 2) }] };
  }
);

registerTool(
  'list_outgoing_session_tasks',
  'List outgoing session tasks for a session',
  { sessionId: z.string().describe('Session ID') },
  async ({ sessionId }) => {
    const tasks = sessionTaskDispatcher.listOutgoing(sessionId);
    return { content: [{ type: 'text', text: JSON.stringify(tasks, null, 2) }] };
  }
);

registerTool(
  'review_session_task_context',
  'Review the full aligned context for a session task (resolves references into a Markdown document)',
  { id: z.string().describe('Session task ID') },
  async ({ id }) => {
    try {
      const view = sessionTaskDispatcher.reviewContext(id);
      return { content: [{ type: 'text', text: JSON.stringify(view, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }
);

registerTool(
  'align_session_task',
  'Confirm context alignment for a session task (receiver side)',
  { id: z.string().describe('Session task ID') },
  async ({ id }) => {
    try {
      const task = sessionTaskDispatcher.align(id);
      return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }
);

registerTool(
  'request_clarify_session_task',
  'Request clarification for a session task (receiver side)',
  {
    id: z.string().describe('Session task ID'),
    note: z.string().describe('Clarification question'),
  },
  async ({ id, note }) => {
    try {
      const task = sessionTaskDispatcher.requestClarify(id, note);
      return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }
);

registerTool(
  'accept_session_task',
  'Accept a session task (receiver side, requires aligned status)',
  { id: z.string().describe('Session task ID') },
  async ({ id }) => {
    try {
      const task = sessionTaskDispatcher.accept(id);
      return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }
);

registerTool(
  'complete_session_task',
  'Complete a session task with result (receiver side)',
  {
    id: z.string().describe('Session task ID'),
    result: z.string().describe('Completion result summary'),
  },
  async ({ id, result }) => {
    try {
      const task = sessionTaskDispatcher.complete(id, result);
      return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }
);

registerTool(
  'reject_session_task',
  'Reject a session task (receiver side)',
  {
    id: z.string().describe('Session task ID'),
    reason: z.string().describe('Rejection reason'),
  },
  async ({ id, reason }) => {
    try {
      const task = sessionTaskDispatcher.reject(id, reason);
      return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }
);

registerTool(
  'cancel_session_task',
  'Cancel a session task (dispatcher side)',
  {
    id: z.string().describe('Session task ID'),
    reason: z.string().describe('Cancellation reason'),
  },
  async ({ id, reason }) => {
    try {
      const task = sessionTaskDispatcher.cancel(id, reason);
      return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.resource(
  'all-memories',
  'coordinator://memories',
  async (uri) => ({
    contents: [{
      uri: uri.href,
      mimeType: 'application/json',
      text: JSON.stringify(memoryStore.list(), null, 2),
    }],
  })
);

// =============================================
// Helpers
// =============================================

function contextToMarkdown(ctx: any): string {
  const lines: string[] = [
    `# Context for: ${ctx.agentRole}`,
    `> Generated: ${ctx.generatedAt} | Token estimate: ${ctx.tokenEstimate}`,
    '',
  ];
  const s = ctx.sections;
  if (s.currentTask) lines.push(s.currentTask, '');
  if (s.dependencies) lines.push(s.dependencies, '');
  if (s.contracts) lines.push(s.contracts, '');
  if (s.decisions) lines.push(s.decisions, '');
  if (s.conventions) lines.push(s.conventions, '');
  if (s.warnings) lines.push(s.warnings, '');
  return lines.join('\n');
}

// =============================================
// Start
// =============================================

async function main() {
  // sql.js 异步初始化 + 应用 schema
  db = await CoordinatorDB.create(DB_PATH);
  eventBus.setDB(db);
  taskManager.setDB(db);
  contractRegistry.setDB(db);
  memoryStore.setDB(db);
  sessionTaskDispatcher.setDB(db);
  sessionTaskDispatcher.setEventBus(eventBus);
  roleManager.setDB(db);
  sessionManager.setDB(db);
  roleManager.seedBuiltInRoles();
  console.error(`[MCP] SQLite (sql.js) initialized at ${DB_PATH}`);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[MCP] AI Agent Coordinator MCP server running on stdio');
}

main().catch((err) => {
  console.error('[MCP] Fatal error:', err);
  process.exit(1);
});
