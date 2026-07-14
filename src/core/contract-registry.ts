import { randomUUID } from 'crypto';
import type { Contract, CreateContractInput, ContractStatus, BreakingChange } from '../models/types';
import type { EventBus } from './event-bus';
import type { CoordinatorDB } from '../db/database';

export class ContractRegistry {
  private db: CoordinatorDB | null = null;

  constructor(private eventBus: EventBus) {}

  setDB(db: CoordinatorDB): void {
    this.db = db;
  }

  create(input: CreateContractInput & { project?: string }): Contract {
    const now = new Date().toISOString();
    const contract: any = {
      id: randomUUID(),
      project: input.project || 'default',
      name: input.name,
      type: input.type,
      version: 1,
      status: input.status || 'draft',
      producer: input.producer,
      consumers: input.consumers || [],
      schema: input.schema,
      examples: input.examples || [],
      breakingChanges: [],
      createdAt: now,
      updatedAt: now,
      metadata: input.metadata || {},
    };

    if (this.db) {
      this.db.insertContract(contract);
      this.db.insertContractHistory(contract.id, contract.version, contract);
    }

    this.eventBus.emit('contract.created', contract.producer, {
      contractId: contract.id,
      name: contract.name,
      type: contract.type,
      producer: contract.producer,
      consumers: contract.consumers,
    }, undefined, contract.project);

    // Notify consumers
    for (const consumer of contract.consumers) {
      this.eventBus.emit('contract.created', contract.producer, {
        contractId: contract.id,
        name: contract.name,
        schema: contract.schema,
      }, consumer, contract.project);
    }

    return contract;
  }

  get(id: string): Contract | undefined {
    if (this.db) {
      return this.db.getContract(id) as Contract | undefined;
    }
    return undefined;
  }

  list(filter?: { producer?: string; consumer?: string; type?: string; status?: ContractStatus; project?: string }): Contract[] {
    if (this.db) {
      return this.db.listContracts(filter) as Contract[];
    }
    return [];
  }

  update(id: string, updates: Partial<Pick<Contract, 'schema' | 'status' | 'examples' | 'metadata'>>): Contract {
    const contract = this.get(id);
    if (!contract) throw new Error(`Contract not found: ${id}`);

    const oldSchema = JSON.stringify(contract.schema);

    const dbUpdates: Record<string, any> = { updatedAt: new Date().toISOString() };
    if (updates.schema) dbUpdates.schema = updates.schema;
    if (updates.status) dbUpdates.status = updates.status;
    if (updates.examples) dbUpdates.examples = updates.examples;
    if (updates.metadata) dbUpdates.metadata = { ...contract.metadata, ...updates.metadata };

    const newSchema = JSON.stringify(dbUpdates.schema || contract.schema);
    const schemaChanged = oldSchema !== newSchema;

    // Detect breaking changes before persisting
    let detectedBreakingChanges: string[] = [];
    if (schemaChanged) {
      detectedBreakingChanges = this.detectBreakingChanges(JSON.parse(oldSchema), dbUpdates.schema || contract.schema);
      if (detectedBreakingChanges.length > 0) {
        const bc: BreakingChange = {
          version: contract.version + 1,
          description: detectedBreakingChanges.join('; '),
          affectedConsumers: [...contract.consumers],
          migrateGuide: '',
          timestamp: dbUpdates.updatedAt,
        };
        dbUpdates.breakingChanges = [...contract.breakingChanges, bc];
      }
    }

    if (this.db) {
      const success = this.db.updateContract(id, dbUpdates, contract.version);
      if (!success) {
        throw new Error(`Contract update conflict: version ${contract.version} is outdated (concurrent modification detected)`);
      }
    }

    // Reload after update
    const updated = this.get(id)!;

    // Save history
    if (this.db) {
      this.db.insertContractHistory(id, updated.version, updated);
    }

    // Emit events
    if (detectedBreakingChanges.length > 0) {
      this.eventBus.emit('contract.breaking_change', contract.producer, {
        contractId: id,
        name: contract.name,
        version: updated.version,
        changes: detectedBreakingChanges,
        affectedConsumers: contract.consumers,
      }, undefined, contract.project);

      for (const consumer of contract.consumers) {
        this.eventBus.emit('contract.breaking_change', contract.producer, {
          contractId: id,
          name: contract.name,
          changes: detectedBreakingChanges,
          newSchema: updated.schema,
        }, consumer, contract.project);
      }
    }

    this.eventBus.emit('contract.updated', contract.producer, {
      contractId: id,
      name: contract.name,
      version: updated.version,
      schemaChanged,
    }, undefined, contract.project);

    return updated;
  }

  agree(id: string, consumer: string): Contract {
    const contract = this.get(id);
    if (!contract) throw new Error(`Contract not found: ${id}`);

    const consumers = contract.consumers.includes(consumer)
      ? contract.consumers
      : [...contract.consumers, consumer];

    if (this.db) {
      const success = this.db.updateContract(id, {
        status: 'agreed',
        consumers,
        updatedAt: new Date().toISOString(),
      }, contract.version);
      if (!success) {
        throw new Error(`Contract agree conflict: version ${contract.version} is outdated (concurrent modification detected)`);
      }
    }

    this.eventBus.emit('contract.agreed', consumer, {
      contractId: id,
      name: contract.name,
      agreedBy: consumer,
    }, undefined, contract.project);

    return this.get(id)!;
  }

  getHistory(id: string): Contract[] {
    if (this.db) {
      return this.db.getContractHistory(id) as Contract[];
    }
    return [];
  }

  /**
   * Simple breaking change detection:
   * - Field removed from top-level
   * - Field type changed
   */
  private detectBreakingChanges(oldSchema: Record<string, any>, newSchema: Record<string, any>): string[] {
    const changes: string[] = [];

    const oldProps = oldSchema.properties || oldSchema;
    const newProps = newSchema.properties || newSchema;

    // Check for removed fields
    for (const key of Object.keys(oldProps)) {
      if (!(key in newProps)) {
        changes.push(`Field "${key}" was removed`);
      } else if (typeof oldProps[key] === 'object' && typeof newProps[key] === 'object') {
        if (oldProps[key].type && newProps[key].type && oldProps[key].type !== newProps[key].type) {
          changes.push(`Field "${key}" type changed from "${oldProps[key].type}" to "${newProps[key].type}"`);
        }
      }
    }

    // Check for required fields added
    const oldRequired = new Set(oldSchema.required || []);
    const newRequired = new Set<string>(newSchema.required || []);
    for (const req of newRequired) {
      if (!oldRequired.has(req) && !(req in oldProps)) {
        changes.push(`New required field "${req}" added`);
      }
    }

    return changes;
  }
}
