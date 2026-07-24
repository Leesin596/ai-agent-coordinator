// ============================================================
// ChatPanel — 聊天会话 Webview 面板管理器（Premium UI v2）
// 管理 WebviewPanel 生命周期 + postMessage 通信 + LLM 流式调用
// ============================================================
import * as vscode from 'vscode';
import type { CoordinatorContext, ActiveWorkspaceRuntime } from '../backend/coordinator-context';
import type { Role, Session } from '../../../src/models/types';
import { LLMService, estimateMessageTokens, type LLMMessage, type LLMConfig, type LLMToolCall } from '../services/llm-service';
import { COORDINATOR_LLM_TOOLS } from '../services/llm-api';
import { filterToolsByRole, isToolAllowedByRole } from '../services/tool-filter';
import { parseSlashCommand } from '../services/slash-commands';
import { buildWorkspaceContext } from '../services/workspace-context';
import { WorkspaceToolExecutor, type ToolApprovalRequest } from '../services/workspace-tools';
import { CheckpointManager } from '../services/checkpoint-manager';
import { shouldAutoApprove } from '../services/approval-helper';
import { preflightCompaction, buildFoldSummaryRequest, assembleFoldedMessages, archiveMessages, searchSessionArchive } from '../services/context-manager';
import { TerminalService } from '../services/terminal-service';
import {
  buildSessionContextPackage,
  listContextSessionOptions,
  type ContextTransferMode,
} from '../services/context-transfer';
import { OrchestratorService } from '../../../src/core/orchestrator-service';
import type { LLMCallFunction } from '../../../src/models/types';

// 活跃面板缓存：sessionId → ChatPanel
const activePanels = new Map<string, ChatPanel>();

/**
 * 跨面板事件广播：当任一面板的会话列表/激活态变化时，
 * 通知所有面板刷新自己的标签栏（修复 Tab active 状态不同步）
 */
type SessionChangeCallback = () => void;
const sessionChangeListeners = new Set<SessionChangeCallback>();

function broadcastSessionChange(): void {
  sessionChangeListeners.forEach((cb) => { try { cb(); } catch (_e) {} });
}

function registerSessionChangeListener(cb: SessionChangeCallback): () => void {
  sessionChangeListeners.add(cb);
  return () => { sessionChangeListeners.delete(cb); };
}

export class ChatPanel {
  private panel: vscode.WebviewPanel;
  private llm = new LLMService();
  private toolExecutor: WorkspaceToolExecutor;
  private terminalService = new TerminalService();
  private abortFn: (() => void) | null = null;
  private isStreaming = false;
  private orchestrationAborted = false;
  private role: Role;
  private session: Session;
  private ctx: CoordinatorContext;
  private runtime: ActiveWorkspaceRuntime;
  private disposables: vscode.Disposable[] = [];
  private orchestrator = new OrchestratorService();
  private pendingApprovals = new Map<string, { resolve: (v: boolean) => void; timeout: NodeJS.Timeout }>();

  private constructor(
    panel: vscode.WebviewPanel,
    ctx: CoordinatorContext,
    runtime: ActiveWorkspaceRuntime,
    role: Role,
    session: Session,
  ) {
    this.panel = panel;
    this.ctx = ctx;
    this.runtime = runtime;
    this.role = role;
    this.session = session;
    this.toolExecutor = new WorkspaceToolExecutor(runtime.workspace.folderPath, async (request) => {
      if (request.toolName && shouldAutoApprove(request.toolName)) return true;
      // Webview 内审批弹窗
      const approvalId = `approval_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      this.sendToWebview({
        type: 'toolApprovalRequest',
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
        }, 300000); // 5 min timeout
        this.pendingApprovals.set(approvalId, { resolve, timeout });
      });
    });
    this.toolExecutor.setRole(role);
    this.toolExecutor.setCheckpointManager(new CheckpointManager(runtime.workspace.folderPath));
    this.toolExecutor.setTerminalRunner(this.terminalService.createRunner());

    // 接入 TodoListManager 和 IndexingService（从 ConsoleProvider 获取共享实例）
    const consoleProvider = ctx.getConsoleProvider();
    if (consoleProvider) {
      this.toolExecutor.setTodoListManager(consoleProvider.todoListManager ?? null);
      this.toolExecutor.setIndexingService(consoleProvider.getIndexingService() ?? null);
    }
    this.toolExecutor.setSessionId(session.id);

    this.panel.title = `${role.icon || '💬'} ${session.title}`;

    this.panel.webview.html = this.getHtml();

    // 接收 Webview 消息
    this.panel.webview.onDidReceiveMessage(
      (msg) => this.handleMessage(msg),
      null,
      this.disposables,
    );

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    // 注册跨面板会话变化监听（刷新 Tab 激活态）
    this.disposables.push({
      dispose: registerSessionChangeListener(() => this.refreshTabs()),
    } as vscode.Disposable);

    // 加载历史消息
    this.loadHistory();
  }

  // ============================================================
  // 公共 API
  // ============================================================

  static async open(
    ctx: CoordinatorContext,
    runtime: ActiveWorkspaceRuntime,
    role: Role,
    existingSession?: Session,
  ): Promise<ChatPanel> {
    if (existingSession) {
      const existing = activePanels.get(existingSession.id);
      if (existing) {
        existing.panel.reveal(vscode.ViewColumn.Active);
        return existing;
      }
    }

    const session = existingSession || runtime.sessionManager.create(runtime.workspace.id, role);

    const panel = vscode.window.createWebviewPanel(
      'coordinator.chat',
      `${role.icon || '💬'} ${session.title}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );

    const chatPanel = new ChatPanel(panel, ctx, runtime, role, session);
    activePanels.set(session.id, chatPanel);
    broadcastSessionChange(); // 通知所有面板刷新标签栏
    ctx.getModelsProvider()?.refreshSessions?.(); // 通知左侧刷新会话列表
    ctx.getSidebarProvider()?.refreshSessions?.();
    return chatPanel;
  }

  static close(sessionId: string): void {
    const panel = activePanels.get(sessionId);
    if (panel) {
      panel.panel.dispose();
    }
  }

  static getActive(sessionId: string): ChatPanel | undefined {
    return activePanels.get(sessionId);
  }

  /** 模型库 / 会话模型绑定变化时，刷新所有打开的聊天面板的模型名显示 */
  static refreshAllModels(): void {
    for (const panel of activePanels.values()) {
      panel.refreshModels();
    }
  }

  static getAllSessions(): { id: string; title: string; roleId: string; roleName: string; roleIcon: string }[] {
    const sessions: { id: string; title: string; roleId: string; roleName: string; roleIcon: string }[] = [];
    for (const [id, panel] of activePanels.entries()) {
      sessions.push({
        id,
        title: panel.session.title,
        roleId: panel.role.id,
        roleName: panel.role.name,
        roleIcon: panel.role.icon || '💬',
      });
    }
    return sessions;
  }

  // ============================================================
  // 消息处理
  // ============================================================

  private async handleMessage(msg: any): Promise<void> {
    switch (msg.type) {
      case 'sendMessage':
        await this.handleSendMessage(msg.content);
        break;
      case 'abortStream':
        this.handleAbort();
        break;
      case 'clearHistory':
        this.handleClearHistory();
        break;
      case 'injectContext':
        await this.handleInjectContext();
        break;
      case 'switchSession':
        await this.handleSwitchSession(msg.sessionId);
        break;
      case 'closeSession':
        this.handleCloseSession();
        break;
      case 'focusModelsView':
        // 点击模型名标签 → 聚焦左侧「模型设置」view
        vscode.commands.executeCommand('coordinator.sidebar.focus');
        break;
      case 'openToolPermissions':
        this.sendToWebview({
          type: 'toolPermissionsData',
          roleId: this.role.id,
          roleName: this.role.name,
          allowedTools: this.role.allowedTools || [],
          deniedTools: this.role.deniedTools || [],
        });
        break;
      case 'updateToolPermissions':
        await this.handleUpdateToolPermissions(msg.allowedTools || [], msg.deniedTools || []);
        break;
      case 'toolApprovalResponse':
        this.handleToolApprovalResponse(msg.approvalId, msg.approved, msg.remember, msg.toolName);
        break;
    }
  }

  private async handleUpdateToolPermissions(allowedTools: string[], deniedTools: string[]): Promise<void> {
    const runtime = this.runtime;
    runtime.roleManager.update(this.role.id, { allowedTools, deniedTools });
    // 立即刷新当前会话的 role 引用
    const updatedRole = runtime.roleManager.get(this.role.id);
    if (updatedRole) {
      this.role = updatedRole;
      this.toolExecutor.setRole(updatedRole);
      runtime.sessionManager.syncRoleToSessions(updatedRole, runtime.workspace.id);
    }
    this.sendToWebview({ type: 'toolPermissionsSaved' });
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

  private async handleSendMessage(content: string): Promise<void> {
    if (this.isStreaming || !content.trim()) return;

    // Slash 命令解析
    const { content: actualContent, modePrompt, mode } = parseSlashCommand(content);
    if (!actualContent.trim()) return;

    const config = this.getLLMConfig(this.session.id);
    const isLocalProvider = /localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(config.baseURL);
    const apiKeyOptional = isLocalProvider || config.apiKeyRequired === false;
    if (!config.apiKey && !apiKeyOptional) {
      this.sendToWebview({ type: 'error', message: '未配置模型 API Key，请在左侧「模型设置」中添加模型预设' });
      return;
    }

    this.runtime.sessionManager.addMessage(this.session.id, 'user', actualContent);
    this.sendToWebview({ type: 'userMessage', content: actualContent });
    if (mode) {
      this.sendToWebview({ type: 'modeIndicator', mode });
    }

    this.isStreaming = true;
    this.sendToWebview({ type: 'streamStart' });

    const messages = this.runtime.sessionManager.getConversationMessages(this.session.id) as LLMMessage[];

    const workspaceContext = buildWorkspaceContext(
      this.ctx,
      this.runtime,
      this.session.id,
      actualContent,
    );
    const systemIdx = messages.findIndex((m) => m.role === 'system');
    if (systemIdx >= 0) {
      const existing = messages[systemIdx];
      messages[systemIdx] = { role: 'system', content: `${existing.content}\n\n${workspaceContext}` } as LLMMessage;
    } else {
      messages.unshift({ role: 'system', content: workspaceContext } as LLMMessage);
    }
    // 注入 slash 命令模式提示（合并到首条 system 消息，避免多条 system 被部分 provider 丢弃）
    if (modePrompt) {
      const idx = messages.findIndex((m) => m.role === 'system');
      if (idx >= 0) {
        messages[idx] = { role: 'system', content: `${messages[idx].content}\n\n${modePrompt}` } as LLMMessage;
      } else {
        messages.unshift({ role: 'system', content: modePrompt } as LLMMessage);
      }
    }

    // P1+P2: preflight 分级压缩 — 发送前检查上下文占比，按需截短/fold
    const preflight = preflightCompaction(messages, config.contextWindow || 128000);
    let compactedMessages = preflight.messages;

    // P2: force-fold 时调用 LLM 摘要历史
    if (preflight.level === 'force-fold' && preflight.foldBoundary) {
      // P3: 先归档将被压缩的 head 消息
      archiveMessages(this.runtime.workspace.folderPath, this.session.id, preflight.foldBoundary.head, 'fold');
      this.sendToWebview({
        type: 'systemMessage',
        content: `📦 上下文压缩 (${Math.round(preflight.ratio * 100)}%): 正在生成历史摘要…`,
      });
      try {
        const summaryMessages = buildFoldSummaryRequest(preflight.foldBoundary.head);
        const summary = await this.llm.chat(summaryMessages, {
          ...config,
          temperature: 0.3,
          maxTokens: 2000,
          tools: undefined,
        });
        compactedMessages = assembleFoldedMessages(summary, preflight.foldBoundary.tail);
        this.sendToWebview({
          type: 'systemMessage',
          content: `📦 上下文 fold 完成: head ${preflight.foldBoundary.headTokens} tokens → 摘要，tail ${preflight.foldBoundary.tailTokens} tokens 保留`,
        });
      } catch (err: any) {
        this.sendToWebview({
          type: 'systemMessage',
          content: `⚠️ 上下文 fold 失败: ${err.message}，降级为 prune`,
        });
      }
    } else if (preflight.level !== 'none') {
      this.sendToWebview({
        type: 'systemMessage',
        content: `📦 上下文压缩 (${Math.round(preflight.ratio * 100)}%): snip=${preflight.snippedCount} prune=${preflight.prunedCount}`,
      });
    }

    this.sendContextUsage(compactedMessages, config.contextWindow);
    this.toolExecutor.begin();

    let usedNativeTool = false;
    const roleFilteredTools = filterToolsByRole(COORDINATOR_LLM_TOOLS, this.role);
    this.abortFn = this.llm.streamChat(compactedMessages, { ...config, tools: roleFilteredTools }, {
      onChunk: (delta) => {
        this.sendToWebview({ type: 'streamChunk', delta });
      },
      onReasoningChunk: (delta) => {
        this.sendToWebview({ type: 'reasoningChunk', delta });
      },
      onToolCall: (call) => {
        usedNativeTool = true;
        return this.executeToolCall(call);
      },
      onToolStatus: (call, status, detail) => {
        this.sendToWebview({ type: 'toolStatus', callId: call.id, name: call.name, status, detail });
      },
      onDone: (fullText, reasoningText, usage) => {
        this.isStreaming = false;
        this.abortFn = null;
        if (fullText) this.runtime.sessionManager.addMessage(this.session.id, 'assistant', fullText);
        this.sendToWebview({ type: 'streamEnd', fullText, reasoningText });
        // 从 DB 重新读取消息（包含刚写入的 assistant 回复），并重建 workspace context
        this.sendToWebview({ type: 'contextUsage', ...this.getFullContextUsage() });
        // 发送 API 返回的真实 token 用量（如有）
        if (usage) {
          this.sendToWebview({ type: 'tokenUsage', usage });
        }
        // 自动解析并执行派发指令
        if (!usedNativeTool) this.parseAndDispatch(fullText);
      },
      onError: (err, fullText, reasoningText) => {
        this.isStreaming = false;
        this.abortFn = null;
        if (fullText) this.runtime.sessionManager.addMessage(this.session.id, 'assistant', fullText);
        this.sendToWebview({ type: 'streamError', message: err.message, fullText, reasoningText });
      },
    });
  }

  /** 构建团队上下文：列出当前工作区所有会话及其角色 */
  private buildTeamContext(): string {
    const sessions = this.runtime.sessionManager.list(this.runtime.workspace.id);
    if (sessions.length <= 1) return '';

    const lines: string[] = [
      '## 当前团队（工作区在线会话）',
      '以下是当前工作区中活跃的 AI 角色会话，你可以通过任务派发机制向它们分配任务：',
      '',
    ];

    for (const s of sessions) {
      const role = this.runtime.roleManager.get(s.roleId);
      if (!role) continue;
      const isMe = s.id === this.session.id;
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
  private parseAndDispatch(llmOutput: string): void {
    for (const block of this.extractDispatchBlocks(llmOutput)) {
      try {
        this.dispatchSessionTask(block);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.sendToWebview({ type: 'error', message: `派发失败: ${message}` });
      }
    }
  }

  private async executeToolCall(call: LLMToolCall): Promise<string> {
    if (call.name === 'orchestrate_task') {
      if (!isToolAllowedByRole(call.name, this.role)) {
        throw new Error(`角色「${this.role?.name || '未知'}」无权使用工具: ${call.name}`);
      }
      return this.executeOrchestrateTask(call);
    }
    if (call.name === 'history_search') {
      if (!isToolAllowedByRole(call.name, this.role)) {
        throw new Error(`角色「${this.role?.name || '未知'}」无权使用工具: ${call.name}`);
      }
      return this.executeHistorySearch(call);
    }
    if (call.name === 'web_search' || call.name === 'web_fetch') {
      if (!isToolAllowedByRole(call.name, this.role)) {
        throw new Error(`角色「${this.role.name}」无权使用工具: ${call.name}`);
      }
      if (call.name === 'web_search' && !shouldAutoApprove('web_search')) {
        const approved = await this.requestWebToolApproval('web_search', call.arguments);
        if (!approved) throw new Error('用户拒绝了联网搜索');
      }
      if (call.name === 'web_fetch' && !shouldAutoApprove('web_fetch')) {
        const approved = await this.requestWebToolApproval('web_fetch', call.arguments);
        if (!approved) throw new Error('用户拒绝了网页抓取');
      }
      return this.executeWebTool(call);
    }
    if (call.name !== 'dispatch_session_task') {
      if (!isToolAllowedByRole(call.name, this.role)) {
        throw new Error(`角色「${this.role.name}」无权使用工具: ${call.name}`);
      }
      return this.toolExecutor.execute(call);
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
    return JSON.stringify({ ok: true, ...this.dispatchSessionTask(block) });
  }

  private async executeHistorySearch(call: LLMToolCall): Promise<string> {
    let input: unknown;
    try {
      input = JSON.parse(call.arguments || '{}');
    } catch {
      throw new Error('工具参数不是有效的 JSON');
    }
    if (!input || typeof input !== 'object') throw new Error('工具参数必须是对象');
    const values = input as Record<string, unknown>;
    const query = typeof values.query === 'string' ? values.query.trim() : '';
    if (!query) throw new Error('query 为必填字符串');
    const topK = typeof values.topK === 'number' && values.topK >= 1 && values.topK <= 20
      ? Math.floor(values.topK)
      : 5;

    const results = searchSessionArchive(this.runtime.workspace.folderPath, this.session.id, query, topK);
    if (results.length === 0) {
      return JSON.stringify({ ok: true, results: [], message: '未找到匹配的归档历史消息' });
    }
    return JSON.stringify({
      ok: true,
      results: results.map((r) => ({
        role: r.role,
        score: Math.round(r.score * 100) / 100,
        content: r.content.length > 2000
          ? `${r.content.slice(0, 1200)}\n[…省略…]\n${r.content.slice(-800)}`
          : r.content,
        archivedAt: r.archivedAt,
      })),
    });
  }

  private async requestWebToolApproval(toolName: string, args: string): Promise<boolean> {
    let detail = '';
    try {
      const parsed = JSON.parse(args || '{}');
      detail = parsed.query || parsed.url || JSON.stringify(parsed);
    } catch {
      detail = args;
    }
    const approvalId = `approval_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.sendToWebview({
      type: 'toolApprovalRequest',
      approvalId,
      title: toolName === 'web_search' ? '允许联网搜索？' : '允许抓取网页？',
      detail,
      confirmLabel: '允许',
      toolName,
    });
    return new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingApprovals.delete(approvalId);
        resolve(false);
      }, 300000);
      this.pendingApprovals.set(approvalId, { resolve, timeout });
    });
  }

  private async executeWebTool(call: LLMToolCall): Promise<string> {
    let input: unknown;
    try {
      input = JSON.parse(call.arguments || '{}');
    } catch {
      throw new Error('工具参数不是有效的 JSON');
    }
    if (!input || typeof input !== 'object') throw new Error('工具参数必须是对象');
    const values = input as Record<string, unknown>;
    if (call.name === 'web_search') {
      const result = await this.runtime.webToolExecutor.search(values);
      return JSON.stringify({ ok: true, result });
    }
    if (call.name === 'web_fetch') {
      const result = await this.runtime.webToolExecutor.fetch(values);
      return JSON.stringify({ ok: true, result });
    }
    throw new Error(`不支持的工具: ${call.name}`);
  }

  private async executeOrchestrateTask(call: LLMToolCall): Promise<string> {
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

    this.orchestrator.setDB(this.runtime.db);
    this.orchestrator.setEventBus(this.runtime.eventBus);
    this.orchestrator.setDispatcher(this.runtime.dispatcher);
    this.orchestrator.setSessionManager(this.runtime.sessionManager);
    this.orchestrator.setRoleManager(this.runtime.roleManager);

    const config = this.getLLMConfig(this.session.id);
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
    this.sendToWebview({ type: 'systemMessage', content: `🔄 开始自动编排任务: ${description.slice(0, 100)}...` });

    try {
      if (this.orchestrationAborted) throw new Error('用户已取消编排');
      const result = await this.orchestrator.orchestrate(
        {
          description,
          context,
          sourceSessionId: this.session.id,
          workspaceId: this.runtime.workspace.id,
          maxSubTasks,
          maxDepth: 2,
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
      this.runtime.sessionManager.addMessage(this.session.id, 'system', summaryMsg);
      this.sendToWebview({ type: 'systemMessage', content: summaryMsg });

      return JSON.stringify({ ok: true, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.sendToWebview({ type: 'error', message: `编排失败: ${message}` });
      throw new Error(`编排失败: ${message}`);
    }
  }

  private dispatchSessionTask(block: { target: string; title: string; objective: string }): {
    taskId: string;
    targetSessionId: string;
    targetSessionTitle: string;
  } {
    const sessions = this.runtime.sessionManager.list(this.runtime.workspace.id);
    const matches = sessions.filter((candidate) => candidate.id === block.target || candidate.id.startsWith(block.target));
    if (matches.length === 0) throw new Error(`找不到目标会话 "${block.target}"`);
    if (matches.length > 1) throw new Error(`目标会话短 ID "${block.target}" 不唯一，请使用更长的 ID`);
    const targetSession = matches[0];
    if (targetSession.id === this.session.id) throw new Error('不能向自己派发任务');

    const sourceRole = this.runtime.roleManager.get(this.session.roleId);
    if (!sourceRole) throw new Error('当前会话角色不存在');
    const targetRole = this.runtime.roleManager.get(targetSession.roleId);
    const task = this.runtime.dispatcher.dispatch({
      sourceSessionId: this.session.id,
      targetSessionId: targetSession.id,
      title: block.title,
      brief: '',
      contextPayload: {
        sourceRole: { id: sourceRole.id, name: sourceRole.name, category: sourceRole.category as string },
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
    this.runtime.sessionManager.addMessage(this.session.id, 'system', successMsg);
    this.sendToWebview({ type: 'systemMessage', content: successMsg });
    const notifyMsg = [
      `**收到来自 ${sourceRole.name} 的任务派发**`,
      '',
      `**任务标题**: ${task.title}`,
      `**任务目标**: ${block.objective}`,
      `**派发方**: ${sourceRole.name}（会话: "${this.session.title}"）`,
      `**优先级**: 中`,
      '',
      '请根据以上任务目标开始执行。完成后可以通过任务中心回复结果。',
    ].join('\n');
    this.runtime.sessionManager.addMessage(targetSession.id, 'system', notifyMsg);
    this.ctx.getConsoleProvider()?.postToWebview({ type: 'systemMessage', sessionId: targetSession.id, content: notifyMsg });
    try {
      this.runtime.dispatcher.align(task.id);
      this.runtime.dispatcher.accept(task.id);
    } catch {}
    return { taskId: task.id, targetSessionId: targetSession.id, targetSessionTitle: targetSession.title };
  }

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

  private extractField(body: string, field: string): string {
    const regex = new RegExp(`^${field}:\\s*(.+?)(?=\\n\\w+:|$)`, 'ims');
    const match = regex.exec(body);
    return match ? match[1].trim() : '';
  }

  private handleAbort(): void {
    this.toolExecutor.cancel();
    this.orchestrationAborted = true;
    this.orchestrator.cancel();
    if (this.abortFn) {
      this.abortFn();
      this.abortFn = null;
      this.isStreaming = false;
      this.sendToWebview({ type: 'streamEnd', fullText: '', aborted: true });
    }
  }

  private handleClearHistory(): void {
    this.runtime.sessionManager.clearHistory(this.session.id);
    this.loadHistory();
    vscode.window.showInformationMessage('已清空对话历史');
  }

  private async handleInjectContext(): Promise<void> {
    const action = await vscode.window.showQuickPick(
      [
        { label: '$(arrow-right) 接力到新会话', description: '保留当前会话的重要上下文，在新会话继续' },
        { label: '$(link) 接力到已有会话', description: '把当前会话上下文传递给另一个会话' },
        { label: '$(git-merge) 对齐到当前会话', description: '把另一个会话的上下文合并到当前会话' },
        { label: '$(sync) 双向对齐', description: '让当前会话与另一个会话互相获得对方上下文' },
      ],
      { title: '会话上下文接力与对齐', placeHolder: '选择上下文操作' },
    );
    if (!action) return;

    try {
      if (action.label.includes('接力到新会话')) {
        const target = this.runtime.sessionManager.create(
          this.runtime.workspace.id,
          this.role,
          `${this.session.title} · 接力`,
        );
        if (this.session.modelId) this.runtime.sessionManager.setModel(target.id, this.session.modelId);
        this.transferSessionContext(this.session, target, 'continue');
        broadcastSessionChange();
        this.ctx.getModelsProvider()?.refreshSessions?.();
        this.ctx.getSidebarProvider()?.refreshSessions?.();
        await ChatPanel.open(this.ctx, this.runtime, this.role, target);
        vscode.window.showInformationMessage(`已创建接力会话“${target.title}”`);
        return;
      }

      const targetId = await this.pickContextSession();
      if (!targetId) return;
      const other = this.runtime.sessionManager.get(targetId);
      if (!other) throw new Error('目标会话不存在');

      if (action.label.includes('接力到已有会话')) {
        this.transferSessionContext(this.session, other, 'continue');
        activePanels.get(other.id)?.loadHistory();
        const targetRole = this.runtime.roleManager.get(other.roleId);
        if (targetRole) await ChatPanel.open(this.ctx, this.runtime, targetRole, other);
      } else if (action.label.includes('对齐到当前会话')) {
        this.transferSessionContext(other, this.session, 'align');
        this.loadHistory();
      } else {
        const currentPackage = buildSessionContextPackage(
          this.session,
          this.role,
          this.runtime.sessionManager.listMessages(this.session.id),
          'align',
        );
        const otherPackage = buildSessionContextPackage(
          other,
          this.runtime.roleManager.get(other.roleId),
          this.runtime.sessionManager.listMessages(other.id),
          'align',
        );
        this.runtime.sessionManager.addMessage(other.id, 'system', currentPackage.content);
        this.runtime.sessionManager.addMessage(this.session.id, 'system', otherPackage.content);
        this.loadHistory();
        activePanels.get(other.id)?.loadHistory();
      }

      broadcastSessionChange();
      this.ctx.getModelsProvider()?.refreshSessions?.();
      this.ctx.getSidebarProvider()?.refreshSessions?.();
      vscode.window.showInformationMessage('会话上下文已完成接力/对齐');
    } catch (err: any) {
      this.sendToWebview({ type: 'error', message: `会话上下文操作失败: ${err.message}` });
    }
  }

  private async pickContextSession(): Promise<string | undefined> {
    const options = listContextSessionOptions(
      this.runtime.sessionManager.list(this.runtime.workspace.id),
      this.session.id,
      (roleId) => this.runtime.roleManager.get(roleId),
      (id) => this.runtime.sessionManager.listMessages(id),
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

  private transferSessionContext(source: Session, target: Session, mode: ContextTransferMode): void {
    const contextPackage = buildSessionContextPackage(
      source,
      this.runtime.roleManager.get(source.roleId),
      this.runtime.sessionManager.listMessages(source.id),
      mode,
    );
    this.runtime.sessionManager.addMessage(target.id, 'system', contextPackage.content);
  }

  private async handleSwitchSession(sessionId: string): Promise<void> {
    // 切换到另一个会话的面板
    const target = activePanels.get(sessionId);
    if (target) {
      target.panel.reveal(vscode.ViewColumn.Active);
      // 目标面板也需要刷新自己的 tabs（当前 session 变了）
      target.refreshTabs();
    } else {
      // 从数据库加载会话并打开
      const s = this.runtime.sessionManager.get(sessionId);
      if (s) {
        const r = this.runtime.roleManager.get(s.roleId);
        if (r) {
          await ChatPanel.open(this.ctx, this.runtime, r, s);
        }
      }
    }
    // 广播：让所有面板（包括当前面板自己）刷新 tab 激活态
    broadcastSessionChange();
  }

  private handleCloseSession(): void {
    this.panel.dispose();
  }

  // ============================================================
  // 辅助
  // ============================================================

  private loadHistory(): void {
    const messages = this.runtime.sessionManager.listMessages(this.session.id);
    // 获取所有活跃会话用于标签栏
    const allSessions = this.runtime.sessionManager.list(this.runtime.workspace.id).map((s) => {
      const r = this.runtime.roleManager.get(s.roleId);
      return {
        id: s.id,
        title: s.title,
        isActive: s.id === this.session.id,
        roleName: r?.name || '?',
        roleIcon: r?.icon || '💬',
        updatedAt: s.updatedAt,
      };
    });

    this.sendToWebview({
      type: 'historyLoaded',
      currentSessionId: this.session.id,
      sessions: allSessions,
      role: {
        name: this.role.name,
        icon: this.role.icon || '💬',
        description: this.role.description,
        skills: this.role.skills,
        category: this.role.category,
        builtIn: this.role.builtIn,
      },
      modelName: this.getCurrentModelName(),
      contextUsage: this.getFullContextUsage(),
      session: { id: this.session.id, title: this.session.title },
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
        createdAt: m.createdAt,
      })),
    });

    this.pushWorkspaceFiles();
  }

  private pushWorkspaceFiles(): void {
    try {
      const fs = require('fs') as typeof import('fs');
      const path = require('path') as typeof import('path');
      const folderPath = this.runtime.workspace.folderPath;
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
      this.sendToWebview({ type: 'workspaceFiles', files });
    } catch {
      // ignore
    }
  }

  private getLLMConfig(sessionId?: string): LLMConfig {
    // 1. 会话绑定的模型预设优先
    if (sessionId) {
      const session = this.runtime.sessionManager.get(sessionId);
      if (session?.modelId) {
        const preset = this.ctx.getModelStore().get(session.modelId);
        if (preset) {
          return {
            apiKey: preset.apiKey,
            baseURL: preset.baseURL,
            model: preset.model,
            apiFormat: preset.apiFormat,
            temperature: preset.temperature ?? 0.7,
            contextWindow: preset.contextWindow ?? 128000,
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
        contextWindow: def.contextWindow ?? 128000,
        thinkingStrength: def.thinkingStrength ?? 'xhigh',
        apiKeyRequired: def.apiKeyRequired,
      };
    }
    // 3. 兜底：全局 configuration
    const globalCfg = vscode.workspace.getConfiguration('coordinator.llm');
    return {
      apiKey: globalCfg.get<string>('apiKey', ''),
      baseURL: globalCfg.get<string>('baseURL', 'https://api.openai.com/v1'),
      model: globalCfg.get<string>('model', 'gpt-4o-mini'),
      apiFormat: 'chat-completions',
      temperature: globalCfg.get<number>('temperature', 0.7),
      contextWindow: 128000,
      thinkingStrength: 'xhigh',
    };
  }

  private getContextUsage(messages: Array<{ content: string }>, contextWindow = 128000): { used: number; limit: number; percent: number } {
    const limit = Math.max(1, contextWindow);
    const used = estimateMessageTokens(messages);
    return { used, limit, percent: Math.min(100, Math.round((used / limit) * 100)) };
  }

  /**
   * 计算包含工作区上下文的真实上下文占用。
   * 使用最后一条 user 消息作为 query 来构建 workspace context，
   * 保证和 handleSendMessage 中发给 LLM 的消息序列一致。
   */
  private getFullContextUsage(): { used: number; limit: number; percent: number } {
    const config = this.getLLMConfig(this.session.id);
    const messages = this.runtime.sessionManager.getConversationMessages(this.session.id) as LLMMessage[];
    // 取最后一条 user 消息作为 query
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const query = lastUser?.content || '';
    const workspaceContext = buildWorkspaceContext(this.ctx, this.runtime, this.session.id, query);
    const systemIdx = messages.findIndex((m) => m.role === 'system');
    if (systemIdx >= 0) {
      messages[systemIdx] = { role: 'system', content: `${messages[systemIdx].content}\n\n${workspaceContext}` } as LLMMessage;
    } else {
      messages.unshift({ role: 'system', content: workspaceContext } as LLMMessage);
    }
    return this.getContextUsage(messages, config.contextWindow);
  }

  private sendContextUsage(messages: Array<{ content: string }>, contextWindow = 128000): void {
    this.sendToWebview({ type: 'contextUsage', ...this.getContextUsage(messages, contextWindow) });
  }

  /** 获取当前会话使用的模型显示名 */
  private getCurrentModelName(): string {
    const store = this.ctx.getModelStore();
    const session = this.runtime.sessionManager.get(this.session.id);
    if (session?.modelId) {
      const preset = store.get(session.modelId);
      if (preset) return preset.name;
    }
    const def = store.getDefault();
    if (def) return def.name + '（默认）';
    return '未配置模型';
  }

  /** 模型库 / 会话模型绑定变化时刷新模型名显示 */
  refreshModels(): void {
    const config = this.getLLMConfig(this.session.id);
    const messages = this.runtime.sessionManager.getConversationMessages(this.session.id) as LLMMessage[];
    this.sendToWebview({
      type: 'modelName',
      modelName: this.getCurrentModelName(),
      contextUsage: this.getFullContextUsage(),
    });
  }

  private sendToWebview(msg: any): void {
    this.panel.webview.postMessage(msg);
  }

  private dispose(): void {
    this.handleAbort();
    this.terminalService.dispose();
    activePanels.delete(this.session.id);
    broadcastSessionChange(); // 通知所有面板刷新标签栏
    this.ctx.getModelsProvider()?.refreshSessions?.(); // 通知左侧刷新会话列表
    this.ctx.getSidebarProvider()?.refreshSessions?.();
    this.panel.dispose();
    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) d.dispose();
    }
  }

  /**
   * 刷新标签栏（从数据库重新拉取所有会话，更新 active 态）
   * 被跨面板事件广播调用，修复 Tab 激活状态不同步
   */
  private refreshTabs(): void {
    const allSessions = this.runtime.sessionManager.list(this.runtime.workspace.id).map((s) => ({
      id: s.id,
      title: s.title,
      isActive: s.id === this.session.id,
      roleName: (this.runtime.roleManager.get(s.roleId))?.name || '?',
      roleIcon: (this.runtime.roleManager.get(s.roleId))?.icon || '💬',
      updatedAt: s.updatedAt,
    }));
    this.sendToWebview({ type: 'sessionsUpdated', sessions: allSessions });
  }

  // ============================================================
  // Premium UI v2 — Webview HTML
  // 参考现代 AI 聊天界面：标签页多会话、深色主题、精致气泡、工具栏
  // ============================================================

  private getHtml(): string {
    return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  /* ========== Design Tokens ========== */
  :root {
    --bg-primary: #1e1e1e;
    --bg-secondary: #252526;
    --bg-elevated: #2d2d30;
    --bg-card: #28282c;
    --bg-hover: #333337;
    --bg-input: #1e1e1e;
    --border: #3e3e42;
    --border-light: #45454a;
    --border-subtle: #2a2a2e;
    --text-primary: #e0e0e0;
    --text-secondary: #9a9a9a;
    --text-muted: #6a6a6a;
    --accent: #0e9ece;
    --accent-dim: rgba(14, 206, 206, 0.15);
    --accent-glow: rgba(14, 206, 206, 0.25);
    --user-bubble-bg: #1a5f52;
    --user-bubble-border: #24806e;
    --user-label: #5ee7c8;
    --system-bubble-bg: #3d3620;
    --system-bubble-border: #5c5028;
    --system-label: #e0c86a;
    --assistant-bubble-bg: #27272a;
    --assistant-bubble-border: #38383c;
    --assistant-label: #8ab4f8;
    --status-online: #34c759;
    --status-idle: #ff9500;
    --danger: #ef4444;
    --warning: #f59e0b;
    --success: #22c55e;
    --radius-sm: 6px;
    --radius-md: 10px;
    --radius-lg: 16px;
    --radius-xl: 20px;
    --shadow-sm: 0 1px 3px rgba(0,0,0,0.3);
    --shadow-md: 0 4px 12px rgba(0,0,0,0.4);
    --transition: 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  }

  /* ========== Reset & Base ========== */
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans SC', Helvetica, Arial, sans-serif;
    font-size: 13px;
    line-height: 1.5;
    color: var(--text-primary);
    background: var(--bg-primary);
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
    user-select: none;
  }

  /* ========== 会话标签栏 (Session Tabs) ========== */
  .tab-bar {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 6px 12px 0;
    background: var(--bg-secondary);
    border-bottom: 1px solid var(--border-subtle);
    flex-shrink: 0;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: thin;
    scrollbar-color: var(--border) transparent;
  }
  .tab-bar::-webkit-scrollbar { height: 3px; }
  .tab-bar::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }
  .session-tab {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 14px;
    border-radius: 20px;
    cursor: pointer;
    white-space: nowrap;
    font-size: 12px;
    color: var(--text-secondary);
    background: transparent;
    border: 1px solid transparent;
    transition: all var(--transition);
    position: relative;
    flex-shrink: 0;
  }
  .session-tab:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }
  .session-tab.active {
    background: var(--accent-dim);
    border-color: var(--accent);
    color: var(--accent);
    font-weight: 500;
  }
  .session-tab.active::before {
    content: '';
    position: absolute;
    bottom: -7px;
    left: 50%;
    transform: translateX(-50%);
    width: 20px;
    height: 2px;
    background: var(--accent);
    border-radius: 1px;
  }
  .session-tab .tab-icon { font-size: 13px; }
  .session-tab .tab-close {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    font-size: 11px;
    opacity: 0;
    transition: all var(--transition);
  }
  .session-tab:hover .tab-close { opacity: 0.6; }
  .session-tab .tab-close:hover {
    opacity: 1;
    background: rgba(255,255,255,0.1);
  }
  .tab-add-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    border: 1px dashed var(--border);
    color: var(--text-muted);
    cursor: pointer;
    font-size: 16px;
    flex-shrink: 0;
    transition: all var(--transition);
    margin-left: 4px;
  }
  .tab-add-btn:hover {
    border-color: var(--accent);
    color: var(--accent);
    background: var(--accent-dim);
  }

  /* ========== 对话记录头部 ========== */
  .chat-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 16px;
    background: var(--bg-secondary);
    border-bottom: 1px solid var(--border-subtle);
    flex-shrink: 0;
  }
  .chat-header .header-title {
    font-size: 13px;
    font-weight: 500;
    color: var(--text-secondary);
  }
  .chat-header .btn-clear {
    padding: 4px 12px;
    border-radius: var(--radius-sm);
    font-size: 12px;
    cursor: pointer;
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-secondary);
    transition: all var(--transition);
  }
  .chat-header .btn-clear:hover {
    border-color: var(--danger);
    color: var(--danger);
    background: rgba(239,68,68,0.08);
  }

  /* ========== 消息列表 ========== */
  .messages {
    flex: 1;
    overflow-y: auto;
    padding: 16px 20px;
    display: flex;
    flex-direction: column;
    gap: 14px;
    scroll-behavior: smooth;
  }
  .messages::-webkit-scrollbar { width: 5px; }
  .messages::-webkit-scrollbar-track { background: transparent; }
  .messages::-webkit-scrollbar-thumb {
    background: var(--border);
    border-radius: 3px;
  }
  .messages::-webkit-scrollbar-thumb:hover { background: var(--border-light); }

  .msg-wrapper {
    display: flex;
    gap: 10px;
    max-width: 88%;
    animation: msgIn 0.3s cubic-bezier(0.16, 1, 0.3, 1);
  }
  @keyframes msgIn {
    from { opacity: 0; transform: translateY(10px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .msg-wrapper.user { align-self: flex-end; flex-direction: row-reverse; }
  .msg-wrapper.assistant { align-self: flex-start; }
  .msg-wrapper.system { align-self: center; max-width: 95%; }

  /* 消息气泡 */
  .bubble {
    padding: 10px 14px;
    border-radius: var(--radius-lg);
    line-height: 1.65;
    word-break: break-word;
    position: relative;
    box-shadow: var(--shadow-sm);
  }

  /* User 气泡 */
  .msg-wrapper.user .bubble {
    background: var(--user-bubble-bg);
    border: 1px solid var(--user-bubble-border);
    border-bottom-right-radius: 4px;
    color: #e8fff4;
  }

  /* Assistant 气泡 */
  .msg-wrapper.assistant .bubble {
    background: var(--assistant-bubble-bg);
    border: 1px solid var(--assistant-bubble-border);
    border-bottom-left-radius: 4px;
    color: var(--text-primary);
  }

  /* System 气泡 */
  .msg-wrapper.system .bubble {
    background: var(--system-bubble-bg);
    border: 1px solid var(--system-bubble-border);
    border-radius: var(--radius-md);
    font-size: 12px;
    color: #d4c896;
    padding: 8px 14px;
  }
  .reasoning-panel {
    margin: 0 0 7px;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: rgba(255,255,255,0.025);
    color: var(--text-secondary);
    transition: border-color 0.3s;
  }
  .reasoning-panel.is-streaming {
    border-color: rgba(100,160,255,0.35);
  }
  .reasoning-panel.is-streaming summary {
    color: #6ba3ff;
  }
  .reasoning-panel summary {
    cursor: pointer;
    padding: 7px 10px;
    color: var(--text-muted);
    font-size: 11px;
    user-select: none;
    display: flex;
    align-items: center;
    gap: 5px;
  }
  .reasoning-panel.is-streaming summary::before {
    content: '';
    width: 6px; height: 6px;
    border-radius: 50%;
    background: #6ba3ff;
    animation: pulseDot 1s ease-in-out infinite;
  }
  @keyframes pulseDot {
    0%, 100% { opacity: 0.3; }
    50% { opacity: 1; }
  }
  .reasoning-content {
    padding: 0 10px 9px;
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 11px;
    line-height: 1.55;
    max-height: 280px;
    overflow: auto;
  }
  .reasoning-content.is-streaming::after {
    content: '▊';
    animation: blinkCursor 0.8s step-end infinite;
    color: #6ba3ff;
    font-size: 10px;
  }

  /* 内联工具徽章 */
  .tool-badges {
    margin: 0 0 6px;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .tool-badge {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 3px 9px;
    border-radius: 10px;
    font-size: 11px;
    line-height: 1.4;
    border: 1px solid var(--border-subtle);
    background: rgba(255,255,255,0.03);
    color: var(--text-secondary);
    max-width: fit-content;
    transition: all 0.25s;
  }
  .tool-badge.running {
    border-color: rgba(100,160,255,0.3);
    color: #6ba3ff;
  }
  .tool-badge.running::before {
    content: '';
    width: 8px; height: 8px;
    border: 1.5px solid #6ba3ff;
    border-top-color: transparent;
    border-radius: 50%;
    animation: spinBadge 0.6s linear infinite;
    flex-shrink: 0;
  }
  .tool-badge.completed {
    border-color: rgba(80,200,120,0.25);
    color: #5ac878;
  }
  .tool-badge.completed::before {
    content: '✓';
    font-size: 10px;
    font-weight: 700;
  }
  .tool-badge.failed {
    border-color: rgba(240,100,100,0.3);
    color: #f06464;
  }
  .tool-badge.failed::before {
    content: '✕';
    font-size: 10px;
    font-weight: 700;
  }
  @keyframes spinBadge {
    to { transform: rotate(360deg); }
  }

  /* 角色标签 + 时间戳 */
  .msg-meta {
    font-size: 11px;
    margin-bottom: 4px;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .msg-wrapper.user .msg-meta { justify-content: flex-end; }
  .role-label {
    font-weight: 600;
    font-size: 11px;
    letter-spacing: 0.3px;
  }
  .role-label.user-label { color: var(--user-label); }
  .role-label.asst-label { color: var(--assistant-label); }
  .role-label.sys-label { color: var(--system-label); }
  .msg-time {
    font-size: 10px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }

  /* Markdown 渲染 */
  .bubble h1, .bubble h2, .bubble h3 { margin: 10px 0 5px; font-weight: 600; }
  .bubble h1 { font-size: 16px; color: var(--text-primary); }
  .bubble h2 { font-size: 14px; color: var(--accent); }
  .bubble h3 { font-size: 13px; }
  .bubble p { margin: 4px 0; }
  .bubble pre {
    background: rgba(0,0,0,0.4);
    padding: 10px 12px;
    border-radius: var(--radius-sm);
    overflow-x: auto;
    margin: 8px 0;
    font-size: 12px;
    border: 1px solid rgba(255,255,255,0.05);
  }
  .bubble code {
    font-family: 'Cascadia Code', 'Fira Code', Consolas, monospace;
    font-size: 12px;
  }
  .bubble p code {
    background: rgba(255,255,255,0.08);
    padding: 1px 5px;
    border-radius: 3px;
    font-size: 11.5px;
  }
  .bubble ul, .bubble ol { padding-left: 18px; margin: 5px 0; }
  .bubble li { margin-bottom: 2px; }
  .bubble a { color: var(--accent); text-decoration: none; }
  .bubble a:hover { text-decoration: underline; }
  .bubble strong { color: #fff; font-weight: 600; }
  .bubble blockquote {
    border-left: 3px solid var(--accent);
    padding-left: 10px;
    margin: 6px 0;
    color: var(--text-secondary);
  }
  .bubble table {
    border-collapse: collapse;
    margin: 8px 0;
    width: 100%;
  }
  .bubble th, .bubble td {
    border: 1px solid var(--border);
    padding: 5px 10px;
    text-align: left;
    font-size: 12px;
  }
  .bubble th { background: rgba(255,255,255,0.03); font-weight: 600; }

  /* 流式光标 */
  .streaming-cursor::after {
    content: '▊';
    animation: blinkCursor 0.8s step-end infinite;
    color: var(--accent);
    margin-left: 2px;
  }
  @keyframes blinkCursor { 50% { opacity: 0; } }

  /* 空状态 */
  .empty-state {
    text-align: center;
    padding: 60px 20px;
    color: var(--text-muted);
  }
  .empty-state .empty-icon {
    font-size: 48px;
    margin-bottom: 14px;
    opacity: 0.5;
  }
  .empty-state .empty-text {
    font-size: 14px;
    color: var(--text-muted);
  }
  .empty-state .empty-hint {
    font-size: 12px;
    margin-top: 8px;
    color: var(--text-muted);
    opacity: 0.7;
  }

  /* ========== 输入区域 ========== */
  .input-area {
    padding: 10px 16px 14px;
    background: var(--bg-secondary);
    border-top: 1px solid var(--border-subtle);
    flex-shrink: 0;
  }

  /* 上方工具栏 */
  .input-toolbar {
    display: flex;
    align-items: center;
    gap: 2px;
    margin-bottom: 8px;
  }
  .toolbar-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 28px;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 14px;
    transition: all var(--transition);
    position: relative;
  }
  .toolbar-btn:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }
  .toolbar-btn.active {
    color: var(--accent);
    background: var(--accent-dim);
  }
  .toolbar-btn .tooltip {
    display: none;
    position: absolute;
    bottom: calc(100% + 6px);
    left: 50%;
    transform: translateX(-50%);
    padding: 4px 8px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 4px;
    font-size: 11px;
    white-space: nowrap;
    color: var(--text-primary);
    box-shadow: var(--shadow-md);
    z-index: 100;
  }
  .toolbar-btn:hover .tooltip { display: block; }
  .toolbar-spacer { flex: 1; }
  .timer-display {
    font-size: 11px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
    padding: 0 8px;
  }
  .context-usage {
    font-size: 10px;
    color: var(--text-muted);
    padding: 2px 7px;
    border: 1px solid var(--border-subtle);
    border-radius: 10px;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .context-usage.warn { color: var(--warning); border-color: rgba(245,158,11,0.45); }
  .context-usage.danger { color: var(--danger); border-color: rgba(239,68,68,0.45); }

  /* 输入框容器 */
  .input-container {
    display: flex;
    gap: 8px;
    align-items: flex-end;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 8px 10px;
    transition: border-color var(--transition);
  }
  .input-container:focus-within {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-glow);
  }
  .input-container textarea {
    flex: 1;
    resize: none;
    min-height: 22px;
    max-height: 130px;
    border: none;
    background: transparent;
    color: var(--text-primary);
    font-family: inherit;
    font-size: 13.5px;
    line-height: 1.55;
    outline: none;
    padding: 0 2px;
  }
  .input-container textarea::placeholder {
    color: var(--text-muted);
  }
  .input-container { position: relative; }
  .cmd-hint {
    position: absolute; bottom: 100%; left: 0; right: 0;
    max-height: 240px; overflow-y: auto;
    background: var(--bg-elevated); border: 1px solid var(--border);
    border-radius: var(--radius-md); box-shadow: 0 -4px 16px rgba(0,0,0,.25);
    z-index: 200; margin-bottom: 4px;
  }
  .cmd-hint-item {
    display: flex; align-items: center; gap: 10px; padding: 8px 12px; cursor: pointer;
    border-bottom: 1px solid var(--border-subtle); font-size: 12px;
  }
  .cmd-hint-item:last-child { border-bottom: none; }
  .cmd-hint-item:hover, .cmd-hint-item.active { background: var(--bg-hover); }
  .cmd-hint-cmd { font-weight: 600; color: var(--accent); min-width: 80px; }
  .cmd-hint-label { color: var(--text-secondary); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cmd-hint-file-icon { color: var(--text-muted); font-size: 14px; flex-shrink: 0; }
  .cmd-hint-file-path { color: var(--text-primary); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; }
  .cmd-hint-file-name { color: var(--accent); font-weight: 600; }
  .send-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    border: none;
    border-radius: 50%;
    cursor: pointer;
    font-size: 16px;
    transition: all var(--transition);
    flex-shrink: 0;
    background: var(--accent);
    color: #fff;
  }
  .send-btn:hover {
    background: #15bddd;
    transform: scale(1.05);
    box-shadow: 0 2px 8px var(--accent-glow);
  }
  .send-btn:active { transform: scale(0.95); }
  .send-btn.stop-mode {
    background: var(--danger);
    animation: pulseStop 1.5s ease infinite;
  }
  @keyframes pulseStop {
    0%, 100% { box-shadow: 0 0 0 0 rgba(239,68,68,0.3); }
    50% { box-shadow: 0 0 0 6px rgba(239,68,68,0); }
  }

  /* 底部工具栏 */
  .bottom-toolbar {
    display: flex;
    align-items: center;
    gap: 2px;
    margin-top: 8px;
    padding-top: 6px;
  }
  .model-name { font-size: 11px; color: var(--text-secondary); margin-left: 3px; max-width: 130px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #btnModel { width: auto; padding: 0 8px; gap: 2px; }
  #btnModel:hover .model-name { color: var(--text-primary); }

  /* ========== 角色模型设置弹窗 ========== */
  .modal-overlay {
    display: none;
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.6);
    z-index: 1000;
    justify-content: center;
    align-items: center;
    backdrop-filter: blur(4px);
    animation: fadeIn 0.15s ease;
  }
  .modal-overlay.show { display: flex; }
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

  .settings-modal {
    width: 420px;
    max-height: 80vh;
    overflow-y: auto;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-md), 0 20px 60px rgba(0,0,0,0.5);
    animation: slideUp 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  }
  @keyframes slideUp {
    from { opacity: 0; transform: translateY(16px) scale(0.97); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 18px;
    border-bottom: 1px solid var(--border-subtle);
  }
  .modal-header h3 {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-primary);
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .modal-close-btn {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    border: none;
    background: transparent;
    color: var(--text-muted);
    font-size: 16px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all var(--transition);
  }
  .modal-close-btn:hover {
    background: rgba(255,255,255,0.08);
    color: var(--text-primary);
  }

  .modal-body { padding: 16px 18px; }

  .setting-group { margin-bottom: 14px; }
  .setting-group:last-child { margin-bottom: 0; }
  .setting-label {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-secondary);
    margin-bottom: 6px;
  }
  .setting-hint {
    font-size: 10px;
    color: var(--text-muted);
    margin-top: 3px;
  }
  .setting-input {
    width: 100%;
    padding: 8px 10px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--bg-input);
    color: var(--text-primary);
    font-size: 12px;
    font-family: inherit;
    outline: none;
    transition: border-color var(--transition);
  }
  .setting-input:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px var(--accent-glow);
  }
  .setting-input::placeholder { color: var(--text-muted); opacity: 0.7; }

  .model-presets {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
    margin-top: 6px;
  }
  .preset-chip {
    padding: 3px 8px;
    border-radius: 12px;
    font-size: 10px;
    cursor: pointer;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text-secondary);
    transition: all var(--transition);
  }
  .preset-chip:hover {
    border-color: var(--accent);
    color: var(--accent);
    background: var(--accent-dim);
  }
  .preset-chip.active {
    background: var(--accent-dim);
    border-color: var(--accent);
    color: var(--accent);
  }

  .modal-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 18px;
    border-top: 1px solid var(--border-subtle);
  }
  .btn-modal {
    padding: 6px 16px;
    border-radius: var(--radius-sm);
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: all var(--transition);
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text-secondary);
  }
  .btn-modal:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }
  .btn-modal-primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  .btn-modal-primary:hover {
    background: #15bddd;
    border-color: #15bddd;
  }
  .config-status {
    font-size: 11px;
    color: var(--text-muted);
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .config-dot { width: 6px; height: 6px; border-radius: 50%; }
  .config-dot.custom { background: var(--accent); }
  .config-dot.global { background: var(--text-muted); }
</style>
</head>
<body>

  <!-- 会话标签栏 -->
  <div class="tab-bar" id="tabBar">
    <div class="tab-add-btn" id="tabAddBtn" title="新建会话">+</div>
  </div>

  <!-- 对话记录头部 -->
  <div class="chat-header">
    <span class="header-title">对话记录</span>
    <button class="btn-clear" id="btnClear">清空</button>
  </div>

  <!-- 消息列表 -->
  <div class="messages" id="messages">
    <div class="empty-state">
      <div class="empty-icon">💬</div>
      <div class="empty-text">开始与 AI 角色对话</div>
      <div class="empty-hint">输入消息，按 Enter 发送 · Shift+Enter 换行</div>
    </div>
  </div>

  <!-- 输入区域 -->
  <div class="input-area">
    <!-- 上方工具栏 -->
    <div class="input-toolbar">
      <button class="toolbar-btn" id="btnContext" title="会话接力与上下文对齐">
        ⇄<span class="tooltip">上下文对齐</span>
      </button>
      <div class="toolbar-spacer"></div>
      <span class="context-usage" id="contextUsage" title="当前会话上下文估算占用">上下文 0 / 128K · 0%</span>
      <span class="token-usage" id="tokenUsage" title="API 返回的真实 token 用量" style="display:none;font-size:11px;color:var(--text3);"></span>
      <span class="timer-display" id="timerDisplay">00:00:00</span>
    </div>

    <!-- 输入框 -->
    <div class="input-container">
      <textarea id="input" placeholder="输入消息 · / 模式 · @ 文件" rows="1"></textarea>
      <button class="send-btn" id="btnSend" title="发送 (Enter)">➤</button>
    </div>

    <!-- 底部工具栏 -->
    <div class="bottom-toolbar">
      <button class="toolbar-btn" title="上传文件">📎<span class="tooltip">上传文件</span></button>
      <button class="toolbar-btn" title="历史记录">🕐<span class="tooltip">历史记录</span></button>
      <button class="toolbar-btn" title="搜索">🔍<span class="tooltip">搜索</span></button>
      <button class="toolbar-btn" id="btnTrash" title="清空">🗑️<span class="tooltip">清空对话</span></button>
      <div class="toolbar-spacer"></div>
      <button class="toolbar-btn" id="btnToolPerm" title="工具权限">🛠️<span class="tooltip">工具权限</span></button>
      <button class="toolbar-btn" title="复制最后回复">📋<span class="tooltip">复制</span></button>
      <button class="toolbar-btn" title="重新生成">🔄<span class="tooltip">重新生成</span></button>
      <button class="toolbar-btn" id="btnModel" title="点击在左侧「模型设置」切换模型">🤖<span class="model-name" id="modelName">未配置模型</span><span class="tooltip">在左侧切换模型</span></button>
    </div>
  </div>

  <!-- 模型切换已收敛到左侧「模型设置」视图 -->

  <!-- 工具权限弹窗 -->
  <div class="modal-overlay" id="toolPermModal">
    <div class="settings-modal" style="width:480px;">
      <div class="modal-header">
        <h3>🛠️ 工具权限 — <span id="toolPermRoleName"></span></h3>
        <button class="modal-close-btn" id="toolPermClose">✕</button>
      </div>
      <div class="modal-body">
        <div class="setting-hint" style="margin-bottom:10px;">允许 = 白名单模式（仅启用选中工具，留空=继承全部）；禁止 = 黑名单（优先排除）。</div>
        <div id="toolPermGrid"></div>
      </div>
      <div class="modal-footer">
        <span class="config-status" id="toolPermStatus"></span>
        <button class="btn-modal btn-modal-primary" id="toolPermSave">保存</button>
      </div>
    </div>
  </div>

  <!-- 工具审批弹窗 -->
  <div class="modal-overlay" id="approvalModal">
    <div class="settings-modal" style="width:520px;">
      <div class="modal-header">
        <h3 id="approvalTitle">⚠️ 工具审批</h3>
        <button class="modal-close-btn" id="approvalDeny" title="拒绝">✕</button>
      </div>
      <div class="modal-body">
        <pre id="approvalDetail" style="white-space:pre-wrap;font-size:12px;line-height:1.6;color:var(--text-secondary);font-family:var(--vscode-editor-font-family,monospace);max-height:300px;overflow-y:auto;"></pre>
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
  const messagesEl = document.getElementById('messages');
  const inputEl = document.getElementById('input');
  const btnSend = document.getElementById('btnSend');
  const btnClear = document.getElementById('btnClear');
  const btnContext = document.getElementById('btnContext');
  const btnTrash = document.getElementById('btnTrash');
  const tabBarEl = document.getElementById('tabBar');
  const tabAddBtn = document.getElementById('tabAddBtn');
  const timerDisplayEl = document.getElementById('timerDisplay');
  const inputContainer = document.querySelector('.input-container');
  const cmdHintEl = document.createElement('div');
  cmdHintEl.className = 'cmd-hint';
  cmdHintEl.style.display = 'none';
  if (inputContainer) inputContainer.appendChild(cmdHintEl);
  let cmdHintMode = null;
  let cmdHintItems = [];
  let cmdHintActiveIdx = 0;
  let workspaceFiles = [];

  let isStreaming = false;
  let currentAssistantEl = null;
  let currentToolStatusEl = null;
  const toolStatusElements = new Map();
  let autoFollowOutput = true;
  let timerSeconds = 0;
  let timerInterval = null;

  // ====== 计时器 ======
  function startTimer() {
    stopTimer();
    timerSeconds = 0;
    timerInterval = setInterval(() => {
      timerSeconds++;
      const h = String(Math.floor(timerSeconds / 3600)).padStart(2,'0');
      const m = String(Math.floor((timerSeconds % 3600)/60)).padStart(2,'0');
      const s = String(timerSeconds % 60).padStart(2,'0');
      timerDisplayEl.textContent = h+':'+m+':'+s;
    }, 1000);
  }
  function stopTimer() {
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
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
    const el = document.getElementById('contextUsage');
    el.textContent = '上下文 ' + formatTokens(usage.used) + ' / ' + formatTokens(usage.limit) + ' · ' + usage.percent + '%';
    el.title = '估算已占用 ' + usage.used.toLocaleString() + ' tokens，上限 ' + usage.limit.toLocaleString() + ' tokens' + (usage.percent >= 70 ? '。点击接力到新会话，避免压缩丢失重要信息。' : '。点击可进行会话接力或跨会话对齐。');
    el.style.cursor = 'pointer';
    el.classList.toggle('warn', usage.percent >= 70 && usage.percent < 90);
    el.classList.toggle('danger', usage.percent >= 90);
  }

  function updateTokenUsage(usage) {
    if (!usage) return;
    const el = document.getElementById('tokenUsage');
    if (!el) return;
    const parts = [];
    parts.push('↑' + formatTokens(usage.promptTokens));
    parts.push('↓' + formatTokens(usage.completionTokens));
    if (usage.cacheHitTokens != null && usage.cacheHitTokens > 0) {
      const totalInput = usage.cacheHitTokens + (usage.cacheMissTokens || 0);
      const hitRate = totalInput > 0 ? Math.round(usage.cacheHitTokens / totalInput * 100) : 0;
      parts.push('cache ' + hitRate + '%');
    }
    el.textContent = parts.join(' · ');
    el.title = 'API 返回真实用量\\n输入: ' + usage.promptTokens.toLocaleString() + ' tokens\\n输出: ' + usage.completionTokens.toLocaleString() + ' tokens' +
      (usage.cacheHitTokens != null ? '\\n缓存命中: ' + usage.cacheHitTokens.toLocaleString() + ' tokens' : '') +
      (usage.cacheMissTokens != null ? '\\n缓存未命中: ' + usage.cacheMissTokens.toLocaleString() + ' tokens' : '');
    el.style.display = '';
  }

  // ====== 标签栏管理 ======
  function renderTabBar(sessions) {
    // 保留添加按钮
    const addBtn = tabAddBtn;
    tabBarEl.innerHTML = '';
    tabBarEl.appendChild(addBtn);

    sessions.forEach(s => {
      const tab = document.createElement('div');
      tab.className = 'session-tab' + (s.isActive ? ' active' : '');
      tab.dataset.sessionId = s.id;
      tab.innerHTML =
        '<span class="tab-icon">' + escapeHtml(s.roleIcon || '💬') + '</span>' +
        '<span class="tab-name">' + escapeHtml(s.roleName || s.title) + '</span>' +
        (!s.isActive ? '<span class="tab-close" data-close="' + s.id + '">✕</span>' : '');

      tab.addEventListener('click', (e) => {
        if (e.target.classList.contains('tab-close')) {
          vscode.postMessage({ type: 'closeSession', sessionId: e.target.dataset.close });
          return;
        }
        vscode.postMessage({ type: 'switchSession', sessionId: s.id });
      });

      tabBarEl.insertBefore(tab, addBtn);
    });
  }

  // ====== Markdown 渲染 ======
  function renderMarkdown(text) {
    if (!text) return '';
    let html = escapeHtml(text);
    // 代码块 (must be first)
    html = html.replace(/\\x60\\x60\\x60(\\w*)\\n?([\\s\\S]*?)\\x60\\x60\\x60/g, (_, lang, code) =>
      '<pre><code class="language-' + (lang||'') + '">' + code.trim() + '</code></pre>'
    );
    // 行内代码
    html = html.replace(/\\x60([^\\x60\\n]+)\\x60/g, '<code>$1</code>');
    // 标题
    html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
    // 粗体/斜体
    html = html.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
    html = html.replace(/\\*(.+?)\\*/g, '<em>$1</em>');
    // 引用块
    html = html.replace(/^&gt;\\s?(.+)$/gm, '<blockquote>$1</blockquote>');
    // 无序列表
    html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>[\\s\\S]*?<\\/li>)/g, '<ul>$1</ul>');
    // 有序列表
    html = html.replace(/^\\d+. (.+)$/gm, '<li>$1</li>');
    // 链接
    html = html.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2" target="_blank">$1</a>');
    // 分隔线
    html = html.replace(/^---$/gm, '<hr style="border:none;border-top:1px solid var(--border);margin:8px 0;">');
    // 换行
    html = html.replace(/\\n/g, '<br>');

    // Clean up empty tags
    html = html.replace(/<ul><\\/ul>/g, '');
    html = html.replace(/<br><br>/g, '<br>');
    return html;
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function formatTime(isoStr) {
    if (!isoStr) return '';
    const d = new Date(isoStr);
    const hh = String(d.getHours()).padStart(2,'0');
    const mm = String(d.getMinutes()).padStart(2,'0');
    const ss = String(d.getSeconds()).padStart(2,'0');
    return hh+':'+mm+':'+ss;
  }

  // ====== 追加消息 ======
  function ensureReasoningPanel(bubble) {
    if (!bubble) return null;
    const wrapper = bubble.parentElement;
    let panel = wrapper.querySelector('.reasoning-panel');
    if (!panel) {
      panel = document.createElement('details');
      panel.className = 'reasoning-panel is-streaming';
      panel.open = true;
      panel.innerHTML = '<summary>思考中...</summary><div class="reasoning-content is-streaming"></div>';
      wrapper.insertBefore(panel, bubble);
    }
    return panel;
  }

  function ensureToolBadges(bubble) {
    if (!bubble) return null;
    const wrapper = bubble.parentElement;
    let container = wrapper.querySelector('.tool-badges');
    if (!container) {
      container = document.createElement('div');
      container.className = 'tool-badges';
      wrapper.insertBefore(container, bubble);
    }
    return container;
  }

  function appendMessage(role, content, createdAt) {
    const empty = messagesEl.querySelector('.empty-state');
    if (empty) empty.remove();

    const wrapper = document.createElement('div');
    wrapper.className = 'msg-wrapper ' + role;

    const bubble = document.createElement('div');
    bubble.className = 'bubble';

    if (role === 'system') {
      bubble.textContent = content;
    } else {
      bubble.innerHTML = renderMarkdown(content);
    }

    // 构建消息元信息
    let metaHtml = '';
    if (role === 'user') {
      metaHtml = '<div class="msg-meta"><span class="role-label user-label">你</span><span class="msg-time">' + formatTime(createdAt) + '</span></div>';
    } else if (role === 'assistant') {
      metaHtml = '<div class="msg-meta"><span class="role-label asst-label">' + (window._currentRoleName || 'AI') + '</span><span class="msg-time">' + formatTime(createdAt) + '</span></div>';
    } else if (role === 'system') {
      metaHtml = '<div class="msg-meta"><span class="role-label sys-label">系统</span><span class="msg-time">' + formatTime(createdAt) + '</span></div>';
    }

    wrapper.innerHTML = metaHtml;
    wrapper.appendChild(bubble);
    messagesEl.appendChild(wrapper);

    scrollBottom(false);
    return bubble;
  }

  // ====== 流式状态 ======
  function setStreaming(streaming) {
    isStreaming = streaming;
    if (streaming) {
      btnSend.classList.add('stop-mode');
      btnSend.textContent = '■';
      startTimer();
    } else {
      btnSend.classList.remove('stop-mode');
      btnSend.textContent = '➤';
      stopTimer();
    }
  }

  // ====== 发送消息 ======
  function sendMessage() {
    const content = inputEl.value.trim();
    if (!content || isStreaming) return;
    vscode.postMessage({ type: 'sendMessage', content });
    inputEl.value = '';
    inputEl.style.height = 'auto';
  }

  // ====== 事件绑定 ======

  // 发送按钮
  btnSend.addEventListener('click', () => {
    if (isStreaming) {
      vscode.postMessage({ type: 'abortStream' });
    } else {
      sendMessage();
    }
  });

  // 清空
  btnClear.addEventListener('click', () => {
    vscode.postMessage({ type: 'clearHistory' });
  });
  btnTrash.addEventListener('click', () => {
    vscode.postMessage({ type: 'clearHistory' });
  });

  // 注入上下文
  btnContext.addEventListener('click', () => {
    vscode.postMessage({ type: 'injectContext' });
  });
  document.getElementById('contextUsage').addEventListener('click', () => {
    vscode.postMessage({ type: 'injectContext' });
  });

  // ─── 命令提示（/ slash 命令 + @ 文件选择）───
  const SLASH_COMMANDS = [
    { cmd: '/code', label: '编码模式 — 直接输出可执行代码' },
    { cmd: '/ask', label: '问答模式 — 简洁准确回答问题' },
    { cmd: '/debug', label: '调试模式 — 系统化排查问题' },
    { cmd: '/architect', label: '架构模式 — 架构师视角分析设计' },
  ];
  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

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
      el.addEventListener('click', () => { selectCmdHint(Number(el.dataset.idx)); });
      el.addEventListener('mouseenter', () => { setActiveHint(Number(el.dataset.idx)); });
    });
  }

  function setActiveHint(idx) {
    cmdHintActiveIdx = idx;
    cmdHintEl.querySelectorAll('.cmd-hint-item').forEach((el, i) => el.classList.toggle('active', i === idx));
  }

  function selectCmdHint(idx) {
    const item = cmdHintItems[idx];
    if (!item) return;
    if (item.type === 'slash') {
      const parts = inputEl.value.split(/\s+/);
      parts[0] = item.cmd;
      inputEl.value = parts.join(' ') + ' ';
    } else if (item.type === 'file') {
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
    inputEl.style.height = Math.min(inputEl.scrollHeight, 130) + 'px';
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

  // 键盘快捷键
  inputEl.addEventListener('keydown', (e) => {
    if (cmdHintEl.style.display !== 'none' && cmdHintItems.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActiveHint((cmdHintActiveIdx + 1) % cmdHintItems.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setActiveHint((cmdHintActiveIdx - 1 + cmdHintItems.length) % cmdHintItems.length); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); selectCmdHint(cmdHintActiveIdx); return; }
      if (e.key === 'Escape') { e.preventDefault(); hideCmdHint(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // 自适应高度
  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 130) + 'px';
    updateCmdHint();
  });
  document.addEventListener('click', (e) => {
    if (cmdHintEl.style.display !== 'none' && !cmdHintEl.contains(e.target) && e.target !== inputEl) {
      hideCmdHint();
    }
  });

  // ====== 模型名标签：点击跳转左侧「模型设置」切换模型 ======
  const modelNameEl = document.getElementById('modelName');
  const btnModel = document.getElementById('btnModel');
  if (btnModel) {
    btnModel.addEventListener('click', () => {
      vscode.postMessage({ type: 'focusModelsView' });
    });
  }

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
    {name:'workspace_apply_diff', label:'Diff 补丁', group:'编辑'},
    {name:'workspace_search_replace', label:'搜索替换', group:'编辑'},
    {name:'workspace_delete', label:'删除文件', group:'编辑'},
    {name:'run_command', label:'执行命令', group:'命令'},
    {name:'dispatch_session_task', label:'派发任务', group:'编排'},
    {name:'orchestrate_task', label:'自动编排', group:'编排'},
    {name:'todo_list_create', label:'创建清单', group:'任务'},
    {name:'todo_list_update', label:'更新清单', group:'任务'},
    {name:'todo_list_read', label:'读取清单', group:'任务'},
    {name:'history_search', label:'历史搜索', group:'任务'},
    {name:'web_search', label:'联网搜索', group:'联网'},
    {name:'web_fetch', label:'网页抓取', group:'联网'},
  ];
  const toolPermModal = document.getElementById('toolPermModal');
  const toolPermGrid = document.getElementById('toolPermGrid');
  const toolPermRoleName = document.getElementById('toolPermRoleName');
  const toolPermStatus = document.getElementById('toolPermStatus');
  const btnToolPerm = document.getElementById('btnToolPerm');
  if (btnToolPerm) {
    btnToolPerm.addEventListener('click', () => {
      vscode.postMessage({ type: 'openToolPermissions' });
    });
  }
  document.getElementById('toolPermClose').addEventListener('click', () => {
    toolPermModal.classList.remove('show');
  });
  function renderToolPermGrid(allowedSet, deniedSet) {
    const groups = {};
    TOOL_LIST.forEach(t => { (groups[t.group] = groups[t.group] || []).push(t); });
    toolPermGrid.innerHTML = Object.entries(groups).map(([groupLabel, tools]) => {
      const rows = tools.map(t => {
        const isAllowed = allowedSet.has(t.name);
        const isDenied = deniedSet.has(t.name);
        return '<div class="tool-perm-row" style="display:flex;align-items:center;justify-content:space-between;padding:4px 0;">' +
          '<span style="font-size:12px;" title="' + t.name + '">' + t.label + '</span>' +
          '<div style="display:flex;gap:4px;">' +
            '<span class="tool-perm-btn allow' + (isAllowed ? ' active' : '') + '" data-allow="' + t.name + '" style="padding:2px 8px;border-radius:4px;cursor:pointer;font-size:11px;border:1px solid var(--border);' + (isAllowed ? 'background:var(--accent-dim);color:var(--accent);border-color:var(--accent);' : '') + '">允许</span>' +
            '<span class="tool-perm-btn deny' + (isDenied ? ' active' : '') + '" data-deny="' + t.name + '" style="padding:2px 8px;border-radius:4px;cursor:pointer;font-size:11px;border:1px solid var(--border);' + (isDenied ? 'background:rgba(239,68,68,0.15);color:var(--danger);border-color:var(--danger);' : '') + '">禁止</span>' +
          '</div>' +
        '</div>';
      }).join('');
      return '<div style="margin-bottom:10px;"><div style="font-size:11px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;margin-bottom:4px;">' + groupLabel + '</div>' + rows + '</div>';
    }).join('');
    // toggle events
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
          // 禁止取消
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
          // 允许取消
          const allowBtn = btn.parentElement.querySelector('.allow.active');
          if (allowBtn && btn.classList.contains('active')) {
            allowBtn.classList.remove('active');
            allowBtn.style.cssText = 'padding:2px 8px;border-radius:4px;cursor:pointer;font-size:11px;border:1px solid var(--border);';
          }
        }
      });
    });
  }
  document.getElementById('toolPermSave').addEventListener('click', () => {
    const allowedTools = Array.from(toolPermGrid.querySelectorAll('.tool-perm-btn.allow.active')).map(el => el.dataset.allow);
    const deniedTools = Array.from(toolPermGrid.querySelectorAll('.tool-perm-btn.deny.active')).map(el => el.dataset.deny);
    toolPermStatus.textContent = '保存中…';
    vscode.postMessage({ type: 'updateToolPermissions', allowedTools, deniedTools });
  });

  // ====== 工具审批弹窗 ======
  const approvalModal = document.getElementById('approvalModal');
  const approvalTitle = document.getElementById('approvalTitle');
  const approvalDetail = document.getElementById('approvalDetail');
  const approvalRemember = document.getElementById('approvalRemember');
  let currentApprovalId = null;
  let currentApprovalToolName = '';
  document.getElementById('approvalApprove').addEventListener('click', () => {
    if (!currentApprovalId) return;
    const remember = approvalRemember.checked;
    if (remember && currentApprovalToolName) {
      vscode.postMessage({ type: 'toolApprovalResponse', approvalId: currentApprovalId, approved: true, remember: true, toolName: currentApprovalToolName });
    } else {
      vscode.postMessage({ type: 'toolApprovalResponse', approvalId: currentApprovalId, approved: true, remember: false });
    }
    approvalModal.classList.remove('show');
    currentApprovalId = null;
  });
  document.getElementById('approvalDenyBtn').addEventListener('click', () => {
    if (!currentApprovalId) return;
    vscode.postMessage({ type: 'toolApprovalResponse', approvalId: currentApprovalId, approved: false });
    approvalModal.classList.remove('show');
    currentApprovalId = null;
  });
  document.getElementById('approvalDeny').addEventListener('click', () => {
    if (!currentApprovalId) return;
    vscode.postMessage({ type: 'toolApprovalResponse', approvalId: currentApprovalId, approved: false });
    approvalModal.classList.remove('show');
    currentApprovalId = null;
  });

  // ====== 接收扩展消息 ======
  window.addEventListener('message', (e) => {
    const msg = e.data;
    switch (msg.type) {
      case 'workspaceFiles':
        if (Array.isArray(msg.files)) workspaceFiles = msg.files;
        break;
      case 'historyLoaded': {
        autoFollowOutput = true;
        window._currentRoleName = msg.role ? msg.role.name : 'AI';
        if (msg.modelName && modelNameEl) modelNameEl.textContent = msg.modelName;
        updateContextUsage(msg.contextUsage);

        // 渲染标签栏
        if (msg.sessions) renderTabBar(msg.sessions);

        // 更新角色信息
        messagesEl.innerHTML = '';
        currentAssistantEl = null;

        if (msg.messages && msg.messages.length > 0) {
          msg.messages.forEach(m => {
            if (m.role === 'system') {
              appendMessage('system', m.content, m.createdAt);
            } else {
              appendMessage(m.role, m.content, m.createdAt);
            }
          });
        } else {
          messagesEl.innerHTML = '<div class="empty-state"><div class="empty-icon">💬</div><div class="empty-text">开始与 AI 角色对话</div><div class="empty-hint">输入消息，按 Enter 发送 · Shift+Enter 换行</div></div>';
        }
        // 如果正在 streaming，重建 streaming 气泡
        if (isStreaming) {
          currentAssistantEl = appendMessage('assistant', '', new Date().toISOString());
          currentAssistantEl.classList.add('streaming-cursor');
        }
        scrollBottom(true);
        break;
      }
      case 'userMessage':
        autoFollowOutput = true;
        appendMessage('user', msg.content, new Date().toISOString());
        scrollBottom(true);
        break;
      case 'modeIndicator':
        appendMessage('system', '📋 ' + msg.mode, new Date().toISOString());
        break;
      case 'streamStart':
        setStreaming(true);
        autoFollowOutput = true;
        currentToolStatusEl = null;
        toolStatusElements.clear();
        currentAssistantEl = appendMessage('assistant', '', new Date().toISOString());
        currentAssistantEl.classList.add('streaming-cursor');
        break;
      case 'reasoningChunk': {
        if (currentAssistantEl) {
          const panel = ensureReasoningPanel(currentAssistantEl);
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
        if (currentAssistantEl) {
          const raw = currentAssistantEl.getAttribute('data-raw') || '';
          const newText = raw + msg.delta;
          currentAssistantEl.setAttribute('data-raw', newText);
          currentAssistantEl.innerHTML = renderMarkdown(newText);
          scrollBottom(false);
        }
        break;
      }
      case 'toolStatus': {
        const toolKey = msg.callId || msg.name || '';
        if (!currentAssistantEl) break;
        const badges = ensureToolBadges(currentAssistantEl);
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
        setStreaming(false);
        if (currentAssistantEl) {
          currentAssistantEl.classList.remove('streaming-cursor');
          currentAssistantEl.removeAttribute('data-raw');
          if (msg.fullText) {
            currentAssistantEl.innerHTML = renderMarkdown(msg.fullText);
            if (msg.reasoningText) {
              const panel = ensureReasoningPanel(currentAssistantEl);
              panel.classList.remove('is-streaming');
              panel.querySelector('summary').textContent = '思考过程';
              const content = panel.querySelector('.reasoning-content');
              content.classList.remove('is-streaming');
              content.removeAttribute('data-raw');
              content.textContent = msg.reasoningText;
            }
          } else {
            currentAssistantEl.textContent = msg.aborted ? '(已中断)' : '(已完成，无文本回复)';
          }
          currentAssistantEl = null;
          currentToolStatusEl = null;
          toolStatusElements.clear();
        }
        break;
      case 'streamError':
        setStreaming(false);
        if (currentAssistantEl) {
          currentAssistantEl.classList.remove('streaming-cursor');
          currentAssistantEl.removeAttribute('data-raw');
          currentAssistantEl.innerHTML = msg.fullText ? renderMarkdown(msg.fullText) : '(生成失败)';
          if (msg.reasoningText) {
            const panel = ensureReasoningPanel(currentAssistantEl);
            panel.classList.remove('is-streaming');
            panel.querySelector('summary').textContent = '思考过程';
            const content = panel.querySelector('.reasoning-content');
            content.classList.remove('is-streaming');
            content.removeAttribute('data-raw');
            content.textContent = msg.reasoningText;
          }
          currentAssistantEl = null;
          currentToolStatusEl = null;
          toolStatusElements.clear();
        }
        appendMessage('system', '错误: ' + msg.message, new Date().toISOString());
        break;
      case 'contextInjected':
        appendMessage('system', msg.summary, new Date().toISOString());
        break;
      case 'error':
        setStreaming(false);
        appendMessage('system', '❌ 错误: ' + msg.message, new Date().toISOString());
        break;
      case 'sessionsUpdated':
        if (msg.sessions) renderTabBar(msg.sessions);
        break;
      case 'modelName':
        if (modelNameEl) modelNameEl.textContent = msg.modelName || '未配置模型';
        updateContextUsage(msg.contextUsage);
        break;
      case 'contextUsage':
        updateContextUsage(msg);
        break;
      case 'tokenUsage':
        updateTokenUsage(msg.usage);
        break;
      case 'toolPermissionsData':
        toolPermRoleName.textContent = msg.roleName || '';
        renderToolPermGrid(new Set(msg.allowedTools || []), new Set(msg.deniedTools || []));
        toolPermStatus.textContent = '';
        toolPermModal.classList.add('show');
        break;
      case 'toolPermissionsSaved':
        toolPermStatus.textContent = '✅ 已保存，当前会话立即生效';
        setTimeout(() => { toolPermModal.classList.remove('show'); }, 600);
        break;
      case 'toolApprovalRequest':
        currentApprovalId = msg.approvalId;
        currentApprovalToolName = msg.toolName || '';
        approvalTitle.textContent = msg.title || '⚠️ 工具审批';
        approvalDetail.textContent = msg.detail || '';
        approvalRemember.checked = false;
        approvalModal.classList.add('show');
        break;
    }
  });

  // 自动聚焦
  inputEl.focus();
</script>
</body>
</html>`;
  }
}
