// ============================================================
// OrchestratorService — 自动编排（P2-13）
// ============================================================
// LLM 自动拆解复杂任务 → 按角色匹配派发 → 依赖感知拓扑执行 → 结果汇总
//
// 核心流程:
//   1. decomposeTask: 调用 LLM 将复杂任务拆解为子任务列表（含角色分配+依赖）
//   2. autoDispatch: 根据子任务 targetRole 自动查找/创建目标 session，拓扑序分批 dispatch
//   3. collectResults: 监听 EventBus 事件等待所有子任务完成
//   4. summarizeResults: 调用 LLM 生成汇总报告
//
// 安全约束:
//   - maxSubTasks 上限（默认 5）防止无限拆解
//   - maxDepth 限制（默认 2）防止递归编排
//   - 依赖图环检测
//   - 超时机制（默认 120s）
// ============================================================

import { randomUUID } from 'crypto';
import type {
  LLMCallFunction,
  SubTask,
  OrchestrationPlan,
  OrchestrateInput,
  SubTaskResult,
  OrchestrationResult,
  Role,
  Session,
  SessionTask,
  TaskContextPayload,
} from '../models/types';
import type { CoordinatorDB } from '../db/database';
import type { EventBus } from './event-bus';
import type { SessionTaskDispatcher } from './session-task-dispatcher';
import type { SessionManager } from './session-manager';
import type { RoleManager } from './role-manager';

const DEFAULT_MAX_SUB_TASKS = 5;
const DEFAULT_MAX_DEPTH = 2;
const DEFAULT_TIMEOUT_MS = 120_000;

export class OrchestratorService {
  private db: CoordinatorDB | null = null;
  private eventBus: EventBus | null = null;
  private dispatcher: SessionTaskDispatcher | null = null;
  private sessionManager: SessionManager | null = null;
  private roleManager: RoleManager | null = null;
  private cancelCallbacks = new Set<() => void>();
  private cancelled = false;

  /** 取消正在进行的编排：所有 waitForTaskCompletion 立即以 cancelled 状态返回 */
  cancel(): void {
    this.cancelled = true;
    for (const cb of this.cancelCallbacks) {
      try { cb(); } catch (_e) {}
    }
    this.cancelCallbacks.clear();
  }

  private resetCancelState(): void {
    this.cancelled = false;
    this.cancelCallbacks.clear();
  }

  setDB(db: CoordinatorDB): void {
    this.db = db;
  }

  setEventBus(bus: EventBus): void {
    this.eventBus = bus;
  }

  setDispatcher(dispatcher: SessionTaskDispatcher): void {
    this.dispatcher = dispatcher;
  }

  setSessionManager(manager: SessionManager): void {
    this.sessionManager = manager;
  }

  setRoleManager(manager: RoleManager): void {
    this.roleManager = manager;
  }

  // ============================================================
  // 完整编排流程
  // ============================================================

  async orchestrate(
    input: OrchestrateInput,
    llmCall: LLMCallFunction,
  ): Promise<OrchestrationResult> {
    this.resetCancelState();
    const orchestrationId = randomUUID();
    const maxSubTasks = input.maxSubTasks ?? DEFAULT_MAX_SUB_TASKS;
    const maxDepth = input.maxDepth ?? DEFAULT_MAX_DEPTH;
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const currentDepth = input.currentDepth ?? 1;

    if (maxDepth < 1) {
      throw new Error('编排深度不能小于 1');
    }
    if (maxSubTasks < 1) {
      throw new Error('最大子任务数不能小于 1');
    }
    if (currentDepth > maxDepth) {
      throw new Error(`编排深度超过限制: 当前 ${currentDepth} 层，最大 ${maxDepth} 层`);
    }

    // 1. 拆解任务
    const plan = await this.decomposeTask(
      input.description,
      input.context || '',
      maxSubTasks,
      llmCall,
    );

    if (plan.subTasks.length === 0) {
      throw new Error('LLM 未拆解出任何子任务');
    }

    // 2. 依赖图环检测
    if (this.hasDependencyCycle(plan.subTasks)) {
      throw new Error('子任务依赖图存在环，无法编排');
    }

    // 3. 按拓扑序分批 dispatch + 收集结果
    const results = await this.autoDispatchAndCollect(
      plan.subTasks,
      input.sourceSessionId,
      input.workspaceId,
      orchestrationId,
      timeoutMs,
      maxDepth,
      currentDepth,
    );

    // 用户取消后跳过汇总，直接返回已收集的部分结果
    if (this.cancelled) {
      return {
        plan,
        subTaskResults: results,
        summary: '用户已取消编排，以下为已完成的子任务结果',
        status: 'partial',
        orchestrationId,
      };
    }

    // 4. 汇总结果
    const summary = await this.summarizeResults(
      input.description,
      plan,
      results,
      llmCall,
    );

    // 5. 确定整体状态
    const allCompleted = results.every((r) => r.status === 'completed');
    const anyCompleted = results.some((r) => r.status === 'completed');
    const status: OrchestrationResult['status'] = allCompleted
      ? 'completed'
      : anyCompleted
        ? 'partial'
        : 'failed';

    return {
      plan,
      subTaskResults: results,
      summary,
      status,
      orchestrationId,
    };
  }

  // ============================================================
  // 1. 任务拆解
  // ============================================================

  async decomposeTask(
    description: string,
    context: string,
    maxSubTasks: number,
    llmCall: LLMCallFunction,
  ): Promise<OrchestrationPlan> {
    const roles = this.roleManager?.list() || [];
    const roleList = roles.map((r) => ({
      id: r.id,
      name: r.name,
      category: r.category,
      skills: r.skills || [],
      description: r.description || '',
    }));

    const systemPrompt = [
      '你是一个任务编排专家。你的职责是将复杂任务拆解为可独立执行的子任务，并分配给最合适的角色。',
      '',
      '## 可用角色列表',
      JSON.stringify(roleList, null, 2),
      '',
      '## 输出要求',
      `将任务拆解为 1-${maxSubTasks} 个子任务，输出严格 JSON 格式：`,
      '```json',
      '{',
      '  "summary": "编排计划说明（简述拆解逻辑和执行顺序）",',
      '  "subTasks": [',
      '    {',
      '      "title": "子任务标题",',
      '      "objective": "详细任务目标和范围",',
      '      "targetRole": "角色ID或角色名称（必须在可用角色列表中）",',
      '      "dependencies": [0],',
      '      "acceptanceCriteria": ["验收标准1"],',
      '      "expectedOutput": "期望产出描述"',
      '    }',
      '  ]',
      '}',
      '```',
      '',
      '## 规则',
      '1. dependencies 使用子任务在数组中的索引（0-based），只能引用前面的子任务',
      '2. 不要产生循环依赖',
      `3. 最多 ${maxSubTasks} 个子任务`,
      '4. targetRole 必须是可用角色列表中的角色 ID 或名称',
      '5. 只输出 JSON，不要其他文字',
    ].join('\n');

    const userPrompt = [
      '## 任务描述',
      description,
      '',
      context ? `## 上下文\n${context}` : '',
    ].filter(Boolean).join('\n');

    const raw = await llmCall(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      { temperature: 0.3, maxTokens: 4096 },
    );

    return this.parseOrchestrationPlan(raw, description, maxSubTasks);
  }

  /** 解析 LLM 输出为 OrchestrationPlan */
  private parseOrchestrationPlan(
    raw: string,
    description: string,
    maxSubTasks: number,
  ): OrchestrationPlan {
    // 提取 JSON（兼容 ```json 包裹和裸 JSON）
    const jsonMatch = raw.match(/```json\s*([\s\S]*?)```/) || raw.match(/```\s*([\s\S]*?)```/);
    const jsonStr = jsonMatch ? jsonMatch[1].trim() : raw.trim();
    let parsed: any;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      // 尝试提取第一个 { 到最后一个 }
      const start = jsonStr.indexOf('{');
      const end = jsonStr.lastIndexOf('}');
      if (start >= 0 && end > start) {
        parsed = JSON.parse(jsonStr.slice(start, end + 1));
      } else {
        throw new Error('LLM 输出无法解析为 JSON');
      }
    }

    if (!parsed || !Array.isArray(parsed.subTasks)) {
      throw new Error('LLM 输出缺少 subTasks 数组');
    }

    const subTasks: SubTask[] = parsed.subTasks
      .slice(0, maxSubTasks)
      .map((st: any, index: number) => ({
        index,
        title: String(st.title || `子任务 ${index + 1}`).slice(0, 200),
        objective: String(st.objective || '').slice(0, 10000),
        targetRole: String(st.targetRole || '').slice(0, 100),
        dependencies: Array.isArray(st.dependencies)
          ? st.dependencies.filter((d: any) => typeof d === 'number' && d >= 0 && d < index)
          : [],
        acceptanceCriteria: Array.isArray(st.acceptanceCriteria)
          ? st.acceptanceCriteria.map((c: any) => String(c).slice(0, 500))
          : [],
        expectedOutput: String(st.expectedOutput || '').slice(0, 1000),
      }));

    return {
      description,
      subTasks,
      summary: String(parsed.summary || '').slice(0, 2000),
    };
  }

  // ============================================================
  // 2. 自动派发 + 结果收集（拓扑序分批执行）
  // ============================================================

  private async autoDispatchAndCollect(
    subTasks: SubTask[],
    sourceSessionId: string,
    workspaceId: string,
    orchestrationId: string,
    timeoutMs: number,
    maxDepth: number,
    currentDepth: number,
  ): Promise<SubTaskResult[]> {
    const results = new Map<number, SubTaskResult>();
    const taskMap = new Map<number, { taskId: string; sessionId: string }>();

    // 按拓扑序分批执行：每批是无依赖或依赖已完成的子任务
    const remaining = new Set(subTasks.map((st) => st.index));
    let timedOut = false;
    const overallTimer = setTimeout(() => { timedOut = true; }, timeoutMs);

    try {
      while (remaining.size > 0 && !timedOut && !this.cancelled) {
        // 找出当前可执行的子任务（依赖全部已完成或已处理）
        const batch = subTasks.filter(
          (st) =>
            remaining.has(st.index) &&
            st.dependencies.every((dep) => !remaining.has(dep)),
        );

        if (batch.length === 0) {
          // 剩余任务都有未完成的依赖（不应该发生，因为已做环检测）
          for (const idx of remaining) {
            const st = subTasks.find((s) => s.index === idx)!;
            results.set(idx, {
              index: idx,
              title: st.title,
              targetRole: st.targetRole,
              targetSessionId: '',
              taskId: '',
              status: 'failed',
              result: '依赖任务未完成，无法执行',
            });
          }
          break;
        }

        // 并行 dispatch 当前批次
        const dispatchResults = await Promise.allSettled(
          batch.map((st) =>
            this.dispatchSingleSubTask(
              st,
              sourceSessionId,
              workspaceId,
              orchestrationId,
              subTasks,
              taskMap,
              results,
              timeoutMs,
              maxDepth,
              currentDepth,
            ),
          ),
        );

        // 处理结果
        for (let i = 0; i < batch.length; i++) {
          const st = batch[i];
          const settled = dispatchResults[i];
          remaining.delete(st.index);

          if (settled.status === 'fulfilled') {
            results.set(st.index, settled.value);
          } else {
            results.set(st.index, {
              index: st.index,
              title: st.title,
              targetRole: st.targetRole,
              targetSessionId: '',
              taskId: '',
              status: 'failed',
              result: settled.reason instanceof Error ? settled.reason.message : String(settled.reason),
            });
          }
        }
      }

      // 全局超时：未完成的子任务标记为 timeout
      if (timedOut) {
        for (const idx of remaining) {
          const st = subTasks.find((s) => s.index === idx)!;
          if (!results.has(idx)) {
            results.set(idx, {
              index: idx,
              title: st.title,
              targetRole: st.targetRole,
              targetSessionId: '',
              taskId: '',
              status: 'timeout',
              result: `全局超时 (${timeoutMs}ms)，任务未执行完`,
            });
          }
        }
      }

      // 用户取消：未完成的子任务标记为 cancelled
      if (this.cancelled) {
        for (const idx of remaining) {
          const st = subTasks.find((s) => s.index === idx)!;
          if (!results.has(idx)) {
            results.set(idx, {
              index: idx,
              title: st.title,
              targetRole: st.targetRole,
              targetSessionId: '',
              taskId: '',
              status: 'cancelled',
              result: '用户已取消编排',
            });
          }
        }
      }
    } finally {
      clearTimeout(overallTimer);
    }

    return subTasks.map((st) => results.get(st.index)!).filter(Boolean);
  }

  /** 派发单个子任务并等待完成 */
  private async dispatchSingleSubTask(
    subTask: SubTask,
    sourceSessionId: string,
    workspaceId: string,
    orchestrationId: string,
    allSubTasks: SubTask[],
    taskMap: Map<number, { taskId: string; sessionId: string }>,
    completedResults: Map<number, SubTaskResult>,
    timeoutMs: number,
    maxDepth: number,
    currentDepth: number,
  ): Promise<SubTaskResult> {
    if (!this.dispatcher || !this.sessionManager || !this.roleManager) {
      throw new Error('OrchestratorService 未初始化依赖模块');
    }

    // 1. 匹配角色
    const role = this.matchRole(subTask.targetRole);
    if (!role) {
      throw new Error(`找不到匹配角色: ${subTask.targetRole}`);
    }

    // 2. 查找或创建目标 session
    const targetSession = this.findOrCreateSession(
      role,
      workspaceId,
      subTask.title,
    );

    // 3. 构建 contextPayload（包含依赖子任务的结果作为上下文）
    const depResults: string[] = [];
    for (const depIdx of subTask.dependencies) {
      const depResult = completedResults.get(depIdx);
      if (depResult) {
        depResults.push(
          `### 前置任务: ${depResult.title}\n状态: ${depResult.status}\n结果: ${depResult.result}`,
        );
      }
    }

    const sourceSession = this.sessionManager.get(sourceSessionId);
    const sourceRole = sourceSession
      ? this.roleManager.get(sourceSession.roleId)
      : undefined;

    const contextPayload: TaskContextPayload = {
      sourceRole: sourceRole
        ? { id: sourceRole.id, name: sourceRole.name, category: sourceRole.category as string }
        : { id: '', name: 'Orchestrator', category: 'system' },
      objective: subTask.objective,
      acceptanceCriteria: subTask.acceptanceCriteria,
      progressSummary: depResults.length > 0
        ? `本任务依赖以下前置任务的产出:\n${depResults.join('\n\n')}`
        : '',
      relatedTasks: [],
      relatedContracts: [],
      relatedMemories: [],
      conversationDigest: '',
      expectedOutput: subTask.expectedOutput,
      constraints: [
        '本任务由 Orchestrator 自动编排派发',
        `编排 ID: ${orchestrationId}`,
        `编排深度: 当前 ${currentDepth}/${maxDepth} 层（禁止递归编排超过此深度）`,
      ],
    };

    // 4. Dispatch
    const task = this.dispatcher.dispatch({
      sourceSessionId,
      targetSessionId: targetSession.id,
      title: subTask.title,
      brief: subTask.objective.slice(0, 200),
      contextPayload,
      priority: 'high',
      metadata: {
        orchestrationId,
        subTaskIndex: subTask.index,
      },
    });

    taskMap.set(subTask.index, { taskId: task.id, sessionId: targetSession.id });

    // 5. 自动 align + accept（编排场景跳过人工对齐）
    try {
      this.dispatcher.align(task.id);
      this.dispatcher.accept(task.id);
    } catch {
      // align/accept 可能因状态冲突失败，忽略 — 任务仍处于 proposed 状态
    }

    // 6. 等待完成
    const result = await this.waitForTaskCompletion(task.id, timeoutMs);

    return {
      index: subTask.index,
      title: subTask.title,
      targetRole: subTask.targetRole,
      targetSessionId: targetSession.id,
      taskId: task.id,
      status: result.status,
      result: result.result,
    };
  }

  // ============================================================
  // 3. 等待单个任务完成（事件驱动 + 超时）
  // ============================================================

  private waitForTaskCompletion(
    taskId: string,
    timeoutMs: number,
  ): Promise<{ status: SubTaskResult['status']; result: string }> {
    return new Promise((resolve) => {
      if (!this.eventBus || !this.dispatcher) {
        resolve({ status: 'failed', result: 'EventBus 或 Dispatcher 未初始化' });
        return;
      }

      let settled = false;

      const checkTask = (): { status: SubTaskResult['status']; result: string } | null => {
        const task = this.dispatcher!.get(taskId);
        if (!task) return null;
        if (task.status === 'completed') {
          return { status: 'completed', result: task.result || '' };
        }
        if (task.status === 'cancelled') {
          return { status: 'cancelled', result: task.alignmentNote || '任务已取消' };
        }
        if (task.status === 'failed') {
          return { status: 'failed', result: task.alignmentNote || '任务失败' };
        }
        return null;
      };

      // 先检查是否已完成（可能 sync 已完成）
      const existing = checkTask();
      if (existing) {
        resolve(existing);
        return;
      }

      const cleanup = () => {
        if (unsubCompleted) unsubCompleted();
        if (unsubCancelled) unsubCancelled();
        if (unsubRejected) unsubRejected();
        clearTimeout(timer);
        this.cancelCallbacks.delete(cancelCb);
      };

      const done = (result: { status: SubTaskResult['status']; result: string }) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };

      // 注册取消回调（cancel() 调用时立即以 cancelled 状态返回）
      const cancelCb = () => done({ status: 'cancelled', result: '用户已取消编排' });
      this.cancelCallbacks.add(cancelCb);

      // 监听完成/取消事件
      const handler = (event: any) => {
        if (event.payload?.taskId !== taskId) return;
        const result = checkTask();
        if (result) done(result);
      };

      const unsubCompleted = this.eventBus.on('session_task.completed', handler);
      const unsubCancelled = this.eventBus.on('session_task.cancelled', handler);
      const unsubRejected = this.eventBus.on('session_task.rejected', handler);

      // 超时
      const timer = setTimeout(() => {
        done({ status: 'timeout', result: `等待任务完成超时 (${timeoutMs}ms)` });
      }, timeoutMs);
    });
  }

  // ============================================================
  // 4. 结果汇总
  // ============================================================

  private async summarizeResults(
    description: string,
    plan: OrchestrationPlan,
    results: SubTaskResult[],
    llmCall: LLMCallFunction,
  ): Promise<string> {
    const systemPrompt = [
      '你是一个任务汇总专家。根据编排计划和各子任务执行结果，生成简洁的汇总报告。',
      '报告应包含：整体完成情况、各子任务结果摘要、关键发现和后续建议。',
    ].join('\n');

    const userPrompt = [
      '## 原始任务',
      description,
      '',
      '## 编排计划',
      plan.summary,
      '',
      '## 子任务执行结果',
      ...results.map((r) => [
        `### ${r.title}`,
        `- 角色: ${r.targetRole}`,
        `- 状态: ${r.status}`,
        `- 结果: ${r.result || '（无结果）'}`,
      ].join('\n')),
    ].join('\n');

    try {
      const summary = await llmCall(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        { temperature: 0.3, maxTokens: 2048 },
      );
      return summary.slice(0, 10000);
    } catch {
      // LLM 汇总失败时降级为简单拼接
      return [
        '## 编排汇总（自动生成）',
        `原始任务: ${description}`,
        '',
        ...results.map((r) => `- **${r.title}** [${r.status}]: ${r.result.slice(0, 200)}`),
      ].join('\n');
    }
  }

  // ============================================================
  // 辅助方法
  // ============================================================

  /** 模糊匹配角色：先精确 ID，再精确名称，再包含匹配 */
  private matchRole(targetRole: string): Role | undefined {
    if (!this.roleManager) return undefined;
    const roles = this.roleManager.list();
    if (roles.length === 0) return undefined;

    // 1. 精确 ID
    const byId = roles.find((r) => r.id === targetRole);
    if (byId) return byId;

    // 2. 精确名称
    const byName = roles.find((r) => r.name === targetRole);
    if (byName) return byName;

    // 3. 名称包含匹配（大小写不敏感）
    const lower = targetRole.toLowerCase();
    const byPartial = roles.find(
      (r) =>
        r.name.toLowerCase().includes(lower) ||
        lower.includes(r.name.toLowerCase()),
    );
    if (byPartial) return byPartial;

    // 4. skillSlug 匹配
    const bySlug = roles.find((r) => r.skillSlug === targetRole);
    if (bySlug) return bySlug;

    return undefined;
  }

  /** 为每个子任务创建独立 session，避免同角色多任务上下文冲突 */
  private findOrCreateSession(
    role: Role,
    workspaceId: string,
    taskTitle: string,
  ): Session {
    if (!this.sessionManager) throw new Error('SessionManager 未初始化');
    // 始终创建新 session，确保子任务间上下文隔离
    return this.sessionManager.create(workspaceId, role, `${role.icon || '💬'} ${taskTitle.slice(0, 30)}`);
  }

  /** 依赖图环检测（Kahn 算法） */
  private hasDependencyCycle(subTasks: SubTask[]): boolean {
    const n = subTasks.length;
    const inDegree = new Map<number, number>();
    const adjacency = new Map<number, number[]>();

    for (const st of subTasks) {
      inDegree.set(st.index, st.dependencies.length);
      if (!adjacency.has(st.index)) adjacency.set(st.index, []);
      for (const dep of st.dependencies) {
        if (!adjacency.has(dep)) adjacency.set(dep, []);
        adjacency.get(dep)!.push(st.index);
      }
    }

    const queue: number[] = [];
    for (const [id, degree] of inDegree) {
      if (degree === 0) queue.push(id);
    }

    let processed = 0;
    while (queue.length > 0) {
      const current = queue.shift()!;
      processed++;
      for (const next of adjacency.get(current) || []) {
        const newDegree = (inDegree.get(next) || 0) - 1;
        inDegree.set(next, newDegree);
        if (newDegree === 0) queue.push(next);
      }
    }

    return processed < n;
  }
}
