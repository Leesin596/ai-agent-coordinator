import { randomUUID } from 'crypto';
import express, { Request, Response, Router } from 'express';
import { z } from 'zod';
import type { TaskManager } from '../core/task-manager';
import type { ContractRegistry } from '../core/contract-registry';
import type { MemoryStore } from '../core/memory-store';
import type { ContextCompiler } from '../core/context-compiler';
import type { EventBus } from '../core/event-bus';
import type { CoordinatorDB } from '../db/database';

export const restSchemas = {
  createTask: z.object({
    title: z.string().min(1, 'title is required'),
    description: z.string().optional(),
    assignee: z.string().min(1, 'assignee is required'),
    dependencies: z.array(z.string()).optional(),
    contractRefs: z.array(z.string()).optional(),
    priority: z.enum(['critical', 'high', 'medium', 'low']).optional(),
    inputs: z.record(z.any()).optional(),
    metadata: z.record(z.any()).optional(),
    project: z.string().optional(),
  }),
  updateTask: z.object({
    status: z.enum(['pending', 'ready', 'in_progress', 'blocked', 'done', 'failed']),
    outputs: z.record(z.any()).optional(),
  }),
  createContract: z.object({
    name: z.string().min(1, 'name is required'),
    type: z.enum(['api', 'data_model', 'event', 'config']),
    status: z.enum(['draft', 'proposed', 'agreed', 'implemented', 'deprecated']).optional(),
    producer: z.string().min(1, 'producer is required'),
    consumers: z.array(z.string()).optional(),
    schema: z.record(z.any()),
    examples: z.array(z.record(z.any())).optional(),
    metadata: z.record(z.any()).optional(),
    project: z.string().optional(),
  }),
  updateContract: z.object({
    schema: z.record(z.any()).optional(),
    status: z.enum(['draft', 'proposed', 'agreed', 'implemented', 'deprecated']).optional(),
    examples: z.array(z.record(z.any())).optional(),
    metadata: z.record(z.any()).optional(),
    project: z.string().optional(),
  }),
  agreeContract: z.object({
    consumer: z.string().min(1, 'consumer is required'),
  }),
  createMemory: z.object({
    category: z.enum(['decision', 'convention', 'architecture', 'lesson', 'note']),
    title: z.string().min(1, 'title is required'),
    content: z.string().min(1, 'content is required'),
    tags: z.array(z.string()).optional(),
    scope: z.string().optional(),
    createdBy: z.string().min(1, 'createdBy is required'),
    references: z.array(z.string()).optional(),
    project: z.string().optional(),
  }),
  updateMemory: z.object({
    title: z.string().optional(),
    content: z.string().optional(),
    tags: z.array(z.string()).optional(),
    scope: z.string().optional(),
    references: z.array(z.string()).optional(),
  }),
  compileContext: z.object({
    agentRole: z.string().min(1, 'agentRole is required'),
    focusTaskId: z.string().optional(),
    project: z.string().optional(),
    includeHistory: z.boolean().optional(),
    format: z.enum(['markdown', 'json']).optional(),
    tokenBudget: z.number().int().positive().optional(),
  }),
  registerAgent: z.object({
    role: z.string().min(1, 'role is required'),
    instanceId: z.string().optional(),
    metadata: z.record(z.any()).optional(),
    project: z.string().optional(),
  }),
  taskListQuery: z.object({
    assignee: z.string().optional(),
    status: z.enum(['pending', 'ready', 'in_progress', 'blocked', 'done', 'failed']).optional(),
    project: z.string().optional(),
  }),
  contractListQuery: z.object({
    producer: z.string().optional(),
    consumer: z.string().optional(),
    type: z.enum(['api', 'data_model', 'event', 'config']).optional(),
    status: z.enum(['draft', 'proposed', 'agreed', 'implemented', 'deprecated']).optional(),
    project: z.string().optional(),
  }),
  memoryListQuery: z.object({
    category: z.enum(['decision', 'convention', 'architecture', 'lesson', 'note']).optional(),
    scope: z.string().optional(),
    tag: z.string().optional(),
    createdBy: z.string().optional(),
    project: z.string().optional(),
  }),
  memorySearchQuery: z.object({
    q: z.string().min(1, 'Query parameter "q" is required'),
    project: z.string().optional(),
  }),
  eventsQuery: z.object({
    since: z.coerce.number().int().nonnegative().default(0),
    project: z.string().optional(),
  }),
  projectQuery: z.object({
    project: z.string().optional(),
  }),
  completeTask: z.object({
    outputs: z.record(z.any()).optional(),
  }),
  idParam: z.string().min(1, 'id is required'),
  agentParams: z.object({
    role: z.string().min(1, 'role is required'),
    instanceId: z.string().min(1, 'instanceId is required'),
  }),
};

export function createRestApi(
  taskManager: TaskManager,
  contractRegistry: ContractRegistry,
  memoryStore: MemoryStore,
  contextCompiler: ContextCompiler,
  eventBus: EventBus,
  db?: CoordinatorDB
): Router {
  const router = Router();
  router.use(express.json());

  // --- Zod validation helper ---
  function validate<T>(schema: z.ZodSchema<T>, body: unknown): T {
    const result = schema.safeParse(body);
    if (!result.success) {
      const msgs = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
      throw new Error(`Validation error: ${msgs}`);
    }
    return result.data;
  }

  function validateForResponse<T>(schema: z.ZodSchema<T>, value: unknown, res: Response): T | undefined {
    try {
      return validate(schema, value);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
      return undefined;
    }
  }

  // --- Zod schemas ---
  const {
    createTask: createTaskSchema,
    updateTask: updateTaskSchema,
    createContract: createContractSchema,
    updateContract: updateContractSchema,
    agreeContract: agreeContractSchema,
    createMemory: createMemorySchema,
    updateMemory: updateMemorySchema,
    compileContext: compileContextSchema,
    registerAgent: registerAgentSchema,
  } = restSchemas;

  // === Tasks ===

  router.post('/tasks', (req: Request, res: Response) => {
    try {
      const data = validate(createTaskSchema, req.body);
      const task = taskManager.create(data);
      res.status(201).json(task);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/tasks', (req: Request, res: Response) => {
    const filter = validateForResponse(restSchemas.taskListQuery, req.query, res);
    if (!filter) return;
    res.json(taskManager.list(filter));
  });

  router.get('/tasks/ready', (req: Request, res: Response) => {
    const query = validateForResponse(restSchemas.taskListQuery.pick({ assignee: true, project: true }), req.query, res);
    if (!query) return;
    res.json(taskManager.getReadyTasks(query.assignee, query.project));
  });

  router.get('/tasks/graph', (req: Request, res: Response) => {
    const query = validateForResponse(restSchemas.projectQuery, req.query, res);
    if (!query) return;
    res.json(taskManager.getGraph(query.project));
  });

  router.get('/tasks/:id', (req: Request, res: Response) => {
    const id = validateForResponse(restSchemas.idParam, req.params.id, res);
    if (!id) return;
    const task = taskManager.get(id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    res.json(task);
  });

  router.patch('/tasks/:id', (req: Request, res: Response) => {
    try {
      const id = validate(restSchemas.idParam, req.params.id);
      const { status, outputs } = validate(updateTaskSchema, req.body);
      const task = taskManager.updateStatus(id, status, outputs);
      res.json(task);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/tasks/:id/complete', (req: Request, res: Response) => {
    try {
      const id = validate(restSchemas.idParam, req.params.id);
      const { outputs } = validate(restSchemas.completeTask, req.body);
      const task = taskManager.updateStatus(id, 'done', outputs);
      res.json(task);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  router.delete('/tasks/:id', (req: Request, res: Response) => {
    const id = validateForResponse(restSchemas.idParam, req.params.id, res);
    if (!id) return;
    const deleted = taskManager.delete(id);
    if (!deleted) return res.status(404).json({ error: 'Task not found' });
    res.json({ deleted: true });
  });

  // === Contracts ===

  router.post('/contracts', (req: Request, res: Response) => {
    try {
      const data = validate(createContractSchema, req.body);
      const contract = contractRegistry.create(data);
      res.status(201).json(contract);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/contracts', (req: Request, res: Response) => {
    const filter = validateForResponse(restSchemas.contractListQuery, req.query, res);
    if (!filter) return;
    res.json(contractRegistry.list(filter));
  });

  router.get('/contracts/:id', (req: Request, res: Response) => {
    const id = validateForResponse(restSchemas.idParam, req.params.id, res);
    if (!id) return;
    const contract = contractRegistry.get(id);
    if (!contract) return res.status(404).json({ error: 'Contract not found' });
    res.json(contract);
  });

  router.patch('/contracts/:id', (req: Request, res: Response) => {
    try {
      const id = validate(restSchemas.idParam, req.params.id);
      const data = validate(updateContractSchema, req.body);
      const contract = contractRegistry.update(id, data);
      res.json(contract);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/contracts/:id/history', (req: Request, res: Response) => {
    const id = validateForResponse(restSchemas.idParam, req.params.id, res);
    if (!id) return;
    res.json(contractRegistry.getHistory(id));
  });

  router.post('/contracts/:id/agree', (req: Request, res: Response) => {
    try {
      const id = validate(restSchemas.idParam, req.params.id);
      const { consumer } = validate(agreeContractSchema, req.body);
      const contract = contractRegistry.agree(id, consumer);
      res.json(contract);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // === Memories ===

  router.post('/memories', (req: Request, res: Response) => {
    try {
      const data = validate(createMemorySchema, req.body);
      const memory = memoryStore.create(data);
      res.status(201).json(memory);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/memories', (req: Request, res: Response) => {
    const filter = validateForResponse(restSchemas.memoryListQuery, req.query, res);
    if (!filter) return;
    res.json(memoryStore.list(filter));
  });

  router.get('/memories/search', (req: Request, res: Response) => {
    const query = validateForResponse(restSchemas.memorySearchQuery, req.query, res);
    if (!query) return;
    res.json(memoryStore.search(query.q, query.project));
  });

  router.patch('/memories/:id', (req: Request, res: Response) => {
    try {
      const id = validate(restSchemas.idParam, req.params.id);
      const data = validate(updateMemorySchema, req.body);
      const memory = memoryStore.update(id, data);
      res.json(memory);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  router.delete('/memories/:id', (req: Request, res: Response) => {
    const id = validateForResponse(restSchemas.idParam, req.params.id, res);
    if (!id) return;
    const deleted = memoryStore.delete(id);
    if (!deleted) return res.status(404).json({ error: 'Memory not found' });
    res.json({ deleted: true });
  });

  // === Context ===

  router.post('/context/compile', (req: Request, res: Response) => {
    try {
      const data = validate(compileContextSchema, req.body);
      const context = contextCompiler.compile(data);
      res.json(context);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // === Events ===

  router.get('/events', (req: Request, res: Response) => {
    const query = validateForResponse(restSchemas.eventsQuery, req.query, res);
    if (!query) return;
    res.json({
      events: eventBus.getEventsSince(query.since ?? 0, query.project),
      total: eventBus.getEventCount(query.project),
    });
  });

  // === Agents ===

  router.post('/agents', (req: Request, res: Response) => {
    try {
      if (!db) return res.status(503).json({ error: 'Database not available' });
      const { role, instanceId, metadata, project } = validate(registerAgentSchema, req.body);
      const agent = {
        project: project || 'default',
        role,
        instanceId: instanceId || randomUUID(),
        status: 'online' as const,
        lastSeen: new Date().toISOString(),
        lastEventSeq: db.getMaxEventSeq(project),
        metadata: metadata || {},
      };
      db.upsertAgent(agent);
      eventBus.emit('agent.connected', role, { role, instanceId: agent.instanceId });
      res.status(201).json(agent);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/agents', (req: Request, res: Response) => {
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const query = validateForResponse(restSchemas.projectQuery, req.query, res);
    if (!query) return;
    res.json(db.listAgents(query.project));
  });

  router.post('/agents/:role/:instanceId/heartbeat', (req: Request, res: Response) => {
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const params = validateForResponse(restSchemas.agentParams, req.params, res);
    const query = validateForResponse(restSchemas.projectQuery, req.query, res);
    if (!params || !query) return;
    const agent = db.getAgent(params.role, params.instanceId, query.project);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    db.upsertAgent({ ...agent, status: 'online', lastSeen: new Date().toISOString() });
    res.json({ ok: true });
  });

  router.post('/agents/:role/:instanceId/disconnect', (req: Request, res: Response) => {
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const params = validateForResponse(restSchemas.agentParams, req.params, res);
    const query = validateForResponse(restSchemas.projectQuery, req.query, res);
    if (!params || !query) return;
    const agent = db.getAgent(params.role, params.instanceId, query.project);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    db.upsertAgent({ ...agent, status: 'offline', lastSeen: new Date().toISOString() });
    eventBus.emit('agent.disconnected', params.role, params);
    res.json({ ok: true });
  });

  // === Health ===

  router.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      agents: db ? db.listAgents().length : 0,
      tasks: taskManager.list().length,
      contracts: contractRegistry.list().length,
      events: eventBus.getEventCount(),
    });
  });

  return router;
}
