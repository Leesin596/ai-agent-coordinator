import { randomUUID } from 'crypto';
import type { Memory, CreateMemoryInput, MemoryCategory } from '../models/types';
import type { CoordinatorDB } from '../db/database';

export class MemoryStore {
  private db: CoordinatorDB | null = null;

  setDB(db: CoordinatorDB): void {
    this.db = db;
  }

  create(input: CreateMemoryInput & { project?: string }): Memory {
    const now = new Date().toISOString();
    const memory: any = {
      id: randomUUID(),
      project: input.project || 'default',
      category: input.category,
      title: input.title,
      content: input.content,
      tags: input.tags || [],
      scope: input.scope || 'global',
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
      references: input.references || [],
    };

    if (this.db) {
      this.db.insertMemory(memory);
    }
    return memory;
  }

  get(id: string): Memory | undefined {
    if (this.db) {
      return this.db.getMemory(id) as Memory | undefined;
    }
    return undefined;
  }

  list(filter?: { category?: MemoryCategory; scope?: string; tag?: string; createdBy?: string; project?: string }): Memory[] {
    if (this.db) {
      return this.db.listMemories(filter) as Memory[];
    }
    return [];
  }

  search(query: string, project?: string): Memory[] {
    if (this.db) {
      return this.db.searchMemories(query, project || 'default') as Memory[];
    }
    return [];
  }

  update(id: string, updates: Partial<Pick<Memory, 'title' | 'content' | 'tags' | 'scope' | 'references'>>): Memory {
    const memory = this.get(id);
    if (!memory) throw new Error(`Memory not found: ${id}`);

    const dbUpdates: Record<string, any> = { updatedAt: new Date().toISOString() };
    if (updates.title !== undefined) dbUpdates.title = updates.title;
    if (updates.content !== undefined) dbUpdates.content = updates.content;
    if (updates.tags !== undefined) dbUpdates.tags = updates.tags;
    if (updates.scope !== undefined) dbUpdates.scope = updates.scope;
    if (updates.references !== undefined) dbUpdates.references = updates.references;

    if (this.db) {
      this.db.updateMemory(id, dbUpdates);
    }

    return this.get(id)!;
  }

  delete(id: string): boolean {
    if (this.db) {
      return this.db.deleteMemory(id);
    }
    return false;
  }
}
