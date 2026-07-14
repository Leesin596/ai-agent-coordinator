// ============================================================
// ModelsViewProvider — 左侧「模型设置」Webview View
// 统一管理模型预设库：增删改 + 设默认。
// 取代旧的「全局 configuration + 角色级 llmConfig」分散配置。
// 每个会话只从此处选模型，不再单独填表单。
// ============================================================
import * as vscode from 'vscode';
import type { CoordinatorContext } from '../backend/coordinator-context';
import { ModelStore, ModelPreset, MODEL_QUICK_PRESETS } from '../services/model-store';

export class ModelsViewProvider implements vscode.WebviewViewProvider {
  public static readonly VIEW_ID = 'coordinator.models';

  private view: vscode.WebviewView | undefined;
  private readonly _onDidChangeModels = new vscode.EventEmitter<void>();
  readonly onDidChangeModels = this._onDidChangeModels.event;

  constructor(private ctx: CoordinatorContext) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    view.webview.html = this.getHtml();

    view.webview.onDidReceiveMessage((msg) => this.handleMessage(msg));

    // 首次可见时推送数据
    this.pushState();
  }

  /** 外部触发刷新（模型库被其他途径改动时） */
  refresh(): void {
    this.pushState();
  }

  /** 外部触发刷新会话列表（会话增删/切换工作区时调用） */
  refreshSessions(): void {
    this.pushState();
  }

  private get store(): ModelStore {
    return this.ctx.getModelStore();
  }

  /** 收集当前工作区的会话列表（供左侧为每个会话选模型） */
  private getSessionsView(): Array<{
    id: string;
    title: string;
    roleIcon: string;
    roleName: string;
    modelId: string;
  }> {
    const runtime = this.ctx.getActiveRuntime();
    if (!runtime) return [];
    return runtime.sessionManager.list(runtime.workspace.id).map((s) => {
      const role = runtime.roleManager.get(s.roleId);
      return {
        id: s.id,
        title: s.title,
        roleIcon: role?.icon || '💬',
        roleName: role?.name || '?',
        modelId: s.modelId || '',
      };
    });
  }

  private async handleMessage(msg: any): Promise<void> {
    try {
      switch (msg.type) {
        case 'ready':
          await this.pushState();
          break;
        case 'add':
          await this.handleAdd(msg.preset);
          break;
        case 'update':
          await this.handleUpdate(msg.id, msg.patch);
          break;
        case 'delete':
          await this.handleDelete(msg.id);
          break;
        case 'setDefault':
          await this.handleSetDefault(msg.id);
          break;
        case 'setSessionModel':
          await this.handleSetSessionModel(msg.sessionId, msg.modelId);
          break;
      }
    } catch (err: any) {
      vscode.window.showErrorMessage(`模型设置: ${err.message}`);
    }
  }

  private async handleAdd(preset: any): Promise<void> {
    if (!preset?.name?.trim()) {
      vscode.window.showWarningMessage('请填写模型名称');
      return;
    }
    await this.store.add({
      name: preset.name.trim(),
      apiKey: preset.apiKey?.trim() || '',
      baseURL: preset.baseURL?.trim() || 'https://api.openai.com/v1',
      model: preset.model?.trim() || 'gpt-4o-mini',
      temperature: preset.temperature !== undefined && preset.temperature !== ''
        ? Number(preset.temperature) : 0.7,
    });
    await this.pushState();
    this._onDidChangeModels.fire();
  }

  private async handleUpdate(id: string, patch: any): Promise<void> {
    const clean: any = {};
    if (patch.name !== undefined) clean.name = String(patch.name).trim();
    if (patch.apiKey !== undefined) clean.apiKey = String(patch.apiKey).trim();
    if (patch.baseURL !== undefined) clean.baseURL = String(patch.baseURL).trim();
    if (patch.model !== undefined) clean.model = String(patch.model).trim();
    if (patch.temperature !== undefined && patch.temperature !== '') {
      clean.temperature = Number(patch.temperature);
    }
    await this.store.update(id, clean);
    await this.pushState();
    this._onDidChangeModels.fire();
  }

  private async handleDelete(id: string): Promise<void> {
    const m = this.store.get(id);
    if (!m) return;
    const choice = await vscode.window.showWarningMessage(
      `确定删除模型「${m.name}」？`,
      { modal: true },
      '删除',
    );
    if (choice !== '删除') return;
    await this.store.delete(id);
    await this.pushState();
    this._onDidChangeModels.fire();
  }

  private async handleSetDefault(id: string): Promise<void> {
    await this.store.setDefault(id);
    await this.pushState();
    this._onDidChangeModels.fire();
  }

  private async handleSetSessionModel(sessionId: string, modelId: string): Promise<void> {
    const runtime = this.ctx.getActiveRuntime();
    if (!runtime) return;
    runtime.sessionManager.setModel(sessionId, modelId || null);
    await this.pushState();
    // 通知聊天面板/控制台刷新当前模型显示
    this._onDidChangeModels.fire();
  }

  private async pushState(): Promise<void> {
    const models = this.store.list();
    const defaultId = this.store.getDefaultId();
    const sessions = this.getSessionsView();
    this.postToWebview({ type: 'state', models, defaultId, sessions });
  }

  private postToWebview(msg: any): void {
    this.view?.webview?.postMessage(msg);
  }

  // ============================================================
  // HTML / CSS / JS
  // ============================================================
  private getHtml(): string {
    const presetsJson = JSON.stringify(MODEL_QUICK_PRESETS);
    return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<style>
  :root {
    --bg: var(--vscode-sideBar-background, #1e1e1e);
    --bg-card: var(--vscode-sideBarSectionHeader-background, #252526);
    --bg-hover: rgba(255,255,255,.06);
    --bg-input: var(--vscode-input-background, #1e1e1e);
    --border: var(--vscode-panel-border, #3e3e42);
    --border-subtle: rgba(255,255,255,.07);
    --text: var(--vscode-foreground, #cccccc);
    --text2: var(--vscode-descriptionForeground, #858585);
    --text3: #6a6a6a;
    --accent: var(--vscode-button-background, #0e639c);
    --accent-hover: var(--vscode-button-hoverBackground, #1177bb);
    --btn-text: var(--vscode-button-foreground, #ffffff);
    --danger: var(--vscode-errorForeground, #f14c4c);
    --success: #4ec970;
    --r-sm: 4px;
    --r-md: 6px;
  }
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { height:100%; }
  body {
    font-family: var(--vscode-font-family, -apple-system, 'Segoe UI', sans-serif);
    font-size: 12px;
    color: var(--text);
    background: var(--bg);
    display:flex; flex-direction:column;
    overflow:hidden;
    user-select:none;
  }

  .header {
    padding:10px 12px 8px;
    display:flex; align-items:center; justify-content:space-between;
    border-bottom:1px solid var(--border-subtle);
    flex-shrink:0;
  }
  .header h2 { font-size:12px; font-weight:600; display:flex; align-items:center; gap:5px; }
  .header h2 .ico { font-size:13px; }
  .btn-add {
    display:inline-flex; align-items:center; gap:3px;
    padding:3px 9px; border:none; border-radius:var(--r-sm);
    background:var(--accent); color:var(--btn-text);
    font-size:11px; cursor:pointer; transition:background .15s;
  }
  .btn-add:hover { background:var(--accent-hover); }

  .list {
    flex:1; overflow-y:auto;
    padding:8px 10px;
    display:flex; flex-direction:column; gap:6px;
  }
  .list::-webkit-scrollbar { width:5px; }
  .list::-webkit-scrollbar-thumb { background:var(--border); border-radius:3px; }

  .model-card {
    background:var(--bg-card);
    border:1px solid var(--border-subtle);
    border-radius:var(--r-md);
    padding:8px 10px;
    transition:border-color .15s, background .15s;
  }
  .model-card:hover { border-color:var(--border); }
  .model-card.default { border-color:var(--accent); }
  .card-row {
    display:flex; align-items:center; justify-content:space-between;
    gap:6px;
  }
  .card-name {
    font-size:12px; font-weight:600; color:var(--text);
    display:flex; align-items:center; gap:5px;
    overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  }
  .default-badge {
    font-size:9px; padding:1px 5px; border-radius:8px;
    background:rgba(78,201,112,.15); color:var(--success);
    border:1px solid rgba(78,201,112,.3);
    flex-shrink:0;
  }
  .card-model {
    font-size:10.5px; color:var(--text2);
    margin-top:3px;
    overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
    font-family:var(--vscode-editor-font-family, Consolas, monospace);
  }
  .card-actions {
    display:flex; gap:2px; margin-top:6px;
  }
  .act-btn {
    padding:2px 7px; border:1px solid var(--border-subtle);
    border-radius:var(--r-sm); background:transparent;
    color:var(--text2); font-size:10px; cursor:pointer;
    transition:all .15s;
  }
  .act-btn:hover { border-color:var(--accent); color:var(--accent); }
  .act-btn.danger:hover { border-color:var(--danger); color:var(--danger); }
  .act-btn.set-default:hover { border-color:var(--success); color:var(--success); }

  .empty {
    flex:1; display:flex; flex-direction:column;
    align-items:center; justify-content:center;
    color:var(--text3); text-align:center; gap:8px; padding:30px 16px;
  }
  .empty .eico { font-size:32px; opacity:.4; }
  .empty .ehint { font-size:11px; line-height:1.6; opacity:.8; }

  /* ─── 会话模型选择区 ─── */
  .sessions-section {
    flex-shrink:0;
    border-top:1px solid var(--border-subtle);
    background:var(--bg);
    display:flex; flex-direction:column;
    max-height:45%;
  }
  .sessions-header {
    padding:8px 12px 6px;
    display:flex; align-items:center; justify-content:space-between;
  }
  .sessions-header h3 {
    font-size:11px; font-weight:600; color:var(--text2);
    text-transform:uppercase; letter-spacing:.4px;
    display:flex; align-items:center; gap:4px;
  }
  .sessions-header .s-count {
    font-size:10px; color:var(--text3); font-weight:400;
  }
  .sessions-list {
    overflow-y:auto;
    padding:0 10px 8px;
    display:flex; flex-direction:column; gap:4px;
  }
  .sessions-list::-webkit-scrollbar { width:5px; }
  .sessions-list::-webkit-scrollbar-thumb { background:var(--border); border-radius:3px; }
  .session-row {
    display:flex; align-items:center; gap:6px;
    padding:5px 8px;
    background:var(--bg-card);
    border:1px solid var(--border-subtle);
    border-radius:var(--r-sm);
    transition:border-color .15s;
  }
  .session-row:hover { border-color:var(--border); }
  .session-row .s-ico { font-size:12px; flex-shrink:0; }
  .session-row .s-name {
    flex:1; font-size:11px; color:var(--text);
    overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  }
  .session-row select {
    flex-shrink:0; max-width:42%;
    padding:2px 4px; border-radius:var(--r-sm);
    border:1px solid var(--border-subtle); background:var(--bg-input);
    color:var(--text); font-size:10.5px; font-family:inherit; outline:none;
    cursor:pointer; transition:border-color .15s;
  }
  .session-row select:hover { border-color:var(--accent); }
  .session-row select:focus { border-color:var(--accent); }
  .sessions-empty {
    padding:10px 12px; font-size:10.5px; color:var(--text3); text-align:center;
  }

  /* ─── 编辑弹窗 ─── */
  .modal-overlay {
    position:fixed; inset:0; z-index:999;
    background:rgba(0,0,0,.55);
    display:none; align-items:center; justify-content:center;
    backdrop-filter:blur(3px);
  }
  .modal-overlay.show { display:flex; }
  .modal {
    width:340px; max-height:86vh; overflow-y:auto;
    background:var(--bg-card); border:1px solid var(--border);
    border-radius:10px; box-shadow:0 8px 40px rgba(0,0,0,.5);
  }
  .modal-header {
    display:flex; align-items:center; justify-content:space-between;
    padding:11px 14px; border-bottom:1px solid var(--border-subtle);
  }
  .modal-header h3 { font-size:12px; font-weight:600; }
  .modal-close {
    width:22px; height:22px; border-radius:50%; border:none;
    background:transparent; color:var(--text3); cursor:pointer;
    font-size:13px; display:flex; align-items:center; justify-content:center;
  }
  .modal-close:hover { background:rgba(255,255,255,.08); color:var(--text); }
  .modal-body { padding:12px 14px; }
  .field { margin-bottom:10px; }
  .field:last-child { margin-bottom:0; }
  .field label {
    display:block; font-size:10px; font-weight:600;
    text-transform:uppercase; letter-spacing:.4px;
    color:var(--text2); margin-bottom:4px;
  }
  .field input {
    width:100%; padding:6px 8px; border-radius:var(--r-sm);
    border:1px solid var(--border); background:var(--bg-input);
    color:var(--text); font-size:11.5px; font-family:inherit; outline:none;
    transition:border-color .15s;
  }
  .field input:focus { border-color:var(--accent); }
  .field input::placeholder { color:var(--text3); opacity:.7; }
  .quick-presets { display:flex; gap:3px; flex-wrap:wrap; margin-top:5px; }
  .qp-chip {
    padding:2px 7px; border-radius:10px; font-size:9.5px; cursor:pointer;
    border:1px solid var(--border-subtle); background:transparent; color:var(--text2);
    transition:all .15s;
  }
  .qp-chip:hover { border-color:var(--accent); color:var(--accent); }
  .modal-footer {
    display:flex; justify-content:flex-end; gap:6px;
    padding:10px 14px; border-top:1px solid var(--border-subtle);
  }
  .btn {
    padding:5px 12px; border-radius:var(--r-sm); font-size:11px;
    cursor:pointer; border:1px solid var(--border);
    background:transparent; color:var(--text2); transition:all .15s;
  }
  .btn:hover { background:var(--bg-hover); color:var(--text); }
  .btn.primary { background:var(--accent); border-color:var(--accent); color:var(--btn-text); }
  .btn.primary:hover { background:var(--accent-hover); border-color:var(--accent-hover); }
</style>
</head>
<body>

<div class="header">
  <h2><span class="ico">⚙️</span> 模型设置</h2>
  <button class="btn-add" id="btnAdd">＋ 新增</button>
</div>

<div class="list" id="list"></div>

<div class="empty" id="empty" style="display:none">
  <div class="eico">🤖</div>
  <div>暂无模型配置</div>
  <div class="ehint">点击右上角「＋ 新增」配置一个模型预设<br>会话将从这里选择模型使用</div>
</div>

<!-- 会话模型选择区 -->
<div class="sessions-section" id="sessionsSection" style="display:none">
  <div class="sessions-header">
    <h3>🗂️ 会话模型</h3>
    <span class="s-count" id="sCount"></span>
  </div>
  <div class="sessions-list" id="sessionsList"></div>
</div>

<!-- 编辑弹窗 -->
<div class="modal-overlay" id="modal">
  <div class="modal">
    <div class="modal-header">
      <h3 id="modalTitle">新增模型</h3>
      <button class="modal-close" id="modalClose">✕</button>
    </div>
    <div class="modal-body">
      <div class="field">
        <label>名称</label>
        <input type="text" id="fName" placeholder="如：GPT-4o / DeepSeek">
      </div>
      <div class="field">
        <label>API Key</label>
        <input type="password" id="fApiKey" placeholder="sk-...">
      </div>
      <div class="field">
        <label>Base URL</label>
        <input type="text" id="fBaseURL" placeholder="https://api.openai.com/v1">
      </div>
      <div class="field">
        <label>模型标识</label>
        <input type="text" id="fModel" placeholder="gpt-4o">
        <div class="quick-presets" id="quickPresets"></div>
      </div>
      <div class="field">
        <label>Temperature</label>
        <input type="number" id="fTemp" min="0" max="2" step="0.1" placeholder="0.7">
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn" id="btnCancel">取消</button>
      <button class="btn primary" id="btnSave">保存</button>
    </div>
  </div>
</div>

<script>
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const listEl = $('list');
  const emptyEl = $('empty');
  const modal = $('modal');
  const sessionsSection = $('sessionsSection');
  const sessionsListEl = $('sessionsList');
  const sCountEl = $('sCount');
  const QUICK_PRESETS = ${presetsJson};

  let editMode = 'add'; // 'add' | 'edit'
  let editId = null;
  let curDefaultId = '';
  let curModels = [];   // 当前模型库（供会话下拉渲染）

  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function maskKey(k) {
    if (!k) return '<span style="color:var(--text3)">未设置</span>';
    if (k.length <= 8) return '••••';
    return esc(k.slice(0,4)) + '••••' + esc(k.slice(-4));
  }

  function render(models) {
    curModels = models || [];
    if (!models || models.length === 0) {
      listEl.style.display = 'none';
      emptyEl.style.display = 'flex';
      return;
    }
    listEl.style.display = 'flex';
    emptyEl.style.display = 'none';
    listEl.innerHTML = models.map(m => {
      const isDef = m.id === curDefaultId;
      return '<div class="model-card' + (isDef ? ' default' : '') + '">' +
        '<div class="card-row">' +
          '<div class="card-name">' + esc(m.name) + (isDef ? '<span class="default-badge">默认</span>' : '') + '</div>' +
        '</div>' +
        '<div class="card-model">' + esc(m.model) + ' · ' + maskKey(m.apiKey) + '</div>' +
        '<div class="card-actions">' +
          (isDef ? '' : '<button class="act-btn set-default" data-act="default" data-id="' + m.id + '">设为默认</button>') +
          '<button class="act-btn" data-act="edit" data-id="' + m.id + '">编辑</button>' +
          '<button class="act-btn danger" data-act="delete" data-id="' + m.id + '">删除</button>' +
        '</div>' +
      '</div>';
    }).join('');

    listEl.querySelectorAll('.act-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const act = btn.dataset.act;
        const id = btn.dataset.id;
        if (act === 'default') vscode.postMessage({ type:'setDefault', id });
        else if (act === 'edit') openEdit(id);
        else if (act === 'delete') vscode.postMessage({ type:'delete', id });
      });
    });
  }

  function renderSessions(sessions) {
    if (!sessions || sessions.length === 0) {
      sessionsSection.style.display = 'none';
      return;
    }
    sessionsSection.style.display = 'flex';
    sCountEl.textContent = String(sessions.length);
    const def = curModels.find(m => m.id === curDefaultId);
    const defLabel = def ? def.name : '默认';
    sessionsListEl.innerHTML = sessions.map(s => {
      const opts = curModels.map(m =>
        '<option value="' + esc(m.id) + '"' + (m.id === s.modelId ? ' selected' : '') + '>' + esc(m.name) + '</option>'
      ).join('');
      const useDefault = !s.modelId;
      return '<div class="session-row">' +
        '<span class="s-ico">' + esc(s.roleIcon) + '</span>' +
        '<span class="s-name" title="' + esc(s.title) + '">' + esc(s.title) + '</span>' +
        '<select data-sid="' + esc(s.id) + '">' +
          '<option value=""' + (useDefault ? ' selected' : '') + '>默认（' + esc(defLabel) + '）</option>' +
          opts +
        '</select>' +
      '</div>';
    }).join('');
    sessionsListEl.querySelectorAll('select').forEach(sel => {
      sel.addEventListener('change', () => {
        vscode.postMessage({ type:'setSessionModel', sessionId: sel.dataset.sid, modelId: sel.value });
      });
    });
  }

  function renderQuickPresets() {
    $('quickPresets').innerHTML = QUICK_PRESETS.map((p,i) =>
      '<span class="qp-chip" data-i="' + i + '">' + esc(p.name) + '</span>'
    ).join('');
    $('quickPresets').querySelectorAll('.qp-chip').forEach(c => {
      c.addEventListener('click', () => {
        const p = QUICK_PRESETS[Number(c.dataset.i)];
        if ($('fName').value.trim() === '') $('fName').value = p.name;
        $('fModel').value = p.model;
        $('fBaseURL').value = p.baseURL;
      });
    });
  }

  function openAdd() {
    editMode = 'add'; editId = null;
    $('modalTitle').textContent = '新增模型';
    $('fName').value = ''; $('fApiKey').value = '';
    $('fBaseURL').value = 'https://api.openai.com/v1';
    $('fModel').value = 'gpt-4o-mini'; $('fTemp').value = '0.7';
    renderQuickPresets();
    modal.classList.add('show');
    setTimeout(() => $('fName').focus(), 50);
  }

  function openEdit(id) {
    const card = listEl.querySelector('.model-card .act-btn[data-id="' + id + '"]');
    // 从当前渲染数据找模型
    const m = window._models ? window._models.find(x => x.id === id) : null;
    if (!m) return;
    editMode = 'edit'; editId = id;
    $('modalTitle').textContent = '编辑模型';
    $('fName').value = m.name; $('fApiKey').value = m.apiKey || '';
    $('fBaseURL').value = m.baseURL || ''; $('fModel').value = m.model || '';
    $('fTemp').value = m.temperature !== undefined ? String(m.temperature) : '0.7';
    renderQuickPresets();
    modal.classList.add('show');
  }

  function closeModal() { modal.classList.remove('show'); }

  function save() {
    const data = {
      name: $('fName').value,
      apiKey: $('fApiKey').value,
      baseURL: $('fBaseURL').value,
      model: $('fModel').value,
      temperature: $('fTemp').value,
    };
    if (!data.name.trim()) { vscode.window?.showWarningMessage?.('请填写名称'); $('fName').focus(); return; }
    if (editMode === 'add') {
      vscode.postMessage({ type:'add', preset:data });
    } else {
      vscode.postMessage({ type:'update', id:editId, patch:data });
    }
    closeModal();
  }

  $('btnAdd').addEventListener('click', openAdd);
  $('modalClose').addEventListener('click', closeModal);
  $('btnCancel').addEventListener('click', closeModal);
  $('btnSave').addEventListener('click', save);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg.type === 'state') {
      window._models = msg.models || [];
      curDefaultId = msg.defaultId || '';
      render(msg.models);
      renderSessions(msg.sessions);
    }
  });

  vscode.postMessage({ type:'ready' });
</script>
</body>
</html>`;
  }
}
