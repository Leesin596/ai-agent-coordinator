// ============================================================
// TaskCenterPanel — 任务中心 Webview 面板（Premium UI v2）
// 统一展示收件箱/已派发任务，查看对齐文档，执行握手操作
// ============================================================
import * as vscode from 'vscode';
import type { CoordinatorContext, ActiveWorkspaceRuntime } from '../backend/coordinator-context';
import type { SessionTask, SessionTaskStatus, SessionTaskAlignment } from '../../../src/models/types';

let currentPanel: TaskCenterPanel | undefined;

export class TaskCenterPanel {
  private panel: vscode.WebviewPanel;
  private ctx: CoordinatorContext;
  private runtime: ActiveWorkspaceRuntime;
  private currentSessionId: string | null = null;
  private disposables: vscode.Disposable[] = [];

  private constructor(
    panel: vscode.WebviewPanel,
    ctx: CoordinatorContext,
    runtime: ActiveWorkspaceRuntime,
    currentSessionId?: string,
  ) {
    this.panel = panel;
    this.ctx = ctx;
    this.runtime = runtime;
    this.currentSessionId = currentSessionId || null;

    this.panel.title = '📨 任务中心';

    this.panel.webview.html = this.getHtml();

    this.panel.webview.onDidReceiveMessage(
      (msg) => this.handleMessage(msg),
      null,
      this.disposables,
    );

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.refresh();
  }

  static open(
    ctx: CoordinatorContext,
    runtime: ActiveWorkspaceRuntime,
    currentSessionId?: string,
    options?: { focusTab?: 'incoming' | 'outgoing' },
  ): TaskCenterPanel {
    if (currentPanel) {
      currentPanel.runtime = runtime;
      currentPanel.currentSessionId = currentSessionId || null;
      currentPanel.refresh();
      currentPanel.panel.reveal(vscode.ViewColumn.Active);
      if (options?.focusTab) {
        currentPanel.sendToWebview({ type: 'focusTab', tab: options.focusTab });
      }
      return currentPanel;
    }
    const panel = vscode.window.createWebviewPanel(
      'coordinator.taskCenter',
      '📨 任务中心',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    currentPanel = new TaskCenterPanel(panel, ctx, runtime, currentSessionId);
    if (options?.focusTab) {
      currentPanel.sendToWebview({ type: 'focusTab', tab: options.focusTab });
    }
    return currentPanel;
  }

  refresh(): void {
    const sessionId = this.currentSessionId;
    let incoming: any[] = [];
    let outgoing: any[] = [];

    if (sessionId) {
      incoming = this.runtime.dispatcher.listIncoming(sessionId);
      outgoing = this.runtime.dispatcher.listOutgoing(sessionId);
    } else {
      const all = this.runtime.dispatcher.listByWorkspace(this.runtime.workspace.id);
      incoming = all;
    }

    // 附加角色名和会话标题
    const enrich = (tasks: SessionTask[]) =>
      tasks.map((t, idx) => {
        const sourceRole = this.runtime.roleManager.get(t.sourceRoleId);
        const targetRole = this.runtime.roleManager.get(t.targetRoleId);
        const sourceSession = this.runtime.sessionManager.get(t.sourceSessionId);
        const targetSession = this.runtime.sessionManager.get(t.targetSessionId);
        return {
          ...t,
          index: idx + 1,
          sourceRoleName: sourceRole?.name || '?',
          sourceRoleIcon: sourceRole?.icon || '💬',
          targetRoleName: targetRole?.name || '?',
          targetRoleIcon: targetRole?.icon || '💬',
          sourceSessionTitle: sourceSession?.title || t.sourceSessionId.slice(0, 8),
          targetSessionTitle: targetSession?.title || t.targetSessionId.slice(0, 8),
        };
      });

    // 获取会话统计
    const allSessions = this.runtime.sessionManager.list(this.runtime.workspace.id);

    this.sendToWebview({
      type: 'tasksLoaded',
      incoming: enrich(incoming),
      outgoing: enrich(outgoing),
      currentSessionId: sessionId,
      sessionCount: allSessions.length,
      workspaceName: this.runtime.workspace.name || '工作区',
      sessions: allSessions.map((s) => ({ id: s.id, title: s.title })),
    });
  }

  // ============================================================
  // 消息处理
  // ============================================================

  private async handleMessage(msg: any): Promise<void> {
    try {
      switch (msg.type) {
        case 'refresh':
          this.refresh();
          break;
        case 'reviewContext':
          await this.handleReview(msg.taskId);
          break;
        case 'align':
          this.runtime.dispatcher.align(msg.taskId);
          vscode.window.showInformationMessage('✅ 已确认对齐');
          this.refresh();
          break;
        case 'requestClarify': {
          const note = await vscode.window.showInputBox({
            prompt: '请输入需要澄清的问题',
            validateInput: (v) => (v.trim() ? null : '不能为空'),
          });
          if (note) {
            this.runtime.dispatcher.requestClarify(msg.taskId, note);
            vscode.window.showInformationMessage('已请求澄清');
            this.refresh();
          }
          break;
        }
        case 'supplement': {
          const supplement = await vscode.window.showInputBox({
            prompt: '请输入补充说明（回应澄清）',
            validateInput: (v) => (v.trim() ? null : '不能为空'),
          });
          if (supplement) {
            this.runtime.dispatcher.supplementContext(msg.taskId, { progressSummary: supplement });
            vscode.window.showInformationMessage('已补充上下文');
            this.refresh();
          }
          break;
        }
        case 'accept':
          this.runtime.dispatcher.accept(msg.taskId);
          vscode.window.showInformationMessage('✅ 已接受任务，转入进行中');
          this.refresh();
          break;
        case 'reject': {
          const reason = await vscode.window.showInputBox({ prompt: '拒绝原因', validateInput: (v) => (v.trim() ? null : '不能为空') });
          if (reason) { this.runtime.dispatcher.reject(msg.taskId, reason); vscode.window.showInformationMessage('已拒绝任务'); this.refresh(); }
          break;
        }
        case 'complete': {
          const result = await vscode.window.showInputBox({ prompt: '完成结果描述', validateInput: (v) => (v.trim() ? null : '不能为空') });
          if (result) { this.runtime.dispatcher.complete(msg.taskId, result); vscode.window.showInformationMessage('✅ 任务已完成'); this.refresh(); }
          break;
        }
        case 'cancel': {
          const reason = await vscode.window.showInputBox({ prompt: '取消原因', validateInput: (v) => (v.trim() ? null : '不能为空') });
          if (reason) { this.runtime.dispatcher.cancel(msg.taskId, reason); vscode.window.showInformationMessage('已取消任务'); this.refresh(); }
          break;
        }
        case 'openDispatch':
          await vscode.commands.executeCommand('coordinator.dispatchTask', this.currentSessionId);
          break;
        case 'switchSession':
          await this.handleSwitchSession(msg.sessionId);
          break;
        case 'copyInstruction':
          this.handleCopyInstruction(msg.taskId);
          break;
      }
    } catch (err: any) {
      vscode.window.showErrorMessage(`操作失败: ${err.message}`);
    }
  }

  private async handleReview(taskId: string): Promise<void> {
    try {
      const view = this.runtime.dispatcher.reviewContext(taskId);
      this.sendToWebview({
        type: 'reviewResult',
        taskId,
        document: view.document,
        payload: view.payload,
        source: view.source,
        target: view.target,
      });
    } catch (err: any) {
      vscode.window.showErrorMessage(`查看对齐上下文失败: ${err.message}`);
    }
  }

  private async handleSwitchSession(sessionId?: string | null): Promise<void> {
    if (sessionId) {
      this.currentSessionId = sessionId;
    } else {
      // 未传 sessionId：弹出 QuickPick 选择
      const sessions = this.runtime.sessionManager.list(this.runtime.workspace.id);
      if (sessions.length === 0) { vscode.window.showInformationMessage('暂无会话'); return; }
      const pick = await vscode.window.showQuickPick(
        sessions.map((s) => ({
          label: s.title,
          description: new Date(s.updatedAt).toLocaleString(),
          session: s,
        })),
        { placeHolder: '选择当前会话（用于过滤收件箱/已派发）' },
      );
      if (pick) { this.currentSessionId = pick.session.id; }
    }
    this.refresh();
  }

  private handleCopyInstruction(taskId: string): void {
    const task = [...this.runtime.dispatcher.listByWorkspace(this.runtime.workspace.id)].find((t) => t.id === taskId);
    if (!task) return;

    let instruction = `## 任务：${task.title}\n\n`;
    instruction += `### 目标\n${task.contextPayload?.objective || task.brief || ''}\n\n`;
    if (task.contextPayload?.acceptanceCriteria?.length) {
      instruction += `### 验收标准\n${task.contextPayload.acceptanceCriteria.map((c: string, i: number) => `${i+1}. ${c}`).join('\n')}\n\n`;
    }
    if (task.contextPayload?.constraints?.length) {
      instruction += `### 约束\n${task.contextPayload.constraints.join('\n')}\n\n`;
    }

    vscode.env.clipboard.writeText(instruction);
    vscode.window.showInformationMessage('已复制指令到剪贴板');
  }

  private sendToWebview(msg: any): void {
    this.panel.webview.postMessage(msg);
  }

  private dispose(): void {
    currentPanel = undefined;
    this.panel.dispose();
    while (this.disposables.length) { const d = this.disposables.pop(); if (d) d.dispose(); }
  }

  // ============================================================
  // Premium UI v2 — HTML
  // 参考卡片化任务列表：图标工具栏、状态横幅、Tab导航、卡片详情行、操作栏
  // ============================================================

  private getHtml(): string {
    return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<style>
  /* ========== Design Tokens ========== */
  :root {
    --bg-primary: #1e1e1e;
    --bg-secondary: #222225;
    --bg-elevated: #28282c;
    --bg-card: #252528;
    --bg-card-hover: #2d2d30;
    --bg-input: #1a1a1c;
    --bg-badge: rgba(255,255,255,0.06);
    --border: #333337;
    --border-light: #3f3f44;
    --border-subtle: #29292c;
    --text-primary: #dfdfd9;
    --text-secondary: #9a9a95;
    --text-muted: #60605c;
    --accent: #0e9ece;
    --accent-dim: rgba(14,206,206,0.12);
    --accent-glow: rgba(14,206,206,0.18);
    --success: #34c759;
    --success-dim: rgba(52,199,89,0.12);
    --warning: #e5a020;
    --warning-dim: rgba(229,160,32,0.12);
    --danger: #ef4544;
    --danger-dim: rgba(239,69,68,0.12);
    --info: #5ea4f4;
    --info-dim: rgba(94,164,244,0.12);
    --radius-sm: 6px;
    --radius-md: 10px;
    --radius-lg: 14px;
    --shadow-sm: 0 1px 4px rgba(0,0,0,0.25);
    --shadow-md: 0 4px 16px rgba(0,0,0,0.35);
    --transition: 0.2s cubic-bezier(0.4,0,0.2,1);
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans SC', sans-serif;
    font-size: 13px;
    color: var(--text-primary);
    background: var(--bg-primary);
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
  }

  /* ========== 头部工具栏 ========== */
  .header-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 10px 16px;
    background: var(--bg-secondary);
    border-bottom: 1px solid var(--border-subtle);
    flex-shrink: 0;
  }
  .header-title {
    font-size: 15px;
    font-weight: 600;
    flex: 1;
    letter-spacing: 0.2px;
  }
  .header-icon-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 31px;
    height: 31px;
    border-radius: var(--radius-sm);
    border: none;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    font-size: 14px;
    transition: all var(--transition);
  }
  .header-icon-btn:hover {
    background: var(--bg-hover, var(--bg-elevated));
    color: var(--text-primary);
  }

  /* ========== 状态横幅 ========== */
  .status-banner {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 16px;
    background: linear-gradient(135deg, rgba(14,206,206,0.04), rgba(94,164,244,0.04));
    border-bottom: 1px solid var(--border-subtle);
    flex-shrink: 0;
    font-size: 12px;
  }
  .banner-title {
    font-weight: 600;
    color: var(--text-primary);
  }
  .banner-stats {
    color: var(--text-secondary);
  }
  .banner-status {
    color: var(--success);
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .banner-space {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 4px;
    color: var(--text-muted);
  }
  .dot-online {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--success);
    box-shadow: 0 0 6px var(--success);
  }

  /* ========== Tab 导航 ========== */
  .nav-tabs {
    display: flex;
    gap: 0;
    padding: 0 16px;
    background: var(--bg-secondary);
    border-bottom: 1px solid var(--border-subtle);
    flex-shrink: 0;
  }
  .nav-tab {
    padding: 11px 20px;
    cursor: pointer;
    border-bottom: 2px solid transparent;
    font-size: 13px;
    color: var(--text-muted);
    transition: all var(--transition);
    position: relative;
  }
  .nav-tab:hover { color: var(--text-secondary); }
  .nav-tab.active {
    color: var(--text-primary);
    border-bottom-color: var(--accent);
    font-weight: 500;
  }
  .nav-tab .tab-count {
    margin-left: 5px;
    font-size: 11px;
    color: var(--text-muted);
  }
  .nav-tab.active .tab-count { color: var(--accent); }

  /* ========== 任务列表 ========== */
  .task-list {
    flex: 1;
    overflow-y: auto;
    padding: 10px 14px;
    scroll-behavior: smooth;
  }
  .task-list::-webkit-scrollbar { width: 5px; }
  .task-list::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }

  /* ====== 任务卡片 ====== */
  .task-card {
    background: var(--bg-card);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    margin-bottom: 8px;
    overflow: hidden;
    transition: all var(--transition);
    cursor: default;
  }
  .task-card:hover {
    border-color: var(--border-light);
    background: var(--bg-card-hover);
  }
  .task-card.expanded {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-glow), var(--shadow-sm);
  }

  /* 卡片头部 */
  .card-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 14px;
    border-bottom: 1px solid transparent;
  }
  .task-card.expanded .card-header {
    border-bottom-color: var(--border-subtle);
  }
  .card-index {
    font-family: 'Cascadia Code', monospace;
    font-size: 12px;
    font-weight: 700;
    color: var(--text-muted);
    min-width: 24px;
  }
  .card-name {
    font-weight: 500;
    font-size: 13px;
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .card-name-text {
    color: var(--text-primary);
  }
  .card-name-sub {
    font-weight: 400;
    font-size: 11px;
    color: var(--text-muted);
    margin-left: 6px;
  }

  /* 徽章系统 */
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 2px 8px;
    border-radius: 10px;
    font-size: 11px;
    font-weight: 500;
    line-height: 1.5;
    white-space: nowrap;
  }
  /* 状态徽章 */
  .badge-idle { background: var(--info-dim); color: var(--info); }
  .badge-active { background: var(--success-dim); color: var(--success); }
  .badge-proposed { background: var(--warning-dim); color: var(--warning); }
  .badge-in_progress { background: var(--info-dim); color: var(--info); }
  .badge-completed { background: var(--success-dim); color: var(--success); }
  .badge-cancelled, .badge-rejected { background: var(--danger-dim); color: var(--danger); }
  /* 对齐徽章 */
  .badge-align-pending { background: var(--warning-dim); color: var(--warning); }
  .badge-align-aligned { background: var(--success-dim); color: var(--success); }
  .badge-align-clarify { background: rgba(191,144,0,0.15); color: #bf9000; }
  /* 时间徽章 */
  .badge-time {
    background: transparent;
    color: var(--text-muted);
    font-size: 11px;
    font-weight: 400;
  }

  /* 卡片详情区 */
  .card-body {
    padding: 10px 14px;
    display: none;
    background: rgba(0,0,0,0.08);
  }
  .task-card.expanded .card-body { display: block; }

  .detail-row {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 4px 0;
    font-size: 12px;
  }
  .detail-label {
    color: var(--text-muted);
    min-width: 40px;
    flex-shrink: 0;
  }
  .detail-value {
    color: var(--text-secondary);
  }
  .detail-value-empty {
    color: var(--text-muted);
    font-style: italic;
  }

  /* 对齐文档区域 */
  .doc-section {
    margin-top: 10px;
  }
  .doc-label {
    font-size: 11px;
    color: var(--text-muted);
    margin-bottom: 5px;
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .doc-content {
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 12px;
    max-height: 300px;
    overflow-y: auto;
    font-size: 12px;
    line-height: 1.65;
    color: var(--text-secondary);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .doc-content::-webkit-scrollbar { width: 4px; }
  .doc-content::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }
  .doc-content h1 { font-size: 14px; margin: 8px 0 4px; color: var(--text-primary); }
  .doc-content h2 { font-size: 13px; margin: 8px 0 4px; color: var(--accent); }
  .doc-content h3 { font-size: 12px; margin: 6px 0 3px; }
  .doc-content pre { background: rgba(0,0,0,0.35); padding: 8px; border-radius: 4px; overflow-x: auto; margin: 6px 0; }
  .doc-content code { font-family: monospace; font-size: 11.5px; }
  .doc-content strong { color: var(--text-primary); }

  /* 操作栏 */
  .card-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 10px 14px;
    border-top: 1px solid var(--border-subtle);
    flex-wrap: wrap;
  }
  .action-input {
    flex: 1;
    min-width: 120px;
    max-width: 200px;
    padding: 5px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-input);
    color: var(--text-primary);
    font-size: 11.5px;
    outline: none;
    transition: border-color var(--transition);
  }
  .action-input:focus { border-color: var(--accent); }
  .action-input::placeholder { color: var(--text-muted); }

  .action-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 5px 12px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text-secondary);
    font-size: 11.5px;
    cursor: pointer;
    transition: all var(--transition);
    white-space: nowrap;
  }
  .action-btn:hover { background: var(--bg-elevated); color: var(--text-primary); }
  .action-btn.primary {
    background: var(--accent-dim);
    border-color: rgba(14,206,206,0.3);
    color: var(--accent);
  }
  .action-btn.primary:hover { background: var(--accent-glow); }
  .action-btn.danger {
    color: var(--danger);
    border-color: rgba(239,69,68,0.25);
  }
  .action-btn.danger:hover { background: var(--danger-dim); }
  .action-btn-icon {
    width: 29px;
    height: 29px;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-sm);
    font-size: 13px;
  }
  .action-btn-icon.danger:hover { background: var(--danger-dim); color: var(--danger); }

  /* ========== 底部操作栏 ========== */
  .bottom-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 16px;
    background: var(--bg-secondary);
    border-top: 1px solid var(--border-subtle);
    flex-shrink: 0;
  }
  .btn-add {
    padding: 7px 18px;
    border-radius: var(--radius-md);
    border: 1px solid var(--accent);
    background: var(--accent-dim);
    color: var(--accent);
    font-size: 12.5px;
    font-weight: 500;
    cursor: pointer;
    transition: all var(--transition);
    display: flex;
    align-items: center;
    gap: 5px;
  }
  .btn-add:hover {
    background: var(--accent);
    color: #fff;
  }
  .btn-batch {
    padding: 7px 14px;
    border-radius: var(--radius-md);
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text-secondary);
    font-size: 12.5px;
    cursor: pointer;
    transition: all var(--transition);
  }
  .btn-batch:hover { background: var(--bg-elevated); color: var(--text-primary); }
  .btn-danger-fill {
    padding: 7px 18px;
    border-radius: var(--radius-md);
    border: none;
    background: var(--warning);
    color: #000;
    font-size: 12.5px;
    font-weight: 600;
    cursor: pointer;
    transition: all var(--transition);
    margin-left: auto;
  }
  .btn-danger-fill:hover { filter: brightness(1.1); }
  .btn-secondary {
    padding: 7px 16px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text-secondary);
    font-size: 12px;
    cursor: pointer;
    transition: all var(--transition);
  }
  .btn-secondary:hover { background: var(--bg-hover); color: var(--text-primary); }

  /* ========== 底部工具栏 ========== */
  .config-sections {
    padding: 8px 14px 14px;
    background: var(--bg-secondary);
    border-top: 1px solid var(--border-subtle);
    flex-shrink: 0;
  }
  .config-section {
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    margin-top: 6px;
    overflow: hidden;
  }
  .config-section:first-child { margin-top: 0; }
  .config-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    cursor: pointer;
    font-size: 12px;
    color: var(--text-secondary);
    transition: background var(--transition);
  }
  .config-header:hover { background: var(--bg-elevated); }
  .config-body {
    padding: 10px 12px;
    border-top: 1px solid var(--border-subtle);
    display: none;
  }
  .config-section.open .config-body { display: block; }
  .config-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
  }
  .config-row:last-child { margin-bottom: 0; }
  .config-label { font-size: 11.5px; color: var(--text-muted); min-width: 80px; }
  .config-input {
    flex: 1;
    padding: 5px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-input);
    color: var(--text-primary);
    font-size: 12px;
    outline: none;
  }
  .config-input:focus { border-color: var(--accent); }
  .config-btn {
    padding: 5px 12px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text-secondary);
    font-size: 11.5px;
    cursor: pointer;
  }
  .config-btn:hover { background: var(--bg-elevated); color: var(--text-primary); }

  /* ========== 空状态 ========== */
  .empty-state {
    text-align: center;
    padding: 60px 20px;
    color: var(--text-muted);
  }
  .empty-icon { font-size: 42px; opacity: 0.4; margin-bottom: 12px; }
  .empty-text { font-size: 14px; color: var(--text-muted); }
</style>
</head>
<body>

  <!-- 头部工具栏 -->
  <div class="header-bar">
    <span class="header-title">📋 任务中心</span>
    <div style="flex:1"></div>
    <select id="sessionSelect" title="筛选会话" style="
      padding: 4px 8px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      background: var(--bg-elevated);
      color: var(--text-primary);
      font-size: 12px;
      outline: none;
      cursor: pointer;
    ">
      <option value="">全部会话</option>
    </select>
    <button class="header-icon-btn" id="btnSearch" title="搜索/刷新">🔍</button>
    <button class="header-icon-btn" id="btnRefresh" title="刷新">↻</button>
    <button class="header-icon-btn" id="btnDispatch" title="派发新任务">📤</button>
  </div>

  <!-- 状态横幅 -->
  <div class="status-banner">
    <span class="banner-title">会话任务状态</span>
    <span class="banner-stats" id="bannerStats">共 0 条任务</span>
    <span class="banner-status">● 活跃</span>
    <span class="banner-space"><span class="dot-online"></span><span id="wsName">工作区</span></span>
  </div>

  <!-- Tab 导航（只有收件箱/已派发有意义）-->
  <div class="nav-tabs">
    <div class="nav-tab active" data-tab="incoming">📥 收件箱<span class="tab-count" id="cntIn">0</span></div>
    <div class="nav-tab" data-tab="outgoing">📤 已派发<span class="tab-count" id="cntOut">0</span></div>
  </div>

  <!-- 任务列表 -->
  <div class="task-list" id="taskList">
    <div class="empty-state"><div class="empty-icon">📋</div><div class="empty-text">正在加载任务...</div></div>
  </div>

  <!-- 底部操作栏 -->
  <div class="bottom-bar">
    <button class="btn-add" id="btnAddSession">＋ 派发新任务</button>
    <button class="btn-secondary" id="btnSwitchSession">🔄 切换当前会话</button>
  </div>

<script>
  const vscode = acquireVsCodeApi();
  const listEl = document.getElementById('taskList');
  const cntInEl = document.getElementById('cntIn');
  const cntOutEl = document.getElementById('cntOut');
  const bannerStatsEl = document.getElementById('bannerStats');
  const sessionSelectEl = document.getElementById('sessionSelect');
  const wsNameEl = document.getElementById('wsName');

  let currentTab = 'incoming';
  let allIncoming = [];
  let allOutgoing = [];
  let expandedTaskId = null;
  let reviewDocs = {};

  // ====== 工具函数 ======
  function escapeHtml(t) { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }
  function timeLabel(iso) {
    if (!iso) return '';
    const d = new Date(iso), now = new Date(), diff = (now-d)/1000;
    if (diff<60) return '刚刚'; if (diff<3600) return Math.floor(diff/60)+'min前'; if (diff<86400) return Math.floor(diff/3600)+'h前'; return d.toLocaleDateString();
  }
  function statusBadgeClass(s) {
    const m = { proposed:'proposed', accepted:'in_progress', in_progress:'in_progress', completed:'completed', cancelled:'cancelled', failed:'cancelled' };
    return 'badge-' + (m[s]||'idle');
  }
  function statusLabel(s) {
    const m = { proposed:'空闲', accepted:'进行中', in_progress:'进行中', completed:'完成', cancelled:'已取消', failed:'失败' };
    return m[s] || s;
  }
  function alignLabel(a) {
    const m = { pending:'待对齐', aligned:'已对齐', clarify:'需澄清', rejected:'已拒绝' };
    return m[a] || a;
  }
  function alignClass(a) {
    return 'badge-align-' + (a||'pending');
  }

  // Markdown 渲染（精简版）—— 用 String.fromCharCode(96) 避免模板字符串内反引号转义地狱
  const BT = String.fromCharCode(96); // 反引号
  function renderMd(text) {
    if (!text) return '';
    let h = escapeHtml(text);
    const fence = BT+BT+BT;
    h = h.replace(new RegExp(fence+'[\\\\s\\\\S]*?'+fence,'g'), (m)=>'<pre>'+m.replace(new RegExp(fence+'\\\\w*\\\\n?'),'')+'</pre>');
    h = h.replace(new RegExp(BT+'([^'+BT+'\\\\n]+)'+BT,'g'), '<code>$1</code>');
    h = h.replace(/^### /gm, '<h3>').replace(/^## /gm, '<h2>').replace(/^# /gm, '<h1>');
    h = h.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
    h = h.replace(/^- /gm, '<li>').replace(/^\\d+\\. /gm, '<li>');
    h = h.replace(/\\n/g, '<br>');
    return h;
  }

  // ====== 渲染任务卡片（事件委托，无内联 onclick） ======
  function renderCard(t, isIncoming) {
    const exp = expandedTaskId === t.id;
    const name = isIncoming ? t.sourceRoleName : t.targetRoleName;
    const sub = isIncoming ? t.sourceSessionTitle : t.targetSessionTitle;
    const doc = reviewDocs[t.id];

    // 构建操作按钮（用 data-act 属性，事件委托统一处理）
    let actionsHtml = '';
    if (isIncoming) {
      if (t.status === 'proposed') {
        if (t.alignmentStatus === 'pending' && !doc)
          actionsHtml += actBtn('reviewContext', t.id, 'primary', '👀 查看');
        if (t.alignmentStatus === 'pending')
          actionsHtml += actBtn('align', t.id, 'primary', '✅ 对齐');
        if (t.alignmentStatus === 'pending')
          actionsHtml += actBtn('requestClarify', t.id, '', '❓ 澄清');
        if (t.alignmentStatus === 'pending')
          actionsHtml += actBtn('reject', t.id, 'danger', '拒绝');
      }
      if ((t.status === 'accepted' || t.status === 'in_progress'))
        actionsHtml += actBtn('accept', t.id, 'primary', '接受');
      if (t.status === 'in_progress')
        actionsHtml += actBtn('complete', t.id, 'primary', '完成');
    } else {
      if (t.alignmentStatus === 'clarify')
        actionsHtml += actBtn('supplement', t.id, 'primary', '📝 补充');
      if (t.status !== 'completed' && t.status !== 'cancelled')
        actionsHtml += actBtn('cancel', t.id, 'danger', '取消');
      if (t.status === 'proposed' && !doc)
        actionsHtml += actBtn('reviewContext', t.id, '', '👀 查看');
    }

    // 展开的详情
    let bodyHtml = '';
    if (exp) {
      bodyHtml = '<div class="card-body">';
      bodyHtml += '<div class="detail-row"><span class="detail-label">心跳</span><span class="detail-value detail-value-empty">—</span></div>';
      bodyHtml += '<div class="detail-row"><span class="detail-label">Inbox</span><span class="detail-value detail-value-empty">—</span></div>';
      if (t.brief) bodyHtml += '<div class="detail-row"><span class="detail-label">简述</span><span class="detail-value">'+escapeHtml(t.brief)+'</span></div>';

      if (doc) {
        bodyHtml += '<div class="doc-section"><div class="doc-label">📋 对齐文档</div><div class="doc-content">'+renderMd(doc)+'</div></div>';
      } else {
        bodyHtml += '<div class="doc-section"><div class="doc-label">💡 点击「查看」生成对齐文档</div></div>';
      }
      if (t.result) bodyHtml += '<div class="doc-section"><div class="doc-label">✅ 结果</div><div class="doc-content" style="background:var(--success-dim);color:var(--success);border-color:rgba(52,199,89,0.2)">'+escapeHtml(t.result)+'</div></div>';

      bodyHtml += '<div class="card-actions">';
      bodyHtml += '<input class="action-input" placeholder="复制指令" data-copy-input="'+escapeHtml(t.id)+'">';
      if (isIncoming && t.status === 'in_progress')
        bodyHtml += actBtn('accept', t.id, 'action-btn-icon primary', '▶');
      bodyHtml += actBtn('openDispatch', t.id, '', '角色');
      bodyHtml += actionsHtml;
      bodyHtml += '</div>';
      bodyHtml += '</div>';
    } else {
      // 未展开也显示操作栏（简化版）
      bodyHtml = '<div class="card-actions">';
      bodyHtml += '<input class="action-input" placeholder="复制指令" readonly>';
      bodyHtml += '<button class="action-btn action-btn-icon primary" title="操作" data-act="expand" data-id="'+escapeHtml(t.id)+'">▶</button>';
      bodyHtml += '<button class="action-btn" title="角色" data-act="expand" data-id="'+escapeHtml(t.id)+'">角色</button>';
      bodyHtml += '<button class="action-btn action-btn-icon danger" title="关闭" data-act="expand" data-id="'+escapeHtml(t.id)+'">✕</button>';
      bodyHtml += '</div>';
    }

    return '<div class="task-card'+(exp?' expanded':'')+'" data-act="expand" data-id="'+escapeHtml(t.id)+'">'+
      '<div class="card-header">'+
        '<span class="card-index">['+t.index+']</span>'+
        '<span class="card-name"><span class="card-name-text">'+escapeHtml(name)+'</span><span class="card-name-sub">'+escapeHtml(sub)+'</span></span>'+
        '<span class="badge '+statusBadgeClass(t.status)+'">'+statusLabel(t.status)+'</span>'+
        '<span class="badge badge-time">'+timeLabel(t.createdAt)+'</span>'+
      '</div>'+bodyHtml+
    '</div>';
  }

  // 生成操作按钮（用 data 属性，避免 onclick 字符串拼接转义地狱）
  function actBtn(act, taskId, cls, label) {
    return '<button class="action-btn '+cls+'" data-act="'+act+'" data-id="'+escapeHtml(taskId)+'">'+label+'</button>';
  }

  function renderList() {
    const tasks = currentTab==='incoming'?allIncoming:allOutgoing;
    if (tasks.length===0) {
      const icon = currentTab==='incoming'?'📥':'📤';
      const text = currentTab==='incoming'?'收件箱空空如也':'还没有派发过任务';
      listEl.innerHTML = '<div class="empty-state"><div class="empty-icon">'+icon+'</div><div class="empty-text">'+text+'</div></div>';
      return;
    }
    listEl.innerHTML = tasks.map(t=>renderCard(t,currentTab==='incoming')).join('');
  }

  // ====== 事件委托（统一处理所有按钮点击，无需内联 onclick） ======

  // 任务卡片点击：展开/折叠
  listEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    const tid = btn.dataset.id;
    if (act === 'expand') {
      expandedTaskId = expandedTaskId === tid ? null : tid;
      renderList();
    } else {
      vscode.postMessage({ type: act, taskId: tid });
    }
  });

  // 复制指令输入框：Enter 触发
  listEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.classList.contains('action-input') && e.target.dataset.copyInput) {
      vscode.postMessage({ type: 'copyInstruction', taskId: e.target.dataset.copyInput });
    }
  });

  // Tab 切换
  document.querySelectorAll('.nav-tab').forEach(el => {
    el.addEventListener('click', () => {
      document.querySelectorAll('.nav-tab').forEach(t=>{t.classList.remove('active');});
      el.classList.add('active');
      currentTab = el.dataset.tab;
      expandedTaskId=null;renderList();
    });
  });

  // 会话筛选下拉框
  sessionSelectEl.addEventListener('change', () => {
    vscode.postMessage({ type: 'switchSession', sessionId: sessionSelectEl.value || null });
  });

  // 工具栏按钮
  document.getElementById('btnRefresh').addEventListener('click', () => vscode.postMessage({type:'refresh'}));
  document.getElementById('btnSearch').addEventListener('click', () => vscode.postMessage({type:'refresh'}));
  document.getElementById('btnDispatch').addEventListener('click', () => vscode.postMessage({type:'openDispatch'}));

  // 底部操作栏
  document.getElementById('btnAddSession').addEventListener('click', () => vscode.postMessage({type:'openDispatch'}));
  document.getElementById('btnSwitchSession').addEventListener('click', () => vscode.postMessage({type:'switchSession'}));

  // 接收扩展消息
  window.addEventListener('message', (e) => {
    const msg=e.data;
    switch(msg.type) {
      case 'tasksLoaded':
        allIncoming=msg.incoming||[];
        allOutgoing=msg.outgoing||[];
        cntInEl.textContent=allIncoming.length;
        cntOutEl.textContent=allOutgoing.length;
        bannerStatsEl.textContent='共 '+(allIncoming.length+allOutgoing.length)+' 条任务';
        if (msg.workspaceName) wsNameEl.textContent = msg.workspaceName;
        // 填充会话筛选下拉框
        if (msg.sessions && msg.sessions.length > 0) {
          const cur = msg.currentSessionId || '';
          sessionSelectEl.innerHTML = '<option value="">全部会话</option>' +
            msg.sessions.map((s) =>
              '<option value="'+s.id+'"'+(s.id===cur?' selected':'')+'>'+escapeHtml(s.title)+'</option>'
            ).join('');
        }
        renderList();
        break;
      case 'reviewResult':
        reviewDocs[msg.taskId]=msg.document;
        if(expandedTaskId!==msg.taskId) expandedTaskId=msg.taskId;
        renderList();
        break;
      case 'focusTab':
        if (msg.tab === 'incoming' || msg.tab === 'outgoing') {
          currentTab = msg.tab;
          document.querySelectorAll('.nav-tab').forEach(t => {
            t.classList.toggle('active', t.dataset.tab === currentTab);
          });
          expandedTaskId = null;
          renderList();
        }
        break;
    }
  });
</script>
</body>
</html>`;
  }
}
