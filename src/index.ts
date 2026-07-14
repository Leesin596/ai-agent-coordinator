import * as path from 'path';
import * as http from 'http';
import express from 'express';
import { CoordinatorDB } from './db/database';
import { EventBus } from './core/event-bus';
import { TaskManager } from './core/task-manager';
import { ContractRegistry } from './core/contract-registry';
import { MemoryStore } from './core/memory-store';
import { ContextCompiler } from './core/context-compiler';
import { createRestApi } from './transport/rest-api';
import { FileSync } from './transport/file-sync';
import { WebSocketTransport } from './transport/websocket';
import { resolveDBPath } from './db/db-path';
import packageJson from '../package.json';

const PORT = parseInt(process.env.COORDINATOR_PORT || '9700', 10);
const HOST = process.env.COORDINATOR_HOST || '127.0.0.1';
const DB_PATH = resolveDBPath();

// 模块级实例（bootstrap 异步初始化）
let db!: CoordinatorDB;
let eventBus!: EventBus;
let taskManager!: TaskManager;
let contractRegistry!: ContractRegistry;
let memoryStore!: MemoryStore;
let contextCompiler!: ContextCompiler;
let fileSync!: FileSync;
let wsTransport!: WebSocketTransport;
const app = express();

async function bootstrap(): Promise<void> {
  // --- Bootstrap database (sql.js 异步初始化) ---
  db = await CoordinatorDB.create(DB_PATH);
  console.log(`[DB] SQLite (sql.js) initialized at ${DB_PATH}`);

  // --- Bootstrap core modules ---
  eventBus = new EventBus();
  eventBus.setDB(db);

  taskManager = new TaskManager(eventBus);
  taskManager.setDB(db);

  contractRegistry = new ContractRegistry(eventBus);
  contractRegistry.setDB(db);

  memoryStore = new MemoryStore();
  memoryStore.setDB(db);

  contextCompiler = new ContextCompiler(taskManager, contractRegistry, memoryStore);

  // --- REST API server ---
  app.use('/api', createRestApi(taskManager, contractRegistry, memoryStore, contextCompiler, eventBus, db));

  // --- Dashboard (static files) ---
  app.use(express.static(path.join(__dirname, 'public')));

  // --- File sync layer ---
  fileSync = new FileSync(taskManager, contractRegistry, memoryStore, contextCompiler, eventBus, db, process.cwd());

  // --- HTTP server (shared by Express + WebSocket) ---
  const server = http.createServer(app);

  // --- WebSocket transport ---
  wsTransport = new WebSocketTransport(eventBus, db);
  wsTransport.attach(server);

  // Info endpoint
  app.get('/api/info', (_req, res) => {
    res.json({
      name: 'AI Agent Coordinator',
      version: packageJson.version,
      storage: 'SQLite (sql.js / WASM)',
      dbPath: DB_PATH,
      dashboard: `http://${HOST}:${PORT}`,
      endpoints: {
        tasks: '/api/tasks',
        contracts: '/api/contracts',
        memories: '/api/memories',
        context: '/api/context/compile',
        events: '/api/events',
        health: '/api/health',
      },
    });
  });

  // Graceful shutdown
  function shutdown() {
    console.log('\n[Shutdown] Closing database...');
    db.close();
    process.exit(0);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  server.listen(PORT, HOST, () => {
    console.log(`\n🤖 AI Agent Coordinator v${packageJson.version} running at http://${HOST}:${PORT}`);
    console.log(`   Dashboard:   http://${HOST}:${PORT}`);
    console.log(`   REST API:    http://${HOST}:${PORT}/api`);
    console.log(`   WebSocket:   ws://${HOST}:${PORT}/ws`);
    console.log(`   Database:    ${DB_PATH} (sql.js)`);
    console.log(`   FileSync:    ${process.cwd()}/.coordinator/`);
    console.log(`   Health:      http://${HOST}:${PORT}/api/health\n`);
    fileSync.start();
  });
}

bootstrap().catch((err) => {
  console.error('[Fatal] Failed to start coordinator:', err);
  process.exit(1);
});

export { app, db, taskManager, contractRegistry, memoryStore, contextCompiler, eventBus, fileSync, wsTransport };
