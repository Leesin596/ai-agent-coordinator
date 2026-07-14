import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { restSchemas } from '../transport/rest-api';

const {
  createTask: createTaskSchema,
  updateTask: updateTaskSchema,
  createContract: createContractSchema,
  createMemory: createMemorySchema,
  compileContext: compileContextSchema,
  registerAgent: registerAgentSchema,
} = restSchemas;

function validate<T>(schema: z.ZodSchema<T>, body: any): { success: boolean; error?: string; data?: T } {
  const result = schema.safeParse(body);
  if (!result.success) {
    const msgs = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
    return { success: false, error: msgs };
  }
  return { success: true, data: result.data };
}

describe('REST API Zod validation schemas', () => {
  it('should reject task without title', () => {
    const r = validate(createTaskSchema, { assignee: 'frontend' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('title');
  });

  it('should reject task without assignee', () => {
    const r = validate(createTaskSchema, { title: 'Test' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('assignee');
  });

  it('should accept valid task', () => {
    const r = validate(createTaskSchema, {
      title: 'Test',
      assignee: 'frontend',
      priority: 'high',
      contractRefs: ['contract-1'],
    });
    expect(r.success).toBe(true);
    expect(r.data!.title).toBe('Test');
    expect(r.data!.contractRefs).toEqual(['contract-1']);
  });

  it('should reject task with invalid priority', () => {
    const r = validate(createTaskSchema, { title: 'Test', assignee: 'frontend', priority: 'urgent' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('priority');
  });

  it('should reject task status update with invalid status', () => {
    const r = validate(updateTaskSchema, { status: 'invalid' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('status');
  });

  it('should accept valid task status update', () => {
    const r = validate(updateTaskSchema, { status: 'in_progress' });
    expect(r.success).toBe(true);
  });

  it('should reject contract without schema', () => {
    const r = validate(createContractSchema, { name: 'Test', type: 'api', producer: 'backend' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('schema');
  });

  it('should reject contract with invalid type', () => {
    const r = validate(createContractSchema, { name: 'Test', type: 'invalid', producer: 'backend', schema: {} });
    expect(r.success).toBe(false);
    expect(r.error).toContain('type');
  });

  it('should accept valid contract', () => {
    const r = validate(createContractSchema, {
      name: 'Test',
      type: 'api',
      status: 'proposed',
      producer: 'backend',
      schema: { type: 'object' },
    });
    expect(r.success).toBe(true);
    expect(r.data!.status).toBe('proposed');
  });

  it('should reject memory without category', () => {
    const r = validate(createMemorySchema, { title: 'T', content: 'c', createdBy: 'a' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('category');
  });

  it('should reject memory with invalid category', () => {
    const r = validate(createMemorySchema, { category: 'random', title: 'T', content: 'c', createdBy: 'a' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('category');
  });

  it('should accept valid memory', () => {
    const r = validate(createMemorySchema, { category: 'decision', title: 'T', content: 'c', createdBy: 'a' });
    expect(r.success).toBe(true);
  });

  it('should reject context compile without agentRole', () => {
    const r = validate(compileContextSchema, {});
    expect(r.success).toBe(false);
    expect(r.error).toContain('agentRole');
  });

  it('should accept valid context compile', () => {
    const r = validate(compileContextSchema, {
      agentRole: 'frontend',
      format: 'markdown',
      includeHistory: true,
    });
    expect(r.success).toBe(true);
    expect(r.data!.includeHistory).toBe(true);
  });

  it('should reject agent registration without role', () => {
    const r = validate(registerAgentSchema, {});
    expect(r.success).toBe(false);
    expect(r.error).toContain('role');
  });

  it('should accept valid agent registration', () => {
    const r = validate(registerAgentSchema, { role: 'frontend' });
    expect(r.success).toBe(true);
  });

  it('should reject invalid list query enums', () => {
    expect(restSchemas.taskListQuery.safeParse({ status: 'unknown' }).success).toBe(false);
    expect(restSchemas.contractListQuery.safeParse({ type: 'unknown' }).success).toBe(false);
    expect(restSchemas.memoryListQuery.safeParse({ category: 'unknown' }).success).toBe(false);
  });

  it('should require a non-empty memory search query', () => {
    expect(restSchemas.memorySearchQuery.safeParse({}).success).toBe(false);
    expect(restSchemas.memorySearchQuery.safeParse({ q: '' }).success).toBe(false);
    expect(restSchemas.memorySearchQuery.safeParse({ q: 'locking' }).success).toBe(true);
  });

  it('should coerce and validate the event sequence query', () => {
    expect(restSchemas.eventsQuery.parse({ since: '12' }).since).toBe(12);
    expect(restSchemas.eventsQuery.parse({}).since).toBe(0);
    expect(restSchemas.eventsQuery.safeParse({ since: '-1' }).success).toBe(false);
  });

  it('should validate task completion outputs and path parameters', () => {
    expect(restSchemas.completeTask.safeParse({ outputs: { result: 'ok' } }).success).toBe(true);
    expect(restSchemas.completeTask.safeParse({ outputs: 'invalid' }).success).toBe(false);
    expect(restSchemas.agentParams.safeParse({ role: 'frontend', instanceId: '' }).success).toBe(false);
  });
});
