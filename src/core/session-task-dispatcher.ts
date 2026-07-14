import { randomUUID } from 'crypto';
import type {
  SessionTask,
  SessionTaskStatus,
  SessionTaskAlignment,
  TaskContextPayload,
  DispatchSessionTaskInput,
  AlignedContextView,
  Task,
  Contract,
  Memory,
} from '../models/types';
import type { CoordinatorDB } from '../db/database';
import type { EventBus } from './event-bus';

// ============================================================
// SessionTaskDispatcher — 会话间任务派发 + 上下文对齐
// ============================================================
// 让一个 AI 会话(source)向另一个会话(target)派发任务，派发时打包对齐上下文。
// 接收方 reviewContext 后确认对齐 / 请求澄清，双方基于同一份上下文协作。
//
// 握手协议（两阶段对齐）:
//   派发方                                    接收方
//     | 1. dispatch(打包 context_payload)        |
//     | ---------------------------------------> | status=proposed, align=pending
//     |                                          |
//     |                            2. reviewContext(查看完整对齐文档)
//     |                                          |
//     |                3a. align(确认对齐)        |
//     | <--------------------------------------- | align=aligned
//     |                3b. requestClarify(澄清)  |
//     | <--------------------------------------- | align=clarify
//     |                                          |
//     | 4. supplementContext(补充上下文)         |
//     | ---------------------------------------> | align=pending
//     |                                          |
//     |                5. accept(接受)            |
//     | <--------------------------------------- | status=accepted→in_progress
//     |                                          |
//     |                6. complete(完成+结果)     |
//     | <--------------------------------------- | status=completed
//     |                                          |
//     |   (任一时刻) reject / cancel             |
// ============================================================

export class SessionTaskDispatcher {
  private db: CoordinatorDB | null = null;
  private eventBus: EventBus | null = null;

  setDB(db: CoordinatorDB): void {
    this.db = db;
  }

  setEventBus(bus: EventBus): void {
    this.eventBus = bus;
  }

  // ============================================================
  // 1. 派发任务（派发方调用）
  // ============================================================
  dispatch(input: DispatchSessionTaskInput): SessionTask {
    if (!this.db) throw new Error('DB not initialized');
    const db = this.db;

    const sourceSession = db.getSession(input.sourceSessionId);
    const targetSession = db.getSession(input.targetSessionId);
    if (!sourceSession) throw new Error(`派发方会话不存在: ${input.sourceSessionId}`);
    if (!targetSession) throw new Error(`接收方会话不存在: ${input.targetSessionId}`);
    if (input.sourceSessionId === input.targetSessionId) {
      throw new Error('不能向自己派发任务');
    }
    if (sourceSession.workspaceId !== targetSession.workspaceId) {
      throw new Error('跨工作区派发不允许：两个会话必须属于同一工作区');
    }

    const now = new Date().toISOString();
    const task: SessionTask = {
      id: randomUUID(),
      workspaceId: sourceSession.workspaceId,
      sourceSessionId: input.sourceSessionId,
      targetSessionId: input.targetSessionId,
      sourceRoleId: sourceSession.roleId,
      targetRoleId: targetSession.roleId,
      title: input.title,
      brief: input.brief || '',
      contextPayload: input.contextPayload,
      alignmentStatus: 'pending',
      alignmentNote: '',
      status: 'proposed',
      result: '',
      parentTaskId: input.parentTaskId,
      priority: input.priority || 'medium',
      createdAt: now,
      metadata: input.metadata || {},
      version: 1,
    };

    db.insertSessionTask(task);
    this.emit('session_task.dispatched', task.sourceSessionId, {
      taskId: task.id,
      title: task.title,
      sourceSessionId: task.sourceSessionId,
      targetSessionId: task.targetSessionId,
      targetRoleId: task.targetRoleId,
      priority: task.priority,
    }, task.targetSessionId);

    return task;
  }

  // ============================================================
  // 查询
  // ============================================================
  get(taskId: string): SessionTask | undefined {
    if (!this.db) return undefined;
    return this.db.getSessionTask(taskId) as SessionTask | undefined;
  }

  /** 接收方收到的任务 */
  listIncoming(sessionId: string): SessionTask[] {
    if (!this.db) return [];
    return this.db.listIncomingSessionTasks(sessionId) as SessionTask[];
  }

  /** 派发方派出的任务 */
  listOutgoing(sessionId: string): SessionTask[] {
    if (!this.db) return [];
    return this.db.listOutgoingSessionTasks(sessionId) as SessionTask[];
  }

  listByWorkspace(workspaceId: string): SessionTask[] {
    if (!this.db) return [];
    return this.db.listSessionTasksByWorkspace(workspaceId) as SessionTask[];
  }

  // ============================================================
  // 2. reviewContext — 接收方查看完整对齐上下文（核心）
  //    把 context_payload 里的 related* 引用解析成实际内容，
  //    编译成双方共享的 Markdown 对齐文档。
  // ============================================================
  reviewContext(taskId: string): AlignedContextView {
    if (!this.db) throw new Error('DB not initialized');
    const db = this.db;
    const task = db.getSessionTask(taskId);
    if (!task) throw new Error(`会话任务不存在: ${taskId}`);

    const payload = task.contextPayload as TaskContextPayload;

    // 解析引用 → 拉取实际内容
    const resolvedTasks: Task[] = [];
    for (const tid of payload.relatedTasks || []) {
      const t = db.getTask(tid);
      if (t) resolvedTasks.push(t as Task);
    }
    const resolvedContracts: Contract[] = [];
    for (const cid of payload.relatedContracts || []) {
      const c = db.getContract(cid);
      if (c) resolvedContracts.push(c as Contract);
    }
    const resolvedMemories: Memory[] = [];
    for (const mid of payload.relatedMemories || []) {
      const m = db.getMemory(mid);
      if (m) resolvedMemories.push(m as Memory);
    }

    // 取角色名
    const sourceRole = db.getRole(task.sourceRoleId);
    const targetRole = db.getRole(task.targetRoleId);
    const sourceRoleName = sourceRole?.name || task.sourceRoleId;
    const targetRoleName = targetRole?.name || task.targetRoleId;

    const document = this.compileAlignmentDocument(task as SessionTask, payload, resolvedTasks, resolvedContracts, resolvedMemories, sourceRoleName, targetRoleName);

    return {
      taskId: task.id,
      title: task.title,
      source: { sessionId: task.sourceSessionId, roleId: task.sourceRoleId, roleName: sourceRoleName },
      target: { sessionId: task.targetSessionId, roleId: task.targetRoleId, roleName: targetRoleName },
      payload,
      resolved: { tasks: resolvedTasks, contracts: resolvedContracts, memories: resolvedMemories },
      document,
      generatedAt: new Date().toISOString(),
    };
  }

  // ============================================================
  // 3a. align — 接收方确认对齐
  // ============================================================
  align(taskId: string): SessionTask {
    const task = this.requireTask(taskId);
    if (task.status !== 'proposed') {
      throw new Error(`仅 proposed 状态可确认对齐，当前: ${task.status}`);
    }
    if (task.alignmentStatus !== 'pending') {
      throw new Error(`当前对齐状态不可确认: ${task.alignmentStatus}（需 pending）`);
    }
    const now = new Date().toISOString();
    this.db!.updateSessionTask(taskId, { alignmentStatus: 'aligned', alignedAt: now }, task.version);
    this.emit('session_task.aligned', task.targetSessionId, {
      taskId, title: task.title, sourceSessionId: task.sourceSessionId,
    }, task.sourceSessionId);
    return this.get(taskId)!;
  }

  // ============================================================
  // 3b. requestClarify — 接收方请求澄清
  // ============================================================
  requestClarify(taskId: string, note: string): SessionTask {
    const task = this.requireTask(taskId);
    if (task.status !== 'proposed') {
      throw new Error(`仅 proposed 状态可请求澄清，当前: ${task.status}`);
    }
    if (task.alignmentStatus !== 'pending') {
      throw new Error(`当前对齐状态不可请求澄清: ${task.alignmentStatus}`);
    }
    if (!note.trim()) throw new Error('澄清问题不能为空');
    this.db!.updateSessionTask(taskId, { alignmentStatus: 'clarify', alignmentNote: note }, task.version);
    this.emit('session_task.clarify_requested', task.targetSessionId, {
      taskId, title: task.title, sourceSessionId: task.sourceSessionId, clarifyQuestion: note,
    }, task.sourceSessionId);
    return this.get(taskId)!;
  }

  // ============================================================
  // 4. supplementContext — 派发方补充上下文（回应澄清）
  // ============================================================
  supplementContext(taskId: string, supplement: Partial<TaskContextPayload>): SessionTask {
    const task = this.requireTask(taskId);
    if (task.alignmentStatus !== 'clarify') {
      throw new Error(`仅 clarify 状态可补充上下文，当前: ${task.alignmentStatus}`);
    }
    // 合并补充字段到 contextPayload
    const merged: TaskContextPayload = { ...task.contextPayload };
    if (supplement.objective !== undefined) merged.objective = supplement.objective;
    if (supplement.acceptanceCriteria !== undefined) merged.acceptanceCriteria = [...merged.acceptanceCriteria, ...supplement.acceptanceCriteria];
    if (supplement.progressSummary !== undefined) merged.progressSummary = supplement.progressSummary;
    if (supplement.relatedTasks !== undefined) merged.relatedTasks = [...new Set([...merged.relatedTasks, ...supplement.relatedTasks])];
    if (supplement.relatedContracts !== undefined) merged.relatedContracts = [...new Set([...merged.relatedContracts, ...supplement.relatedContracts])];
    if (supplement.relatedMemories !== undefined) merged.relatedMemories = [...new Set([...merged.relatedMemories, ...supplement.relatedMemories])];
    if (supplement.conversationDigest !== undefined) merged.conversationDigest = supplement.conversationDigest;
    if (supplement.expectedOutput !== undefined) merged.expectedOutput = supplement.expectedOutput;
    if (supplement.constraints !== undefined) merged.constraints = [...merged.constraints, ...supplement.constraints];

    this.db!.updateSessionTask(taskId, { contextPayload: merged, alignmentStatus: 'pending', alignmentNote: '' }, task.version);
    this.emit('session_task.supplemented', task.sourceSessionId, {
      taskId, title: task.title, targetSessionId: task.targetSessionId,
    }, task.targetSessionId);
    return this.get(taskId)!;
  }

  // ============================================================
  // 5. accept — 接收方接受（必须先 aligned）
  // ============================================================
  accept(taskId: string): SessionTask {
    const task = this.requireTask(taskId);
    if (task.status !== 'proposed') {
      throw new Error(`仅 proposed 状态可接受，当前: ${task.status}`);
    }
    if (task.alignmentStatus !== 'aligned') {
      throw new Error(`必须先确认对齐(aligned)才能接受，当前: ${task.alignmentStatus}`);
    }
    const now = new Date().toISOString();
    const success1 = this.db!.updateSessionTask(taskId, { status: 'accepted', acceptedAt: now }, task.version);
    if (!success1) {
      throw new Error(`SessionTask accept conflict: version ${task.version} is outdated (concurrent modification detected)`);
    }
    this.emit('session_task.accepted', task.targetSessionId, {
      taskId, title: task.title, sourceSessionId: task.sourceSessionId,
    }, task.sourceSessionId);

    // 自动转入进行中
    const refreshed = this.get(taskId)!;
    this.db!.updateSessionTask(taskId, { status: 'in_progress' }, refreshed.version);
    this.emit('session_task.in_progress', task.targetSessionId, {
      taskId, title: task.title, sourceSessionId: task.sourceSessionId,
    }, task.sourceSessionId);
    return this.get(taskId)!;
  }

  // ============================================================
  // reject — 接收方拒绝
  // ============================================================
  reject(taskId: string, reason: string): SessionTask {
    const task = this.requireTask(taskId);
    if (task.status !== 'proposed') {
      throw new Error(`仅 proposed 状态可拒绝，当前: ${task.status}`);
    }
    this.db!.updateSessionTask(taskId, { status: 'cancelled', alignmentStatus: 'rejected', alignmentNote: reason }, task.version);
    this.emit('session_task.rejected', task.targetSessionId, {
      taskId, title: task.title, sourceSessionId: task.sourceSessionId, reason,
    }, task.sourceSessionId);
    this.emit('session_task.cancelled', task.targetSessionId, {
      taskId, title: task.title, reason,
    }, task.sourceSessionId);
    return this.get(taskId)!;
  }

  // ============================================================
  // 6. complete — 接收方完成（回填结果）
  // ============================================================
  complete(taskId: string, result: string): SessionTask {
    const task = this.requireTask(taskId);
    if (task.status !== 'in_progress') {
      throw new Error(`仅 in_progress 状态可完成，当前: ${task.status}`);
    }
    if (!result.trim()) throw new Error('完成结果不能为空');
    const now = new Date().toISOString();
    this.db!.updateSessionTask(taskId, { status: 'completed', result, completedAt: now }, task.version);
    this.emit('session_task.completed', task.targetSessionId, {
      taskId, title: task.title, sourceSessionId: task.sourceSessionId, result,
    }, task.sourceSessionId);
    return this.get(taskId)!;
  }

  // ============================================================
  // cancel — 派发方取消
  // ============================================================
  cancel(taskId: string, reason: string): SessionTask {
    const task = this.requireTask(taskId);
    if (task.status === 'completed' || task.status === 'cancelled') {
      throw new Error(`任务已终态(${task.status})，不可取消`);
    }
    this.db!.updateSessionTask(taskId, { status: 'cancelled', alignmentNote: reason }, task.version);
    this.emit('session_task.cancelled', task.sourceSessionId, {
      taskId, title: task.title, targetSessionId: task.targetSessionId, reason,
    }, task.targetSessionId);
    return this.get(taskId)!;
  }

  // ============================================================
  // 内部辅助
  // ============================================================
  private requireTask(taskId: string): SessionTask {
    if (!this.db) throw new Error('DB not initialized');
    const task = this.db.getSessionTask(taskId);
    if (!task) throw new Error(`会话任务不存在: ${taskId}`);
    return task as SessionTask;
  }

  private emit(type: any, source: string, payload: any, target?: string): void {
    if (this.eventBus) {
      this.eventBus.emit(type, source, payload, target);
    }
  }

  /**
   * 编译双方共享的 Markdown 对齐文档。
   * 派发方打包引用，系统解析成实际内容 —— 这就是"两个会话对齐任务上下文"的落地。
   */
  private compileAlignmentDocument(
    task: SessionTask,
    payload: TaskContextPayload,
    tasks: Task[],
    contracts: Contract[],
    memories: Memory[],
    sourceRoleName: string,
    targetRoleName: string
  ): string {
    const lines: string[] = [];
    lines.push(`# 任务对齐上下文：${task.title}`);
    lines.push('');
    lines.push(`> 优先级：${task.priority} | 状态：${task.status} | 对齐：${task.alignmentStatus}`);
    lines.push('');
    lines.push('## 协作双方');
    lines.push(`- **派发方**：${sourceRoleName}（会话 \`${task.sourceSessionId.slice(0, 8)}\`）`);
    lines.push(`- **接收方**：${targetRoleName}（会话 \`${task.targetSessionId.slice(0, 8)}\`）`);
    lines.push('');

    if (task.brief) {
      lines.push('## 任务简述');
      lines.push(task.brief);
      lines.push('');
    }

    lines.push('## 任务目标');
    lines.push(payload.objective || '（未提供）');
    lines.push('');

    if (payload.acceptanceCriteria && payload.acceptanceCriteria.length > 0) {
      lines.push('## 验收标准');
      payload.acceptanceCriteria.forEach((c, i) => lines.push(`${i + 1}. ${c}`));
      lines.push('');
    }

    if (payload.progressSummary) {
      lines.push('## 派发方进展');
      lines.push(payload.progressSummary);
      lines.push('');
    }

    if (payload.expectedOutput) {
      lines.push('## 期望产出');
      lines.push(payload.expectedOutput);
      lines.push('');
    }

    if (payload.constraints && payload.constraints.length > 0) {
      lines.push('## 约束与注意事项');
      payload.constraints.forEach((c) => lines.push(`- ${c}`));
      lines.push('');
    }

    if (payload.conversationDigest) {
      lines.push('## 派发方对话摘要');
      lines.push(payload.conversationDigest);
      lines.push('');
    }

    // 解析后的关联任务
    if (tasks.length > 0) {
      lines.push('## 关联任务（已解析）');
      for (const t of tasks) {
        lines.push(`### ${t.title}`);
        lines.push(`- 状态：${t.status} | 负责人：${t.assignee} | 优先级：${t.priority}`);
        if (t.description) lines.push(`- 描述：${t.description}`);
        if (t.contractRefs && t.contractRefs.length > 0) lines.push(`- 关联契约：${t.contractRefs.join(', ')}`);
        lines.push('');
      }
    }

    // 解析后的关联契约
    if (contracts.length > 0) {
      lines.push('## 关联契约（已解析）');
      for (const c of contracts) {
        lines.push(`### ${c.name}`);
        lines.push(`- 状态：${c.status} | 生产方：${c.producer} | 版本：v${c.version}`);
        lines.push('```json');
        lines.push(JSON.stringify(c.schema, null, 2));
        lines.push('```');
        lines.push('');
      }
    }

    // 解析后的关联记忆
    if (memories.length > 0) {
      lines.push('## 关联记忆（已解析）');
      for (const m of memories) {
        lines.push(`### ${m.title}`);
        lines.push(`- 类型：${m.category} | 作用域：${m.scope}`);
        lines.push(m.content);
        lines.push('');
      }
    }

    lines.push('---');
    lines.push(`*生成于 ${new Date().toISOString()}，双方基于此文档对齐任务上下文。*`);
    return lines.join('\n');
  }
}
