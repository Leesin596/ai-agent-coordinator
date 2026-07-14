import * as fs from 'fs';
import * as path from 'path';
import type { EventBus } from '../core/event-bus';
import type { TaskManager } from '../core/task-manager';
import type { ContractRegistry } from '../core/contract-registry';
import type { MemoryStore } from '../core/memory-store';
import type { ContextCompiler } from '../core/context-compiler';
import type { CoordinatorDB } from '../db/database';

export class FileSync {
  private syncDir: string;
  private contextDir: string;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private debounceMs = 500;

  constructor(
    private taskManager: TaskManager,
    private contractRegistry: ContractRegistry,
    private memoryStore: MemoryStore,
    private contextCompiler: ContextCompiler,
    private eventBus: EventBus,
    private db: CoordinatorDB,
    basePath: string
  ) {
    this.syncDir = path.resolve(basePath, '.coordinator');
    this.contextDir = path.join(this.syncDir, 'context');
    this.ensureDirs();
  }

  start(): void {
    // Subscribe to all events and trigger debounced sync
    this.eventBus.on('*', () => {
      this.scheduleSyncAll();
    });

    // Initial full sync
    this.syncAll();
    console.log(`[FileSync] Watching and syncing to ${this.syncDir}`);
  }

  syncAll(): void {
    this.syncTasks();
    this.syncContracts();
    this.syncMemories();
    this.syncAgents();
    this.syncContextSnapshots();
  }

  // --- Individual sync methods ---

  private syncTasks(): void {
    const tasks = this.taskManager.list();
    const graph = this.taskManager.getGraph();
    this.writeJSON('tasks.json', { tasks, graph: { edges: graph.edges }, updatedAt: new Date().toISOString() });
  }

  private syncContracts(): void {
    const contracts = this.contractRegistry.list();
    this.writeJSON('contracts.json', { contracts, updatedAt: new Date().toISOString() });
  }

  private syncMemories(): void {
    const memories = this.memoryStore.list();
    this.writeJSON('memories.json', { memories, updatedAt: new Date().toISOString() });
  }

  private syncAgents(): void {
    const agents = this.db.listAgents();
    this.writeJSON('agents.json', { agents, updatedAt: new Date().toISOString() });
  }

  private syncContextSnapshots(): void {
    // Get unique agent roles from tasks
    const tasks = this.taskManager.list();
    const roles = [...new Set(tasks.map((t) => t.assignee))];

    for (const role of roles) {
      try {
        const ctx = this.contextCompiler.compile({
          agentRole: role,
          tokenBudget: 8000,
          format: 'markdown',
        });

        const md = this.contextToMarkdown(ctx);
        this.writeFile(path.join('context', `${role}.md`), md);
      } catch (err) {
        console.error(`[FileSync] Failed to compile context for role "${role}":`, err);
      }
    }
  }

  // --- Helpers ---

  private contextToMarkdown(ctx: any): string {
    const lines: string[] = [
      `# Context for: ${ctx.agentRole}`,
      `> Generated: ${ctx.generatedAt} | Token estimate: ${ctx.tokenEstimate}`,
      '',
    ];

    const sections = ctx.sections;
    if (sections.currentTask) lines.push(sections.currentTask, '');
    if (sections.dependencies) lines.push(sections.dependencies, '');
    if (sections.contracts) lines.push(sections.contracts, '');
    if (sections.decisions) lines.push(sections.decisions, '');
    if (sections.conventions) lines.push(sections.conventions, '');
    if (sections.warnings) lines.push(sections.warnings, '');

    return lines.join('\n');
  }

  private scheduleSyncAll(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.syncAll();
    }, this.debounceMs);
  }

  private ensureDirs(): void {
    for (const dir of [this.syncDir, this.contextDir]) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
  }

  private writeJSON(relativePath: string, data: any): void {
    const filePath = path.join(this.syncDir, relativePath);
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmp, filePath);
  }

  private writeFile(relativePath: string, content: string): void {
    const filePath = path.join(this.syncDir, relativePath);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, content, 'utf-8');
    fs.renameSync(tmp, filePath);
  }
}
