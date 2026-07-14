// ============================================================
// DispatchPanel — 派发任务表单 Webview（Premium UI v2）
// 从当前会话向其他会话派发任务，打包对齐上下文
// ============================================================
import * as vscode from 'vscode';
import type { CoordinatorContext, ActiveWorkspaceRuntime } from '../backend/coordinator-context';
import type { Role, Session } from '../../../src/models/types';

let currentDispatchPanel: DispatchPanel | undefined;

export class DispatchPanel {
  private panel: vscode.WebviewPanel;
  private ctx: CoordinatorContext;
  private runtime: ActiveWorkspaceRuntime;
  private sourceSessionId: string;
  private disposables: vscode.Disposable[] = [];

  private constructor(
    panel: vscode.WebviewPanel,
    ctx: CoordinatorContext,
    runtime: ActiveWorkspaceRuntime,
    sourceSessionId: string,
  ) {
    this.panel = panel;
    this.ctx = ctx;
    this.runtime = runtime;
    this.sourceSessionId = sourceSessionId;

    this.panel.title = '📤 派发任务';

    this.panel.webview.html = this.getHtml();

    this.panel.webview.onDidReceiveMessage(
      (msg) => this.handleMessage(msg),
      null,
      this.disposables,
    );

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.loadOptions();
  }

  static open(
    ctx: CoordinatorContext,
    runtime: ActiveWorkspaceRuntime,
    sourceSessionId: string,
  ): DispatchPanel {
    if (currentDispatchPanel) {
      currentDispatchPanel.runtime = runtime;
      currentDispatchPanel.sourceSessionId = sourceSessionId;
      currentDispatchPanel.loadOptions();
      currentDispatchPanel.panel.reveal(vscode.ViewColumn.Active);
      return currentDispatchPanel;
    }
    const panel = vscode.window.createWebviewPanel(
      'coordinator.dispatch',
      '📤 派发任务',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    currentDispatchPanel = new DispatchPanel(panel, ctx, runtime, sourceSessionId);
    return currentDispatchPanel;
  }

  private loadOptions(): void {
    const allSessions = this.runtime.sessionManager.list(this.runtime.workspace.id);
    const targets = allSessions
      .filter((s) => s.id !== this.sourceSessionId)
      .map((s) => {
        const role = this.runtime.roleManager.get(s.roleId);
        return { id: s.id, title: s.title, roleName: role?.name || '?', roleIcon: role?.icon || '💬', updatedAt: s.updatedAt };
      });

    const tasks = this.runtime.taskManager.list({ project: 'default' }).map((t: any) => ({ id: t.id, title: t.title, status: t.status }));
    const contracts = this.runtime.contractRegistry.list({ project: 'default' }).map((c: any) => ({ id: c.id, name: c.name, version: c.version }));
    const memories = this.runtime.memoryStore.list({ project: 'default' }).map((m: any) => ({ id: m.id, title: m.title, category: m.category }));

    const sourceSession = this.runtime.sessionManager.get(this.sourceSessionId);
    const sourceRole = sourceSession ? this.runtime.roleManager.get(sourceSession.roleId) : undefined;

    this.sendToWebview({
      type: 'optionsLoaded',
      source: { sessionTitle: sourceSession?.title || this.sourceSessionId.slice(0,8), roleName: sourceRole?.name || '?', roleIcon: sourceRole?.icon || '💬' },
      targets, tasks, contracts, memories,
    });
  }

  private async handleMessage(msg: any): Promise<void> {
    try {
      switch (msg.type) {
        case 'refreshOptions': this.loadOptions(); break;
        case 'submit': await this.handleSubmit(msg.payload); break;
        case 'cancel': this.panel.dispose(); break;
      }
    } catch (err: any) {
      vscode.window.showErrorMessage(`派发失败: ${err.message}`);
    }
  }

  private async handleSubmit(payload: any): Promise<void> {
    if (!payload.targetSessionId) { vscode.window.showWarningMessage('请选择目标会话'); return; }
    if (!payload.title?.trim()) { vscode.window.showWarningMessage('请填写任务标题'); return; }
    if (!payload.objective?.trim()) { vscode.window.showWarningMessage('请填写任务目标'); return; }

    const sourceSession = this.runtime.sessionManager.get(this.sourceSessionId);
    if (!sourceSession) { vscode.window.showErrorMessage('源会话不存在'); return; }
    const sourceRole = this.runtime.roleManager.get(sourceSession.roleId);
    if (!sourceRole) { vscode.window.showErrorMessage('源角色不存在'); return; }

    const task = this.runtime.dispatcher.dispatch({
      sourceSessionId: this.sourceSessionId,
      targetSessionId: payload.targetSessionId,
      title: payload.title.trim(),
      brief: payload.brief || '',
      contextPayload: {
        sourceRole: { id: sourceRole.id, name: sourceRole.name, category: sourceRole.category },
        objective: payload.objective.trim(),
        acceptanceCriteria: payload.acceptanceCriteria || [],
        progressSummary: payload.progressSummary || '',
        relatedTasks: payload.relatedTasks || [],
        relatedContracts: payload.relatedContracts || [],
        relatedMemories: payload.relatedMemories || [],
        conversationDigest: payload.conversationDigest || '',
        expectedOutput: payload.expectedOutput || '',
        constraints: payload.constraints || [],
      },
      priority: payload.priority || 'medium',
    });

    vscode.window.showInformationMessage(`✅ 任务「${task.title}」已派发`);
    this.panel.dispose();
    // 派发后打开任务中心，自动聚焦「已派发」tab 让用户立刻看到刚派出的任务
    import('./task-center-panel').then((m) => m.TaskCenterPanel.open(this.ctx, this.runtime, this.sourceSessionId, { focusTab: 'outgoing' }));
  }

  private sendToWebview(msg: any): void { this.panel.webview.postMessage(msg); }

  private dispose(): void {
    currentDispatchPanel = undefined;
    this.panel.dispose();
    while (this.disposables.length) { const d = this.disposables.pop(); if (d) d.dispose(); }
  }

  // ============================================================
  // Premium UI v2 — HTML（统一设计语言）
  // ============================================================

  private getHtml(): string {
    return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<style>
  /* ========== Design Tokens (与 chat-panel / task-center 统一) ========== */
  :root {
    --bg-primary: #1e1e1e;
    --bg-secondary: #222225;
    --bg-elevated: #28282c;
    --bg-card: #252528;
    --bg-input: #1a1a1c;
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
    --radius-sm: 6px;
    --radius-md: 10px;
    --radius-lg: 14px;
    --shadow-sm: 0 1px 4px rgba(0,0,0,0.25);
    --transition: 0.2s cubic-bezier(0.4,0,0.2,1);
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans SC', sans-serif;
    font-size: 13px;
    color: var(--text-primary);
    background: var(--bg-primary);
    padding: 16px 20px;
    overflow-y: auto;
    height: 100vh;
  }

  /* 页面标题 */
  .page-header {
    margin-bottom: 18px;
  }
  .page-title {
    font-size: 17px;
    font-weight: 600;
    color: var(--text-primary);
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .page-subtitle {
    font-size: 12px;
    color: var(--text-muted);
    margin-top: 4px;
  }

  /* 来源横幅 */
  .source-banner {
    background: linear-gradient(135deg, var(--accent-dim), rgba(94,164,244,0.06));
    border: 1px solid rgba(14,206,206,0.15);
    border-radius: var(--radius-sm);
    padding: 10px 14px;
    margin-bottom: 16px;
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12.5px;
  }
  .source-banner-icon { font-size: 16px; }
  .source-banner-text { color: var(--text-secondary); }
  .source-banner-role { color: var(--accent); font-weight: 500; }

  /* 表单卡片 */
  .form-card {
    background: var(--bg-card);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    overflow: hidden;
    margin-bottom: 10px;
  }
  .form-section {
    padding: 12px 16px;
    border-bottom: 1px solid var(--border-subtle);
  }
  .form-section:last-child { border-bottom: none; }

  .field-label {
    display: block;
    font-size: 11.5px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-muted);
    margin-bottom: 6px;
  }
  .field-label .required { color: var(--danger); margin-left: 2px; }
  .field-label .hint { color: var(--text-muted); font-weight: 400; text-transform: none; letter-spacing: 0; margin-left: 4px; }

  input[type="text"], textarea, select {
    width: 100%;
    padding: 8px 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-input);
    color: var(--text-primary);
    font-family: inherit;
    font-size: 13px;
    outline: none;
    transition: border-color var(--transition), box-shadow var(--transition);
  }
  input[type="text"]:focus, textarea:focus, select:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-glow);
  }
  input[type="text"]::placeholder, textarea::placeholder { color: var(--text-muted); }
  select { cursor: pointer; appearance: none; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='%236a6a6a'%3E%3Cpath d='M6 8L1 3h10z'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 10px center; padding-right: 28px; }
  textarea {
    resize: vertical;
    min-height: 56px;
    line-height: 1.55;
  }

  /* 多选组 */
  .checkbox-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    max-height: 120px;
    overflow-y: auto;
    padding: 6px;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }
  .checkbox-grid::-webkit-scrollbar { width: 4px; }
  .checkbox-grid::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }
  .checkbox-grid:empty::after { content: '（暂无可选项）'; color: var(--text-muted); font-size: 11.5px; }
  .check-item {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 9px;
    background: var(--bg-badge);
    border-radius: 12px;
    font-size: 11.5px;
    cursor: pointer;
    transition: all var(--transition);
    user-select: none;
  }
  .check-item:hover { background: var(--bg-elevated); }
  .check-item.checked { background: var(--accent-dim); color: var(--accent); border: 1px solid rgba(14,206,206,0.25); }
  .check-item input { display: none; }

  /* 优先级 */
  .priority-row { display: flex; gap: 6px; }
  .priority-opt {
    flex: 1;
    padding: 7px 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    text-align: center;
    cursor: pointer;
    font-size: 12px;
    color: var(--text-secondary);
    background: transparent;
    transition: all var(--transition);
  }
  .priority-opt:hover { border-color: var(--border-light); background: var(--bg-elevated); }
  .priority-opt.active { border-color: var(--accent); color: var(--accent); background: var(--accent-dim); font-weight: 600; }
  .priority-opt input { display: none; }

  /* 操作栏 */
  .form-actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    padding-top: 18px;
    border-top: 1px solid var(--border-subtle);
    margin-top: 6px;
  }
  .btn {
    padding: 8px 22px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text-secondary);
    transition: all var(--transition);
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .btn:hover { background: var(--bg-elevated); color: var(--text-primary); }
  .btn-primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  .btn-primary:hover { filter: brightness(1.1); box-shadow: 0 2px 10px var(--accent-glow); }

  .loading-overlay {
    text-align: center;
    padding: 40px;
    color: var(--text-muted);
  }
</style>
</head>
<body>

  <div class="page-header">
    <div class="page-title">📤 派发任务</div>
    <div class="page-subtitle">向其他会话派发任务，系统自动对齐双方上下文</div>
  </div>

  <div class="source-banner" id="sourceBanner">
    <span class="source-banner-icon">📌</span>
    <span>派发方：</span>
    <span class="source-banner-role" id="sourceRoleName">加载中...</span>
    <span class="source-banner-text">—</span>
    <span id="sourceSessionTitle"></span>
  </div>

  <div id="formBody" style="display:none;">
    <div class="form-card">
      <!-- 目标会话 -->
      <div class="form-section">
        <label class="field-label">目标会话 <span class="required">*</span></label>
        <select id="targetSession"><option value="">-- 选择目标会话 --</option></select>
      </div>
      <!-- 任务标题 -->
      <div class="form-section">
        <label class="field-label">任务标题 <span class="required">*</span></label>
        <input type="text" id="title" placeholder="例如：实现用户登录接口" />
      </div>
      <!-- 简述 -->
      <div class="form-section">
        <label class="field-label">简述 <span class="hint">（任务背景）</span></label>
        <textarea id="brief" placeholder="前端需要调用登录接口完成用户认证流程..."></textarea>
      </div>
    </div>

    <div class="form-card">
      <!-- 目标 -->
      <div class="form-section">
        <label class="field-label">任务目标 <span class="required">*</span> <span class="hint">（一句话说清要干什么）</span></label>
        <textarea id="objective" placeholder="提供 POST /api/auth/login 接口，接收 username+password，返回 JWT token"></textarea>
      </div>
      <!-- 验收标准 -->
      <div class="form-section">
        <label class="field-label">验收标准 <span class="hint">（每行一条）</span></label>
        <textarea id="acceptanceCriteria" placeholder="接口返回 200 + token&#10;token 有效期 24h&#10;密码错误返回 401"></textarea>
      </div>
      <!-- 进展 -->
      <div class="form-section">
        <label class="field-label">当前进展 <span class="hint">（让接收方知道上游进度）</span></label>
        <textarea id="progressSummary" placeholder="已完成路由注册，缺少 controller 实现"></textarea>
      </div>
    </div>

    <div class="form-card">
      <!-- 产出 -->
      <div class="form-section">
        <label class="field-label">期望产出 <span class="hint">（输出格式/内容）</span></label>
        <input type="text" id="expectedOutput" placeholder="完整的 controller 代码 + 单元测试" />
      </div>
      <!-- 约束 -->
      <div class="form-section">
        <label class="field-label">约束与注意事项 <span class="hint">（每行一条）</span></label>
        <textarea id="constraints" placeholder="必须使用 JWT&#10;密码用 bcrypt 加密"></textarea>
      </div>
    </div>

    <div class="form-card">
      <!-- 关联 -->
      <div class="form-section">
        <label class="field-label">关联任务 <span class="hint">（review 时拉取实际内容）</span></label>
        <div class="checkbox-grid" id="relatedTasks"></div>
      </div>
      <div class="form-section">
        <label class="field-label">关联契约 <span class="hint">（API 契约，review 时拉 schema）</span></label>
        <div class="checkbox-grid" id="relatedContracts"></div>
      </div>
      <div class="form-section">
        <label class="field-label">关联记忆 <span class="hint">（项目决策/约定）</span></label>
        <div class="checkbox-grid" id="relatedMemories"></div>
      </div>
      <!-- 优先级 -->
      <div class="form-section">
        <label class="field-label">优先级</label>
        <div class="priority-row">
          <label class="priority-opt"><input type="radio" name="priority" value="low"><span>低</span></label>
          <label class="priority-opt active"><input type="radio" name="priority" value="medium" checked><span>中</span></label>
          <label class="priority-opt"><input type="radio" name="priority" value="high"><span>高</span></label>
          <label class="priority-opt"><input type="radio" name="priority" value="critical"><span>紧急</span></label>
        </div>
      </div>
    </div>

    <div class="form-actions">
      <button class="btn" id="btnCancel">取消</button>
      <button class="btn btn-primary" id="btnSubmit">📤 派发任务</button>
    </div>
  </div>

  <div id="loadingState" class="loading-overlay">⏳ 加载选项中...</div>

<script>
  const vscode = acquireVsCodeApi();

  function splitLines(t) { return t.split('\\n').map(s=>s.trim()).filter(Boolean); }
  function getChecked(id) { return Array.from(document.querySelectorAll('#'+id+' .checked')).map(el=>el.dataset.value); }

  // 渲染多选网格
  function renderGrid(id, items, labelFn) {
    const el=document.getElementById(id);
    el.innerHTML=items.map(i=>{
      const lbl=labelFn(i);
      return '<label class="check-item" data-value="'+i.id+'"><input type="checkbox" value="'+i.id+'">'+escapeHtml(lbl)+'</label>';
    }).join('');
    el.querySelectorAll('.check-item').forEach(item=>{
      item.addEventListener('click',()=>{
        item.classList.toggle('checked');
        item.querySelector('input').checked=item.classList.contains('checked');
      });
    });
  }

  document.getElementById('btnCancel').addEventListener('click',()=>vscode.postMessage({type:'cancel'}));
  document.getElementById('btnSubmit').addEventListener('click', ()=>{
    const payload={
      targetSessionId:document.getElementById('targetSession').value,
      title:document.getElementById('title').value,
      brief:document.getElementById('brief').value,
      objective:document.getElementById('objective').value,
      acceptanceCriteria:splitLines(document.getElementById('acceptanceCriteria').value),
      progressSummary:document.getElementById('progressSummary').value,
      expectedOutput:document.getElementById('expectedOutput').value,
      constraints:splitLines(document.getElementById('constraints').value),
      relatedTasks:getChecked('relatedTasks'),
      relatedContracts:getChecked('relatedContracts'),
      relatedMemories:getChecked('relatedMemories'),
      priority:document.querySelector('input[name="priority"]:checked').value,
    };
    vscode.postMessage({type:'submit',payload});
  });

  // 优先级切换
  document.querySelectorAll('.priority-opt').forEach(opt=>{
    opt.addEventListener('click',()=>{
      document.querySelectorAll('.priority-opt').forEach(o=>o.classList.remove('active'));
      opt.classList.add('active');
      opt.querySelector('input').checked=true;
    });
  });

  function escapeHtml(t){const d=document.createElement('div');d.textContent=t;return d.innerHTML;}

  window.addEventListener('message',(e)=>{
    const msg=e.data;
    if(msg.type==='optionsLoaded'){
      document.getElementById('loadingState').style.display='none';
      document.getElementById('formBody').style.display='block';

      document.getElementById('sourceRoleName').textContent=msg.source.roleIcon+' '+msg.source.roleName;
      document.getElementById('sourceSessionTitle').textContent=msg.source.sessionTitle;

      const sel=document.getElementById('targetSession');
      sel.innerHTML='<option value="">-- 选择目标会话 --</option>'+
        msg.targets.map(t=>'<option value="'+t.id+'">'+t.roleIcon+' '+t.roleName+' — '+t.title+'</option>').join('');

      renderGrid('relatedTasks',msg.tasks||[],t=>t.title+' ('+t.status+')');
      renderGrid('relatedContracts',msg.contracts||[],c=>c.name+' v'+c.version);
      renderGrid('relatedMemories',msg.memories||[],m=>m.title+' ['+m.category+']');
    }
  });
</script>
</body>
</html>`;
  }
}
