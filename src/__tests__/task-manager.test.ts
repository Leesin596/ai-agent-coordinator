import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CoordinatorDB } from '../db/database';
import { EventBus } from '../core/event-bus';
import { TaskManager } from '../core/task-manager';
import * as fs from 'fs';
import * as path from 'path';

const TEST_DIR = path.join(__dirname, '../../.coordinator');
const TEST_DB = path.join(TEST_DIR, 'test-task-manager.db');
const SCHEMA = path.join(__dirname, '../db/schema.sql');

describe('TaskManager', () => {
  let db: CoordinatorDB;
  let eventBus: EventBus;
  let taskManager: TaskManager;

  beforeEach(async () => {
    try { fs.unlinkSync(TEST_DB); } catch {}
    try { fs.unlinkSync(TEST_DB + '.lock'); } catch {}
    fs.mkdirSync(TEST_DIR, { recursive: true });
    db = await CoordinatorDB.create(TEST_DB, SCHEMA);
    eventBus = new EventBus();
    eventBus.setDB(db);
    taskManager = new TaskManager(eventBus);
    taskManager.setDB(db);
  });

  afterEach(() => {
    db.close();
    try { fs.unlinkSync(TEST_DB); } catch {}
    try { fs.unlinkSync(TEST_DB + '.lock'); } catch {}
  });

  it('should create a task', () => {
    const task = taskManager.create({
      title: 'Implement feature A',
      description: 'Build the feature',
      assignee: 'frontend',
      priority: 'high',
      project: 'default',
    });

    expect(task.id).toBeDefined();
    expect(task.title).toBe('Implement feature A');
    expect(task.status).toBe('ready');
    expect(task.assignee).toBe('frontend');
    expect(task.priority).toBe('high');
    expect(task.project).toBe('default');
  });

  it('should get a task by ID', () => {
    const created = taskManager.create({
      title: 'Task B',
      assignee: 'backend',
      project: 'default',
    });

    const task = taskManager.get(created.id);
    expect(task).toBeDefined();
    expect(task!.title).toBe('Task B');
  });

  it('should list tasks with filters', () => {
    taskManager.create({ title: 'T1', assignee: 'frontend', project: 'proj-a' });
    taskManager.create({ title: 'T2', assignee: 'backend', project: 'proj-a' });
    taskManager.create({ title: 'T3', assignee: 'frontend', project: 'proj-b' });

    const allProjA = taskManager.list({ project: 'proj-a' });
    expect(allProjA.length).toBe(2);

    const frontendProjA = taskManager.list({ project: 'proj-a', assignee: 'frontend' });
    expect(frontendProjA.length).toBe(1);
    expect(frontendProjA[0].title).toBe('T1');
  });

  it('should update task status', () => {
    const task = taskManager.create({
      title: 'Status task',
      assignee: 'frontend',
      project: 'default',
    });

    taskManager.updateStatus(task.id, 'in_progress');
    const updated = taskManager.get(task.id);
    expect(updated!.status).toBe('in_progress');
  });

  it('should handle task dependencies', () => {
    const t1 = taskManager.create({
      title: 'Dependency',
      assignee: 'backend',
      project: 'default',
    });

    const t2 = taskManager.create({
      title: 'Dependent',
      assignee: 'frontend',
      dependencies: [t1.id],
      project: 'default',
    });

    expect(t2.dependencies).toContain(t1.id);

    // t1 is ready (no deps), t2 is pending (has dep on t1)
    const ready = taskManager.getReadyTasks(undefined, 'default');
    expect(ready.length).toBe(1);
    expect(ready[0].id).toBe(t1.id);

    taskManager.updateStatus(t1.id, 'done');
    const readyAfter = taskManager.getReadyTasks(undefined, 'default');
    expect(readyAfter.length).toBe(1);
    expect(readyAfter[0].id).toBe(t2.id);
  });

  it('should prevent circular dependencies', () => {
    const t1 = taskManager.create({
      title: 'T1',
      assignee: 'frontend',
      project: 'default',
    });

    const t2 = taskManager.create({
      title: 'T2',
      assignee: 'frontend',
      dependencies: [t1.id],
      project: 'default',
    });

    expect(() => {
      taskManager.create({
        title: 'T1 circular',
        assignee: 'frontend',
        dependencies: [t2.id],
        project: 'default',
      });
    }).not.toThrow();

    const t1Updated = taskManager.get(t1.id);
    expect(t1Updated!.dependents).toContain(t2.id);
  });

  it('should delete a task', () => {
    const task = taskManager.create({
      title: 'To delete',
      assignee: 'frontend',
      project: 'default',
    });

    const deleted = taskManager.delete(task.id);
    expect(deleted).toBe(true);
    expect(taskManager.get(task.id)).toBeUndefined();
  });

  it('should get task graph', () => {
    const t1 = taskManager.create({ title: 'Root', assignee: 'a', project: 'default' });
    const t2 = taskManager.create({ title: 'Child', assignee: 'b', dependencies: [t1.id], project: 'default' });

    const graph = taskManager.getGraph('default');
    expect(graph.nodes.length).toBe(2);
    expect(graph.edges.length).toBe(1);
  });

  it('should isolate tasks by project namespace', () => {
    taskManager.create({ title: 'ProjA task', assignee: 'a', project: 'proj-a' });
    taskManager.create({ title: 'ProjB task', assignee: 'b', project: 'proj-b' });

    const projA = taskManager.list({ project: 'proj-a' });
    const projB = taskManager.list({ project: 'proj-b' });

    expect(projA.length).toBe(1);
    expect(projA[0].title).toBe('ProjA task');
    expect(projB.length).toBe(1);
    expect(projB[0].title).toBe('ProjB task');
  });
});
