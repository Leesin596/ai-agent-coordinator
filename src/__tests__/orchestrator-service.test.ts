import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CoordinatorDB } from '../db/database';
import { EventBus } from '../core/event-bus';
import { SessionTaskDispatcher } from '../core/session-task-dispatcher';
import { SessionManager } from '../core/session-manager';
import { RoleManager } from '../core/role-manager';
import { OrchestratorService } from '../core/orchestrator-service';
import type { LLMCallFunction } from '../models/types';
import * as fs from 'fs';
import * as path from 'path';

const TEST_DIR = path.join(__dirname, '../../.coordinator');
const TEST_DB = path.join(TEST_DIR, 'test-orchestrator.db');
const SCHEMA = path.join(__dirname, '../db/schema.sql');

describe('OrchestratorService', () => {
  let db: CoordinatorDB;
  let eventBus: EventBus;
  let dispatcher: SessionTaskDispatcher;
  let sessionManager: SessionManager;
  let roleManager: RoleManager;
  let orchestrator: OrchestratorService;

  beforeEach(async () => {
    try { fs.unlinkSync(TEST_DB); } catch {}
    try { fs.unlinkSync(TEST_DB + '.lock'); } catch {}
    fs.mkdirSync(TEST_DIR, { recursive: true });
    db = await CoordinatorDB.create(TEST_DB, SCHEMA);
    eventBus = new EventBus();
    eventBus.setDB(db);
    dispatcher = new SessionTaskDispatcher();
    dispatcher.setDB(db);
    dispatcher.setEventBus(eventBus);
    roleManager = new RoleManager();
    roleManager.setDB(db);
    sessionManager = new SessionManager();
    sessionManager.setDB(db);
    roleManager.seedBuiltInRoles();

    orchestrator = new OrchestratorService();
    orchestrator.setDB(db);
    orchestrator.setEventBus(eventBus);
    orchestrator.setDispatcher(dispatcher);
    orchestrator.setSessionManager(sessionManager);
    orchestrator.setRoleManager(roleManager);
  });

  afterEach(() => {
    db.close();
    try { fs.unlinkSync(TEST_DB); } catch {}
    try { fs.unlinkSync(TEST_DB + '.lock'); } catch {}
  });

  it('decomposeTask parses LLM JSON output into OrchestrationPlan', async () => {
    const llmCall: LLMCallFunction = async () =>
      JSON.stringify({
        summary: '拆解为前端+后端两个子任务',
        subTasks: [
          {
            title: '实现前端页面',
            objective: '创建 Vue 登录页面',
            targetRole: 'Vue 开发',
            dependencies: [],
            acceptanceCriteria: ['页面可输入用户名密码'],
            expectedOutput: 'Vue 组件',
          },
          {
            title: '实现后端 API',
            objective: '创建登录 API 接口',
            targetRole: 'Go 开发',
            dependencies: [0],
            acceptanceCriteria: ['返回 JWT token'],
            expectedOutput: 'Go handler',
          },
        ],
      });

    const plan = await orchestrator.decomposeTask(
      '实现用户登录功能',
      '',
      5,
      llmCall,
    );

    expect(plan.summary).toBe('拆解为前端+后端两个子任务');
    expect(plan.subTasks).toHaveLength(2);
    expect(plan.subTasks[0].title).toBe('实现前端页面');
    expect(plan.subTasks[0].index).toBe(0);
    expect(plan.subTasks[1].dependencies).toEqual([0]);
  });

  it('decomposeTask handles ```json wrapped output', async () => {
    const llmCall: LLMCallFunction = async () =>
      '```json\n{"summary":"test","subTasks":[{"title":"T1","objective":"O1","targetRole":"Vue 开发","dependencies":[],"acceptanceCriteria":[],"expectedOutput":""}]}\n```';

    const plan = await orchestrator.decomposeTask('test', '', 5, llmCall);
    expect(plan.subTasks).toHaveLength(1);
    expect(plan.subTasks[0].title).toBe('T1');
  });

  it('decomposeTask truncates to maxSubTasks', async () => {
    const llmCall: LLMCallFunction = async () =>
      JSON.stringify({
        summary: 'too many tasks',
        subTasks: Array.from({ length: 10 }, (_, i) => ({
          title: `T${i}`,
          objective: 'O',
          targetRole: 'Vue 开发',
          dependencies: [],
          acceptanceCriteria: [],
          expectedOutput: '',
        })),
      });

    const plan = await orchestrator.decomposeTask('test', '', 3, llmCall);
    expect(plan.subTasks).toHaveLength(3);
  });

  it('decomposeTask throws on invalid JSON', async () => {
    const llmCall: LLMCallFunction = async () => 'not json at all';
    await expect(orchestrator.decomposeTask('test', '', 5, llmCall)).rejects.toThrow();
  });

  it('hasDependencyCycle detects circular dependencies', () => {
    // Access private method via any cast for testing
    const svc = orchestrator as any;
    // 0 → 1 → 0 (cycle)
    const subTasks = [
      { index: 0, title: 'A', objective: '', targetRole: '', dependencies: [1], acceptanceCriteria: [], expectedOutput: '' },
      { index: 1, title: 'B', objective: '', targetRole: '', dependencies: [0], acceptanceCriteria: [], expectedOutput: '' },
    ];
    expect(svc.hasDependencyCycle(subTasks)).toBe(true);
  });

  it('hasDependencyCycle returns false for valid DAG', () => {
    const svc = orchestrator as any;
    const subTasks = [
      { index: 0, title: 'A', objective: '', targetRole: '', dependencies: [], acceptanceCriteria: [], expectedOutput: '' },
      { index: 1, title: 'B', objective: '', targetRole: '', dependencies: [0], acceptanceCriteria: [], expectedOutput: '' },
      { index: 2, title: 'C', objective: '', targetRole: '', dependencies: [0, 1], acceptanceCriteria: [], expectedOutput: '' },
    ];
    expect(svc.hasDependencyCycle(subTasks)).toBe(false);
  });

  it('matchRole matches by exact ID', () => {
    const roles = roleManager.list();
    const svc = orchestrator as any;
    const matched = svc.matchRole(roles[0].id);
    expect(matched).toBeDefined();
    expect(matched.id).toBe(roles[0].id);
  });

  it('matchRole matches by exact name', () => {
    const svc = orchestrator as any;
    const matched = svc.matchRole('Vue 开发');
    expect(matched).toBeDefined();
    expect(matched.name).toBe('Vue 开发');
  });

  it('matchRole matches by partial name', () => {
    const svc = orchestrator as any;
    const matched = svc.matchRole('Vue');
    expect(matched).toBeDefined();
    expect(matched.name).toBe('Vue 开发');
  });

  it('matchRole returns undefined for no match', () => {
    const svc = orchestrator as any;
    const matched = svc.matchRole('不存在的角色');
    expect(matched).toBeUndefined();
  });

  it('findOrCreateSession always creates new session for context isolation', () => {
    const roles = roleManager.list();
    const role = roles[0];
    const svc = orchestrator as any;

    // Create a session with this role
    const session1 = sessionManager.create('ws-1', role, 'Session 1');
    // findOrCreateSession should create a NEW session, not reuse the existing one
    const session2 = svc.findOrCreateSession(role, 'ws-1', 'Task title');
    expect(session2.id).not.toBe(session1.id);
    expect(session2.roleId).toBe(role.id);
  });

  it('findOrCreateSession creates new session if none exists', () => {
    const roles = roleManager.list();
    const role = roles[0];
    const svc = orchestrator as any;

    const session = svc.findOrCreateSession(role, 'ws-1', 'New task');
    expect(session).toBeDefined();
    expect(session.roleId).toBe(role.id);
  });

  it('full orchestrate workflow with mock LLM', async () => {
    const roles = roleManager.list();
    const vueRole = roles.find((r) => r.name === 'Vue 开发')!;
    const goRole = roles.find((r) => r.name === 'Go 开发')!;

    // Create source session with a different role (PM) to avoid self-dispatch
    const pmRole = roles.find((r) => r.name === '产品经理') || roles[0];
    const sourceSession = sessionManager.create('ws-1', pmRole, 'Orchestrator Source');

    // Mock LLM: first call = decompose, second call = summarize
    let callCount = 0;
    const llmCall: LLMCallFunction = async () => {
      callCount++;
      if (callCount === 1) {
        // Decompose response
        return JSON.stringify({
          summary: '拆解为前端+后端',
          subTasks: [
            {
              title: '前端页面',
              objective: '创建登录页面',
              targetRole: vueRole.name,
              dependencies: [],
              acceptanceCriteria: ['页面可登录'],
              expectedOutput: 'Vue 组件',
            },
            {
              title: '后端API',
              objective: '创建登录接口',
              targetRole: goRole.name,
              dependencies: [0],
              acceptanceCriteria: ['返回 token'],
              expectedOutput: 'Go handler',
            },
          ],
        });
      }
      // Summarize response
      return '编排完成，前后端均已实现';
    };

    // We need to intercept the dispatch to auto-complete tasks
    // (since there's no real target session LLM to process them)
    // The orchestrator will call align+accept synchronously, so we just
    // need to call complete after a short delay to simulate processing
    const originalDispatch = dispatcher.dispatch.bind(dispatcher);

    dispatcher.dispatch = (input: any) => {
      const task = originalDispatch(input);
      // Auto-complete after orchestrator's align+accept (task will be in_progress)
      setTimeout(() => {
        try {
          dispatcher.complete(task.id, `完成: ${task.title}`);
        } catch (_e) {
          // ignore state errors in test
        }
      }, 50);
      return task;
    };

    try {
      const result = await orchestrator.orchestrate(
        {
          description: '实现用户登录功能',
          sourceSessionId: sourceSession.id,
          workspaceId: 'ws-1',
          maxSubTasks: 5,
          timeoutMs: 10000,
        },
        llmCall,
      );

      expect(result.status).toBe('completed');
      expect(result.subTaskResults).toHaveLength(2);
      expect(result.subTaskResults[0].status).toBe('completed');
      expect(result.subTaskResults[1].status).toBe('completed');
      expect(result.summary).toContain('编排完成');
      expect(result.orchestrationId).toBeDefined();
    } finally {
      dispatcher.dispatch = originalDispatch;
    }
  }, 15000);

  it('orchestrate filters forward references in dependencies', async () => {
    const roles = roleManager.list();
    const sourceSession = sessionManager.create('ws-1', roles[0], 'Source');

    // LLM outputs a forward reference (dep on index 1 from index 0)
    // The parser should filter it out, preventing a cycle
    const llmCall: LLMCallFunction = async () =>
      JSON.stringify({
        summary: 'forward ref filtered',
        subTasks: [
          {
            title: 'A',
            objective: 'O',
            targetRole: roles[0].name,
            dependencies: [1], // forward ref - should be filtered to []
            acceptanceCriteria: [],
            expectedOutput: '',
          },
          {
            title: 'B',
            objective: 'O',
            targetRole: roles[0].name,
            dependencies: [0],
            acceptanceCriteria: [],
            expectedOutput: '',
          },
        ],
      });

    // Should not throw cycle error - forward ref is filtered
    // Will fail because source session dispatches to itself, but that's OK
    // We just verify no cycle error is thrown
    const result = await orchestrator.orchestrate(
      {
        description: 'forward ref task',
        sourceSessionId: sourceSession.id,
        workspaceId: 'ws-1',
        timeoutMs: 5000,
      },
      llmCall,
    );

    // Forward ref filtered: A has deps=[], B has deps=[0] → valid DAG
    // Both will fail because dispatching to self, but no cycle error
    expect(result.plan.subTasks[0].dependencies).toEqual([]);
    expect(result.plan.subTasks[1].dependencies).toEqual([0]);
  }, 10000);

  it('orchestrate fails on empty subTasks', async () => {
    const roles = roleManager.list();
    const sourceSession = sessionManager.create('ws-1', roles[0], 'Source');

    const llmCall: LLMCallFunction = async () =>
      JSON.stringify({ summary: 'no tasks', subTasks: [] });

    await expect(
      orchestrator.orchestrate(
        {
          description: 'empty task',
          sourceSessionId: sourceSession.id,
          workspaceId: 'ws-1',
        },
        llmCall,
      ),
    ).rejects.toThrow('未拆解出任何子任务');
  });


  it('orchestrate handles unmatched role gracefully', async () => {
    const roles = roleManager.list();
    const sourceSession = sessionManager.create('ws-1', roles[0], 'Source');

    const llmCall: LLMCallFunction = async () =>
      JSON.stringify({
        summary: 'bad role',
        subTasks: [
          {
            title: 'T1',
            objective: 'O',
            targetRole: '不存在的角色XYZ',
            dependencies: [],
            acceptanceCriteria: [],
            expectedOutput: '',
          },
        ],
      });

    const result = await orchestrator.orchestrate(
      {
        description: 'bad role task',
        sourceSessionId: sourceSession.id,
        workspaceId: 'ws-1',
        timeoutMs: 5000,
      },
      llmCall,
    );

    // The sub-task should fail because role not found
    expect(result.status).toBe('failed');
    expect(result.subTaskResults[0].status).toBe('failed');
    expect(result.subTaskResults[0].result).toContain('找不到匹配角色');
  }, 10000);
});
