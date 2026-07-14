import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CoordinatorDB } from '../db/database';
import * as fs from 'fs';
import * as path from 'path';

const TEST_DIR = path.join(__dirname, '../../.coordinator');
const TEST_DB = path.join(TEST_DIR, 'test-concurrency.db');
const SCHEMA = path.join(__dirname, '../db/schema.sql');

function makeTask(id: string, title: string, assignee: string) {
  return {
    id,
    project: 'default',
    title,
    description: '',
    status: 'pending',
    assignee,
    dependencies: [] as string[],
    dependents: [] as string[],
    inputs: {},
    outputs: {},
    contractRefs: [] as string[],
    priority: 'medium',
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: {},
  };
}

function makeMemory(id: string, title: string) {
  return {
    id,
    project: 'default',
    category: 'decision',
    title,
    content: 'test content',
    tags: ['test'],
    scope: 'global',
    createdBy: 'tester',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    references: [] as string[],
  };
}

describe('CoordinatorDB cross-process safety', () => {
  beforeEach(() => {
    try { fs.unlinkSync(TEST_DB); } catch {}
    try { fs.unlinkSync(TEST_DB + '.lock'); } catch {}
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    try { fs.unlinkSync(TEST_DB); } catch {}
    try { fs.unlinkSync(TEST_DB + '.lock'); } catch {}
  });

  it('two instances writing same file should not lose data', async () => {
    const db1 = await CoordinatorDB.create(TEST_DB, SCHEMA);

    db1.insertTask(makeTask('task-1', 'Task from db1', 'frontend'));

    const db2 = await CoordinatorDB.create(TEST_DB, SCHEMA);

    db2.insertTask(makeTask('task-2', 'Task from db2', 'backend'));

    const fromDb1 = db1.listTasks({});
    const fromDb2 = db2.listTasks({});

    expect(fromDb1.length).toBe(2);
    expect(fromDb2.length).toBe(2);

    const ids1 = fromDb1.map(t => t.id).sort();
    const ids2 = fromDb2.map(t => t.id).sort();
    expect(ids1).toEqual(['task-1', 'task-2']);
    expect(ids2).toEqual(['task-1', 'task-2']);

    db1.close();
    db2.close();
  });

  it('should recover from stale lock file', async () => {
    fs.writeFileSync(TEST_DB + '.lock', '999999999');

    const db = await CoordinatorDB.create(TEST_DB, SCHEMA);

    db.insertTask(makeTask('task-stale', 'Stale lock test', 'test'));

    const tasks = db.listTasks({});
    expect(tasks.length).toBe(1);
    expect(tasks[0].id).toBe('task-stale');

    db.close();
  });

  it('reads from instance B should see writes from instance A', async () => {
    const db1 = await CoordinatorDB.create(TEST_DB, SCHEMA);
    const db2 = await CoordinatorDB.create(TEST_DB, SCHEMA);

    db1.insertMemory(makeMemory('mem-1', 'Test decision'));

    const memories = db2.listMemories({});
    expect(memories.length).toBe(1);
    expect(memories[0].title).toBe('Test decision');

    db1.close();
    db2.close();
  });

  it('interleaved writes from two instances should all persist', async () => {
    const db1 = await CoordinatorDB.create(TEST_DB, SCHEMA);
    const db2 = await CoordinatorDB.create(TEST_DB, SCHEMA);

    db1.insertTask(makeTask('t-a', 'A1', 'fe'));
    db2.insertTask(makeTask('t-b', 'B1', 'be'));
    db1.insertTask(makeTask('t-c', 'A2', 'fe'));
    db2.insertTask(makeTask('t-d', 'B2', 'be'));

    const fromDb1 = db1.listTasks({});
    const fromDb2 = db2.listTasks({});

    expect(fromDb1.length).toBe(4);
    expect(fromDb2.length).toBe(4);

    const ids = fromDb1.map(t => t.id).sort();
    expect(ids).toEqual(['t-a', 't-b', 't-c', 't-d']);

    db1.close();
    db2.close();
  });

  it('lock file should be cleaned up after close', async () => {
    const db = await CoordinatorDB.create(TEST_DB, SCHEMA);
    db.insertTask(makeTask('t-1', 'test', 'test'));
    db.close();

    expect(fs.existsSync(TEST_DB + '.lock')).toBe(false);
  });

  it('lock file should not exist during idle (no write in progress)', async () => {
    const db = await CoordinatorDB.create(TEST_DB, SCHEMA);
    db.insertTask(makeTask('t-1', 'test', 'test'));

    expect(fs.existsSync(TEST_DB + '.lock')).toBe(false);

    db.close();
  });
});
