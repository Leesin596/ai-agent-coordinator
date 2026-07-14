import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CoordinatorDB } from '../db/database';
import { EventBus } from '../core/event-bus';
import { SessionTaskDispatcher } from '../core/session-task-dispatcher';
import * as fs from 'fs';
import * as path from 'path';

const TEST_DIR = path.join(__dirname, '../../.coordinator');
const TEST_DB = path.join(TEST_DIR, 'test-mcp-session-task.db');
const SCHEMA = path.join(__dirname, '../db/schema.sql');

describe('MCP session_task tools workflow', () => {
  let db: CoordinatorDB;
  let eventBus: EventBus;
  let dispatcher: SessionTaskDispatcher;

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

    db.insertSession({ id: 'sess-1', workspaceId: 'ws-1', roleId: 'role-1', title: 'Source', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    db.insertSession({ id: 'sess-2', workspaceId: 'ws-1', roleId: 'role-2', title: 'Target', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  });

  afterEach(() => {
    db.close();
    try { fs.unlinkSync(TEST_DB); } catch {}
    try { fs.unlinkSync(TEST_DB + '.lock'); } catch {}
  });

  it('full dispatch → align → accept → complete workflow', () => {
    const task = dispatcher.dispatch({
      sourceSessionId: 'sess-1',
      targetSessionId: 'sess-2',
      title: 'Implement API',
      brief: 'Build the REST endpoint',
      contextPayload: {
        objective: 'Create GET /api/users',
        acceptanceCriteria: ['Returns user list'],
        progressSummary: '',
        relatedTasks: [],
        relatedContracts: [],
        relatedMemories: [],
        conversationDigest: '',
        expectedOutput: 'JSON response',
        constraints: [],
      },
    });

    expect(task.status).toBe('proposed');
    expect(task.alignmentStatus).toBe('pending');
    expect(task.version).toBe(1);

    const got = dispatcher.get(task.id);
    expect(got).toBeDefined();
    expect(got!.title).toBe('Implement API');

    const incoming = dispatcher.listIncoming('sess-2');
    expect(incoming.length).toBe(1);
    expect(incoming[0].id).toBe(task.id);

    const outgoing = dispatcher.listOutgoing('sess-1');
    expect(outgoing.length).toBe(1);

    const aligned = dispatcher.align(task.id);
    expect(aligned.alignmentStatus).toBe('aligned');
    expect(aligned.version).toBe(2);

    const accepted = dispatcher.accept(task.id);
    expect(accepted.status).toBe('in_progress');
    expect(accepted.version).toBe(4);

    const completed = dispatcher.complete(task.id, 'API implemented and tested');
    expect(completed.status).toBe('completed');
    expect(completed.result).toBe('API implemented and tested');
    expect(completed.version).toBe(5);
  });

  it('dispatch → reject workflow', () => {
    const task = dispatcher.dispatch({
      sourceSessionId: 'sess-1',
      targetSessionId: 'sess-2',
      title: 'Rejected task',
      contextPayload: { objective: 'test', acceptanceCriteria: [], progressSummary: '', relatedTasks: [], relatedContracts: [], relatedMemories: [], conversationDigest: '', expectedOutput: '', constraints: [] },
    });

    const rejected = dispatcher.reject(task.id, 'Out of scope');
    expect(rejected.status).toBe('cancelled');
    expect(rejected.alignmentStatus).toBe('rejected');
    expect(rejected.alignmentNote).toBe('Out of scope');
  });

  it('dispatch → clarify → supplement → align workflow', () => {
    const task = dispatcher.dispatch({
      sourceSessionId: 'sess-1',
      targetSessionId: 'sess-2',
      title: 'Needs clarification',
      contextPayload: { objective: 'test', acceptanceCriteria: [], progressSummary: '', relatedTasks: [], relatedContracts: [], relatedMemories: [], conversationDigest: '', expectedOutput: '', constraints: [] },
    });

    const clarified = dispatcher.requestClarify(task.id, 'What format?');
    expect(clarified.alignmentStatus).toBe('clarify');

    const supplemented = dispatcher.supplementContext(task.id, { expectedOutput: 'JSON' });
    expect(supplemented.alignmentStatus).toBe('pending');

    const aligned = dispatcher.align(task.id);
    expect(aligned.alignmentStatus).toBe('aligned');
  });

  it('dispatch → cancel workflow', () => {
    const task = dispatcher.dispatch({
      sourceSessionId: 'sess-1',
      targetSessionId: 'sess-2',
      title: 'Cancelled task',
      contextPayload: { objective: 'test', acceptanceCriteria: [], progressSummary: '', relatedTasks: [], relatedContracts: [], relatedMemories: [], conversationDigest: '', expectedOutput: '', constraints: [] },
    });

    const cancelled = dispatcher.cancel(task.id, 'No longer needed');
    expect(cancelled.status).toBe('cancelled');
  });

  it('reviewContext returns aligned view', () => {
    const task = dispatcher.dispatch({
      sourceSessionId: 'sess-1',
      targetSessionId: 'sess-2',
      title: 'Review test',
      contextPayload: { objective: 'test objective', acceptanceCriteria: ['criteria 1'], progressSummary: '', relatedTasks: [], relatedContracts: [], relatedMemories: [], conversationDigest: '', expectedOutput: 'output', constraints: [] },
    });

    const view = dispatcher.reviewContext(task.id);
    expect(view.taskId).toBe(task.id);
    expect(view.payload.objective).toBe('test objective');
    expect(view.document).toContain('test objective');
  });
});
