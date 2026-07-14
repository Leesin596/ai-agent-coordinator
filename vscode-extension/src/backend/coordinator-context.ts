// ============================================================
// CoordinatorContext — 插件后端实例容器
// 管理：全局库(workspaces 列表) + 激活工作区库(全部 manager)
// 工作区切换时：关闭旧 DB → 打开新 DB → 重建所有 manager → seed 内置角色
// ============================================================
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { CoordinatorDB } from '../../../src/db/database';
import { EventBus } from '../../../src/core/event-bus';
import { TaskManager } from '../../../src/core/task-manager';
import { ContractRegistry } from '../../../src/core/contract-registry';
import { MemoryStore } from '../../../src/core/memory-store';
import { ContextCompiler } from '../../../src/core/context-compiler';
import { WorkspaceManager } from '../../../src/core/workspace-manager';
import { RoleManager } from '../../../src/core/role-manager';
import { SessionTaskDispatcher } from '../../../src/core/session-task-dispatcher';
import { SessionManager } from '../../../src/core/session-manager';
import type { Workspace, Role } from '../../../src/models/types';
import { ModelStore } from '../services/model-store';
import * as vscode from 'vscode';

/**
 * 激活工作区的运行时实例集合。
 * 切换工作区时整体替换。
 */
export interface ActiveWorkspaceRuntime {
  workspace: Workspace;
  db: CoordinatorDB;
  eventBus: EventBus;
  taskManager: TaskManager;
  contractRegistry: ContractRegistry;
  memoryStore: MemoryStore;
  contextCompiler: ContextCompiler;
  roleManager: RoleManager;
  dispatcher: SessionTaskDispatcher;
  sessionManager: SessionManager;
}

export class CoordinatorContext implements vscode.Disposable {
  // 全局库（仅 workspaces 表）
  private globalDB!: CoordinatorDB;
  private workspaceManager!: WorkspaceManager;

  // 激活的工作区运行时
  private active: ActiveWorkspaceRuntime | null = null;

  // 状态栏项
  private statusItem: vscode.StatusBarItem;

  // schema 路径
  private schemaPath: string;

  // 工作区切换事件
  private readonly _onDidSwitchWorkspace = new vscode.EventEmitter<void>();
  readonly onDidSwitchWorkspace = this._onDidSwitchWorkspace.event;

  // 会话增删事件
  private readonly _onDidSessionsChange = new vscode.EventEmitter<void>();
  readonly onDidSessionsChange = this._onDidSessionsChange.event;

  // 控制台引用（可选，由 extension.ts 注入）
  private _consoleProvider: any = null;

  // 左侧「模型设置」视图引用（可选，由 extension.ts 注入）
  private _modelsProvider: any = null;

  // 模型预设库（跨工作区共享，存于 globalState）
  private modelStore: ModelStore;

  constructor(private extensionPath: string, context?: vscode.ExtensionContext) {
    this.statusItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      50
    );
    this.statusItem.command = 'coordinator.switchWorkspace';
    this.statusItem.tooltip = '点击切换 AI Agent Coordinator 工作区';

    // 模型库需要 globalState，context 可选以兼容旧调用
    this.modelStore = new ModelStore(context?.globalState ?? new InMemoryMemento());

    // schema.sql 解析顺序（多路径 fallback 兼容开发/打包）
    // esbuild 打包后 extension.js 在 out/，build.js 会把 schema.sql 拷到 out/schema.sql
    const candidates = [
      path.join(__dirname, 'schema.sql'),                         // 打包后: out/extension.js → out/schema.sql
      path.join(extensionPath, 'out', 'schema.sql'),               // 安装后: extensionPath/out/schema.sql
      path.join(extensionPath, 'schema.sql'),                      // 安装后顶层
      path.join(extensionPath, '..', 'src', 'db', 'schema.sql'),   // dev: extensionPath = .., 源码 schema
    ];
    this.schemaPath = candidates.find((p) => fs.existsSync(p)) || candidates[0];
  }

  // ============================================================
  // 生命周期
  // ============================================================

  async activate(): Promise<void> {
    // 首次迁移：把旧 VSCode configuration 的 LLM 配置导入模型库
    try {
      const migrated = await this.modelStore.migrateFromConfig();
      if (migrated) {
        vscode.window.showInformationMessage('🔄 已将旧 LLM 配置迁移到「模型设置」，可在左侧管理模型');
      }
    } catch (_e) { /* 迁移失败不阻塞启动 */ }

    // 全局库存于用户主目录
    const globalDir = path.join(os.homedir(), '.coordinator');
    if (!fs.existsSync(globalDir)) {
      fs.mkdirSync(globalDir, { recursive: true });
    }
    const globalDBPath = path.join(globalDir, 'global.db');
    this.globalDB = await CoordinatorDB.create(globalDBPath, this.schemaPath);
    this.workspaceManager = new WorkspaceManager();
    this.workspaceManager.setDB(this.globalDB);

    // 自动激活最近使用的工作区
    const workspaces = this.workspaceManager.list();
    if (workspaces.length > 0) {
      // 按 lastActiveAt 降序取第一个
      const sorted = [...workspaces].sort((a, b) => {
        const ta = a.lastActiveAt ? Date.parse(a.lastActiveAt) : 0;
        const tb = b.lastActiveAt ? Date.parse(b.lastActiveAt) : 0;
        return tb - ta;
      });
      await this.switchWorkspace(sorted[0].id);
    } else {
      this.updateStatusItem();
    }
  }

  dispose(): void {
    this.active?.db.close();
    this.globalDB?.close();
    this.statusItem.dispose();
    this._onDidSwitchWorkspace.dispose();
    this._onDidSessionsChange.dispose();
  }

  /** 触发会话变更事件（由 ConsoleViewProvider 调用） */
  fireSessionsChanged(): void {
    this._onDidSessionsChange.fire();
  }

  /** 注入底部控制台引用（由 extension.ts 调用） */
  setConsoleProvider(provider: any): void {
    this._consoleProvider = provider;
  }

  getConsoleProvider(): any {
    return this._consoleProvider;
  }

  /** 注入统一侧边栏引用（由 extension.ts 调用） */
  private _sidebarProvider: any = null;
  setSidebarProvider(provider: any): void {
    this._sidebarProvider = provider;
  }

  getSidebarProvider(): any {
    return this._sidebarProvider;
  }

  /** 注入左侧「模型设置」视图引用（由 extension.ts 调用） */
  setModelsProvider(provider: any): void {
    this._modelsProvider = provider;
  }

  getModelsProvider(): any {
    return this._modelsProvider;
  }

  /** 获取模型预设库（跨工作区共享） */
  getModelStore(): ModelStore {
    return this.modelStore;
  }

  // ============================================================
  // 工作区管理
  // ============================================================

  getWorkspaceManager(): WorkspaceManager {
    return this.workspaceManager;
  }

  listWorkspaces(): Workspace[] {
    return this.workspaceManager.list();
  }

  async addWorkspace(): Promise<Workspace | undefined> {
    const folderUri = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: '选择项目文件夹',
    });
    if (!folderUri || folderUri.length === 0) return undefined;

    const folderPath = folderUri[0].fsPath;
    const defaultName = path.basename(folderPath);
    const name = await vscode.window.showInputBox({
      prompt: '工作区名称',
      value: defaultName,
      validateInput: (v) => (v.trim() ? null : '名称不能为空'),
    });
    if (!name) return undefined;

    try {
      const ws = this.workspaceManager.add({ name, folderPath });
      vscode.window.showInformationMessage(`✅ 工作区「${name}」已添加`);
      // 自动切换到新工作区
      await this.switchWorkspace(ws.id);
      return ws;
    } catch (err: any) {
      vscode.window.showErrorMessage(`添加工作区失败: ${err.message}`);
      return undefined;
    }
  }

  async switchWorkspace(id: string): Promise<boolean> {
    const ws = this.workspaceManager.get(id);
    if (!ws) {
      vscode.window.showErrorMessage(`工作区不存在: ${id}`);
      return false;
    }

    // 关闭旧工作区
    if (this.active) {
      this.active.db.close();
      this.active = null;
    }

    try {
      // 打开新工作区 DB
      const db = await CoordinatorDB.create(ws.dbPath, this.schemaPath);

      // 重建所有 manager
      const eventBus = new EventBus();
      eventBus.setDB(db);

      const taskManager = new TaskManager(eventBus);
      taskManager.setDB(db);

      const contractRegistry = new ContractRegistry(eventBus);
      contractRegistry.setDB(db);

      const memoryStore = new MemoryStore();
      memoryStore.setDB(db);

      const contextCompiler = new ContextCompiler(taskManager, contractRegistry, memoryStore);

      const roleManager = new RoleManager();
      roleManager.setDB(db);
      roleManager.seedBuiltInRoles(); // 首次打开 seed 内置角色（幂等）

      const dispatcher = new SessionTaskDispatcher();
      dispatcher.setDB(db);
      dispatcher.setEventBus(eventBus);

      const sessionManager = new SessionManager();
      sessionManager.setDB(db);

      this.active = {
        workspace: ws,
        db,
        eventBus,
        taskManager,
        contractRegistry,
        memoryStore,
        contextCompiler,
        roleManager,
        dispatcher,
        sessionManager,
      };

      // 更新最后激活时间
      this.workspaceManager.touchActive(id);
      this.updateStatusItem();

      // 通知 UI 层（侧边栏树 + 底部控制台）刷新
      this._onDidSwitchWorkspace.fire();

      vscode.window.showInformationMessage(`🔄 已切换到工作区「${ws.name}」`);
      return true;
    } catch (err: any) {
      vscode.window.showErrorMessage(`切换工作区失败: ${err.message}`);
      return false;
    }
  }

  async removeWorkspace(id: string): Promise<boolean> {
    const ws = this.workspaceManager.get(id);
    if (!ws) return false;

    const choice = await vscode.window.showWarningMessage(
      `确定移除工作区「${ws.name}」？`,
      { modal: true },
      '仅移除记录',
      '移除记录并删除数据',
    );
    if (!choice) return false;

    const deleteFiles = choice === '移除记录并删除数据';

    // 如果移除的是当前激活工作区，先关闭
    if (this.active && this.active.workspace.id === id) {
      this.active.db.close();
      this.active = null;
    }

    const ok = this.workspaceManager.remove(id, deleteFiles);
    if (ok) {
      this.updateStatusItem();
      vscode.window.showInformationMessage(`已移除工作区「${ws.name}」`);
    }
    return ok;
  }

  async renameWorkspace(id: string): Promise<boolean> {
    const ws = this.workspaceManager.get(id);
    if (!ws) return false;
    const name = await vscode.window.showInputBox({
      prompt: '新名称',
      value: ws.name,
      validateInput: (v) => (v.trim() ? null : '名称不能为空'),
    });
    if (!name) return false;
    this.workspaceManager.rename(id, name);
    this.updateStatusItem();
    return true;
  }

  getActiveWorkspace(): Workspace | null {
    return this.active?.workspace ?? null;
  }

  /**
   * 获取激活工作区运行时。若无激活工作区，提示用户添加。
   */
  getActiveRuntime(): ActiveWorkspaceRuntime | null {
    if (!this.active) {
      return null;
    }
    return this.active;
  }

  /**
   * 确保有激活工作区，否则提示用户添加。返回 runtime 或 null。
   */
  async ensureActiveWorkspace(): Promise<ActiveWorkspaceRuntime | null> {
    if (this.active) return this.active;
    const choice = await vscode.window.showInformationMessage(
      '当前没有激活的工作区。请先添加一个工作区。',
      '添加工作区',
      '取消',
    );
    if (choice === '添加工作区') {
      await this.addWorkspace();
    }
    return this.active ?? null;
  }

  // ============================================================
  // 状态栏
  // ============================================================

  private updateStatusItem(): void {
    if (this.active) {
      this.statusItem.text = `$(hub) ${this.active.workspace.name}`;
      this.statusItem.show();
    } else {
      this.statusItem.text = '$(hub) 无工作区';
      this.statusItem.show();
    }
  }
}

/** 内存版 Memento，仅在未提供 ExtensionContext 时兜底（不应发生于正常激活路径） */
class InMemoryMemento implements vscode.Memento {
  private map = new Map<string, any>();
  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    return this.map.has(key) ? this.map.get(key) : defaultValue;
  }
  keys(): readonly string[] {
    return [...this.map.keys()];
  }
  async update(key: string, value: any): Promise<void> {
    this.map.set(key, value);
  }
}
