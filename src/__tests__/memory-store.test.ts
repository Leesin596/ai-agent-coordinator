import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CoordinatorDB } from '../db/database';
import { MemoryStore } from '../core/memory-store';
import * as fs from 'fs';
import * as path from 'path';

const TEST_DIR = path.join(__dirname, '../../.coordinator');
const TEST_DB = path.join(TEST_DIR, 'test-memory-store.db');
const SCHEMA = path.join(__dirname, '../db/schema.sql');

describe('MemoryStore', () => {
  let db: CoordinatorDB;
  let memoryStore: MemoryStore;

  beforeEach(async () => {
    try { fs.unlinkSync(TEST_DB); } catch {}
    try { fs.unlinkSync(TEST_DB + '.lock'); } catch {}
    fs.mkdirSync(TEST_DIR, { recursive: true });
    db = await CoordinatorDB.create(TEST_DB, SCHEMA);
    memoryStore = new MemoryStore();
    memoryStore.setDB(db);
  });

  afterEach(() => {
    db.close();
    try { fs.unlinkSync(TEST_DB); } catch {}
    try { fs.unlinkSync(TEST_DB + '.lock'); } catch {}
  });

  it('should create a memory', () => {
    const mem = memoryStore.create({
      category: 'decision',
      title: 'Use PostgreSQL',
      content: 'We decided to use PostgreSQL for the main database',
      tags: ['database', 'infrastructure'],
      scope: 'global',
      createdBy: 'architect',
      project: 'default',
    });

    expect(mem.id).toBeDefined();
    expect(mem.category).toBe('decision');
    expect(mem.title).toBe('Use PostgreSQL');
    expect(mem.tags).toEqual(['database', 'infrastructure']);
  });

  it('should get a memory by ID', () => {
    const created = memoryStore.create({
      category: 'convention',
      title: 'Naming convention',
      content: 'Use camelCase for variables',
      createdBy: 'frontend',
      project: 'default',
    });

    const mem = memoryStore.get(created.id);
    expect(mem).toBeDefined();
    expect(mem!.title).toBe('Naming convention');
  });

  it('should list memories with filters', () => {
    memoryStore.create({ category: 'decision', title: 'D1', content: 'c', createdBy: 'a', project: 'proj-a' });
    memoryStore.create({ category: 'convention', title: 'C1', content: 'c', createdBy: 'b', project: 'proj-a' });
    memoryStore.create({ category: 'decision', title: 'D2', content: 'c', createdBy: 'a', project: 'proj-b' });

    const decisions = memoryStore.list({ category: 'decision', project: 'proj-a' });
    expect(decisions.length).toBe(1);
    expect(decisions[0].title).toBe('D1');

    const allProjA = memoryStore.list({ project: 'proj-a' });
    expect(allProjA.length).toBe(2);
  });

  it('should search memories', () => {
    memoryStore.create({ category: 'lesson', title: 'API versioning', content: 'Always version your REST APIs', createdBy: 'backend', project: 'default' });
    memoryStore.create({ category: 'note', title: 'Deployment', content: 'Deploy using Docker containers', createdBy: 'devops', project: 'default' });

    const results = memoryStore.search('API', 'default');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some(m => m.title === 'API versioning')).toBe(true);
  });

  it('should update a memory', () => {
    const mem = memoryStore.create({
      category: 'note',
      title: 'Original title',
      content: 'Original content',
      createdBy: 'a',
      project: 'default',
    });

    const updated = memoryStore.update(mem.id, { title: 'Updated title', content: 'Updated content' });
    expect(updated).toBeDefined();
    expect(updated.title).toBe('Updated title');

    const got = memoryStore.get(mem.id);
    expect(got!.title).toBe('Updated title');
    expect(got!.content).toBe('Updated content');
  });

  it('should delete a memory', () => {
    const mem = memoryStore.create({
      category: 'note',
      title: 'To delete',
      content: 'c',
      createdBy: 'a',
      project: 'default',
    });

    const deleted = memoryStore.delete(mem.id);
    expect(deleted).toBe(true);
    expect(memoryStore.get(mem.id)).toBeUndefined();
  });

  it('should isolate memories by project namespace', () => {
    memoryStore.create({ category: 'note', title: 'A', content: 'c', createdBy: 'a', project: 'proj-a' });
    memoryStore.create({ category: 'note', title: 'B', content: 'c', createdBy: 'b', project: 'proj-b' });

    const projA = memoryStore.list({ project: 'proj-a' });
    const projB = memoryStore.list({ project: 'proj-b' });

    expect(projA.length).toBe(1);
    expect(projA[0].title).toBe('A');
    expect(projB.length).toBe(1);
    expect(projB[0].title).toBe('B');
  });
});
