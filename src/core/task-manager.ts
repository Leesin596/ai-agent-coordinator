import { randomUUID } from 'crypto';
import type { Task, CreateTaskInput, TaskStatus } from '../models/types';
import type { EventBus } from './event-bus';
import type { CoordinatorDB } from '../db/database';

export class TaskManager {
  private db: CoordinatorDB | null = null;

  constructor(private eventBus: EventBus) {}

  setDB(db: CoordinatorDB): void {
    this.db = db;
  }

  create(input: CreateTaskInput & { project?: string }): Task {
    const now = new Date().toISOString();
    const task: any = {
      id: randomUUID(),
      project: input.project || 'default',
      title: input.title,
      description: input.description || '',
      status: 'pending',
      assignee: input.assignee,
      dependencies: input.dependencies || [],
      dependents: [],
      inputs: input.inputs || {},
      outputs: {},
      contractRefs: input.contractRefs || [],
      priority: input.priority || 'medium',
      version: 1,
      createdAt: now,
      updatedAt: now,
      metadata: input.metadata || {},
    };

    // Validate dependencies exist
    for (const depId of task.dependencies) {
      if (!this.loadTask(depId)) {
        throw new Error(`Dependency task not found: ${depId}`);
      }
    }

    // Detect circular dependency before inserting
    if (task.dependencies.length > 0) {
      this.saveTask(task); // Temporarily add
      if (this.hasCycle()) {
        this.deleteTask(task.id);
        throw new Error(`Circular dependency detected when adding task "${task.title}"`);
      }
    } else {
      this.saveTask(task);
    }

    // Register as dependent in upstream tasks
    for (const depId of task.dependencies) {
      const dep = this.loadTask(depId)!;
      dep.dependents.push(task.id);
      this.persistUpdate(dep.id, { dependents: dep.dependents, updatedAt: dep.updatedAt }, dep.version);
    }

    // Check if task is immediately ready (no deps or all deps done)
    this.evaluateReadiness(task.id);

    this.eventBus.emit('task.created', task.assignee, {
      taskId: task.id,
      title: task.title,
      assignee: task.assignee,
      dependencies: task.dependencies,
    }, undefined, task.project);

    return this.loadTask(task.id)!;
  }

  get(id: string): Task | undefined {
    return this.loadTask(id);
  }

  list(filter?: { assignee?: string; status?: TaskStatus; project?: string }): Task[] {
    if (this.db) {
      return this.db.listTasks(filter) as Task[];
    }
    return [];
  }

  getReadyTasks(assignee?: string, project?: string): Task[] {
    let result = this.list({ status: 'ready', project });
    if (assignee) {
      result = result.filter((t) => t.assignee === assignee);
    }
    return result;
  }

  updateStatus(id: string, status: TaskStatus, outputs?: Record<string, any>): Task {
    const task = this.loadTask(id);
    if (!task) throw new Error(`Task not found: ${id}`);

    const oldStatus = task.status;
    const now = new Date().toISOString();
    const updates: Record<string, any> = { status, updatedAt: now };

    if (outputs) {
      updates.outputs = { ...task.outputs, ...outputs };
    }
    if (status === 'done') {
      updates.completedAt = now;
    }

    this.persistUpdate(id, updates, task.version);

    if (status === 'done') {
      this.eventBus.emit('task.completed', task.assignee, {
        taskId: id,
        title: task.title,
        outputs: updates.outputs || task.outputs,
      }, undefined, task.project);
      // Cascade: evaluate dependents readiness
      for (const depId of task.dependents) {
        this.evaluateReadiness(depId);
      }
    } else if (status === 'failed') {
      // Cascade: block dependents
      this.cascadeBlock(id);
    }

    this.eventBus.emit('task.status_changed', task.assignee, {
      taskId: id,
      title: task.title,
      from: oldStatus,
      to: status,
    }, undefined, task.project);

    return this.loadTask(id)!;
  }

  delete(id: string): boolean {
    const task = this.loadTask(id);
    if (!task) return false;

    // Remove from dependents lists of upstream tasks
    for (const depId of task.dependencies) {
      const dep = this.loadTask(depId);
      if (dep) {
        dep.dependents = dep.dependents.filter((d) => d !== id);
        this.persistUpdate(dep.id, { dependents: dep.dependents, updatedAt: new Date().toISOString() }, dep.version);
      }
    }

    // Remove from dependencies lists of downstream tasks
    for (const depId of task.dependents) {
      const dep = this.loadTask(depId);
      if (dep) {
        dep.dependencies = dep.dependencies.filter((d) => d !== id);
        this.persistUpdate(dep.id, { dependencies: dep.dependencies, updatedAt: new Date().toISOString() }, dep.version);
        this.evaluateReadiness(depId);
      }
    }

    this.deleteTask(id);
    return true;
  }

  getGraph(project?: string): { nodes: Task[]; edges: { from: string; to: string }[] } {
    const nodes = this.list({ project });
    const edges: { from: string; to: string }[] = [];
    for (const task of nodes) {
      for (const depId of task.dependencies) {
        edges.push({ from: depId, to: task.id });
      }
    }
    return { nodes, edges };
  }

  getTopologicalOrder(project?: string): string[] {
    const allTasks = this.list({ project });
    const inDegree: Map<string, number> = new Map();
    const adjacency: Map<string, string[]> = new Map();

    for (const task of allTasks) {
      inDegree.set(task.id, task.dependencies.length);
      if (!adjacency.has(task.id)) adjacency.set(task.id, []);
      for (const depId of task.dependencies) {
        if (!adjacency.has(depId)) adjacency.set(depId, []);
        adjacency.get(depId)!.push(task.id);
      }
    }

    const queue: string[] = [];
    for (const [id, degree] of inDegree) {
      if (degree === 0) queue.push(id);
    }

    const order: string[] = [];
    while (queue.length > 0) {
      const current = queue.shift()!;
      order.push(current);
      for (const next of adjacency.get(current) || []) {
        const newDegree = (inDegree.get(next) || 0) - 1;
        inDegree.set(next, newDegree);
        if (newDegree === 0) queue.push(next);
      }
    }

    return order;
  }

  // --- Private helpers ---

  private loadTask(id: string): Task | undefined {
    if (this.db) {
      return this.db.getTask(id) as Task | undefined;
    }
    return undefined;
  }

  private saveTask(task: Task): void {
    if (this.db) {
      this.db.insertTask(task);
    }
  }

  private deleteTask(id: string): void {
    if (this.db) {
      this.db.deleteTask(id);
    }
  }

  private persistUpdate(id: string, updates: Record<string, any>, expectedVersion: number): void {
    if (this.db) {
      const ok = this.db.updateTask(id, updates, expectedVersion);
      if (!ok) {
        throw new Error(`Optimistic lock conflict on task ${id} (expected version ${expectedVersion})`);
      }
    }
  }

  private evaluateReadiness(taskId: string): void {
    const task = this.loadTask(taskId);
    if (!task || task.status === 'done' || task.status === 'failed') return;

    const allDepsDone = task.dependencies.every((depId) => {
      const dep = this.loadTask(depId);
      return dep && dep.status === 'done';
    });

    if (allDepsDone && task.status === 'pending') {
      const now = new Date().toISOString();
      this.persistUpdate(taskId, { status: 'ready', updatedAt: now }, task.version);
      this.eventBus.emit('task.ready', task.assignee, {
        taskId: task.id,
        title: task.title,
      }, task.assignee, task.project);
    }
  }

  private cascadeBlock(failedTaskId: string): void {
    const task = this.loadTask(failedTaskId);
    if (!task) return;

    for (const depId of task.dependents) {
      const dependent = this.loadTask(depId);
      if (dependent && dependent.status !== 'done' && dependent.status !== 'failed') {
        const now = new Date().toISOString();
        this.persistUpdate(depId, { status: 'blocked', updatedAt: now }, dependent.version);
        this.eventBus.emit('task.blocked', dependent.assignee, {
          taskId: depId,
          blockedBy: failedTaskId,
          title: dependent.title,
        }, dependent.assignee, dependent.project);
        // Recursive cascade
        this.cascadeBlock(depId);
      }
    }
  }

  private hasCycle(project?: string): boolean {
    const order = this.getTopologicalOrder(project);
    const totalTasks = this.list({ project }).length;
    return order.length < totalTasks;
  }
}
