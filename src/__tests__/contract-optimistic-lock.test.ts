import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CoordinatorDB } from '../db/database';
import { EventBus } from '../core/event-bus';
import { ContractRegistry } from '../core/contract-registry';
import * as fs from 'fs';
import * as path from 'path';

const TEST_DIR = path.join(__dirname, '../../.coordinator');
const TEST_DB = path.join(TEST_DIR, 'test-contract-lock.db');
const SCHEMA = path.join(__dirname, '../db/schema.sql');

describe('ContractRegistry optimistic lock', () => {
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

  it('should update contract successfully with correct version', () => {
    const contract = registry.create({
      name: 'GET /api/users',
      type: 'api',
      producer: 'backend',
      consumers: ['frontend'],
      schema: { type: 'object', properties: { id: { type: 'string' } } },
      examples: [],
      project: 'default',
      metadata: {},
    });

    const updated = registry.update(contract.id, {
      status: 'agreed',
    });

    expect(updated.version).toBe(2);
    expect(updated.status).toBe('agreed');
  });

  it('should throw on concurrent update with stale version', async () => {
    const contract = registry.create({
      name: 'GET /api/posts',
      type: 'api',
      producer: 'backend',
      consumers: ['frontend'],
      schema: { type: 'object', properties: { id: { type: 'string' } } },
      examples: [],
      project: 'default',
      metadata: {},
    });

    const db2 = await CoordinatorDB.create(TEST_DB, SCHEMA);
    const eventBus2 = new EventBus();
    eventBus2.setDB(db2);
    const registry2 = new ContractRegistry(eventBus2);
    registry2.setDB(db2);

    const staleContract = registry2.get(contract.id)!;
    expect(staleContract.version).toBe(1);

    registry.update(contract.id, { status: 'agreed' });

    const success = db2.updateContract(contract.id, {
      status: 'implemented',
      updatedAt: new Date().toISOString(),
    }, staleContract.version);

    expect(success).toBe(false);

    const final = registry.get(contract.id)!;
    expect(final.version).toBe(2);
    expect(final.status).toBe('agreed');

    db2.close();
  });

  it('should allow sequential updates from same instance', () => {
    const contract = registry.create({
      name: 'GET /api/items',
      type: 'api',
      producer: 'backend',
      consumers: ['frontend'],
      schema: { type: 'object' },
      examples: [],
      project: 'default',
      metadata: {},
    });

    registry.update(contract.id, { status: 'proposed' });
    registry.update(contract.id, { status: 'agreed' });
    const final = registry.update(contract.id, { status: 'implemented' });

    expect(final.version).toBe(4);
    expect(final.status).toBe('implemented');
  });

  it('agree() should also use optimistic lock', async () => {
    const contract = registry.create({
      name: 'GET /api/orders',
      type: 'api',
      producer: 'backend',
      consumers: ['frontend'],
      schema: { type: 'object' },
      examples: [],
      project: 'default',
      metadata: {},
    });

    const db2 = await CoordinatorDB.create(TEST_DB, SCHEMA);
    const eventBus2 = new EventBus();
    eventBus2.setDB(db2);
    const registry2 = new ContractRegistry(eventBus2);
    registry2.setDB(db2);

    const staleContract = registry2.get(contract.id)!;
    expect(staleContract.version).toBe(1);

    registry.update(contract.id, { status: 'agreed' });

    const success = db2.updateContract(contract.id, {
      status: 'agreed',
      consumers: ['frontend'],
      updatedAt: new Date().toISOString(),
    }, staleContract.version);

    expect(success).toBe(false);

    db2.close();
  });
});
