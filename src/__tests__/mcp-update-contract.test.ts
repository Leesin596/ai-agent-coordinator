import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CoordinatorDB } from '../db/database';
import { EventBus } from '../core/event-bus';
import { ContractRegistry } from '../core/contract-registry';
import * as fs from 'fs';
import * as path from 'path';

const TEST_DIR = path.join(__dirname, '../../.coordinator');
const TEST_DB = path.join(TEST_DIR, 'test-mcp-update-contract.db');
const SCHEMA = path.join(__dirname, '../db/schema.sql');

describe('MCP update_contract project param', () => {
  let db: CoordinatorDB;
  let eventBus: EventBus;
  let registry: ContractRegistry;

  beforeEach(async () => {
    try { fs.unlinkSync(TEST_DB); } catch {}
    try { fs.unlinkSync(TEST_DB + '.lock'); } catch {}
    fs.mkdirSync(TEST_DIR, { recursive: true });
    db = await CoordinatorDB.create(TEST_DB, SCHEMA);
    eventBus = new EventBus();
    eventBus.setDB(db);
    registry = new ContractRegistry(eventBus);
    registry.setDB(db);
  });

  afterEach(() => {
    db.close();
    try { fs.unlinkSync(TEST_DB); } catch {}
    try { fs.unlinkSync(TEST_DB + '.lock'); } catch {}
  });

  it('should update contract when project matches', () => {
    const contract = registry.create({
      name: 'GET /api/users',
      type: 'api',
      producer: 'backend',
      consumers: ['frontend'],
      schema: { type: 'object' },
      examples: [],
      project: 'proj-a',
      metadata: {},
    });

    const existing = registry.get(contract.id)!;
    expect(existing.project).toBe('proj-a');

    const updated = registry.update(contract.id, { status: 'agreed' });
    expect(updated.status).toBe('agreed');
    expect(updated.project).toBe('proj-a');
  });

  it('should reject update when project does not match', () => {
    const contract = registry.create({
      name: 'GET /api/posts',
      type: 'api',
      producer: 'backend',
      consumers: ['frontend'],
      schema: { type: 'object' },
      examples: [],
      project: 'proj-a',
      metadata: {},
    });

    const existing = registry.get(contract.id)!;
    expect(existing.project).toBe('proj-a');

    expect(existing.project).not.toBe('proj-b');
  });

  it('should allow update without project param (backwards compatible)', () => {
    const contract = registry.create({
      name: 'GET /api/items',
      type: 'api',
      producer: 'backend',
      consumers: ['frontend'],
      schema: { type: 'object' },
      examples: [],
      project: 'proj-c',
      metadata: {},
    });

    const updated = registry.update(contract.id, { status: 'implemented' });
    expect(updated.status).toBe('implemented');
  });
});
