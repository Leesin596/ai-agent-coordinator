// ============================================================
// ConsoleViewProvider — 底部面板 Webview 控制台
// 在 VSCode 底部面板（与 TERMINAL/OUTPUT 并排）显示插件 Tab
// 内含：多会话胶囊标签 + 消息流（流式 LLM）+ 输入区 + 工具栏
// ============================================================
import * as vscode from 'vscode';
import * as path from 'path';
import type { CoordinatorContext, ActiveWorkspaceRuntime } from '../backend/coordinator-context';
import type { Role, Session } from '../../../src/models/types';
import { LLMService, estimateMessageTokens, type LLMConfig, type LLMMessage, type LLMToolCall } from '../services/llm-service';
import { COORDINATOR_LLM_TOOLS } from '../services/llm-api';
import { filterToolsByRole, isToolAllowedByRole } from '../services/tool-filter';
import { parseSlashCommand } from '../services/slash-commands';
import type { MCPClientManager } from '../services/mcp-client';
import { buildWorkspaceContext } from '../services/workspace-context';
import { WorkspaceToolExecutor } from '../services/workspace-tools';
import { CheckpointManager } from '../services/checkpoint-manager';
import { TodoListManager } from '../services/todo-list-manager';
import { EmbeddingService } from '../services/embedding-service';
import { IndexingService } from '../services/indexing-service';
import { shouldAutoApprove } from '../services/approval-helper';
import { TerminalService } from '../services/terminal-service';
import {
  buildSessionContextPackage,
  listContextSessionOptions,
  type ContextTransferMode,
} from '../services/context-transfer';
import { OrchestratorService } from '../../../src/core/orchestrator-service';
import type { LLMCallFunction } from '../../../src/models/types';

interface SessionTab {
  session: Session;
  role: Role;
  streaming: boolean;
  abortFn: (() => void) | null;
  toolExecutor: WorkspaceToolExecutor;
}

/**
 * 底部面板控制台 Provider
 * 一个 Webview View 实例，管理多个会话标签
 */
export class ConsoleViewProvider implements vscode.WebviewViewProvider {
  public static readonly VIEW_ID = 'coordinatorConsole';

  private view: vscode.WebviewView | undefined;
  private ctx: CoordinatorContext;
  private llm = new LLMService();
  private tabs = new Map<string, SessionTab>();
  private currentSessionId: string | null = null;
  private orchestrationAborted = false;
  private lastUsedRoleId: string | null = null;
  private pendingRoleEditorId: string | null | undefined;
  private pendingNewRoleEditor = false;
  private pendingDraftContexts: string[] = [];
  private webviewReady = false;
  private mcpManager: MCPClientManager | null = null;
  private terminalService = new TerminalService();
  private todoListManager = new TodoListManager();
  private embeddingService: EmbeddingService | null = null;
  private indexingService: IndexingService | null = null;
  private fileWatcherDisposable: vscode.Disposable | null = null;
  private orchestrator = new OrchestratorService();
  private pendingApprovals = new Map<string, { resolve: (v: boolean) => void; timeout: NodeJS.Timeout }>();

  private static readonly ROLE_CAT_LABELS: Record<string, string> = {
    engineering: '工程研发', product: '产品', design: '设计', qa: '质量保障', custom: '自定义',
  };

  constructor(ctx: CoordinatorContext) {
    this.ctx = ctx;
    this.todoListManager.setChangeHandler((snapshot) => {
      this.postToWebview({ type: 'todoUpdated', sessionId: snapshot.sessionId, items: snapshot.items });
    });
    this.embeddingService = new EmbeddingService(ctx.getModelStore());
  }

  /** 设置 MCP 客户端管理器，将其工具注入 LLM 调用 */
  setMCPManager(manager: MCPClientManager): void {
    this.mcpManager = manager;
  }

  /** 获取索引服务实例（供命令调用） */
  getIndexingService(): IndexingService | null {
    return this.indexingService;
  }

  /** 初始化语义索引服务（工作区切换时调用） */
  private async initIndexingService(folderPath: string): Promise<void> {
    // 清理旧实例
    this.indexingService?.dispose();
    this.indexingService = null;

    const config = vscode.workspace.getConfiguration('coordinator.indexing');
    const enabled = config.get<boolean>('enabled', true);
    if (!enabled || !this.embeddingService) return;

    // 刷新 embedding 配置（用户可能切换了模型预设）
    this.embeddingService.refreshConfig();
    if (!this.embeddingService.isConfigured()) return;

    const schemaPath = path.join(this.ctx.getExtensionPath(), 'index-schema.sql');
    this.indexingService = new IndexingService(folderPath, this.embeddingService, schemaPath);
    await this.indexingService.ensureInitialized();

    // 注册文件保存监听（增量索引）
    this.fileWatcherDisposable?.dispose();
    this.fileWatcherDisposable = vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.uri.scheme !== 'file' || !this.indexingService) return;
      const wsFolder = vscode.workspace.getWorkspaceFolder(doc.uri);
      if (!wsFolder || wsFolder.uri.fsPath !== folderPath) return;
      const relativePath = vscode.workspace.asRelativePath(doc.uri, false).replace(/\\/g, '/');
      this.indexingService.indexFile(relativePath).catch((err) => {
        console.error('[Coordinator] 增量索引失败:', err);
      });
    });
  }

  /** 外部命令调用：聚焦面板并打开/切换到某会话 */
  async openSessionInPanel(sessionId: string, focus = true): Promise<void> {
    this.ensureViewVisible();
    this.currentSessionId = sessionId;
    if (focus) this.ensureViewVisible();
    await this.pushFullState();
  }

  /** 外部命令调用：为角色创建新会话并聚焦 */
  async startSessionForRole(role: Role, forceNew = false): Promise<void> {
    const runtime = this.ctx.getActiveRuntime();
    if (!runtime) {
      vscode.window.showWarningMessage('请先切换到工作区');
      return;
    }
    // forceNew=false 时已存在该角色的会话则复用；forceNew=true 时始终创建新会话
    let session: Session;
    if (!forceNew) {
      const existing = runtime.sessionManager.list(runtime.workspace.id)
        .find((s) => s.roleId === role.id);
      if (existing) {
        session = existing;
      } else {
        session = runtime.sessionManager.create(runtime.workspace.id, role);
      }
    } else {
      session = runtime.sessionManager.create(runtime.workspace.id, role);
    }
    this.ensureViewVisible();
    this.currentSessionId = session.id;
    this.lastUsedRoleId = role.id;
    await this.pushFullState();
    this.notifySessionsChanged();
  }

  /** 当工作区切换、配置变化时刷新整个面板 */
  async refresh(): Promise<void> {
    // 工作区切换后旧会话标签失效，清空
    for (const tab of this.tabs.values()) {
      tab.abortFn?.();
      tab.toolExecutor.cancel();
    }
    this.tabs.clear();
    this.currentSessionId = null;
    // 重新初始化索引服务
    const runtime = this.ctx.getActiveRuntime();
    if (runtime) {
      this.initIndexingService(runtime.workspace.folderPath).catch((err) => {
        console.error('[Coordinator] 索引服务初始化失败:', err);
      });
    }
    await this.pushFullState();
    this.notifySessionsChanged();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.webviewReady = false;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [],
    };
    view.webview.html = this.getHtml();

    view.webview.onDidReceiveMessage((msg) => this.handleMessage(msg));

    // 首次可见时推送数据
    this.pushFullState();
  }

  private ensureViewVisible(): void {
    if (this.view) {
      this.view.show(true);
    } else {
      // 视图尚未创建，聚焦命令会让 VSCode 实例化它
      vscode.commands.executeCommand(`${ConsoleViewProvider.VIEW_ID}.focus`);
    }
  }

  async appendContextToInput(content: string): Promise<void> {
    if (!content.trim()) return;
    const runtime = this.ctx.getActiveRuntime();
    if (!runtime || runtime.sessionManager.list(runtime.workspace.id).length === 0) {
      vscode.window.showWarningMessage('请先创建或打开一个 Coordinator 会话');
      return;
    }
    if (!this.view || !this.webviewReady) {
      this.pendingDraftContexts.push(content);
      await vscode.commands.executeCommand(`${ConsoleViewProvider.VIEW_ID}.focus`);
      return;
    }
    this.view.show(true);
    this.postToWebview({ type: 'appendDraftContext', content });
  }

  async showRoleEditor(roleId?: string, createNew = false): Promise<void> {
    if (!this.view || !this.webviewReady) {
      this.pendingRoleEditorId = roleId ?? null;
      this.pendingNewRoleEditor = createNew;
      await vscode.commands.executeCommand(`${ConsoleViewProvider.VIEW_ID}.focus`);
      return;
    }
    this.view.show(true);
    this.pushRolesList();
    this.postToWebview({ type: 'showRoleEditor', roleId, createNew });
  }

  // ============================================================
  // 消息处理
  // ============================================================

  private async handleMessage(msg: any): Promise<void> {
    try {
      switch (msg.type) {
        case 'ready':
          this.webviewReady = true;
          await this.pushFullState();
          this.pushRolesList();
          if (this.pendingRoleEditorId !== undefined) {
            const roleId = this.pendingRoleEditorId;
            const createNew = this.pendingNewRoleEditor;
            this.pendingRoleEditorId = undefined;
            this.pendingNewRoleEditor = false;
            this.pushRolesList();
            this.postToWebview({ type: 'showRoleEditor', roleId: roleId || undefined, createNew });
          }
          for (const content of this.pendingDraftContexts.splice(0)) {
            this.postToWebview({ type: 'appendDraftContext', content });
          }
          break;
        case 'newSession': {
          await this.handleNewSession();
          break;
        }
        case 'pickEditorContext': {
          await vscode.commands.executeCommand('coordinator.pickContext');
          break;
        }
        case 'createSession': {
          await this.handleCreateSession(msg.roleId);
          break;
        }
        case 'getRoles': {
          this.pushRolesList();
          this.postToWebview({ type: 'showRoleEditor' });
          break;
        }
        case 'createRole': {
          await this.handleCreateRole(msg.role);
          break;
        }
        case 'updateRole': {
          await this.handleUpdateRole(msg.id, msg.patch);
          break;
        }
        case 'deleteRole': {
          await this.handleDeleteRole(msg.id);
          break;
        }
        case 'switchTab':
          this.currentSessionId = msg.sessionId;
          // 重新渲染标签栏以更新 active 态，再推送当前会话消息
          await this.pushFullState();
          break;
        case 'closeTab': {
          await this.handleCloseTab(msg.sessionId);
          break;
        }
        case 'sendMessage':
          await this.handleSendMessage(msg.sessionId, msg.content);
          break;
        case 'abortStream':
          this.handleAbort(msg.sessionId);
          break;
        case 'clearHistory':
          this.handleClearHistory(msg.sessionId);
          break;
        case 'injectContext':
          await this.handleInjectContext(msg.sessionId);
          break;
        case 'switchModel':
          await this.handleSwitchModel(msg.sessionId, msg.modelId);
          break;
        case 'focusModelsView':
          // 点击模型名标签 → 聚焦左侧「模型设置」view
          vscode.commands.executeCommand('coordinator.sidebar.focus');
          break;
        case 'openToolPermissions': {
          const tab = this.tabs.get(msg.sessionId || this.currentSessionId || '');
          if (tab) {
            this.postToWebview({
              type: 'toolPermissionsData',
              sessionId: tab.session.id,
              roleId: tab.role.id,
              roleName: tab.role.name,
              allowedTools: tab.role.allowedTools || [],
              deniedTools: tab.role.deniedTools || [],
            });
          }
          break;
        }
        case 'updateToolPermissions': {
          await this.handleUpdateToolPermissions(msg.sessionId, msg.allowedTools || [], msg.deniedTools || []);
          break;
        }
        case 'toolApprovalResponse': {
          this.handleToolApprovalResponse(msg.approvalId, msg.approved, msg.remember, msg.toolName);
          break;
        }
      }
    } catch (err: any) {
      this.postToWebview({ type: 'error', message: err.message });
      vscode.window.showErrorMessage(`Coordinator: ${err.message}`);
    }
  }

  /** 点击 + 按钮：直接用最近使用的角色创建会话；若无则推送角色列表让用户选 */
  private async handleNewSession(): Promise<void> {
    const runtime = this.ctx.getActiveRuntime();
    if (!runtime) {
      vscode.window.showWarningMessage('请先切换到工作区');
      return;
    }
    const roles = runtime.roleManager.list();
    if (roles.length === 0) {
      // 无角色，直接打开角色编辑器让用户新增
      this.pushRolesList();
      this.postToWebview({ type: 'showRoleEditor' });
      return;
    }
    // 有最近使用的角色 → 直接创建新会话
    if (this.lastUsedRoleId) {
      const role = runtime.roleManager.get(this.lastUsedRoleId);
      if (role) {
        await this.startSessionForRole(role, true);
        return;
      }
    }
    // 无最近使用 → 取第一个角色，创建新会话
    await this.startSessionForRole(roles[0], true);
  }

  /** webview 选择角色后创建会话 */
  private async handleCreateSession(roleId: string): Promise<void> {
    const runtime = this.ctx.getActiveRuntime();
    if (!runtime) return;
    const role = runtime.roleManager.get(roleId);
    if (!role) return;
    await this.startSessionForRole(role, true);
  }

  /** 推送角色列表到 webview（供下拉和编辑器使用） */
  private pushRolesList(): void {
    const runtime = this.ctx.getActiveRuntime();
    if (!runtime) return;
    const roles = runtime.roleManager.list();
    this.postToWebview({
      type: 'rolesList',
      roles: roles.map(r => ({
        id: r.id,
        name: r.name,
        icon: r.icon || '👤',
        description: r.description || '',
        category: r.category,
        categoryLabel: ConsoleViewProvider.ROLE_CAT_LABELS[r.category] || r.category,
        builtIn: !!r.builtIn,
        skillSlug: r.skillSlug || '',
        skills: r.skills || [],
        skillContent: r.skillContent || '',
        systemPrompt: r.systemPrompt || '',
      })),
      lastUsedRoleId: this.lastUsedRoleId,
    });
  }

  private async handleCreateRole(role: any): Promise<void> {
    const runtime = this.ctx.getActiveRuntime();
    if (!runtime) return;
    if (!role?.name?.trim()) {
      vscode.window.showWarningMessage('请填写角色名称');
      return;
    }
    const createdRole = runtime.roleManager.create({
      name: role.name.trim(),
      category: role.category || 'custom',
      description: role.description || '',
      skillSlug: role.skillSlug || '',
      skills: role.skills || [],
      skillContent: role.skillContent || '',
      systemPrompt: role.systemPrompt || '',
      icon: role.icon || '👤',
      allowedTools: Array.isArray(role.allowedTools) ? role.allowedTools : [],
      deniedTools: Array.isArray(role.deniedTools) ? role.deniedTools : [],
    });
    this.pushRolesList();
    this.postToWebview({ type: 'roleSaved', roleId: createdRole.id });
    this.ctx.getSidebarProvider()?.refreshRoles?.();
  }

  private async handleUpdateRole(id: string, patch: any): Promise<void> {
    const runtime = this.ctx.getActiveRuntime();
    if (!runtime) return;
    const updates: any = {};
    if (patch.name !== undefined) updates.name = String(patch.name).trim();
    if (patch.category !== undefined) updates.category = patch.category;
    if (patch.description !== undefined) updates.description = String(patch.description);
    if (patch.skillSlug !== undefined) updates.skillSlug = String(patch.skillSlug).trim();
    if (patch.skills !== undefined) updates.skills = Array.isArray(patch.skills) ? patch.skills : [];
    if (patch.skillContent !== undefined) updates.skillContent = String(patch.skillContent);
    if (patch.systemPrompt !== undefined) updates.systemPrompt = String(patch.systemPrompt);
    if (patch.icon !== undefined) updates.icon = String(patch.icon) || '👤';
    if (patch.allowedTools !== undefined) updates.allowedTools = Array.isArray(patch.allowedTools) ? patch.allowedTools : [];
    if (patch.deniedTools !== undefined) updates.deniedTools = Array.isArray(patch.deniedTools) ? patch.deniedTools : [];
    runtime.roleManager.update(id, updates);
    // 同步角色变更到已有会话的 system 消息
    const updatedRole = runtime.roleManager.get(id);
    if (updatedRole) {
      runtime.sessionManager.syncRoleToSessions(updatedRole, runtime.workspace.id);
    }
    this.pushRolesList();
    this.postToWebview({ type: 'roleSaved', roleId: id });
    this.ctx.getSidebarProvider()?.refreshRoles?.();
  }

  private async handleDeleteRole(id: string): Promise<void> {
    const runtime = this.ctx.getActiveRuntime();
    if (!runtime) return;
    const role = runtime.roleManager.get(id);
    if (!role) return;
    if (role.builtIn) {
      vscode.window.showWarningMessage('内置角色不可删除');
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      `确定删除角色「${role.name}」？`,
      { modal: true },
      '删除',
    );
    if (choice !== '删除') return;
    runtime.roleManager.delete(id);
    if (this.lastUsedRoleId === id) this.lastUsedRoleId = null;
    this.pushRolesList();
    this.postToWebview({ type: 'roleDeleted', roleId: id });
    this.ctx.getSidebarProvider()?.refreshRoles?.();
  }

  private async handleCloseTab(sessionId: string): Promise<void> {
    const runtime = this.ctx.getActiveRuntime();
    if (!runtime) return;
    const session = runtime.sessionManager.get(sessionId);
    if (!session) {
      // 会话已不存在，仅清内存
      this.disposeTab(sessionId);
      await this.pushFullState();
      return;
    }
    // 二次确认（删除会话不可恢复）
    const choice = await vscode.window.showWarningMessage(
      `确定关闭并删除会话「${session.title}」？所有消息将被删除。`,
      { modal: true },
      '删除',
    );
    if (choice !== '删除') return;

    // 中断可能的流式请求
    const tab = this.tabs.get(sessionId);
    if (tab?.abortFn) tab.abortFn();
    tab?.toolExecutor.cancel();
    // 真正删除会话数据
    runtime.sessionManager.delete(sessionId);
    this.disposeTab(sessionId);
    await this.pushFullState();
    this.notifySessionsChanged();
  }

  /** 仅清理内存中的 tab 状态 + 切换 currentSessionId */
  private disposeTab(sessionId: string): void {
    this.tabs.get(sessionId)?.toolExecutor.cancel();
    this.tabs.delete(sessionId);
    this.todoListManager.dispose(sessionId);
    if (this.currentSessionId === sessionId) {
      this.currentSessionId = [...this.tabs.keys()][0] || null;
    }
  }

  // ============================================================
  // 业务逻辑
  // ============================================================

  /** 外部调用：向当前活跃会话发送 Code Action 提示词 */
  async handleCodeActionPrompt(prompt: string): Promise<void> {
    if (!this.currentSessionId) return;
    await this.handleSendMessage(this.currentSessionId, prompt);
  }

  private async handleSendMessage(sessionId: string, content: string): Promise<void> {
    const runtime = this.ctx.getActiveRuntime();
    if (!runtime) return;
    if (!content || !content.trim()) return;

    const tab = this.tabs.get(sessionId);
    if (!tab || tab.streaming) return;

    // Slash 命令解析
    const { content: actualContent, modePrompt, mode } = parseSlashCommand(content);
    if (!actualContent.trim()) return;

    const config = this.getLLMConfig(sessionId);
    const isLocalProvider = /localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(config.baseURL);
    const apiKeyOptional = isLocalProvider || config.apiKeyRequired === false;
    if (!config.apiKey && !apiKeyOptional) {
      this.postToWebview({ type: 'error', sessionId, message: '未配置模型 API Key，请在左侧「模型设置」中添加模型预设' });
      vscode.window.showWarningMessage('未配置模型 API Key', '去设置').then((choice) => {
        if (choice === '去设置') {
          vscode.commands.executeCommand('coordinator.sidebar.focus');
        }
      });
      return;
    }

    runtime.sessionManager.addMessage(sessionId, 'user', actualContent);
    this.postToWebview({ type: 'userMessage', sessionId, content: actualContent, createdAt: new Date().toISOString() });
    if (mode) {
      this.postToWebview({ type: 'modeIndicator', sessionId, mode });
    }

    tab.streaming = true;
    tab.abortFn = null;
    this.postToWebview({ type: 'streamStart', sessionId });

    const messages = runtime.sessionManager.getConversationMessages(sessionId) as any[];

    const workspaceContext = buildWorkspaceContext(this.ctx, runtime, sessionId, actualContent);
    const systemIdx = messages.findIndex((m) => m.role === 'system');
    if (systemIdx >= 0) {
      const existing = messages[systemIdx];
      messages[systemIdx] = { role: 'system', content: `${existing.content}\n\n${workspaceContext}` };
    } else {
      messages.unshift({ role: 'system', content: workspaceContext });
    }
    // 注入 slash 命令模式提示（合并到首条 system 消息，避免多条 system 被部分 provider 丢弃）
    if (modePrompt) {
      const idx = messages.findIndex((m) => m.role === 'system');
      if (idx >= 0) {
        messages[idx] = { role: 'system', content: `${messages[idx].content}\n\n${modePrompt}` };
      } else {
        messages.unshift({ role: 'system', content: modePrompt });
      }
    }

    this.postContextUsage(sessionId, messages, config.contextWindow);
    tab.toolExecutor.begin();

    let usedNativeTool = false;
    // 合并内置工具和 MCP 工具
    const mcpTools = this.mcpManager?.getToolDefinitions() || [];
    const roleFilteredTools = filterToolsByRole(COORDINATOR_LLM_TOOLS, tab.role);
    const allTools = [...roleFilteredTools, ...mcpTools];
    const abortFn = this.llm.streamChat(messages, { ...config, tools: allTools }, {
      onChunk: (delta) => {
        this.postToWebview({ type: 'streamChunk', sessionId, delta });
      },
      onReasoningChunk: (delta) => {
        this.postToWebview({ type: 'reasoningChunk', sessionId, delta });
      },
      onToolCall: (call) => {
        usedNativeTool = true;
        // MCP 工具路由到 mcpManager 执行
        if (this.mcpManager?.isMCPTool(call.name)) {
          return this.mcpManager.executeTool(call);
        }
        return this.executeToolCall(runtime, sessionId, call);
      },
      onToolStatus: (call, status, detail) => {
        this.postToWebview({ type: 'toolStatus', sessionId, callId: call.id, name: call.name, status, detail });
      },
      onDone: (fullText, reasoningText) => {
        if (fullText) runtime.sessionManager.addMessage(sessionId, 'assistant', fullText);
        tab.streaming = false;
        tab.abortFn = null;
        this.postToWebview({ type: 'streamEnd', sessionId, fullText, reasoningText });
        // 从 DB 重新读取消息（包含刚写入的 assistant 回复），并重建 workspace context
        this.postToWebview({ type: 'contextUsage', sessionId, ...this.getFullContextUsage(sessionId) });
        // 自动解析并执行派发指令
        if (!usedNativeTool) this.parseAndDispatch(runtime, sessionId, fullText);
      },
      onError: (err, fullText, reasoningText) => {
        tab.streaming = false;
        tab.abortFn = null;
        if (fullText) runtime.sessionManager.addMessage(sessionId, 'assistant', fullText);
        const detail = `[${config.model}] ${err.message}`;
        this.postToWebview({ type: 'streamError', sessionId, message: detail, fullText, reasoningText });
      },
    });
    tab.abortFn = abortFn;
  }

  /** 构建团队上下文：列出当前工作区所有会话及其角色，让 LLM 知道可以向谁派发任务 */
  private buildTeamContext(runtime: any, currentSessionId: string): string {
    const sessions = runtime.sessionManager.list(runtime.workspace.id);
    if (sessions.length <= 1) return '';

    const lines: string[] = [
      '## 当前团队（工作区在线会话）',
      '以下是当前工作区中活跃的 AI 角色会话，你可以通过任务派发机制向它们分配任务：',
      '',
    ];

    for (const s of sessions) {
      const role = runtime.roleManager.get(s.roleId);
      if (!role) continue;
      const isMe = s.id === currentSessionId;
      const tag = isMe ? '（你自己）' : `[可派发: ${s.id.slice(0, 8)}]`;
      const skills = role.skills?.length ? role.skills.join(', ') : '无';
      lines.push(`- ${role.icon || '👤'} **${role.name}**${tag} — 会话: "${s.title}"`);
      lines.push(`  技能: ${skills}`);
      if (role.description) {
        lines.push(`  职责: ${role.description}`);
      }
    }

    lines.push('');
    lines.push('## 如何派发任务给其他会话');
    lines.push('当你需要其他角色协助时，在回复中包含以下格式的指令，系统会自动解析并派发任务：');
    lines.push('');
    lines.push('```dispatch');
    lines.push('target: <目标会话ID>');
    lines.push('title: <任务标题>');
    lines.push('objective: <任务目标/详细描述>');
    lines.push('```');
    lines.push('');
    lines.push('示例：');
    lines.push('```dispatch');
    lines.push('target: abc12345');
    lines.push('title: 实现用户登录API');
    lines.push('objective: 实现POST /api/login接口，接收用户名和密码，返回JWT token');
    lines.push('```');
    lines.push('');
    lines.push('注意：target 使用上面标注的会话ID（8位短ID）。派发后目标会话会自动收到任务通知。');

    return lines.join('\n');
  }

  /** 解析 LLM 输出中的 ```dispatch 指令块并自动执行派发 */
  private parseAndDispatch(runtime: ActiveWorkspaceRuntime, sourceSessionId: string, llmOutput: string): void {
    for (const block of this.extractDispatchBlocks(llmOutput)) {
      try {
        this.dispatchSessionTask(runtime, sourceSessionId, block);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.postToWebview({ type: 'error', sessionId: sourceSessionId, message: `派发失败: ${message}` });
      }
    }
  }

  private async executeToolCall(
    runtime: ActiveWorkspaceRuntime,
    sourceSessionId: string,
    call: LLMToolCall,
  ): Promise<string> {
    if (call.name === 'orchestrate_task') {
      const tab = this.tabs.get(sourceSessionId);
      if (tab && !isToolAllowedByRole(call.name, tab.role)) {
        throw new Error(`角色「${tab.role.name}」无权使用工具: ${call.name}`);
      }
      return this.executeOrchestrateTask(runtime, sourceSessionId, call);
    }
    if (call.name !== 'dispatch_session_task') {
      const tab = this.tabs.get(sourceSessionId);
      if (!tab) throw new Error('当前会话工具执行器不可用');
      if (!isToolAllowedByRole(call.name, tab.role)) {
        throw new Error(`角色「${tab.role.name}」无权使用工具: ${call.name}`);
      }
      return tab.toolExecutor.execute(call);
    }
    let input: unknown;
    try {
      input = JSON.parse(call.arguments || '{}');
    } catch {
      throw new Error('工具参数不是有效的 JSON');
    }
    if (!input || typeof input !== 'object') throw new Error('工具参数必须是对象');
    const values = input as Record<string, unknown>;
    const block = {
      target: typeof values.target === 'string' ? values.target.trim() : '',
      title: typeof values.title === 'string' ? values.title.trim() : '',
      objective: typeof values.objective === 'string' ? values.objective.trim() : '',
    };
    if (!block.target || !block.title || !block.objective) {
      throw new Error('target、title 和 objective 均为必填字符串');
    }
    if (block.target.length > 128 || block.title.length > 200 || block.objective.length > 20000) {
      throw new Error('工具参数超过允许长度');
    }
    return JSON.stringify({ ok: true, ...this.dispatchSessionTask(runtime, sourceSessionId, block) });
  }

  private async executeOrchestrateTask(
    runtime: ActiveWorkspaceRuntime,
    sourceSessionId: string,
    call: LLMToolCall,
  ): Promise<string> {
    let input: unknown;
    try {
      input = JSON.parse(call.arguments || '{}');
    } catch {
      throw new Error('工具参数不是有效的 JSON');
    }
    if (!input || typeof input !== 'object') throw new Error('工具参数必须是对象');
    const values = input as Record<string, unknown>;
    const description = typeof values.description === 'string' ? values.description.trim() : '';
    if (!description) throw new Error('description 为必填字符串');
    if (description.length > 20000) throw new Error('description 超过允许长度');
    const context = typeof values.context === 'string' ? values.context.trim().slice(0, 10000) : '';
    const maxSubTasks = typeof values.maxSubTasks === 'number' && values.maxSubTasks >= 1 && values.maxSubTasks <= 10
      ? Math.floor(values.maxSubTasks)
      : 5;

    this.orchestrator.setDB(runtime.db);
    this.orchestrator.setEventBus(runtime.eventBus);
    this.orchestrator.setDispatcher(runtime.dispatcher);
    this.orchestrator.setSessionManager(runtime.sessionManager);
    this.orchestrator.setRoleManager(runtime.roleManager);

    const config = this.getLLMConfig(sourceSessionId);
    const llmCall: LLMCallFunction = (messages, options) => {
      if (this.orchestrationAborted) throw new Error('用户已取消编排');
      return this.llm.chat(messages as LLMMessage[], {
        ...config,
        temperature: options?.temperature ?? 0.3,
        maxTokens: options?.maxTokens,
        tools: undefined,
      });
    };

    this.orchestrationAborted = false;
    this.postToWebview({ type: 'systemMessage', sessionId: sourceSessionId, content: `🔄 开始自动编排任务: ${description.slice(0, 100)}...` });

    try {
      if (this.orchestrationAborted) throw new Error('用户已取消编排');
      const result = await this.orchestrator.orchestrate(
        {
          description,
          context,
          sourceSessionId,
          workspaceId: runtime.workspace.id,
          maxSubTasks,
        },
        llmCall,
      );

      const summaryMsg = [
        `## 编排结果: ${result.status === 'completed' ? '✅ 全部完成' : result.status === 'partial' ? '⚠️ 部分完成' : '❌ 失败'}`,
        '',
        result.summary,
        '',
        '### 子任务执行情况',
        ...result.subTaskResults.map((r) =>
          `- ${r.status === 'completed' ? '✅' : r.status === 'cancelled' ? '🚫' : '❌'} **${r.title}** → ${r.targetRole}: ${r.result.slice(0, 200)}`,
        ),
      ].join('\n');
      runtime.sessionManager.addMessage(sourceSessionId, 'system', summaryMsg);
      this.postToWebview({ type: 'systemMessage', sessionId: sourceSessionId, content: summaryMsg });

      return JSON.stringify({ ok: true, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.postToWebview({ type: 'error', sessionId: sourceSessionId, message: `编排失败: ${message}` });
      throw new Error(`编排失败: ${message}`);
    }
  }

  private dispatchSessionTask(
    runtime: ActiveWorkspaceRuntime,
    sourceSessionId: string,
    block: { target: string; title: string; objective: string },
  ): { taskId: string; targetSessionId: string; targetSessionTitle: string } {
    const sessions = runtime.sessionManager.list(runtime.workspace.id);
    const matches = sessions.filter((candidate) => candidate.id === block.target || candidate.id.startsWith(block.target));
    if (matches.length === 0) throw new Error(`找不到目标会话 "${block.target}"`);
    if (matches.length > 1) throw new Error(`目标会话短 ID "${block.target}" 不唯一，请使用更长的 ID`);
    const targetSession = matches[0];
    if (targetSession.id === sourceSessionId) throw new Error('不能向自己派发任务');
    const sourceSession = runtime.sessionManager.get(sourceSessionId);
    if (!sourceSession) throw new Error('当前会话不存在');
    const sourceRole = runtime.roleManager.get(sourceSession.roleId);
    if (!sourceRole) throw new Error('当前会话角色不存在');
    const targetRole = runtime.roleManager.get(targetSession.roleId);
    const task = runtime.dispatcher.dispatch({
      sourceSessionId,
      targetSessionId: targetSession.id,
      title: block.title,
      brief: '',
      contextPayload: {
        sourceRole: { id: sourceRole.id, name: sourceRole.name, category: sourceRole.category },
        objective: block.objective,
        acceptanceCriteria: [],
        progressSummary: '',
        relatedTasks: [],
        relatedContracts: [],
        relatedMemories: [],
        conversationDigest: '',
        expectedOutput: '',
        constraints: [],
      },
      priority: 'medium',
    });
    const successMsg = `任务「${task.title}」已自动派发给 ${targetRole?.name || '未知角色'}（会话: "${targetSession.title}"）`;
    runtime.sessionManager.addMessage(sourceSessionId, 'system', successMsg);
    this.postToWebview({ type: 'systemMessage', sessionId: sourceSessionId, content: successMsg });
    const notifyMsg = [
      `**收到来自 ${sourceRole.name} 的任务派发**`,
      '',
      `**任务标题**: ${task.title}`,
      `**任务目标**: ${block.objective}`,
      `**派发方**: ${sourceRole.name}（会话: "${sourceSession.title}"）`,
      `**优先级**: 中`,
      '',
      '请根据以上任务目标开始执行。完成后可以通过任务中心回复结果。',
    ].join('\n');
    runtime.sessionManager.addMessage(targetSession.id, 'system', notifyMsg);
    if (this.tabs.has(targetSession.id)) {
      this.postToWebview({ type: 'systemMessage', sessionId: targetSession.id, content: notifyMsg });
    }
    try {
      runtime.dispatcher.align(task.id);
      runtime.dispatcher.accept(task.id);
    } catch {}
    return { taskId: task.id, targetSessionId: targetSession.id, targetSessionTitle: targetSession.title };
  }

  /** 从 LLM 输出中提取 ```dispatch 代码块 */
  private extractDispatchBlocks(text: string): Array<{ target: string; title: string; objective: string }> {
    const blocks: Array<{ target: string; title: string; objective: string }> = [];
    const regex = /```dispatch\s*\n([\s\S]*?)```/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const body = match[1];
      const target = this.extractField(body, 'target');
      const title = this.extractField(body, 'title');
      const objective = this.extractField(body, 'objective');
      if (target && title && objective) {
        blocks.push({ target: target.trim(), title: title.trim(), objective: objective.trim() });
      }
    }
    return blocks;
  }

  /** 从 dispatch 块体中提取字段值（支持单行和多行） */
  private extractField(body: string, field: string): string {
    // 匹配 "field: value" 或 "field: value\n续行"
    const regex = new RegExp(`^${field}:\\s*(.+?)(?=\\n\\w+:|$)`, 'ims');
    const match = regex.exec(body);
    return match ? match[1].trim() : '';
  }

  private handleAbort(sessionId: string): void {
    const tab = this.tabs.get(sessionId);
    tab?.toolExecutor.cancel();
    this.orchestrationAborted = true;
    this.orchestrator.cancel();
    if (tab?.abortFn) {
      tab.abortFn();
      tab.abortFn = null;
      tab.streaming = false;
      this.postToWebview({ type: 'streamEnd', sessionId, fullText: '', aborted: true });
    }
  }

  private handleClearHistory(sessionId: string): void {
    const runtime = this.ctx.getActiveRuntime();
    if (!runtime) return;
    runtime.sessionManager.clearHistory(sessionId);
    const contextWindow = this.getLLMConfig(sessionId).contextWindow;
    this.postToWebview({
      type: 'historyCleared',
      sessionId,
      contextUsage: this.getContextUsage([], contextWindow),
    });
    vscode.window.showInformationMessage('已清空对话历史');
  }

  private async handleInjectContext(sessionId: string): Promise<void> {
    const runtime = this.ctx.getActiveRuntime();
    if (!runtime) return;
    const current = runtime.sessionManager.get(sessionId);
    if (!current) return;

    const action = await vscode.window.showQuickPick(
      [
        { label: '$(arrow-right) 接力到新会话', description: '压缩当前会话的关键内容，在新会话继续' },
        { label: '$(link) 接力到已有会话', description: '把当前会话上下文传递给另一个会话' },
        { label: '$(git-merge) 对齐到当前会话', description: '把另一个会话的上下文合并到当前会话' },
        { label: '$(sync) 双向对齐', description: '让当前会话与另一个会话互相获得对方上下文' },
      ],
      { title: '会话上下文接力与对齐', placeHolder: '选择上下文操作' },
    );
    if (!action) return;

    try {
      if (action.label.includes('接力到新会话')) {
        const role = runtime.roleManager.get(current.roleId);
        if (!role) throw new Error('当前会话角色不存在');
        const target = runtime.sessionManager.create(
          runtime.workspace.id,
          role,
          `${current.title} · 接力`,
        );
        if (current.modelId) runtime.sessionManager.setModel(target.id, current.modelId);
        this.transferSessionContext(runtime, current, target, 'continue');
        this.currentSessionId = target.id;
        await this.pushFullState();
        this.notifySessionsChanged();
        vscode.window.showInformationMessage(`已创建接力会话“${target.title}”`);
        return;
      }

      const targetId = await this.pickContextSession(runtime, sessionId);
      if (!targetId) return;
      const other = runtime.sessionManager.get(targetId);
      if (!other) throw new Error('目标会话不存在');

      if (action.label.includes('接力到已有会话')) {
        this.transferSessionContext(runtime, current, other, 'continue');
        this.currentSessionId = other.id;
      } else if (action.label.includes('对齐到当前会话')) {
        this.transferSessionContext(runtime, other, current, 'align');
      } else {
        const currentPackage = buildSessionContextPackage(
          current,
          runtime.roleManager.get(current.roleId),
          runtime.sessionManager.listMessages(current.id),
          'align',
        );
        const otherPackage = buildSessionContextPackage(
          other,
          runtime.roleManager.get(other.roleId),
          runtime.sessionManager.listMessages(other.id),
          'align',
        );
        runtime.sessionManager.addMessage(other.id, 'system', currentPackage.content);
        runtime.sessionManager.addMessage(current.id, 'system', otherPackage.content);
      }

      await this.pushFullState();
      this.notifySessionsChanged();
      vscode.window.showInformationMessage('会话上下文已完成接力/对齐');
    } catch (err: any) {
      this.postToWebview({
        type: 'error',
        sessionId,
        message: `会话上下文操作失败: ${err.message}`,
      });
    }
  }

  private async pickContextSession(runtime: ActiveWorkspaceRuntime, currentSessionId: string): Promise<string | undefined> {
    const options = listContextSessionOptions(
      runtime.sessionManager.list(runtime.workspace.id),
      currentSessionId,
      (roleId) => runtime.roleManager.get(roleId),
      (id) => runtime.sessionManager.listMessages(id),
    );
    if (options.length === 0) {
      vscode.window.showInformationMessage('当前工作区没有其他可用会话');
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      options.map((option) => ({
        label: `${option.roleIcon} ${option.title}`,
        description: option.roleName,
        detail: `${option.messageCount} 条有效消息 · 约 ${option.tokenEstimate.toLocaleString()} tokens`,
        sessionId: option.id,
      })),
      { title: '选择会话', placeHolder: '选择要接力或对齐的会话' },
    );
    return picked?.sessionId;
  }

  private transferSessionContext(
    runtime: ActiveWorkspaceRuntime,
    source: Session,
    target: Session,
    mode: ContextTransferMode,
  ): void {
    const contextPackage = buildSessionContextPackage(
      source,
      runtime.roleManager.get(source.roleId),
      runtime.sessionManager.listMessages(source.id),
      mode,
    );
    runtime.sessionManager.addMessage(target.id, 'system', contextPackage.content);
  }

  private async handleSwitchModel(sessionId: string, modelId: string): Promise<void> {
    const runtime = this.ctx.getActiveRuntime();
    if (!runtime) return;
    runtime.sessionManager.setModel(sessionId, modelId || null);
    // 刷新模型显示
    this.refreshModels();
    // 通知左侧模型视图刷新会话列表
    this.notifySessionsChanged();
  }

  private async handleUpdateToolPermissions(sessionId: string, allowedTools: string[], deniedTools: string[]): Promise<void> {
    const runtime = this.ctx.getActiveRuntime();
    if (!runtime) return;
    const tab = this.tabs.get(sessionId || '');
    if (!tab) return;
    runtime.roleManager.update(tab.role.id, { allowedTools, deniedTools });
    // 立即刷新当前 tab 的 role 引用
    const updatedRole = runtime.roleManager.get(tab.role.id);
    if (updatedRole) {
      tab.role = updatedRole;
      tab.toolExecutor.setRole(updatedRole);
      runtime.sessionManager.syncRoleToSessions(updatedRole, runtime.workspace.id);
    }
    this.postToWebview({ type: 'toolPermissionsSaved', sessionId });
  }

  private handleToolApprovalResponse(approvalId: string, approved: boolean, remember: boolean, toolName?: string): void {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingApprovals.delete(approvalId);
    pending.resolve(approved);
    if (remember && approved && toolName) {
      const config = vscode.workspace.getConfiguration('coordinator.autoApprove');
      const tools = config.get<string[]>('tools', []);
      if (!tools.includes(toolName)) {
        tools.push(toolName);
        config.update('tools', tools, vscode.ConfigurationTarget.Workspace);
      }
    }
  }

  // ============================================================
  // 状态推送
  // ============================================================

  private async pushFullState(): Promise<void> {
    const runtime = this.ctx.getActiveRuntime();
    if (!runtime) {
      this.postToWebview({ type: 'noWorkspace' });
      return;
    }

    const allSessions = runtime.sessionManager.list(runtime.workspace.id);
    const tabs = allSessions.map((s) => {
      const role = runtime.roleManager.get(s.roleId);
      const tab = this.tabs.get(s.id);
      return {
        id: s.id,
        title: s.title,
        roleId: s.roleId,
        roleName: role?.name || '?',
        roleIcon: role?.icon || '💬',
        isActive: s.id === this.currentSessionId,
        streaming: tab?.streaming || false,
        updatedAt: s.updatedAt,
      };
    });

    // 若无激活标签但有会话，激活第一个
    if (!this.currentSessionId && tabs.length > 0) {
      this.currentSessionId = tabs[0].id;
      tabs[0].isActive = true;
    }

    // 同步内存 tabs
    this.syncTabs(tabs, runtime);

    this.postToWebview({
      type: 'state',
      workspaceName: runtime.workspace.name,
      tabs,
      currentSessionId: this.currentSessionId,
    });

    this.pushWorkspaceFiles(runtime.workspace.folderPath);

    await this.pushCurrentMessages();
  }

  private workspaceFilesCache: { name: string; relPath: string }[] = [];
  private pushWorkspaceFiles(folderPath: string): void {
    try {
      const fs = require('fs') as typeof import('fs');
      const path = require('path') as typeof import('path');
      const excludeDirs = new Set(['node_modules', '.git', 'dist', 'out', '.coordinator', '.vscode', 'build']);
      const excludeExts = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg', '.woff', '.woff2', '.ttf', '.eot', '.mp4', '.mp3', '.zip', '.tar', '.gz', '.lock']);
      const files: { name: string; relPath: string }[] = [];
      const walk = (dir: string, depth: number) => {
        if (depth > 4 || files.length > 500) return;
        let entries: string[];
        try { entries = fs.readdirSync(dir); } catch { return; }
        for (const entry of entries) {
          if (entry.startsWith('.') && entry !== '.github') continue;
          const full = path.join(dir, entry);
          let stat;
          try { stat = fs.statSync(full); } catch { continue; }
          if (stat.isDirectory()) {
            if (excludeDirs.has(entry)) continue;
            walk(full, depth + 1);
          } else {
            const ext = path.extname(entry).toLowerCase();
            if (excludeExts.has(ext)) continue;
            const relPath = path.relative(folderPath, full).replace(/\\/g, '/');
            files.push({ name: entry, relPath });
          }
        }
      };
      walk(folderPath, 0);
      this.workspaceFilesCache = files;
      this.postToWebview({ type: 'workspaceFiles', files });
    } catch {
      // ignore
    }
  }

  private async pushCurrentMessages(): Promise<void> {
    const runtime = this.ctx.getActiveRuntime();
    if (!runtime || !this.currentSessionId) return;
    const session = runtime.sessionManager.get(this.currentSessionId);
    if (!session) return;
    const role = runtime.roleManager.get(session.roleId);
    const messages = runtime.sessionManager.listMessages(this.currentSessionId);
    // 获取模型列表供控制台下拉切换
    const store = this.ctx.getModelStore();
    const models = store.list().map(m => ({ id: m.id, name: m.name }));
    const config = this.getLLMConfig(this.currentSessionId);
    const defaultModelId = store.getDefaultId();
    const currentModelId = session.modelId || '';
    this.postToWebview({
      type: 'messages',
      sessionId: this.currentSessionId,
      role: role ? { name: role.name, icon: role.icon || '💬', builtIn: !!role.builtIn } : { name: 'AI', icon: '💬', builtIn: false },
      modelName: this.getCurrentModelName(this.currentSessionId),
      models,
      defaultModelId,
      currentModelId,
      contextUsage: this.getFullContextUsage(this.currentSessionId),
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
        createdAt: m.createdAt,
      })),
    });
    this.postToWebview({
      type: 'todoUpdated',
      sessionId: this.currentSessionId,
      items: this.todoListManager.getTodos(this.currentSessionId),
    });
  }

  /** 把数据库会话同步进内存 tabs（新增的会话补全 SessionTab，保留 streaming/abortFn 状态） */
  private syncTabs(tabs: any[], runtime: ActiveWorkspaceRuntime): void {
    const incoming = new Set(tabs.map((t) => t.id));
    // 删除已不存在的
    for (const id of [...this.tabs.keys()]) {
      if (!incoming.has(id)) this.disposeTab(id);
    }
    // 新增的补全
    for (const t of tabs) {
      if (!this.tabs.has(t.id)) {
        const session = runtime.sessionManager.get(t.id);
        const role = runtime.roleManager.get(t.roleId);
        if (session && role) {
          this.tabs.set(t.id, {
            session,
            role,
            streaming: false,
            abortFn: null,
            toolExecutor: new WorkspaceToolExecutor(runtime.workspace.folderPath, async (request) => {
              if (request.toolName && shouldAutoApprove(request.toolName)) return true;
              if (request.toolName && role.allowedTools?.includes(request.toolName)) return true;
              // Webview 内审批弹窗
              const approvalId = `approval_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
              this.postToWebview({
                type: 'toolApprovalRequest',
                sessionId: t.id,
                approvalId,
                title: request.title,
                detail: request.detail,
                confirmLabel: request.confirmLabel,
                toolName: request.toolName || '',
              });
              return new Promise<boolean>((resolve) => {
                const timeout = setTimeout(() => {
                  this.pendingApprovals.delete(approvalId);
                  resolve(false);
                }, 300000);
                this.pendingApprovals.set(approvalId, { resolve, timeout });
              });
            }),
          });
          this.tabs.get(t.id)!.toolExecutor.setRole(role);
          this.tabs.get(t.id)!.toolExecutor.setCheckpointManager(new CheckpointManager(runtime.workspace.folderPath));
          this.tabs.get(t.id)!.toolExecutor.setTerminalRunner(this.terminalService.createRunner());
          this.tabs.get(t.id)!.toolExecutor.setTodoListManager(this.todoListManager);
          this.tabs.get(t.id)!.toolExecutor.setIndexingService(this.indexingService);
          this.tabs.get(t.id)!.toolExecutor.setSessionId(t.id);
        }
      }
    }
  }

  // ============================================================
  // 辅助
  // ============================================================

  private getLLMConfig(sessionId?: string): LLMConfig {
    // 1. 会话绑定的模型预设优先
    if (sessionId) {
      const runtime = this.ctx.getActiveRuntime();
      const session = runtime?.sessionManager.get(sessionId);
      if (session?.modelId) {
        const preset = this.ctx.getModelStore().get(session.modelId);
        if (preset) {
          return {
            apiKey: preset.apiKey,
            baseURL: preset.baseURL,
            model: preset.model,
            apiFormat: preset.apiFormat,
            temperature: preset.temperature ?? 0.7,
            contextWindow: preset.contextWindow ?? 1000000,
            thinkingStrength: preset.thinkingStrength ?? 'xhigh',
            apiKeyRequired: preset.apiKeyRequired,
          };
        }
      }
    }
    // 2. 默认模型预设
    const def = this.ctx.getModelStore().getDefault();
    if (def) {
      return {
        apiKey: def.apiKey,
        baseURL: def.baseURL,
        model: def.model,
        apiFormat: def.apiFormat,
        temperature: def.temperature ?? 0.7,
        contextWindow: def.contextWindow ?? 1000000,
        thinkingStrength: def.thinkingStrength ?? 'xhigh',
        apiKeyRequired: def.apiKeyRequired,
      };
    }
    // 3. 兜底：全局 configuration（兼容极旧配置）
    const globalCfg = vscode.workspace.getConfiguration('coordinator.llm');
    return {
      apiKey: globalCfg.get<string>('apiKey', ''),
      baseURL: globalCfg.get<string>('baseURL', 'https://api.openai.com/v1'),
      model: globalCfg.get<string>('model', 'gpt-4o-mini'),
      apiFormat: 'chat-completions',
      temperature: globalCfg.get<number>('temperature', 0.7),
      contextWindow: 1000000,
      thinkingStrength: 'xhigh',
    };
  }

  private getContextUsage(messages: Array<{ content: string }>, contextWindow = 1000000): { used: number; limit: number; percent: number } {
    const limit = Math.max(1, contextWindow);
    const used = estimateMessageTokens(messages);
    return { used, limit, percent: Math.min(100, Math.round((used / limit) * 100)) };
  }

  /**
   * 计算包含工作区上下文的真实上下文占用。
   * 使用最后一条 user 消息作为 query 来构建 workspace context，
   * 保证和 handleSendMessage 中发给 LLM 的消息序列一致。
   */
  private getFullContextUsage(sessionId: string): { used: number; limit: number; percent: number } {
    const runtime = this.ctx.getActiveRuntime();
    if (!runtime) return { used: 0, limit: 1, percent: 0 };
    const config = this.getLLMConfig(sessionId);
    const messages = runtime.sessionManager.getConversationMessages(sessionId) as any[];
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const query = lastUser?.content || '';
    const workspaceContext = buildWorkspaceContext(this.ctx, runtime, sessionId, query);
    const systemIdx = messages.findIndex((m) => m.role === 'system');
    if (systemIdx >= 0) {
      messages[systemIdx] = { role: 'system', content: `${messages[systemIdx].content}\n\n${workspaceContext}` };
    } else {
      messages.unshift({ role: 'system', content: workspaceContext });
    }
    return this.getContextUsage(messages, config.contextWindow);
  }

  private postContextUsage(sessionId: string, messages: Array<{ content: string }>, contextWindow = 1000000): void {
    this.postToWebview({ type: 'contextUsage', sessionId, ...this.getContextUsage(messages, contextWindow) });
  }

  /** 获取会话当前使用的模型显示名（供 UI 展示） */
  private getCurrentModelName(sessionId: string | null): string {
    const store = this.ctx.getModelStore();
    if (sessionId) {
      const runtime = this.ctx.getActiveRuntime();
      const session = runtime?.sessionManager.get(sessionId);
      if (session?.modelId) {
        const preset = store.get(session.modelId);
        if (preset) return preset.name;
      }
    }
    const def = store.getDefault();
    if (def) return def.name + '（默认）';
    return '未配置模型';
  }

  /** 模型库 / 会话模型绑定变化时刷新当前模型名显示 */
  refreshModels(): void {
    const modelName = this.getCurrentModelName(this.currentSessionId);
    this.postToWebview({
      type: 'modelName',
      modelName,
      contextUsage: this.currentSessionId ? this.getFullContextUsage(this.currentSessionId) : undefined,
    });
  }

  /** 会话增删后通知左侧视图刷新 */
  private notifySessionsChanged(): void {
    this.ctx.getModelsProvider()?.refreshSessions?.();
    this.ctx.getSidebarProvider()?.refreshSessions?.();
    this.ctx.fireSessionsChanged();
  }

  private postToWebview(msg: any): void {
    this.view?.webview?.postMessage(msg);
  }

  // ============================================================
  // Webview HTML / CSS / JS
  // ============================================================

  private getHtml(): string {
    return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  :root {
    --bg: var(--vscode-panel-background, #1e1e1e);
    --bg-elevated: var(--vscode-sideBar-background, #252526);
    --bg-card: #2a2a2e;
    --bg-hover: #333337;
    --bg-input: var(--vscode-input-background, #1e1e1e);
    --border: var(--vscode-panel-border, #3e3e42);
    --border-subtle: #2a2a2e;
    --text: var(--vscode-foreground, #cccccc);
    --text2: var(--vscode-descriptionForeground, #858585);
    --text3: #6a6a6a;
    --accent: var(--vscode-button-background, #0e639c);
    --accent-hover: var(--vscode-button-hoverBackground, #1177bb);
    --user-bubble: var(--vscode-button-background, #0e639c);
    --user-text: var(--vscode-button-foreground, #ffffff);
    --ai-bubble: var(--vscode-editorWidget-background, #2a2a2e);
    --danger: var(--vscode-errorForeground, #f14c4c);
    --success: #4ec970;
    --r-sm: 4px;
    --r-md: 8px;
    --r-pill: 999px;
    --shadow: 0 1px 3px rgba(0,0,0,.3);
    --transition: .15s cubic-bezier(.4,0,.2,1);
  }
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { height:100%; }
  body {
    font-family: var(--vscode-font-family, -apple-system, 'Segoe UI', sans-serif);
    font-size: 13px;
    color: var(--text);
    background: var(--bg);
    display:flex; flex-direction:column;
    overflow:hidden;
    user-select:none;
  }

  /* ─── 会话标签栏 ─── */
  .tab-bar {
    display:flex; align-items:center; gap:4px;
    padding:6px 10px 0;
    background: var(--bg-elevated);
    border-bottom:1px solid var(--border-subtle);
    flex-shrink:0;
    overflow-x:auto;
    scrollbar-width:thin;
  }
  .tab-bar::-webkit-scrollbar { height:3px; }
  .tab-bar::-webkit-scrollbar-thumb { background:var(--border); border-radius:2px; }
  .session-tab {
    display:inline-flex; align-items:center; gap:5px;
    padding:5px 12px;
    border-radius: var(--r-pill);
    background: var(--bg-card);
    color: var(--text2);
    cursor:pointer;
    white-space:nowrap;
    font-size:12px;
    border:1px solid transparent;
    transition: all var(--transition);
    flex-shrink:0;
  }
  .session-tab:hover { background: var(--bg-hover); color: var(--text); }
  .session-tab.active {
    background: var(--accent);
    color: var(--user-text);
    font-weight:500;
  }
  .session-tab .tab-ico { font-size:13px; }
  .session-tab .tab-close {
    display:inline-flex; align-items:center; justify-content:center;
    width:14px; height:14px; border-radius:50%;
    font-size:11px; opacity:0; transition: opacity var(--transition);
    margin-left:2px;
  }
  .session-tab:hover .tab-close { opacity:.7; }
  .session-tab .tab-close:hover { opacity:1; background:rgba(255,255,255,.15); }
  .session-tab.active .tab-close { opacity:.8; }
  .session-tab.streaming::after {
    content:'●'; color: var(--success);
    animation: pulse 1s infinite;
    font-size:9px;
  }
  @keyframes pulse { 50% { opacity:.3; } }
  .tab-add {
    display:inline-flex; align-items:center; justify-content:center;
    width:26px; height:26px; border-radius:50%;
    border:1px dashed var(--border);
    color: var(--text3); cursor:pointer; font-size:16px;
    transition: all var(--transition); flex-shrink:0;
    margin-left:4px;
  }
  .tab-add:hover { border-color: var(--accent); color: var(--accent); }

  /* ─── 消息区 ─── */
  .messages {
    flex:1; overflow-y:auto;
    padding:14px 16px;
    display:flex; flex-direction:column; gap:12px;
    scroll-behavior:smooth;
  }
  .messages::-webkit-scrollbar { width:6px; }
  .messages::-webkit-scrollbar-thumb { background:var(--border); border-radius:3px; }

  .msg-row { display:flex; gap:8px; max-width:92%; animation: fadeIn .25s ease; }
  @keyframes fadeIn { from { opacity:0; transform:translateY(6px);} to {opacity:1; transform:none;} }
  .msg-row.user { align-self:flex-end; flex-direction:row-reverse; }
  .msg-row.assistant { align-self:flex-start; }
  .msg-row.system { align-self:center; max-width:96%; }

  .avatar {
    width:24px; height:24px; border-radius:50%;
    display:flex; align-items:center; justify-content:center;
    font-size:13px; flex-shrink:0;
    background: var(--bg-card); border:1px solid var(--border);
  }
  .bubble {
    padding:8px 12px; border-radius: var(--r-md);
    line-height:1.6; word-break:break-word;
    box-shadow: var(--shadow);
  }
  .msg-row.user .bubble {
    background: var(--user-bubble); color: var(--user-text);
    border-bottom-right-radius: var(--r-sm);
  }
  .msg-row.assistant .bubble {
    background: var(--ai-bubble); color: var(--text);
    border-bottom-left-radius: var(--r-sm);
  }
  .msg-row.system .bubble {
    background: rgba(220,200,120,.08); color: #d4c896;
    border:1px solid rgba(220,200,120,.2);
    font-size:12px; padding:7px 12px; border-radius: var(--r-md);
  }
  .reasoning-panel { margin:0 0 6px; border:1px solid var(--border-subtle); border-radius:var(--r-md); background:rgba(255,255,255,.025); color:var(--text2); max-width:720px; transition:border-color .3s; }
  .reasoning-panel.is-streaming { border-color: rgba(100,160,255,.35); }
  .reasoning-panel.is-streaming summary { color:#6ba3ff; }
  .reasoning-panel summary { cursor:pointer; padding:6px 9px; font-size:11px; color:var(--text3); user-select:none; display:flex; align-items:center; gap:5px; }
  .reasoning-panel.is-streaming summary::before { content:''; width:6px; height:6px; border-radius:50%; background:#6ba3ff; animation:pulseDot 1s ease-in-out infinite; }
  @keyframes pulseDot { 0%,100%{opacity:.3} 50%{opacity:1} }
  .reasoning-content { padding:0 9px 8px; white-space:pre-wrap; word-break:break-word; font-size:11px; line-height:1.55; max-height:260px; overflow:auto; }
  .reasoning-content.is-streaming::after { content:'▊'; animation:blinkCursor .8s step-end infinite; color:#6ba3ff; font-size:10px; }
  .tool-badges { margin:0 0 5px; display:flex; flex-direction:column; gap:3px; max-width:720px; }
  .tool-badge { display:inline-flex; align-items:center; gap:5px; padding:3px 9px; border-radius:10px; font-size:11px; line-height:1.4; border:1px solid var(--border-subtle); background:rgba(255,255,255,.03); color:var(--text2); max-width:fit-content; transition:all .25s; }
  .tool-badge.running { border-color:rgba(100,160,255,.3); color:#6ba3ff; }
  .tool-badge.running::before { content:''; width:8px; height:8px; border:1.5px solid #6ba3ff; border-top-color:transparent; border-radius:50%; animation:spinBadge .6s linear infinite; flex-shrink:0; }
  .tool-badge.completed { border-color:rgba(80,200,120,.25); color:#5ac878; }
  .tool-badge.completed::before { content:'✓'; font-size:10px; font-weight:700; }
  .tool-badge.failed { border-color:rgba(240,100,100,.3); color:#f06464; }
  .tool-badge.failed::before { content:'✕'; font-size:10px; font-weight:700; }
  @keyframes spinBadge { to{transform:rotate(360deg)} }
  .msg-meta { font-size:10px; color: var(--text3); margin-bottom:2px; }
  .msg-row.user .msg-meta { text-align:right; }

  /* markdown */
  .bubble p { margin:3px 0; }
  .bubble pre {
    background: rgba(0,0,0,.4); padding:8px 10px; border-radius: var(--r-sm);
    overflow-x:auto; margin:6px 0; font-size:12px;
  }
  .bubble code { font-family: var(--vscode-editor-font-family, Consolas, monospace); font-size:12px; }
  .bubble p code { background:rgba(255,255,255,.08); padding:1px 4px; border-radius:3px; }
  .bubble ul, .bubble ol { padding-left:18px; margin:4px 0; }
  .bubble li { margin:2px 0; }
  .bubble h1,.bubble h2,.bubble h3 { margin:8px 0 4px; font-weight:600; }
  .bubble h2 { font-size:14px; color: var(--accent); }
  .bubble h3 { font-size:13px; }
  .bubble strong { color:#fff; }
  .bubble blockquote { border-left:3px solid var(--accent); padding-left:8px; margin:4px 0; color: var(--text2); }

  .stream-cursor::after { content:'▊'; color: var(--accent); animation: blink .8s step-end infinite; margin-left:1px; }
  @keyframes blink { 50% { opacity:0; } }

  /* ─── 空状态 ─── */
  .empty {
    flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center;
    color: var(--text3); text-align:center; gap:8px; padding:30px;
  }
  .empty .eico { font-size:36px; opacity:.4; }
  .empty .ehint { font-size:11px; opacity:.7; max-width:280px; line-height:1.6; }

  /* ─── 输入区 ─── */
  .input-area {
    padding:8px 12px 10px;
    background: var(--bg-elevated);
    border-top:1px solid var(--border-subtle);
    flex-shrink:0;
    position:relative;
  }
  .toolbar {
    display:flex; align-items:center; gap:2px; margin-bottom:6px;
  }
  .tool-btn {
    display:inline-flex; align-items:center; justify-content:center;
    width:28px; height:26px;
    border:none; border-radius: var(--r-sm);
    background:transparent; color: var(--text3); cursor:pointer;
    font-size:14px; transition: all var(--transition);
    position:relative;
  }
  .tool-btn:hover { background: var(--bg-hover); color: var(--text); }
  .tool-btn .tip {
    display:none; position:absolute; bottom:calc(100% + 4px); left:50%; transform:translateX(-50%);
    padding:3px 7px; background: var(--bg-card); border:1px solid var(--border);
    border-radius:3px; font-size:11px; white-space:nowrap; color: var(--text);
    box-shadow: var(--shadow); z-index:10;
  }
  .tool-btn:hover .tip { display:block; }
  .tool-spacer { flex:1; }
  .timer { font-size:11px; color: var(--text3); padding:0 6px; font-variant-numeric:tabular-nums; }
  .context-usage { font-size:10px; color:var(--text3); padding:2px 7px; border:1px solid var(--border-subtle); border-radius:10px; font-variant-numeric:tabular-nums; white-space:nowrap; }
  .context-usage.warn { color:var(--warning); border-color:rgba(245,158,11,.45); }
  .context-usage.danger { color:var(--danger); border-color:rgba(239,68,68,.45); }
  .model-name { font-size:11px; color: var(--text2); margin-left:3px; max-width:130px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; display:inline-block; vertical-align:middle; }
  #btnModel { padding:0 8px; width:auto; gap:2px; }
  #btnModel:hover .model-name { color: var(--text); }

  /* ─── 模型下拉弹窗 ─── */
  .model-dropdown {
    position:absolute; bottom:calc(100% + 6px); right:0;
    min-width:200px; max-height:280px; overflow-y:auto;
    background: var(--bg-elevated); border:1px solid var(--border);
    border-radius: var(--r-md); box-shadow: 0 4px 20px rgba(0,0,0,.4);
    z-index:100; display:none; flex-direction:column;
    padding:4px;
    animation: fadeIn .15s ease;
  }
  .model-dropdown.show { display:flex; }
  .model-dropdown::-webkit-scrollbar { width:5px; }
  .model-dropdown::-webkit-scrollbar-thumb { background:var(--border); border-radius:3px; }
  .model-item {
    display:flex; align-items:center; gap:6px;
    padding:6px 10px; border-radius: var(--r-sm);
    cursor:pointer; font-size:12px; color: var(--text);
    transition: background var(--transition); white-space:nowrap;
  }
  .model-item:hover { background: var(--bg-hover); }
  .model-item.active { background: rgba(14,99,156,.15); color: var(--accent); }
  .model-item .mi-check { font-size:10px; opacity:0; flex-shrink:0; }
  .model-item.active .mi-check { opacity:1; }
  .model-item .mi-name { flex:1; overflow:hidden; text-overflow:ellipsis; }
  .model-item .mi-tag { font-size:9px; padding:1px 5px; border-radius:8px; background:rgba(78,201,112,.12); color:var(--success); flex-shrink:0; }
  .model-dropdown-sep { height:1px; background:var(--border-subtle); margin:4px 0; }
  .model-item.manage { color: var(--text2); font-size:11px; }
  .model-item.manage:hover { color: var(--accent); }

  .input-box {
    display:flex; gap:8px; align-items:flex-end;
    background: var(--bg-input); border:1px solid var(--border);
    border-radius: var(--r-md); padding:7px 9px;
    transition: border-color var(--transition);
  }
  .input-box:focus-within { border-color: var(--accent); }
  .draft-contexts { display:none; flex-wrap:wrap; gap:5px; margin-bottom:6px; }
  .draft-contexts.show { display:flex; }
  .draft-context-chip {
    display:inline-flex; align-items:center; gap:5px; max-width:240px;
    min-height:22px; padding:2px 5px 2px 7px; border:1px solid var(--border);
    border-radius:4px; background:var(--bg-hover); color:var(--text2); font-size:11px;
  }
  .draft-context-label { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .draft-context-remove {
    display:inline-flex; align-items:center; justify-content:center; width:16px; height:16px;
    border:0; border-radius:3px; padding:0; background:transparent; color:var(--text3); cursor:pointer;
  }
  .draft-context-remove:hover { background:var(--danger-bg); color:var(--danger); }
  .input-box textarea {
    flex:1; resize:none; min-height:20px; max-height:120px;
    border:none; background:transparent; color: var(--text);
    font-family:inherit; font-size:13px; line-height:1.5;
    outline:none; padding:0 2px;
  }
  .input-box textarea::placeholder { color: var(--text3); }
  .cmd-hint {
    position:absolute; bottom:52px; left:12px; right:12px;
    max-height:240px; overflow-y:auto;
    background:var(--bg-elevated); border:1px solid var(--border);
    border-radius:var(--r-md); box-shadow:0 -4px 16px rgba(0,0,0,.25);
    z-index:200;
  }
  .cmd-hint-item {
    display:flex; align-items:center; gap:10px; padding:8px 12px; cursor:pointer;
    border-bottom:1px solid var(--border-subtle); font-size:12px;
  }
  .cmd-hint-item:last-child { border-bottom:none; }
  .cmd-hint-item:hover, .cmd-hint-item.active { background:var(--bg-hover); }
  .cmd-hint-cmd { font-weight:600; color:var(--accent); min-width:80px; }
  .cmd-hint-label { color:var(--text2); flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .cmd-hint-file-icon { color:var(--text3); font-size:14px; flex-shrink:0; }
  .cmd-hint-file-path { color:var(--text); flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family:var(--vscode-editor-font-family, monospace); font-size:11px; }
  .cmd-hint-file-name { color:var(--accent); font-weight:600; }
  .send-btn {
    display:inline-flex; align-items:center; justify-content:center;
    width:30px; height:30px; border:none; border-radius:50%;
    background: var(--accent); color: var(--user-text);
    cursor:pointer; font-size:14px; transition: all var(--transition);
    flex-shrink:0;
  }
  .send-btn:hover { background: var(--accent-hover); transform:scale(1.05); }
  .send-btn.stop { background: var(--danger); }
  .send-btn.stop:hover { background: var(--danger); }

  .ws-bar {
    padding:4px 12px; background: var(--bg-elevated);
    border-bottom:1px solid var(--border-subtle);
    font-size:11px; color: var(--text2); display:flex; align-items:center; gap:6px;
    flex-shrink:0;
  }
  .ws-bar .dot { width:6px; height:6px; border-radius:50%; background: var(--success); }

  /* ─── 设置弹窗 ─── */
  .modal-overlay {
    position:fixed; inset:0; z-index:999;
    background:rgba(0,0,0,.55);
    display:flex; align-items:center; justify-content:center;
    backdrop-filter:blur(3px); animation:modalFadeIn .15s ease;
  }
  @keyframes modalFadeIn { from{opacity:0} to{opacity:1} }
  .settings-modal {
    width:400px; max-height:78vh; overflow-y:auto;
    background:var(--bg-elevated); border:1px solid var(--border);
    border-radius:12px; box-shadow:0 8px 40px rgba(0,0,0,.5),0 20px 60px rgba(0,0,0,.35);
    animation:modalSlideUp .2s cubic-bezier(.16,1,.3,1);
  }
  @keyframes modalSlideUp { from{opacity:0;transform:translateY(14px) scale(.97)} to{opacity:1;transform:none} }
  @keyframes mFadeIn { from{opacity:0} to{opacity:1} }
  .modal-header {
    display:flex; align-items:center; justify-content:space-between;
    padding:13px 16px; border-bottom:1px solid var(--border-subtle);
  }
  .modal-header h3 { font-size:13.5px; font-weight:600; color:var(--text); display:flex; align-items:center; gap:6px; margin:0; }
  .modal-close-btn {
    width:26px; height:26px; border-radius:50%; border:none;
    background:transparent; color:var(--text3); cursor:pointer;
    font-size:14px; display:flex; align-items:center; justify-content:center;
    transition:all var(--transition);
  }
  .modal-close-btn:hover { background:rgba(255,255,255,.08); color:var(--text); }
  .modal-body { padding:14px 16px; }
  .setting-group { margin-bottom:12px; }
  .setting-group:last-child { margin-bottom:0; }
  .setting-label {
    display:flex; align-items:center; gap:3px;
    font-size:10.5px; font-weight:600; text-transform:uppercase; letter-spacing:.4px;
    color:var(--text2); margin-bottom:5px;
  }
  .setting-input {
    width:100%; padding:7px 9px; border-radius:6px;
    border:1px solid var(--border); background:var(--bg-input); color:var(--text);
    font-size:12px; font-family:inherit; outline:none;
    transition:border-color var(--transition);
  }
  .setting-input:focus { border-color:var(--accent); box-shadow:0 0 0 2px rgba(14,99,156,.18); }
  .setting-input::placeholder { color:var(--text3); opacity:.7; }
  .model-presets { display:flex; gap:3px; flex-wrap:wrap; margin-top:5px; }
  .preset-chip {
    padding:2px 7px; border-radius:12px; font-size:9.5px; cursor:pointer;
    border:1px solid var(--border); background:transparent; color:var(--text2);
    transition:all var(--transition);
  }
  .preset-chip:hover { border-color:var(--accent); color:var(--accent); background:rgba(14,99,156,.08); }
  .preset-chip.active { background:rgba(14,99,156,.12); border-color:var(--accent); color:var(--accent); }
  .modal-footer {
    display:flex; align-items:center; justify-content:space-between;
    padding:11px 16px; border-top:1px solid var(--border-subtle);
  }
  .btn-modal {
    padding:5px 14px; border-radius:6px; font-size:11.5px; font-weight:500; cursor:pointer;
    transition:all var(--transition); border:1px solid var(--border);
    background:transparent; color:var(--text2);
  }
  .btn-modal:hover { background:var(--bg-hover); color:var(--text); }
  .btn-modal-primary { background:var(--accent); border-color:var(--accent); color:#fff; }
  .btn-modal-primary:hover { background:var(--accent-hover); border-color:var(--accent-hover); }
  .config-status { font-size:10.5px; color:var(--text3); display:flex; align-items:center; gap:4px; }
  .config-dot { width:5px; height:5px; border-radius:50%; display:inline-block; }
  .config-dot.custom { background:var(--accent); }
  .config-dot.global { background:var(--text3); }

  /* ─── +按钮角色下拉（fixed 定位避免被 tab-bar overflow 裁剪）─── */
  .role-quick-dropdown {
    position:fixed; z-index:200;
    min-width:220px; max-height:320px; overflow-y:auto;
    background: var(--bg-elevated); border:1px solid var(--border);
    border-radius: var(--r-md); box-shadow: 0 4px 20px rgba(0,0,0,.4);
    display:none; flex-direction:column;
    padding:4px; animation: fadeIn .15s ease;
  }
  .role-quick-dropdown.show { display:flex; }
  .role-quick-dropdown::-webkit-scrollbar { width:5px; }
  .role-quick-dropdown::-webkit-scrollbar-thumb { background:var(--border); border-radius:3px; }
  .rq-item {
    display:flex; align-items:center; gap:7px;
    padding:6px 10px; border-radius: var(--r-sm);
    cursor:pointer; font-size:12px; color: var(--text);
    transition: background var(--transition); white-space:nowrap;
  }
  .rq-item:hover { background: var(--bg-hover); }
  .rq-item .rq-icon { font-size:14px; flex-shrink:0; }
  .rq-item .rq-name { flex:1; overflow:hidden; text-overflow:ellipsis; }
  .rq-item .rq-cat { font-size:9px; padding:1px 5px; border-radius:8px; background:rgba(255,255,255,.06); color:var(--text2); flex-shrink:0; }
  .rq-sep { height:1px; background:var(--border-subtle); margin:4px 0; }
  .rq-item.manage { color: var(--text2); font-size:11px; }
  .rq-item.manage:hover { color: var(--accent); }

  /* ─── 角色编辑器弹窗 ─── */
  .role-editor-modal {
    width:min(1000px, calc(100vw - 28px)); height:min(720px, calc(100vh - 28px));
    max-height:none; overflow:hidden; border-radius:8px; display:flex; flex-direction:column;
  }
  .role-editor-modal .modal-header { min-height:42px; padding:9px 12px; }
  .role-editor-modal .modal-header h3 { font-size:13px; }
  .role-editor-body { display:flex; flex:1; min-height:0; }
  .role-editor-left {
    width:220px; flex-shrink:0; border-right:1px solid var(--border-subtle);
    display:flex; flex-direction:column; background:var(--bg);
  }
  .re-list-tools { display:flex; gap:6px; padding:8px; border-bottom:1px solid var(--border-subtle); }
  .re-search {
    flex:1; min-width:0; padding:6px 8px; border:1px solid var(--border-subtle);
    border-radius:6px; background:var(--bg-input); color:var(--text); font:inherit; font-size:11px; outline:none;
  }
  .re-search:focus { border-color:var(--accent); }
  .re-add-btn {
    flex-shrink:0; padding:5px 9px; border:1px solid var(--accent); border-radius:6px;
    background:rgba(14,99,156,.12); color:var(--accent); font-size:11px; cursor:pointer;
  }
  .re-add-btn:hover { background:rgba(14,99,156,.22); }
  .role-editor-list { flex:1; overflow-y:auto; padding:5px; }
  .role-editor-list::-webkit-scrollbar, .role-editor-right::-webkit-scrollbar { width:5px; }
  .role-editor-list::-webkit-scrollbar-thumb, .role-editor-right::-webkit-scrollbar-thumb { background:var(--border); border-radius:3px; }
  .re-item {
    display:grid; grid-template-columns:22px minmax(0,1fr); column-gap:7px; align-items:center;
    padding:7px 8px; border:1px solid transparent; border-radius:6px;
    cursor:pointer; color:var(--text); transition:background var(--transition), border-color var(--transition);
  }
  .re-item:hover { background:var(--bg-hover); }
  .re-item.active { background:rgba(14,99,156,.18); border-color:var(--accent); }
  .re-item .re-icon { grid-row:1 / 3; font-size:14px; text-align:center; }
  .re-item-title { display:flex; align-items:center; gap:5px; min-width:0; }
  .re-item .re-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:11.5px; }
  .re-item .re-builtin { flex-shrink:0; font-size:8px; color:var(--text3); border:1px solid var(--border-subtle); border-radius:8px; padding:0 4px; }
  .re-meta { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--text3); font-size:9px; margin-top:2px; }
  .role-editor-right { flex:1; min-width:0; overflow-y:auto; background:var(--bg-elevated); }
  .re-form-empty { display:flex; align-items:center; justify-content:center; height:100%; color:var(--text3); font-size:12px; }
  .re-form { display:flex; flex-direction:column; min-height:100%; }
  .re-form-scroll { display:flex; flex-direction:column; gap:9px; padding:14px 16px; flex:1; }
  .re-form-row { display:grid; grid-template-columns:58px minmax(0,1fr); gap:10px; }
  .re-form-row.equal { grid-template-columns:minmax(0,1fr) minmax(0,1fr); }
  .re-form textarea {
    width:100%; min-height:58px; resize:vertical; padding:7px 9px; border-radius:6px;
    border:1px solid var(--border); background:var(--bg-input); color:var(--text);
    font-size:12px; line-height:1.5; font-family:inherit; outline:none; transition:border-color var(--transition);
  }
  .re-form textarea:focus { border-color:var(--accent); }
  .re-form .re-prompt { min-height:190px; font-family:var(--vscode-editor-font-family, monospace); }
  .re-form select { padding:7px 9px; border-radius:6px; border:1px solid var(--border); background:var(--bg-input); color:var(--text); font-size:12px; font-family:inherit; outline:none; }
  .re-help { color:var(--text3); font-size:9.5px; margin-top:4px; }
  .tool-perm-grid { display:flex; flex-direction:column; gap:8px; }
  .tool-perm-group { display:flex; flex-direction:column; gap:4px; }
  .tool-perm-group-label { font-size:10px; font-weight:600; color:var(--text2); text-transform:uppercase; letter-spacing:.4px; }
  .tool-perm-row { display:flex; align-items:center; gap:6px; padding:4px 8px; border-radius:5px; background:var(--bg-input); }
  .tool-perm-name { flex:1; font-size:11px; color:var(--text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .tool-perm-toggle { display:flex; gap:2px; flex-shrink:0; }
  .tool-perm-btn {
    padding:2px 8px; border:1px solid var(--border); border-radius:10px;
    font-size:9.5px; cursor:pointer; background:transparent; color:var(--text3);
    transition:all var(--transition); user-select:none;
  }
  .tool-perm-btn:hover { border-color:var(--text3); }
  .tool-perm-btn.active.allow { background:var(--accent); color:var(--user-text); border-color:var(--accent); }
  .tool-perm-btn.active.deny { background:var(--danger); color:#fff; border-color:var(--danger); }
  .re-form-actions {
    position:sticky; bottom:0; display:flex; align-items:center; gap:8px; justify-content:flex-end;
    padding:10px 14px; border-top:1px solid var(--border-subtle); background:var(--bg-elevated);
  }
  .re-form-status { margin-right:auto; color:var(--text3); font-size:10px; }
  @media (max-width:640px) {
    .role-editor-left { width:176px; }
    .re-form-row, .re-form-row.equal { grid-template-columns:1fr; }
  }

  /* ─── Todo List 面板 ─── */
  .todo-panel {
    flex-shrink:0; max-height:220px; overflow-y:auto;
    background:var(--bg-elevated); border-bottom:1px solid var(--border-subtle);
    padding:8px 12px; display:none; flex-direction:column; gap:4px;
  }
  .todo-panel.show { display:flex; }
  .todo-panel::-webkit-scrollbar { width:5px; }
  .todo-panel::-webkit-scrollbar-thumb { background:var(--border); border-radius:3px; }
  .todo-header {
    display:flex; align-items:center; gap:6px; font-size:11px; color:var(--text2);
    margin-bottom:2px; user-select:none;
  }
  .todo-header .todo-progress {
    margin-left:auto; font-size:10px; color:var(--text3); font-variant-numeric:tabular-nums;
  }
  .todo-item {
    display:flex; align-items:center; gap:7px; padding:4px 8px;
    border-radius:var(--r-sm); background:var(--bg-card); font-size:12px;
    transition:background var(--transition);
  }
  .todo-item:hover { background:var(--bg-hover); }
  .todo-icon {
    width:16px; height:16px; border-radius:50%; flex-shrink:0;
    display:flex; align-items:center; justify-content:center;
    font-size:10px; border:1.5px solid var(--border);
  }
  .todo-item.pending .todo-icon { border-color:var(--text3); }
  .todo-item.in_progress .todo-icon {
    border-color:#6ba3ff; border-top-color:transparent;
    animation:spinBadge .8s linear infinite;
  }
  .todo-item.completed .todo-icon {
    background:var(--success); border-color:var(--success); color:#1e1e1e;
  }
  .todo-item.completed .todo-icon::before { content:'✓'; font-weight:700; }
  .todo-item.failed .todo-icon {
    background:var(--danger); border-color:var(--danger); color:#fff;
  }
  .todo-item.failed .todo-icon::before { content:'✕'; font-weight:700; }
  .todo-content { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--text); }
  .todo-item.completed .todo-content { color:var(--text3); text-decoration:line-through; }
  .todo-priority {
    font-size:9px; padding:1px 5px; border-radius:8px; flex-shrink:0;
  }
  .todo-priority.high { background:rgba(240,100,100,.15); color:#f06464; }
  .todo-priority.medium { background:rgba(100,160,255,.12); color:#6ba3ff; }
  .todo-priority.low { background:rgba(255,255,255,.06); color:var(--text3); }
</style>
</head>
<body>

<div class="tab-bar" id="tabBar">
  <div class="tab-add" id="tabAdd" title="点击新建会话（最近角色）· 悬停可选择角色">+</div>
</div>

<!-- 角色快速下拉（独立于 tab-bar 避免 overflow 裁剪） -->
<div class="role-quick-dropdown" id="roleQuickDropdown"></div>

<div class="ws-bar" id="wsBar" style="display:none">
  <span class="dot"></span>
  <span id="wsName"></span>
</div>

<div class="todo-panel" id="todoPanel"></div>
<div class="messages" id="messages"></div>

  <div class="input-area" id="inputArea" style="display:none">
  <div class="toolbar">
    <button class="tool-btn" id="btnAttachContext" title="添加上下文">＋<span class="tip">添加上下文</span></button>
    <button class="tool-btn" id="btnContext" title="会话接力与上下文对齐">⇄<span class="tip">上下文对齐</span></button>
    <button class="tool-btn" id="btnClear">🗑️<span class="tip">清空对话</span></button>
    <button class="tool-btn" id="btnToolPerm" title="工具权限">🛠️<span class="tip">工具权限</span></button>
    <div class="tool-spacer"></div>
    <div style="position:relative; display:inline-flex; align-items:center;">
      <button class="tool-btn" id="btnModel" title="点击切换模型">🤖<span class="model-name" id="modelName">未配置模型</span><span class="tip">切换模型</span></button>
      <div class="model-dropdown" id="modelDropdown"></div>
    </div>
    <span class="context-usage" id="contextUsage" title="当前会话上下文估算占用">上下文 0 / 1M · 0%</span>
    <span class="timer" id="timer">00:00</span>
  </div>
  <div class="draft-contexts" id="draftContexts"></div>
  <div class="input-box">
    <textarea id="input" placeholder="输入消息 · / 模式 · @ 文件" rows="1"></textarea>
    <button class="send-btn" id="btnSend" title="发送 (Enter)">➤</button>
  </div>
</div>


<div class="empty" id="empty">
  <div class="eico">💬</div>
  <div>暂无会话</div>
  <div class="ehint">点击上方 + 按钮开始会话</div>
</div>

<!-- 角色编辑器弹窗 -->
<div class="modal-overlay" id="roleEditor" style="display:none">
  <div class="settings-modal role-editor-modal">
    <div class="modal-header">
      <h3>角色管理 · 选择角色创建会话</h3>
      <button class="modal-close-btn" id="roleEditorClose" title="关闭">×</button>
    </div>
    <div class="role-editor-body">
      <div class="role-editor-left">
        <div class="re-list-tools">
          <input class="re-search" id="roleEditorSearch" placeholder="搜索名称、分类或技能">
          <button class="re-add-btn" id="reAddBtn">+ 新增</button>
        </div>
        <div class="role-editor-list" id="roleEditorList"></div>
      </div>
      <div class="role-editor-right" id="roleEditorRight">
        <div class="re-form-empty">从左侧选择角色，或创建新角色</div>
      </div>
    </div>
  </div>
</div>

<!-- 工具权限弹窗 -->
<div class="modal-overlay" id="toolPermModal" style="display:none">
  <div class="settings-modal" style="width:480px;">
    <div class="modal-header">
      <h3>🛠️ 工具权限 — <span id="toolPermRoleName"></span></h3>
      <button class="modal-close-btn" id="toolPermClose" title="关闭">×</button>
    </div>
    <div class="modal-body" style="padding:14px 18px;">
      <div class="re-help" style="margin-bottom:8px;">允许 = 白名单模式（仅启用选中工具，留空=继承全部）；禁止 = 黑名单（优先排除）。</div>
      <div id="toolPermGrid"></div>
    </div>
    <div class="modal-footer">
      <span class="config-status" id="toolPermStatus"></span>
      <button class="btn-modal btn-modal-primary" id="toolPermSave">保存</button>
    </div>
  </div>
</div>

<!-- 工具审批弹窗 -->
<div class="modal-overlay" id="approvalModal" style="display:none">
  <div class="settings-modal" style="width:520px;">
    <div class="modal-header">
      <h3 id="approvalTitle">⚠️ 工具审批</h3>
      <button class="modal-close-btn" id="approvalDeny" title="拒绝">×</button>
    </div>
    <div class="modal-body" style="padding:14px 18px;">
      <pre id="approvalDetail" style="white-space:pre-wrap;font-size:12px;line-height:1.6;color:var(--text2);font-family:var(--vscode-editor-font-family,monospace);max-height:300px;overflow-y:auto;"></pre>
    </div>
    <div class="modal-footer">
      <span class="config-status" id="approvalStatus" style="flex:1;">
        <label style="display:flex;align-items:center;gap:4px;font-size:11px;cursor:pointer;">
          <input type="checkbox" id="approvalRemember" style="margin:0;"> 记住选择（后续自动批准此工具）
        </label>
      </span>
      <button class="btn-modal" id="approvalDenyBtn">拒绝</button>
      <button class="btn-modal btn-modal-primary" id="approvalApprove">允许</button>
    </div>
  </div>
</div>

<script>
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const messagesEl = $('messages');
  const inputEl = $('input');
  const btnSend = $('btnSend');
  const tabBarEl = $('tabBar');
  const tabAdd = $('tabAdd');
  const inputArea = $('inputArea');
  const emptyEl = $('empty');
  const wsBar = $('wsBar');
  const todoPanelEl = $('todoPanel');
  const cmdHintEl = document.createElement('div');
  cmdHintEl.className = 'cmd-hint';
  cmdHintEl.style.display = 'none';
  inputArea.appendChild(cmdHintEl);
  let cmdHintMode = null; // 'slash' | 'file' | null
  let cmdHintItems = [];
  let cmdHintActiveIdx = 0;

  let curSession = null;
  let isStreaming = false;
  let curRoleName = 'AI';
  let curRoleIcon = '💬';
  let timerInt = null;
  let timerSec = 0;
  let autoFollowOutput = true;
  let currentToolStatusEl = null;
  const toolStatusElements = new Map();
  // sessionId → streaming 状态（用于渲染标签 loading 点）
  let tabStreamingMap = {};
  const draftContextsBySession = {};

  // ─── 工具 ───
  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');
  }
  function isNearBottom() {
    return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight <= 48;
  }
  function scrollBottom(force) {
    if (!force && !autoFollowOutput) return;
    requestAnimationFrame(() => {
      if (force || autoFollowOutput) messagesEl.scrollTop = messagesEl.scrollHeight;
    });
  }
  messagesEl.addEventListener('scroll', () => {
    autoFollowOutput = isNearBottom();
  }, { passive: true });
  function formatTokens(value) {
    if (value >= 1000000) return (value / 1000000).toFixed(value >= 10000000 ? 0 : 1).replace(/\.0$/, '') + 'M';
    if (value >= 1000) return (value / 1000).toFixed(value >= 100000 ? 0 : 1).replace(/\.0$/, '') + 'K';
    return String(value || 0);
  }
  function updateContextUsage(usage) {
    if (!usage) return;
    const el = $('contextUsage');
    el.textContent = '上下文 ' + formatTokens(usage.used) + ' / ' + formatTokens(usage.limit) + ' · ' + usage.percent + '%';
    el.title = '估算已占用 ' + usage.used.toLocaleString() + ' tokens，上限 ' + usage.limit.toLocaleString() + ' tokens' + (usage.percent >= 70 ? '。点击接力到新会话，避免压缩丢失重要信息。' : '。点击可进行会话接力或跨会话对齐。');
    el.style.cursor = 'pointer';
    el.classList.toggle('warn', usage.percent >= 70 && usage.percent < 90);
    el.classList.toggle('danger', usage.percent >= 90);
  }

  function renderMarkdown(text) {
    if (!text) return '';
    let h = esc(text);
    h = h.replace(/\\x60\\x60\\x60(\\w*)\\n?([\\s\\S]*?)\\x60\\x60\\x60/g, (_, lang, code) =>
      '<pre><code class="language-'+(lang||'')+'">'+code.trim()+'</code></pre>');
    h = h.replace(/\\x60([^\\x60\\n]+)\\x60/g, '<code>$1</code>');
    h = h.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
    h = h.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    h = h.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    h = h.replace(/^# (.+)$/gm, '<h1>$1</h1>');
    h = h.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
    h = h.replace(/\\*(.+?)\\*/g, '<em>$1</em>');
    h = h.replace(/^&gt;\\s?(.+)$/gm, '<blockquote>$1</blockquote>');
    h = h.replace(/^- (.+)$/gm, '<li>$1</li>');
    h = h.replace(/(<li>[\\s\\S]*?<\\/li>)/g, '<ul>$1</ul>');
    h = h.replace(/^\\d+. (.+)$/gm, '<li>$1</li>');
    h = h.replace(/\\n/g, '<br>');
    h = h.replace(/<ul><\\/ul>/g, '');
    h = h.replace(/<br><br>/g, '<br>');
    return h;
  }

  // ─── 标签栏渲染 ───
  function renderTabs(tabs) {
    tabStreamingMap = {};
    // 保留 add 按钮
    [...tabBarEl.querySelectorAll('.session-tab')].forEach(n => n.remove());
    if (!tabs || tabs.length === 0) {
      showEmpty(true);
      return;
    }
    showEmpty(false);
    tabs.forEach(t => {
      if (t.streaming) tabStreamingMap[t.id] = true;
      const tab = document.createElement('div');
      tab.className = 'session-tab' + (t.isActive ? ' active' : '') + (t.streaming ? ' streaming' : '');
      tab.dataset.sessionId = t.id;
      tab.innerHTML =
        '<span class="tab-ico">'+esc(t.roleIcon)+'</span>' +
        '<span>'+esc(t.roleName)+'</span>' +
        '<span class="tab-close" title="关闭标签">✕</span>';
      tab.addEventListener('click', (e) => {
        if (e.target.classList.contains('tab-close')) {
          e.stopPropagation();
          vscode.postMessage({ type:'closeTab', sessionId:t.id });
          return;
        }
        vscode.postMessage({ type:'switchTab', sessionId:t.id });
      });
      tabBarEl.insertBefore(tab, tabAdd);
    });
  }

  function showEmpty(empty) {
    emptyEl.style.display = empty ? 'flex' : 'none';
    inputArea.style.display = empty ? 'none' : 'block';
  }

  // ─── 消息渲染 ───
  function renderMessages(sessionId, role, messages) {
    curSession = sessionId;
    curRoleName = role ? role.name : 'AI';
    curRoleIcon = role ? role.icon : '💬';
    messagesEl.innerHTML = '';
    if (!messages || messages.length === 0) {
      messagesEl.innerHTML = '<div style="text-align:center;color:var(--text3);padding:30px;font-size:12px;">开始与 '+esc(curRoleName)+' 对话</div>';
      return;
    }
    autoFollowOutput = true;
    messages.forEach(m => appendMessage(m.role, m.content, m.createdAt, sessionId));
    scrollBottom(true);
  }

  // ─── Todo List 渲染 ───
  const todoIcons = { pending: '○', in_progress: '◐', completed: '✓', failed: '✕' };
  function renderTodoPanel(sessionId, items) {
    if (sessionId !== curSession) return;
    if (!items || items.length === 0) {
      todoPanelEl.classList.remove('show');
      todoPanelEl.innerHTML = '';
      return;
    }
    const completed = items.filter(i => i.status === 'completed').length;
    const failed = items.filter(i => i.status === 'failed').length;
    const total = items.length;
    const progress = completed + (failed ? '/' + failed : '') + ' / ' + total;
    let html = '<div class="todo-header"><span>📋 任务清单</span><span class="todo-progress">' + progress + '</span></div>';
    html += items.map(function(item) {
      return '<div class="todo-item ' + item.status + '">' +
        '<span class="todo-icon"></span>' +
        '<span class="todo-content" title="' + esc(item.content) + '">' + esc(item.content) + '</span>' +
        '<span class="todo-priority ' + item.priority + '">' + item.priority + '</span>' +
      '</div>';
    }).join('');
    todoPanelEl.innerHTML = html;
    todoPanelEl.classList.add('show');
  }

  function ensureReasoningPanel(bubble) {
    if (!bubble) return null;
    const container = bubble.parentElement;
    let panel = container.querySelector('.reasoning-panel');
    if (!panel) {
      panel = document.createElement('details');
      panel.className = 'reasoning-panel is-streaming';
      panel.open = true;
      panel.innerHTML = '<summary>思考中...</summary><div class="reasoning-content is-streaming"></div>';
      container.insertBefore(panel, bubble);
    }
    return panel;
  }

  function ensureToolBadges(bubble) {
    if (!bubble) return null;
    const container = bubble.parentElement;
    let el = container.querySelector('.tool-badges');
    if (!el) {
      el = document.createElement('div');
      el.className = 'tool-badges';
      container.insertBefore(el, bubble);
    }
    return el;
  }

  function appendMessage(role, content, createdAt, sessionId) {
    if (curSession !== sessionId) return; // 只渲染当前标签
    const row = document.createElement('div');
    row.className = 'msg-row ' + role;

    let avatarHtml = '';
    if (role === 'assistant') avatarHtml = '<div class="avatar">'+esc(curRoleIcon)+'</div>';
    else if (role === 'system') avatarHtml = '';

    const meta = '<div class="msg-meta">'+(role==='user'?'你':role==='assistant'?esc(curRoleName):'系统')+' · '+fmtTime(createdAt)+'</div>';
    const bubble = '<div class="bubble">'+(role==='system'?esc(content):renderMarkdown(content))+'</div>';

    row.innerHTML = avatarHtml +
      '<div>' + meta + bubble + '</div>';
    messagesEl.appendChild(row);
    scrollBottom(false);
    return row.querySelector('.bubble');
  }

  // ─── 流式状态 ───
  function setStreaming(streaming) {
    isStreaming = streaming;
    if (streaming) {
      btnSend.classList.add('stop');
      btnSend.textContent = '■';
      startTimer();
    } else {
      btnSend.classList.remove('stop');
      btnSend.textContent = '➤';
      stopTimer();
    }
  }

  function startTimer() {
    stopTimer();
    timerSec = 0;
    $('timer').textContent = '00:00';
    timerInt = setInterval(() => {
      timerSec++;
      const m = String(Math.floor(timerSec/60)).padStart(2,'0');
      const s = String(timerSec%60).padStart(2,'0');
      $('timer').textContent = m+':'+s;
    }, 1000);
  }
  function stopTimer() {
    if (timerInt) { clearInterval(timerInt); timerInt = null; }
  }

  function getDraftContexts() {
    if (!curSession) return [];
    if (!draftContextsBySession[curSession]) draftContextsBySession[curSession] = [];
    return draftContextsBySession[curSession];
  }

  function getContextLabel(content) {
    const reference = (content.split('\\n', 1)[0] || '').replace(/^@/, '');
    const match = reference.match(/(?:^|\\/)([^/:]+):L(\\d+)-L(\\d+)$/);
    return match ? '@' + match[1] + '#L' + match[2] + '-' + match[3] : '@' + reference;
  }

  function renderDraftContexts() {
    const container = $('draftContexts');
    const contexts = getDraftContexts();
    container.classList.toggle('show', contexts.length > 0);
    container.innerHTML = '';
    contexts.forEach((context, index) => {
      const chip = document.createElement('span');
      chip.className = 'draft-context-chip';
      chip.title = context.content.split('\\n', 1)[0] || context.label;
      chip.innerHTML = '<span class="draft-context-label">' + esc(context.label) + '</span>' +
        '<button class="draft-context-remove" title="移除上下文" aria-label="移除 ' + esc(context.label) + '">×</button>';
      chip.querySelector('button').addEventListener('click', () => {
        contexts.splice(index, 1);
        renderDraftContexts();
        inputEl.focus();
      });
      container.appendChild(chip);
    });
  }

  function appendDraftContext(content) {
    if (!curSession || !content) return;
    const contexts = getDraftContexts();
    if (!contexts.some(context => context.content === content)) {
      contexts.push({ label: getContextLabel(content), content });
    }
    renderDraftContexts();
    inputEl.focus();
  }

  // ─── 发送 ───
  function send() {
    const v = inputEl.value.trim();
    const contexts = getDraftContexts();
    if ((!v && contexts.length === 0) || isStreaming) return;
    const contextContent = contexts.map(context => context.content).join('\\n\\n');
    const content = [v, contextContent].filter(Boolean).join('\\n\\n');
    vscode.postMessage({ type:'sendMessage', sessionId:curSession, content });
    inputEl.value = '';
    inputEl.style.height = 'auto';
    draftContextsBySession[curSession] = [];
    renderDraftContexts();
  }

  // ─── 事件绑定 ───
  $('btnAttachContext').addEventListener('click', () => {
    vscode.postMessage({ type:'pickEditorContext' });
  });

  btnSend.addEventListener('click', () => {
    if (isStreaming) {
      vscode.postMessage({ type:'abortStream', sessionId:curSession });
    } else {
      send();
    }
  });

  tabAdd.addEventListener('click', (e) => {
    e.stopPropagation();
    vscode.postMessage({ type:'newSession' });
  });

  // ─── +按钮悬停角色下拉 ───
  const roleQuickDropdown = $('roleQuickDropdown');
  let curRoles = [];
  let curLastUsedRoleId = '';
  let roleDropdownHoverTimer = null;

  function renderRoleQuickDropdown() {
    if (!curRoles || curRoles.length === 0) {
      roleQuickDropdown.innerHTML =
        '<div class="rq-item manage" id="rqManage">⚙️ 新增角色</div>';
    } else {
      let html = curRoles.map(r =>
        '<div class="rq-item" data-rid="' + esc(r.id) + '">' +
          '<span class="rq-icon">' + esc(r.icon) + '</span>' +
          '<span class="rq-name">' + esc(r.name) + '</span>' +
          '<span class="rq-cat">' + esc(r.categoryLabel) + '</span>' +
        '</div>'
      ).join('');
      html += '<div class="rq-sep"></div>';
      html += '<div class="rq-item manage" id="rqManage">⚙️ 管理角色</div>';
      roleQuickDropdown.innerHTML = html;
    }
    roleQuickDropdown.querySelectorAll('.rq-item[data-rid]').forEach(el => {
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        vscode.postMessage({ type:'createSession', roleId:el.dataset.rid });
        roleQuickDropdown.classList.remove('show');
      });
    });
    const manageEl = $('rqManage');
    if (manageEl) manageEl.addEventListener('click', (ev) => {
      ev.stopPropagation();
      vscode.postMessage({ type:'getRoles' });
      roleQuickDropdown.classList.remove('show');
    });
  }

  // 悬停显示下拉
  function positionDropdown() {
    const rect = $('tabAdd').getBoundingClientRect();
    roleQuickDropdown.style.left = rect.left + 'px';
    roleQuickDropdown.style.top = (rect.bottom + 4) + 'px';
  }
  $('tabAdd').addEventListener('mouseenter', () => {
    clearTimeout(roleDropdownHoverTimer);
    renderRoleQuickDropdown();
    positionDropdown();
    roleQuickDropdown.classList.add('show');
  });
  $('tabAdd').addEventListener('mouseleave', () => {
    roleDropdownHoverTimer = setTimeout(() => {
      roleQuickDropdown.classList.remove('show');
    }, 200);
  });
  roleQuickDropdown.addEventListener('mouseenter', () => {
    clearTimeout(roleDropdownHoverTimer);
  });
  roleQuickDropdown.addEventListener('mouseleave', () => {
    roleDropdownHoverTimer = setTimeout(() => {
      roleQuickDropdown.classList.remove('show');
    }, 200);
  });
  document.addEventListener('click', (e) => {
    if (!roleQuickDropdown.contains(e.target) && e.target !== $('tabAdd')) {
      roleQuickDropdown.classList.remove('show');
    }
  });

  // ─── 角色编辑器弹窗 ───
  const roleEditor = $('roleEditor');
  const roleEditorList = $('roleEditorList');
  const roleEditorRight = $('roleEditorRight');
  const roleEditorSearch = $('roleEditorSearch');
  let editingRoleId = null;
  let isCreatingRole = false;

  $('roleEditorClose').addEventListener('click', () => {
    roleEditor.style.display = 'none';
  });
  roleEditor.addEventListener('click', (e) => {
    if (e.target === roleEditor) roleEditor.style.display = 'none';
  });
  roleEditorSearch.addEventListener('input', renderRoleEditorList);
  $('reAddBtn').addEventListener('click', () => {
    isCreatingRole = true;
    editingRoleId = null;
    renderRoleEditorList();
    renderRoleForm(null);
  });

  function selectRole(roleId) {
    const role = curRoles.find(r => r.id === roleId);
    if (!role) return;
    isCreatingRole = false;
    editingRoleId = role.id;
    renderRoleEditorList();
    renderRoleForm(role);
  }

  function renderRoleEditorList() {
    const query = roleEditorSearch.value.trim().toLowerCase();
    const visibleRoles = (curRoles || []).filter(r => {
      const text = [r.name, r.categoryLabel, r.description].concat(r.skills || []).join(' ').toLowerCase();
      return !query || text.includes(query);
    });
    if (visibleRoles.length === 0) {
      roleEditorList.innerHTML = '<div class="re-form-empty" style="height:auto;padding:18px 8px;text-align:center;">' + (curRoles.length ? '没有匹配的角色' : '暂无角色，请点击新增') + '</div>';
      return;
    }
    roleEditorList.innerHTML = visibleRoles.map(r =>
      '<div class="re-item' + (r.id === editingRoleId && !isCreatingRole ? ' active' : '') + '" data-rid="' + esc(r.id) + '">' +
        '<span class="re-icon">' + esc(r.icon) + '</span>' +
        '<span class="re-item-title"><span class="re-name">' + esc(r.name) + '</span>' + (r.builtIn ? '<span class="re-builtin">内置</span>' : '') + '</span>' +
        '<span class="re-meta">' + esc(r.categoryLabel) + (r.skills?.length ? ' · ' + esc(r.skills.slice(0, 2).join(' / ')) : '') + '</span>' +
      '</div>'
    ).join('');
    roleEditorList.querySelectorAll('.re-item').forEach(el => {
      el.addEventListener('click', () => selectRole(el.dataset.rid));
    });
  }

  function renderRoleForm(role) {
    const CATS = [
      {value:'engineering', label:'工程研发'},
      {value:'product', label:'产品'},
      {value:'design', label:'设计'},
      {value:'qa', label:'质量保障'},
      {value:'custom', label:'自定义'},
    ];
    const isNew = !role;
    const r = role || { name:'', icon:'👤', category:'custom', description:'', skillSlug:'', skills:[], skillContent:'', systemPrompt:'', builtIn:false, allowedTools:[], deniedTools:[] };
    const skillsStr = Array.isArray(r.skills) ? r.skills.join('\\n') : '';
    const catOpts = CATS.map(c =>
      '<option value="' + c.value + '"' + (c.value === r.category ? ' selected' : '') + '>' + esc(c.label) + '</option>'
    ).join('');

    const ALL_TOOLS = [
      {name:'workspace_list_files', label:'列出文件', group:'读取'},
      {name:'workspace_read_file', label:'读取文件', group:'读取'},
      {name:'workspace_search', label:'搜索内容', group:'读取'},
      {name:'git_status', label:'Git 状态', group:'读取'},
      {name:'git_diff', label:'Git Diff', group:'读取'},
      {name:'workspace_write_file', label:'写入文件', group:'编辑'},
      {name:'workspace_replace', label:'替换内容', group:'编辑'},
      {name:'workspace_apply_diff', label:'Diff 补丁', group:'编辑'},
      {name:'workspace_search_replace', label:'搜索替换', group:'编辑'},
      {name:'workspace_delete', label:'删除文件', group:'编辑'},
      {name:'run_command', label:'执行命令', group:'命令'},
      {name:'dispatch_session_task', label:'派发任务', group:'编排'},
      {name:'todo_list_create', label:'创建清单', group:'任务'},
      {name:'todo_list_update', label:'更新清单', group:'任务'},
      {name:'todo_list_read', label:'读取清单', group:'任务'},
    ];
    const allowedSet = new Set(r.allowedTools || []);
    const deniedSet = new Set(r.deniedTools || []);
    const groups = {};
    ALL_TOOLS.forEach(t => { (groups[t.group] = groups[t.group] || []).push(t); });
    const toolCheckboxes = Object.entries(groups).map(([groupLabel, tools]) => {
      const rows = tools.map(t => {
        const isAllowed = allowedSet.has(t.name);
        const isDenied = deniedSet.has(t.name);
        return '<div class="tool-perm-row">' +
          '<span class="tool-perm-name" title="' + esc(t.name) + '">' + esc(t.label) + '</span>' +
          '<div class="tool-perm-toggle">' +
            '<span class="tool-perm-btn allow' + (isAllowed ? ' active' : '') + '" data-allow="' + esc(t.name) + '">允许</span>' +
            '<span class="tool-perm-btn deny' + (isDenied ? ' active' : '') + '" data-deny="' + esc(t.name) + '">禁止</span>' +
          '</div>' +
        '</div>';
      }).join('');
      return '<div class="tool-perm-group"><div class="tool-perm-group-label">' + esc(groupLabel) + '</div>' + rows + '</div>';
    }).join('');

    roleEditorRight.innerHTML =
      '<div class="re-form">' +
        '<div class="re-form-scroll">' +
          '<div class="re-form-row">' +
            '<div class="setting-group"><div class="setting-label">图标</div><input class="setting-input" id="rfIcon" value="' + esc(r.icon) + '" maxlength="2" style="text-align:center;font-size:17px;"></div>' +
            '<div class="setting-group"><div class="setting-label">中文名称</div><input class="setting-input" id="rfName" value="' + esc(r.name) + '" placeholder="例如：Python 开发"></div>' +
          '</div>' +
          '<div class="re-form-row equal">' +
            '<div class="setting-group"><div class="setting-label">分类</div><select class="setting-input" id="rfCat">' + catOpts + '</select></div>' +
            '<div class="setting-group"><div class="setting-label">角色标识</div><input class="setting-input" value="' + (r.builtIn ? '内置角色，可修改' : isNew ? '新建自定义角色' : '自定义角色') + '" disabled></div>' +
          '</div>' +
          '<div class="setting-group"><div class="setting-label">描述</div><textarea id="rfDesc" placeholder="简要说明角色职责和适用场景">' + esc(r.description) + '</textarea></div>' +
          '<div class="setting-group"><div class="setting-label">Skill 标识</div><input class="setting-input" id="rfSkillSlug" value="' + esc(r.skillSlug) + '" placeholder="例如：frontend-development"><div class="re-help">用于稳定标识能力包；留空时创建角色会自动生成。</div></div>' +
          '<div class="setting-group"><div class="setting-label">能力目录</div><textarea id="rfSkills" placeholder="每行一个能力，例如：\\nTypeScript\\n组件设计\\n可访问性">' + esc(skillsStr) + '</textarea><div class="re-help">用于概览和检索，不承担具体执行方法。</div></div>' +
          '<div class="setting-group"><div class="setting-label">Skill 工作手册</div><textarea class="re-prompt" id="rfSkillContent" placeholder="# 工作手册\\n\\n## 适用场景\\n...\\n\\n## 执行流程\\n1. ...\\n\\n## 完成标准\\n...">' + esc(r.skillContent) + '</textarea><div class="re-help">Markdown 操作手册会在每次请求中强制激活，应写清适用场景、执行步骤、检查项和完成标准。</div></div>' +
          '<div class="setting-group"><div class="setting-label">角色提示词</div><textarea class="re-prompt" id="rfPrompt" placeholder="只定义角色身份、职责和沟通方式">' + esc(r.systemPrompt) + '</textarea><div class="re-help">角色提示词回答“是谁”；Skill 工作手册回答“如何做”。</div></div>' +
          '<div class="setting-group"><div class="setting-label">工具权限</div>' +
            '<div class="re-help" style="margin-bottom:6px;">勾选允许仅启用选定工具（白名单模式，留空=继承全部）；勾选禁止排除工具（黑名单优先）。</div>' +
            '<div class="tool-perm-grid">' + toolCheckboxes + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="re-form-actions">' +
          '<span class="re-form-status" id="rfStatus">' + (r.builtIn ? '内置角色允许修改，但不可删除' : '') + '</span>' +
          (!isNew && !r.builtIn ? '<button class="btn-modal" id="rfDelete" style="color:var(--danger);border-color:var(--danger);">删除</button>' : '') +
          (!isNew ? '<button class="btn-modal" id="rfUse">用此角色创建会话</button>' : '') +
          '<button class="btn-modal btn-modal-primary" id="rfSave">' + (isNew ? '创建' : '保存') + '</button>' +
        '</div>' +
      '</div>';

    $('rfSave').addEventListener('click', () => {
      const allowedTools = Array.from(roleEditorRight.querySelectorAll('.tool-perm-btn.allow.active')).map(el => el.dataset.allow);
      const deniedTools = Array.from(roleEditorRight.querySelectorAll('.tool-perm-btn.deny.active')).map(el => el.dataset.deny);
      const data = {
        name: $('rfName').value.trim(),
        icon: $('rfIcon').value.trim() || '👤',
        category: $('rfCat').value,
        description: $('rfDesc').value.trim(),
        skillSlug: $('rfSkillSlug').value.trim(),
        skills: $('rfSkills').value.split(/[\\n,，]+/).map(s => s.trim()).filter(Boolean),
        skillContent: $('rfSkillContent').value.trim(),
        systemPrompt: $('rfPrompt').value.trim(),
        allowedTools,
        deniedTools,
      };
      if (!data.name) { $('rfName').focus(); return; }
      $('rfStatus').textContent = '正在保存…';
      if (isNew) {
        vscode.postMessage({ type:'createRole', role:data });
      } else {
        vscode.postMessage({ type:'updateRole', id:editingRoleId, patch:data });
      }
    });
    const useBtn = $('rfUse');
    if (useBtn) useBtn.addEventListener('click', () => {
      vscode.postMessage({ type:'createSession', roleId:editingRoleId });
      roleEditor.style.display = 'none';
    });
    const delBtn = $('rfDelete');
    if (delBtn) delBtn.addEventListener('click', () => {
      if (editingRoleId) vscode.postMessage({ type:'deleteRole', id:editingRoleId });
    });
    // 工具权限 toggle 按钮事件
    roleEditorRight.querySelectorAll('.tool-perm-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const isAllow = btn.classList.contains('allow');
        const isDeny = btn.classList.contains('deny');
        if (isAllow) {
          btn.classList.toggle('active');
          // 允许和禁止互斥
          if (btn.classList.contains('active')) {
            const denyBtn = btn.parentElement.querySelector('.deny.active');
            if (denyBtn) denyBtn.classList.remove('active');
          }
        } else if (isDeny) {
          btn.classList.toggle('active');
          if (btn.classList.contains('active')) {
            const allowBtn = btn.parentElement.querySelector('.allow.active');
            if (allowBtn) allowBtn.classList.remove('active');
          }
        }
      });
    });
  }

  $('btnClear').addEventListener('click', () => {
    vscode.postMessage({ type:'clearHistory', sessionId:curSession });
  });
  $('btnContext').addEventListener('click', () => {
    vscode.postMessage({ type:'injectContext', sessionId:curSession });
  });
  $('contextUsage').addEventListener('click', () => {
    vscode.postMessage({ type:'injectContext', sessionId:curSession });
  });
  // ─── 模型切换下拉 ───
  const modelNameEl = $('modelName');
  const modelDropdown = $('modelDropdown');
  let curModels = [];
  let curDefaultModelId = '';
  let curCurrentModelId = '';

  function renderModelDropdown() {
    if (!curModels || curModels.length === 0) {
      modelDropdown.innerHTML =
        '<div class="model-item manage" id="mmManage">⚙️ 去左侧添加模型配置</div>';
    } else {
      let html = curModels.map(m => {
        const isActive = m.id === curCurrentModelId;
        const isDef = m.id === curDefaultModelId;
        return '<div class="model-item' + (isActive ? ' active' : '') + '" data-mid="' + esc(m.id) + '">' +
          '<span class="mi-name">' + esc(m.name) + '</span>' +
          (isDef ? '<span class="mi-tag">默认</span>' : '') +
          '<span class="mi-check">✓</span>' +
        '</div>';
      }).join('');
      html += '<div class="model-dropdown-sep"></div>';
      html += '<div class="model-item manage" id="mmManage">⚙️ 管理模型设置</div>';
      modelDropdown.innerHTML = html;
    }
    // 绑定点击
    modelDropdown.querySelectorAll('.model-item[data-mid]').forEach(el => {
      el.addEventListener('click', () => {
        vscode.postMessage({ type:'switchModel', sessionId:curSession, modelId:el.dataset.mid });
        modelDropdown.classList.remove('show');
      });
    });
    const manageBtn = $('mmManage');
    if (manageBtn) manageBtn.addEventListener('click', () => {
      vscode.postMessage({ type:'focusModelsView' });
      modelDropdown.classList.remove('show');
    });
  }

  $('btnModel').addEventListener('click', (e) => {
    e.stopPropagation();
    modelDropdown.classList.toggle('show');
    if (modelDropdown.classList.contains('show')) renderModelDropdown();
  });
  document.addEventListener('click', (e) => {
    if (!modelDropdown.contains(e.target) && e.target !== $('btnModel') && !$('btnModel').contains(e.target)) {
      modelDropdown.classList.remove('show');
    }
  });

  // ====== 工具权限弹窗 ======
  const TOOL_LIST = [
    {name:'workspace_list_files', label:'列出文件', group:'读取'},
    {name:'workspace_read_file', label:'读取文件', group:'读取'},
    {name:'workspace_search', label:'搜索内容', group:'读取'},
    {name:'workspace_semantic_search', label:'语义搜索', group:'读取'},
    {name:'git_status', label:'Git 状态', group:'读取'},
    {name:'git_diff', label:'Git Diff', group:'读取'},
    {name:'workspace_write_file', label:'写入文件', group:'编辑'},
    {name:'workspace_replace', label:'替换内容', group:'编辑'},
    {name:'workspace_apply_diff', label:'Diff 补了', group:'编辑'},
    {name:'workspace_search_replace', label:'搜索替换', group:'编辑'},
    {name:'workspace_delete', label:'删除文件', group:'编辑'},
    {name:'run_command', label:'执行命令', group:'命令'},
    {name:'dispatch_session_task', label:'派发任务', group:'编排'},
    {name:'orchestrate_task', label:'自动编排', group:'编排'},
    {name:'todo_list_create', label:'创建清单', group:'任务'},
    {name:'todo_list_update', label:'更新清单', group:'任务'},
    {name:'todo_list_read', label:'读取清单', group:'任务'},
  ];
  const toolPermModal = $('toolPermModal');
  const toolPermGrid = $('toolPermGrid');
  const toolPermRoleName = $('toolPermRoleName');
  const toolPermStatus = $('toolPermStatus');
  const toolPermModalDataset = { sessionId: '' };
  const btnToolPerm = $('btnToolPerm');
  if (btnToolPerm) {
    btnToolPerm.addEventListener('click', () => {
      vscode.postMessage({ type: 'openToolPermissions', sessionId: curSession });
    });
  }
  $('toolPermClose').addEventListener('click', () => {
    toolPermModal.style.display = 'none';
  });
  function renderToolPermGrid(allowedSet, deniedSet) {
    const groups = {};
    TOOL_LIST.forEach(t => { (groups[t.group] = groups[t.group] || []).push(t); });
    toolPermGrid.innerHTML = Object.entries(groups).map(([groupLabel, tools]) => {
      const rows = tools.map(t => {
        const isAllowed = allowedSet.has(t.name);
        const isDenied = deniedSet.has(t.name);
        return '<div style="display:flex;align-items:center;justify-content:space-between;padding:4px 0;">' +
          '<span style="font-size:12px;" title="' + t.name + '">' + t.label + '</span>' +
          '<div style="display:flex;gap:4px;">' +
            '<span class="tool-perm-btn allow' + (isAllowed ? ' active' : '') + '" data-allow="' + t.name + '" style="padding:2px 8px;border-radius:4px;cursor:pointer;font-size:11px;border:1px solid var(--border);' + (isAllowed ? 'background:var(--accent-dim);color:var(--accent);border-color:var(--accent);' : '') + '">允许</span>' +
            '<span class="tool-perm-btn deny' + (isDenied ? ' active' : '') + '" data-deny="' + t.name + '" style="padding:2px 8px;border-radius:4px;cursor:pointer;font-size:11px;border:1px solid var(--border);' + (isDenied ? 'background:rgba(239,68,68,0.15);color:var(--danger);border-color:var(--danger);' : '') + '">禁止</span>' +
          '</div>' +
        '</div>';
      }).join('');
      return '<div style="margin-bottom:10px;"><div style="font-size:11px;font-weight:600;color:var(--text2);text-transform:uppercase;margin-bottom:4px;">' + groupLabel + '</div>' + rows + '</div>';
    }).join('');
    toolPermGrid.querySelectorAll('.tool-perm-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const isAllow = btn.classList.contains('allow');
        if (isAllow) {
          btn.classList.toggle('active');
          if (btn.classList.contains('active')) {
            btn.style.cssText = 'padding:2px 8px;border-radius:4px;cursor:pointer;font-size:11px;border:1px solid var(--accent);background:var(--accent-dim);color:var(--accent);';
          } else {
            btn.style.cssText = 'padding:2px 8px;border-radius:4px;cursor:pointer;font-size:11px;border:1px solid var(--border);';
          }
          const denyBtn = btn.parentElement.querySelector('.deny.active');
          if (denyBtn && btn.classList.contains('active')) {
            denyBtn.classList.remove('active');
            denyBtn.style.cssText = 'padding:2px 8px;border-radius:4px;cursor:pointer;font-size:11px;border:1px solid var(--border);';
          }
        } else {
          btn.classList.toggle('active');
          if (btn.classList.contains('active')) {
            btn.style.cssText = 'padding:2px 8px;border-radius:4px;cursor:pointer;font-size:11px;border:1px solid var(--danger);background:rgba(239,68,68,0.15);color:var(--danger);';
          } else {
            btn.style.cssText = 'padding:2px 8px;border-radius:4px;cursor:pointer;font-size:11px;border:1px solid var(--border);';
          }
          const allowBtn = btn.parentElement.querySelector('.allow.active');
          if (allowBtn && btn.classList.contains('active')) {
            allowBtn.classList.remove('active');
            allowBtn.style.cssText = 'padding:2px 8px;border-radius:4px;cursor:pointer;font-size:11px;border:1px solid var(--border);';
          }
        }
      });
    });
  }
  $('toolPermSave').addEventListener('click', () => {
    const allowedTools = Array.from(toolPermGrid.querySelectorAll('.tool-perm-btn.allow.active')).map(el => el.dataset.allow);
    const deniedTools = Array.from(toolPermGrid.querySelectorAll('.tool-perm-btn.deny.active')).map(el => el.dataset.deny);
    toolPermStatus.textContent = '保存中…';
    vscode.postMessage({ type: 'updateToolPermissions', sessionId: toolPermModalDataset.sessionId, allowedTools, deniedTools });
  });

  // ====== 工具审批弹窗 ======
  const approvalModal = $('approvalModal');
  const approvalTitle = $('approvalTitle');
  const approvalDetail = $('approvalDetail');
  const approvalRemember = $('approvalRemember');
  let currentApprovalId = null;
  let currentApprovalToolName = '';
  $('approvalApprove').addEventListener('click', () => {
    if (!currentApprovalId) return;
    const remember = approvalRemember.checked;
    if (remember && currentApprovalToolName) {
      vscode.postMessage({ type: 'toolApprovalResponse', approvalId: currentApprovalId, approved: true, remember: true, toolName: currentApprovalToolName });
    } else {
      vscode.postMessage({ type: 'toolApprovalResponse', approvalId: currentApprovalId, approved: true, remember: false });
    }
    approvalModal.style.display = 'none';
    currentApprovalId = null;
  });
  $('approvalDenyBtn').addEventListener('click', () => {
    if (!currentApprovalId) return;
    vscode.postMessage({ type: 'toolApprovalResponse', approvalId: currentApprovalId, approved: false });
    approvalModal.style.display = 'none';
    currentApprovalId = null;
  });
  $('approvalDeny').addEventListener('click', () => {
    if (!currentApprovalId) return;
    vscode.postMessage({ type: 'toolApprovalResponse', approvalId: currentApprovalId, approved: false });
    approvalModal.style.display = 'none';
    currentApprovalId = null;
  });

  // ─── 命令提示（/ slash 命令 + @ 文件选择）───
  const SLASH_COMMANDS = [
    { cmd: '/code', label: '编码模式 — 直接输出可执行代码' },
    { cmd: '/ask', label: '问答模式 — 简洁准确回答问题' },
    { cmd: '/debug', label: '调试模式 — 系统化排查问题' },
    { cmd: '/architect', label: '架构模式 — 架构师视角分析设计' },
  ];
  let workspaceFiles = [];
  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg.type === 'workspaceFiles' && Array.isArray(msg.files)) {
      workspaceFiles = msg.files;
    }
  });

  function renderCmdHint() {
    if (cmdHintItems.length === 0) { cmdHintEl.style.display = 'none'; return; }
    cmdHintActiveIdx = 0;
    cmdHintEl.innerHTML = cmdHintItems.map((item, i) => {
      if (item.type === 'slash') {
        return '<div class="cmd-hint-item' + (i === 0 ? ' active' : '') + '" data-idx="' + i + '">' +
          '<span class="cmd-hint-cmd">' + esc(item.cmd) + '</span>' +
          '<span class="cmd-hint-label">' + esc(item.label) + '</span>' +
        '</div>';
      } else {
        return '<div class="cmd-hint-item' + (i === 0 ? ' active' : '') + '" data-idx="' + i + '">' +
          '<span class="cmd-hint-file-icon">📄</span>' +
          '<span class="cmd-hint-file-path"><span class="cmd-hint-file-name">' + esc(item.name) + '</span> — ' + esc(item.relPath) + '</span>' +
        '</div>';
      }
    }).join('');
    cmdHintEl.style.display = 'block';
    cmdHintEl.querySelectorAll('.cmd-hint-item').forEach(el => {
      el.addEventListener('click', () => {
        const idx = Number(el.dataset.idx);
        selectCmdHint(idx);
      });
      el.addEventListener('mouseenter', () => {
        const idx = Number(el.dataset.idx);
        setActiveHint(idx);
      });
    });
  }

  function setActiveHint(idx) {
    cmdHintActiveIdx = idx;
    const items = cmdHintEl.querySelectorAll('.cmd-hint-item');
    items.forEach((el, i) => el.classList.toggle('active', i === idx));
  }

  function selectCmdHint(idx) {
    const item = cmdHintItems[idx];
    if (!item) return;
    if (item.type === 'slash') {
      const parts = inputEl.value.split(/\s+/);
      parts[0] = item.cmd;
      inputEl.value = parts.join(' ') + ' ';
    } else if (item.type === 'file') {
      // Replace the @partial with @filePath
      const before = inputEl.value.substring(0, inputEl.selectionStart);
      const after = inputEl.value.substring(inputEl.selectionEnd);
      const atIdx = before.lastIndexOf('@');
      if (atIdx >= 0) {
        inputEl.value = before.substring(0, atIdx) + '@' + item.relPath + ' ' + after;
        const newPos = atIdx + item.relPath.length + 2;
        inputEl.setSelectionRange(newPos, newPos);
      } else {
        inputEl.value = inputEl.value.replace(/@[\w.-]*$/, '@' + item.relPath + ' ');
      }
    }
    hideCmdHint();
    inputEl.focus();
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
  }

  function hideCmdHint() {
    cmdHintEl.style.display = 'none';
    cmdHintMode = null;
    cmdHintItems = [];
  }

  function updateCmdHint() {
    const v = inputEl.value;
    const cursorPos = inputEl.selectionStart;
    const before = v.substring(0, cursorPos);

    // Check for @ trigger — find last @ that's preceded by whitespace or start
    const atMatch = before.match(/(?:^|\s)@([\w./-]*)$/);
    if (atMatch) {
      const query = atMatch[1].toLowerCase();
      cmdHintMode = 'file';
      cmdHintItems = workspaceFiles
        .filter(f => !query || f.relPath.toLowerCase().includes(query) || f.name.toLowerCase().includes(query))
        .slice(0, 20)
        .map(f => ({ type: 'file', name: f.name, relPath: f.relPath }));
      renderCmdHint();
      return;
    }

    // Check for / trigger — must be at start of input
    const trimmed = v.trimStart();
    if (trimmed.startsWith('/') && !trimmed.includes(' ')) {
      const typed = trimmed.toLowerCase();
      cmdHintMode = 'slash';
      cmdHintItems = SLASH_COMMANDS.filter(c => c.cmd.startsWith(typed))
        .map(c => ({ type: 'slash', cmd: c.cmd, label: c.label }));
      renderCmdHint();
      return;
    }

    hideCmdHint();
  }

  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
    updateCmdHint();
  });
  inputEl.addEventListener('keydown', (e) => {
    if (cmdHintEl.style.display !== 'none' && cmdHintItems.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveHint((cmdHintActiveIdx + 1) % cmdHintItems.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveHint((cmdHintActiveIdx - 1 + cmdHintItems.length) % cmdHintItems.length);
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        selectCmdHint(cmdHintActiveIdx);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        hideCmdHint();
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  document.addEventListener('click', (e) => {
    if (cmdHintEl.style.display !== 'none' && !cmdHintEl.contains(e.target) && e.target !== inputEl) {
      hideCmdHint();
    }
  });

  // ─── 接收消息 ───
  window.addEventListener('message', (e) => {
    const msg = e.data;
    switch (msg.type) {
      case 'state':
        if (msg.currentSessionId) curSession = msg.currentSessionId;
        renderDraftContexts();
        if (msg.workspaceName) {
          wsBar.style.display = 'flex';
          $('wsName').textContent = '工作区: ' + msg.workspaceName;
        } else {
          wsBar.style.display = 'none';
        }
        renderTabs(msg.tabs);
        break;
      case 'rolesList':
        curRoles = msg.roles || [];
        curLastUsedRoleId = msg.lastUsedRoleId || '';
        if (roleEditor.style.display === 'flex') renderRoleEditorList();
        break;
      case 'showRoleEditor':
        roleEditor.style.display = 'flex';
        if (msg.createNew) {
          isCreatingRole = true;
          editingRoleId = null;
          renderRoleEditorList();
          renderRoleForm(null);
        } else if (msg.roleId && curRoles.some(r => r.id === msg.roleId)) {
          selectRole(msg.roleId);
        } else if (!editingRoleId && curRoles.length > 0) {
          selectRole(curRoles[0].id);
        } else {
          renderRoleEditorList();
        }
        break;
      case 'roleSaved':
        editingRoleId = msg.roleId;
        isCreatingRole = false;
        renderRoleEditorList();
        const savedRole = curRoles.find(r => r.id === editingRoleId);
        if (savedRole) renderRoleForm(savedRole);
        if ($('rfStatus')) $('rfStatus').textContent = '已保存，会话将在下一次请求使用最新配置';
        break;
      case 'roleDeleted':
        editingRoleId = null;
        isCreatingRole = false;
        if (curRoles.length > 0) selectRole(curRoles[0].id);
        else {
          renderRoleEditorList();
          roleEditorRight.innerHTML = '<div class="re-form-empty">暂无角色，请点击新增</div>';
        }
        break;
      case 'noWorkspace':
        wsBar.style.display = 'none';
        renderTabs([]);
        showEmpty(true);
        $('empty').innerHTML = '<div class="eico">📁</div><div>请先选择工作区</div><div class="ehint">在左侧「工作区」视图添加并切换到工作区</div>';
        break;
      case 'messages':
        renderMessages(msg.sessionId, msg.role, msg.messages);
        renderDraftContexts();
        if (msg.modelName && modelNameEl) modelNameEl.textContent = msg.modelName;
        if (msg.models) curModels = msg.models;
        if (msg.defaultModelId !== undefined) curDefaultModelId = msg.defaultModelId;
        if (msg.currentModelId !== undefined) curCurrentModelId = msg.currentModelId;
        updateContextUsage(msg.contextUsage);
        if (modelDropdown.classList.contains('show')) renderModelDropdown();
        break;
      case 'modelName':
        if (modelNameEl) modelNameEl.textContent = msg.modelName || '未配置模型';
        updateContextUsage(msg.contextUsage);
        break;
      case 'todoUpdated':
        renderTodoPanel(msg.sessionId, msg.items);
        break;
      case 'contextUsage':
        if (msg.sessionId === curSession) updateContextUsage(msg);
        break;
      case 'appendDraftContext':
        appendDraftContext(msg.content || '');
        break;
      case 'userMessage':
        if (msg.sessionId !== curSession) break;
        autoFollowOutput = true;
        appendMessage('user', msg.content, msg.createdAt, msg.sessionId);
        scrollBottom(true);
        break;
      case 'modeIndicator':
        if (msg.sessionId !== curSession) break;
        appendMessage('system', '📋 ' + msg.mode, new Date().toISOString(), msg.sessionId);
        break;
      case 'streamStart': {
        if (msg.sessionId !== curSession) break;
        setStreaming(true);
        autoFollowOutput = true;
        currentToolStatusEl = null;
        toolStatusElements.clear();
        const b = appendMessage('assistant', '', new Date().toISOString(), msg.sessionId);
        if (b) b.classList.add('stream-cursor');
        b && b.setAttribute('data-raw','');
        break;
      }
      case 'reasoningChunk': {
        if (msg.sessionId !== curSession) break;
        const bubbles = messagesEl.querySelectorAll('.msg-row.assistant .bubble');
        const last = bubbles[bubbles.length-1];
        if (last) {
          const panel = ensureReasoningPanel(last);
          const content = panel.querySelector('.reasoning-content');
          const followReasoning = content.scrollHeight - content.scrollTop - content.clientHeight <= 48;
          const raw = content.getAttribute('data-raw') || '';
          const newText = raw + msg.delta;
          content.setAttribute('data-raw', newText);
          content.textContent = newText;
          if (followReasoning) content.scrollTop = content.scrollHeight;
          scrollBottom(false);
        }
        break;
      }
      case 'streamChunk': {
        if (msg.sessionId !== curSession) break;
        const bubbles = messagesEl.querySelectorAll('.bubble');
        // 找最后一个 assistant 气泡
        let last = null;
        for (const b of bubbles) {
          if (b.closest('.msg-row.assistant')) last = b;
        }
        if (last) {
          const raw = last.getAttribute('data-raw') || '';
          const newText = raw + msg.delta;
          last.setAttribute('data-raw', newText);
          last.innerHTML = renderMarkdown(newText);
          scrollBottom(false);
        }
        break;
      }
      case 'toolStatus': {
        if (msg.sessionId !== curSession) break;
        const toolKey = msg.sessionId + ':' + (msg.callId || msg.name || '');
        const bubbles = messagesEl.querySelectorAll('.msg-row.assistant .bubble');
        const last = bubbles[bubbles.length-1];
        if (!last) break;
        const badges = ensureToolBadges(last);
        let badge = toolStatusElements.get(toolKey);
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'tool-badge running';
          badge.setAttribute('data-tool-key', toolKey);
          badges.appendChild(badge);
          toolStatusElements.set(toolKey, badge);
        }
        const toolLabel = msg.name || 'unknown';
        if (msg.status === 'running') {
          badge.className = 'tool-badge running';
          badge.textContent = toolLabel;
        } else if (msg.status === 'completed') {
          badge.className = 'tool-badge completed';
          badge.textContent = toolLabel;
        } else if (msg.status === 'failed') {
          badge.className = 'tool-badge failed';
          badge.textContent = toolLabel + (msg.detail ? ' — ' + msg.detail : '');
        }
        scrollBottom(false);
        break;
      }
      case 'streamEnd':
        if (msg.sessionId !== curSession) break;
        setStreaming(false);
        if (msg.fullText) {
          const bubbles = messagesEl.querySelectorAll('.msg-row.assistant .bubble');
          const last = bubbles[bubbles.length-1];
          if (last) {
            last.classList.remove('stream-cursor');
            last.removeAttribute('data-raw');
            last.innerHTML = renderMarkdown(msg.fullText);
            if (msg.reasoningText) {
              const panel = ensureReasoningPanel(last);
              panel.classList.remove('is-streaming');
              panel.querySelector('summary').textContent = '思考过程';
              const content = panel.querySelector('.reasoning-content');
              content.classList.remove('is-streaming');
              content.removeAttribute('data-raw');
              content.textContent = msg.reasoningText;
            }
          }
        } else {
          const bubbles = messagesEl.querySelectorAll('.msg-row.assistant .bubble');
          const last = bubbles[bubbles.length-1];
          if (last) {
            last.classList.remove('stream-cursor');
            last.textContent = msg.aborted ? '(已中断)' : '(已完成，无文本回复)';
          }
        }
        currentToolStatusEl = null;
        toolStatusElements.clear();
        break;
      case 'streamError': {
        if (msg.sessionId !== curSession) break;
        setStreaming(false);
        const bubbles = messagesEl.querySelectorAll('.msg-row.assistant .bubble');
        const last = bubbles[bubbles.length-1];
        if (last) {
          last.classList.remove('stream-cursor');
          last.removeAttribute('data-raw');
          last.innerHTML = msg.fullText ? renderMarkdown(msg.fullText) : '(生成失败)';
          if (msg.reasoningText) {
            const panel = ensureReasoningPanel(last);
            panel.classList.remove('is-streaming');
            panel.querySelector('summary').textContent = '思考过程';
            const content = panel.querySelector('.reasoning-content');
            content.classList.remove('is-streaming');
            content.removeAttribute('data-raw');
            content.textContent = msg.reasoningText;
          }
        }
        currentToolStatusEl = null;
        toolStatusElements.clear();
        appendMessage('system', '错误: ' + msg.message, new Date().toISOString(), msg.sessionId);
        break;
      }
      case 'contextInjected':
        appendMessage('system', msg.content || msg.summary, new Date().toISOString(), msg.sessionId);
        break;
      case 'historyCleared':
        if (curSession === msg.sessionId) {
          messagesEl.innerHTML = '<div style="text-align:center;color:var(--text3);padding:30px;font-size:12px;">已清空，重新开始</div>';
          updateContextUsage(msg.contextUsage);
        }
        break;
      case 'error':
        setStreaming(false);
        appendMessage('system', '❌ ' + msg.message, new Date().toISOString(), msg.sessionId);
        break;
      case 'toolPermissionsData':
        toolPermRoleName.textContent = msg.roleName || '';
        toolPermModalDataset.sessionId = msg.sessionId || '';
        renderToolPermGrid(new Set(msg.allowedTools || []), new Set(msg.deniedTools || []));
        toolPermStatus.textContent = '';
        toolPermModal.style.display = 'flex';
        break;
      case 'toolPermissionsSaved':
        toolPermStatus.textContent = '✅ 已保存，当前会话立即生效';
        setTimeout(() => { toolPermModal.style.display = 'none'; }, 600);
        break;
      case 'toolApprovalRequest':
        currentApprovalId = msg.approvalId;
        currentApprovalToolName = msg.toolName || '';
        approvalTitle.textContent = msg.title || '⚠️ 工具审批';
        approvalDetail.textContent = msg.detail || '';
        approvalRemember.checked = false;
        approvalModal.style.display = 'flex';
        break;
    }
  });

  vscode.postMessage({ type:'ready' });
</script>
</body>
</html>`;
  }
}
