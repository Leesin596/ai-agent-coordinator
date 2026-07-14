import { randomUUID } from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import type { EventBus } from '../core/event-bus';
import type { CoordinatorEvent } from '../models/types';
import type { CoordinatorDB } from '../db/database';

interface WSClient {
  ws: WebSocket;
  role?: string;
  instanceId?: string;
  project?: string;
  subscribedTypes: Set<string>;
}

export class WebSocketTransport {
  private wss: WebSocketServer | null = null;
  private clients: Map<WebSocket, WSClient> = new Map();

  constructor(
    private eventBus: EventBus,
    private db: CoordinatorDB
  ) {}

  attach(server: Server): void {
    this.wss = new WebSocketServer({ server, path: '/ws' });

    this.wss.on('connection', (ws) => {
      const client: WSClient = { ws, subscribedTypes: new Set(['*']) };
      this.clients.set(ws, client);
      console.log(`[WS] Client connected (${this.clients.size} total)`);

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          this.handleMessage(client, msg);
        } catch {
          ws.send(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });

      ws.on('close', () => {
        const c = this.clients.get(ws);
        if (c?.role && c?.instanceId) {
          const agent = this.db.getAgent(c.role, c.instanceId, c.project);
          if (agent) {
            this.db.upsertAgent({ ...agent, status: 'offline', lastSeen: new Date().toISOString() });
          }
          this.eventBus.emit('agent.disconnected', c.role, { role: c.role, instanceId: c.instanceId }, undefined, c.project);
        }
        this.clients.delete(ws);
        console.log(`[WS] Client disconnected (${this.clients.size} total)`);
      });

      ws.send(JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() }));
    });

    // Subscribe to all events and broadcast to connected clients
    this.eventBus.on('*', (event: CoordinatorEvent) => {
      this.broadcast(event);
    });

    console.log('[WS] WebSocket transport attached at /ws');
  }

  private handleMessage(client: WSClient, msg: any): void {
    switch (msg.action) {
      case 'register': {
        // Agent registers identity: { action: 'register', role: 'frontend', instanceId?: string, project?: string }
        client.role = msg.role;
        client.instanceId = msg.instanceId || randomUUID();
        client.project = msg.project || 'default';
        const agent = {
          project: client.project,
          role: client.role!,
          instanceId: client.instanceId!,
          status: 'online' as const,
          lastSeen: new Date().toISOString(),
          lastEventSeq: this.db.getMaxEventSeq(client.project),
          metadata: msg.metadata || {},
        };
        this.db.upsertAgent(agent);
        this.eventBus.emit('agent.connected', client.role!, { role: client.role, instanceId: client.instanceId }, undefined, client.project);
        client.ws.send(JSON.stringify({ type: 'registered', agent }));
        break;
      }

      case 'subscribe': {
        // Subscribe to specific event types: { action: 'subscribe', types: ['task.created', 'contract.*'] }
        if (Array.isArray(msg.types)) {
          for (const t of msg.types) {
            client.subscribedTypes.add(t);
          }
        }
        client.ws.send(JSON.stringify({ type: 'subscribed', types: Array.from(client.subscribedTypes) }));
        break;
      }

      case 'unsubscribe': {
        if (Array.isArray(msg.types)) {
          for (const t of msg.types) {
            client.subscribedTypes.delete(t);
          }
        }
        client.ws.send(JSON.stringify({ type: 'unsubscribed', types: Array.from(client.subscribedTypes) }));
        break;
      }

      case 'heartbeat': {
        if (client.role && client.instanceId) {
          const agent = this.db.getAgent(client.role, client.instanceId, client.project);
          if (agent) {
            this.db.upsertAgent({ ...agent, lastSeen: new Date().toISOString() });
          }
        }
        client.ws.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
        break;
      }

      case 'replay': {
        // Replay events since a sequence: { action: 'replay', since: 0, project?: string }
        const events = this.eventBus.getEventsSince(msg.since || 0, msg.project || client.project);
        client.ws.send(JSON.stringify({ type: 'replay', events, count: events.length }));
        break;
      }

      default:
        client.ws.send(JSON.stringify({ error: `Unknown action: ${msg.action}` }));
    }
  }

  private broadcast(event: CoordinatorEvent): void {
    const payload = JSON.stringify({ type: 'event', event });

    for (const [, client] of this.clients) {
      if (client.ws.readyState !== WebSocket.OPEN) continue;

      // Check if client is subscribed
      const subscribed =
        client.subscribedTypes.has('*') ||
        client.subscribedTypes.has(event.type) ||
        // Support wildcard patterns like 'task.*'
        Array.from(client.subscribedTypes).some((pattern) => {
          if (pattern.endsWith('.*')) {
            const prefix = pattern.slice(0, -2);
            return event.type.startsWith(prefix);
          }
          return false;
        });

      // Also send if event targets this client's role
      const targeted = event.target && client.role && event.target === client.role;

      if (subscribed || targeted) {
        client.ws.send(payload);
      }
    }
  }
}
