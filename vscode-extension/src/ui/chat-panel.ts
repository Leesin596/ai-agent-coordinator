// ============================================================
// ChatPanel — 聊天会话 Webview 面板管理器（Premium UI v2）
// 管理 WebviewPanel 生命周期 + postMessage 通信 + LLM 流式调用
// ============================================================
import * as vscode from 'vscode';
import type { CoordinatorContext, ActiveWorkspaceRuntime } from '../backend/coordinator-context';
import type { Role, Session } from '../../../src/models/types';
import { LLMService, estimateMessageTokens, type LLMMessage, type LLMConfig, type LLMToolCall } from '../services/llm-service';
import { COORDINATOR_LLM_TOOLS } from '../services/llm-api';
import { buildWorkspaceContext } from '../services/workspace-context';
import { WorkspaceToolExecutor } from '../services/workspace-tools';
import {
  buildSessionContextPackage,
  listContextSessionOptions,
  type ContextTransferMode,
} from '../services/context-transfer';

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
  private abortFn: (() => void) | null = null;
  private isStreaming = false;
  private role: Role;
  private session: Session;
  private ctx: CoordinatorContext;
  private runtime: ActiveWorkspaceRuntime;
  private disposables: vscode.Disposable[] = [];

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
      const choice = await vscode.window.showWarningMessage(
        request.title,
        { modal: true, detail: request.detail },
        request.confirmLabel,
      );
      return choice === request.confirmLabel;
    });

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
    }
  }

  private async handleSendMessage(content: string): Promise<void> {
    if (this.isStreaming || !content.trim()) return;

    const config = this.getLLMConfig(this.session.id);
    if (!config.apiKey) {
      this.sendToWebview({ type: 'error', message: '未配置模型 API Key，请在左侧「模型设置」中添加模型预设' });
      return;
    }

    this.runtime.sessionManager.addMessage(this.session.id, 'user', content);
    this.sendToWebview({ type: 'userMessage', content });

    this.isStreaming = true;
    this.sendToWebview({ type: 'streamStart' });

    const messages = this.runtime.sessionManager.getConversationMessages(this.session.id) as LLMMessage[];

    const workspaceContext = buildWorkspaceContext(
      this.ctx,
      this.runtime,
      this.session.id,
      content,
    );
    const systemIdx = messages.findIndex((m) => m.role === 'system');
    if (systemIdx >= 0) {
      messages.splice(systemIdx + 1, 0, { role: 'system', content: workspaceContext } as LLMMessage);
    } else {
      messages.unshift({ role: 'system', content: workspaceContext } as LLMMessage);
    }

    this.sendContextUsage(messages, config.contextWindow);
    this.toolExecutor.begin();

    let usedNativeTool = false;
    this.abortFn = this.llm.streamChat(messages, { ...config, tools: COORDINATOR_LLM_TOOLS }, {
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
      onDone: (fullText, reasoningText) => {
        this.isStreaming = false;
        this.abortFn = null;
        if (fullText) this.runtime.sessionManager.addMessage(this.session.id, 'assistant', fullText);
        this.sendToWebview({ type: 'streamEnd', fullText, reasoningText });
        this.sendContextUsage(
          [...messages, { content: fullText }],
          config.contextWindow,
        );
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
    if (call.name !== 'dispatch_session_task') return this.toolExecutor.execute(call);
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
      contextUsage: this.getContextUsage(
        this.runtime.sessionManager.getConversationMessages(this.session.id) as LLMMessage[],
        this.getLLMConfig(this.session.id).contextWindow,
      ),
      session: { id: this.session.id, title: this.session.title },
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
        createdAt: m.createdAt,
      })),
    });
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
            contextWindow: preset.contextWindow ?? 1000000,
            thinkingStrength: preset.thinkingStrength ?? 'xhigh',
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
      contextWindow: 1000000,
      thinkingStrength: 'xhigh',
    };
  }

  private getContextUsage(messages: Array<{ content: string }>, contextWindow = 1000000): { used: number; limit: number; percent: number } {
    const limit = Math.max(1, contextWindow);
    const used = estimateMessageTokens(messages);
    return { used, limit, percent: Math.min(100, Math.round((used / limit) * 100)) };
  }

  private sendContextUsage(messages: Array<{ content: string }>, contextWindow = 1000000): void {
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
      contextUsage: this.getContextUsage(messages, config.contextWindow),
    });
  }

  private sendToWebview(msg: any): void {
    this.panel.webview.postMessage(msg);
  }

  private dispose(): void {
    this.handleAbort();
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
  }
  .reasoning-panel summary {
    cursor: pointer;
    padding: 7px 10px;
    color: var(--text-muted);
    font-size: 11px;
    user-select: none;
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
      <span class="context-usage" id="contextUsage" title="当前会话上下文估算占用">上下文 0 / 1M · 0%</span>
      <span class="timer-display" id="timerDisplay">00:00:00</span>
    </div>

    <!-- 输入框 -->
    <div class="input-container">
      <textarea id="input" placeholder="输入消息，按 Enter 发送，Shift+Enter 换行" rows="1"></textarea>
      <button class="send-btn" id="btnSend" title="发送 (Enter)">➤</button>
    </div>

    <!-- 底部工具栏 -->
    <div class="bottom-toolbar">
      <button class="toolbar-btn" title="上传文件">📎<span class="tooltip">上传文件</span></button>
      <button class="toolbar-btn" title="历史记录">🕐<span class="tooltip">历史记录</span></button>
      <button class="toolbar-btn" title="搜索">🔍<span class="tooltip">搜索</span></button>
      <button class="toolbar-btn" id="btnTrash" title="清空">🗑️<span class="tooltip">清空对话</span></button>
      <div class="toolbar-spacer"></div>
      <button class="toolbar-btn" title="复制最后回复">📋<span class="tooltip">复制</span></button>
      <button class="toolbar-btn" title="重新生成">🔄<span class="tooltip">重新生成</span></button>
      <button class="toolbar-btn" id="btnModel" title="点击在左侧「模型设置」切换模型">🤖<span class="model-name" id="modelName">未配置模型</span><span class="tooltip">在左侧切换模型</span></button>
    </div>
  </div>

  <!-- 模型切换已收敛到左侧「模型设置」视图 -->

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
      panel.className = 'reasoning-panel';
      panel.open = true;
      panel.innerHTML = '<summary>思考过程</summary><div class="reasoning-content"></div>';
      wrapper.insertBefore(panel, bubble);
    }
    return panel.querySelector('.reasoning-content');
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

  // 键盘快捷键
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // 自适应高度
  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 130) + 'px';
  });

  // ====== 模型名标签：点击跳转左侧「模型设置」切换模型 ======
  const modelNameEl = document.getElementById('modelName');
  const btnModel = document.getElementById('btnModel');
  if (btnModel) {
    btnModel.addEventListener('click', () => {
      vscode.postMessage({ type: 'focusModelsView' });
    });
  }

  // ====== 接收扩展消息 ======
  window.addEventListener('message', (e) => {
    const msg = e.data;
    switch (msg.type) {
      case 'historyLoaded': {
        autoFollowOutput = true;
        window._currentRoleName = msg.role ? msg.role.name : 'AI';
        if (msg.modelName && modelNameEl) modelNameEl.textContent = msg.modelName;
        updateContextUsage(msg.contextUsage);

        // 渲染标签栏
        if (msg.sessions) renderTabBar(msg.sessions);

        // 更新角色信息
        messagesEl.innerHTML = '';

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
        scrollBottom(true);
        break;
      }
      case 'userMessage':
        autoFollowOutput = true;
        appendMessage('user', msg.content, new Date().toISOString());
        scrollBottom(true);
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
          const reasoning = ensureReasoningPanel(currentAssistantEl);
          const followReasoning = reasoning.scrollHeight - reasoning.scrollTop - reasoning.clientHeight <= 48;
          const raw = reasoning.getAttribute('data-raw') || '';
          const newText = raw + msg.delta;
          reasoning.setAttribute('data-raw', newText);
          reasoning.textContent = newText;
          if (followReasoning) reasoning.scrollTop = reasoning.scrollHeight;
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
        const labels = { running: '正在调用工具', completed: '工具调用完成', failed: '工具调用失败' };
        const toolKey = msg.callId || msg.name || '';
        currentToolStatusEl = toolStatusElements.get(toolKey) || null;
        if (!currentToolStatusEl) {
          currentToolStatusEl = appendMessage('system', '', new Date().toISOString());
          currentToolStatusEl.setAttribute('data-tool-key', toolKey);
          toolStatusElements.set(toolKey, currentToolStatusEl);
        }
        currentToolStatusEl.textContent = (labels[msg.status] || '工具状态') + ': ' + (msg.name || 'unknown') + (msg.status === 'failed' && msg.detail ? ' - ' + msg.detail : '');
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
              const reasoning = ensureReasoningPanel(currentAssistantEl);
              reasoning.removeAttribute('data-raw');
              reasoning.textContent = msg.reasoningText;
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
            const reasoning = ensureReasoningPanel(currentAssistantEl);
            reasoning.removeAttribute('data-raw');
            reasoning.textContent = msg.reasoningText;
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
    }
  });

  // 自动聚焦
  inputEl.focus();
</script>
</body>
</html>`;
  }
}
