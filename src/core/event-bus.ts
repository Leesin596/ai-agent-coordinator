import { randomUUID } from 'crypto';
import type { CoordinatorEvent, EventType } from '../models/types';
import type { CoordinatorDB } from '../db/database';

type EventHandler = (event: CoordinatorEvent) => void;

export class EventBus {
  private handlers: Map<string, Set<EventHandler>> = new Map();
  private db: CoordinatorDB | null = null;

  setDB(db: CoordinatorDB): void {
    this.db = db;
  }

  emit(type: EventType, source: string, payload: any, target?: string, project?: string): CoordinatorEvent {
    const event: any = {
      id: randomUUID(),
      project: project || 'default',
      type,
      source,
      target,
      payload,
      timestamp: new Date().toISOString(),
    };

    if (this.db) {
      this.db.insertEvent(event);
    }

    // Broadcast to wildcard listeners
    this.notifyHandlers('*', event);
    // Broadcast to type-specific listeners
    this.notifyHandlers(type, event);
    // If targeted, also notify role-specific listeners
    if (target) {
      this.notifyHandlers(`role:${target}`, event);
    }

    return event;
  }

  on(typeOrPattern: string, handler: EventHandler): () => void {
    if (!this.handlers.has(typeOrPattern)) {
      this.handlers.set(typeOrPattern, new Set());
    }
    this.handlers.get(typeOrPattern)!.add(handler);

    // Return unsubscribe function
    return () => {
      this.handlers.get(typeOrPattern)?.delete(handler);
    };
  }

  getEventsSince(sinceSeq: number, project?: string): CoordinatorEvent[] {
    if (this.db) {
      return this.db.getEventsSince(sinceSeq, 200, project || 'default') as CoordinatorEvent[];
    }
    return [];
  }

  getEventCount(project?: string): number {
    if (this.db) {
      return this.db.getEventCount(project || 'default');
    }
    return 0;
  }

  private notifyHandlers(key: string, event: CoordinatorEvent): void {
    const handlers = this.handlers.get(key);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(event);
        } catch (err) {
          console.error(`[EventBus] Handler error for ${key}:`, err);
        }
      }
    }
  }
}
