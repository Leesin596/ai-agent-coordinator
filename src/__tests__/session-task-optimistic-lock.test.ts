import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CoordinatorDB } from '../db/database';
import * as fs from 'fs';
import * as path from 'path';

const TEST_DIR = path.join(__dirname, '../../.coordinator');
const TEST_DB = path.join(TEST_DIR, 'test-session-task-lock.db');
const SCHEMA = path.join(__dirname, '../db/schema.sql');

function makeSessionTask(id: string): Record<string, any> {
  return {
    id,
    workspaceId: 'ws-1',
    sourceSessionId: 'sess-1',
    targetSessionId: 'sess-2',
    sourceRoleId: 'role-1',
    targetRoleId: 'role-2',
    title: 'Test task',
    brief: '',
    contextPayload: {},
    alignmentStatus: 'pending',
    alignmentNote: '',
    status: 'proposed',
    result: '',
    parentTaskId: null,
    priority: 'medium',
    createdAt: new Date().toISOString(),
    metadata: {},
    version: 1,
  };
}

describe('SessionTask optimistic lock', () => {
  let db: CoordinatorDB;

  beforeEach(async () => {
    try { fs.unlinkSync(TEST_DB); } catch {}
    try { fs.unlinkSync(TEST_DB + '.lock'); } catch {}
    fs.mkdirSync(TEST_DIR, { recursive: true });
    db = await CoordinatorDB.create(TEST_DB, SCHEMA);
  });

  afterEach(() => {
    db.close();
    try { fs.unlinkSync(TEST_DB); } catch {}
    try { fs.unlinkSync(TEST_DB + '.lock'); } catch {}
  });

  it('should update successfully with correct version', () => {
    db.insertSessionTask(makeSessionTask('st-1'));
    const ok = db.updateSessionTask('st-1', { status: 'accepted' }, 1);
    expect(ok).toBe(true);
    const task = db.getSessionTask('st-1')!;
    expect(task.version).toBe(2);
    expect(task.status).toBe('accepted');
  });

  it('should reject update with stale version', () => {
    db.insertSessionTask(makeSessionTask('st-2'));
    db.updateSessionTask('st-2', { status: 'accepted' }, 1);
    const ok = db.updateSessionTask('st-2', { status: 'in_progress' }, 1);
    expect(ok).toBe(false);
    const task = db.getSessionTask('st-2')!;
    expect(task.version).toBe(2);
    expect(task.status).toBe('accepted');
  });

  it('should allow sequential updates with refreshed version', () => {
    db.insertSessionTask(makeSessionTask('st-3'));

    let ok = db.updateSessionTask('st-3', { status: 'accepted' }, 1);
    expect(ok).toBe(true);

    let task = db.getSessionTask('st-3')!;
    ok = db.updateSessionTask('st-3', { status: 'in_progress' }, task.version);
    expect(ok).toBe(true);

    task = db.getSessionTask('st-3')!;
    ok = db.updateSessionTask('st-3', { status: 'completed', result: 'done' }, task.version);
    expect(ok).toBe(true);

    task = db.getSessionTask('st-3')!;
    expect(task.version).toBe(4);
    expect(task.status).toBe('completed');
    expect(task.result).toBe('done');
  });

  it('should reject concurrent update from second instance', async () => {
    db.insertSessionTask(makeSessionTask('st-4'));

    const db2 = await CoordinatorDB.create(TEST_DB, SCHEMA);
    const staleTask = db2.getSessionTask('st-4')!;
    expect(staleTask.version).toBe(1);

    db.updateSessionTask('st-4', { status: 'accepted' }, 1);

    const ok = db2.updateSessionTask('st-4', { status: 'cancelled' }, staleTask.version);
    expect(ok).toBe(false);

    const final = db.getSessionTask('st-4')!;
    expect(final.version).toBe(2);
    expect(final.status).toBe('accepted');

    db2.close();
  });

  it('should work without expectedVersion (backwards compatible)', () => {
    db.insertSessionTask(makeSessionTask('st-5'));
    const ok = db.updateSessionTask('st-5', { status: 'accepted' });
    expect(ok).toBe(true);
    const task = db.getSessionTask('st-5')!;
    expect(task.version).toBe(2);
  });
});
