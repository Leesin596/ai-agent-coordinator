// ============================================================
// SidebarViewProvider — 统一侧边栏 Webview
// 左侧图标导航 + 右侧内容区，切换 工作区/会话/角色/模型
// ============================================================
import * as vscode from 'vscode';
import type { CoordinatorContext } from '../backend/coordinator-context';
import { ModelStore, MODEL_QUICK_PRESETS } from '../services/model-store';
import type { ModelApiFormat } from '../services/model-store';
import { extractApiError, prepareLLMRequest } from '../services/llm-api';
import type { Role, RoleCategory } from '../../../src/models/types';
import { ROLE_CATEGORY_LABELS } from '../../../src/models/types';

const CATEGORY_ORDER: RoleCategory[] = ['engineering', 'product', 'design', 'qa', 'custom'];
const CATEGORY_ICONS: Record<RoleCategory, string> = {
  engineering: '🔧', product: '💡', design: '🎨', qa: '🛡️', custom: '⭐',
};

export class SidebarViewProvider implements vscode.WebviewViewProvider {
  public static readonly VIEW_ID = 'coordinator.sidebar';

  private view: vscode.WebviewView | undefined;
  private readonly _onDidChangeModels = new vscode.EventEmitter<void>();
  readonly onDidChangeModels = this._onDidChangeModels.event;

  constructor(private ctx: CoordinatorContext) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    view.webview.html = this.getHtml();

    view.webview.onDidReceiveMessage(
      (msg) => this.handleMessage(msg),
    );

    this.pushAll();
  }

  refresh(): void { this.pushAll(); }
  refreshSessions(): void { this.pushSessions(); }
  refreshModels(): void { this.pushModels(); }
  refreshRoles(): void { this.pushRoles(); }
  refreshWorkspaces(): void { this.pushWorkspaces(); }

  private get store(): ModelStore { return this.ctx.getModelStore(); }

  // ============================================================
  // 数据推送
  // ============================================================

  private pushAll(): void {
    this.pushWorkspaces();
    this.pushSessions();
    this.pushRoles();
    this.pushModels();
  }

  private pushWorkspaces(): void {
    const workspaces = this.ctx.listWorkspaces();
    const active = this.ctx.getActiveWorkspace();
    const runtime = this.ctx.getActiveRuntime();
    this.postToWebview({
      type: 'workspaces',
      items: workspaces.sort((a, b) => {
        const ta = a.lastActiveAt ? Date.parse(a.lastActiveAt) : 0;
        const tb = b.lastActiveAt ? Date.parse(b.lastActiveAt) : 0;
        return tb - ta;
      }).map((ws) => ({
        id: ws.id,
        name: ws.name,
        folderPath: ws.folderPath,
        lastActiveAt: ws.lastActiveAt,
        isActive: ws.id === active?.id,
        sessionCount: (runtime && ws.id === active?.id) ? runtime.sessionManager.list(ws.id).length : 0,
      })),
    });
  }

  private pushSessions(): void {
    const runtime = this.ctx.getActiveRuntime();
    if (!runtime) { this.postToWebview({ type: 'sessions', groups: [] }); return; }
    const sessions = runtime.sessionManager.list(runtime.workspace.id);
    const groups: Array<{ roleId: string; roleName: string; roleIcon: string; sessions: any[] }> = [];
    const roleMap = new Map<string, any>();
    for (const s of sessions) {
      const role = runtime.roleManager.get(s.roleId);
      if (!role) continue;
      const g = roleMap.get(s.roleId);
      if (g) g.sessions.push(s);
      else roleMap.set(s.roleId, {
        roleId: s.roleId, roleName: role.name, roleIcon: role.icon || '👤',
        sessions: [s],
      });
    }
    for (const g of roleMap.values()) {
      g.sessions.sort((a: any, b: any) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      groups.push(g);
    }
    groups.sort((a, b) => b.sessions.length - a.sessions.length);
    this.postToWebview({ type: 'sessions', groups });
  }

  private pushRoles(): void {
    const runtime = this.ctx.getActiveRuntime();
    if (!runtime) { this.postToWebview({ type: 'roles', categories: [] }); return; }
    const roles = runtime.roleManager.list();
    const presentCats = new Set(roles.map((r) => r.category));
    const categories = CATEGORY_ORDER.filter((c) => presentCats.has(c)).map((cat) => ({
      category: cat,
      label: ROLE_CATEGORY_LABELS[cat],
      icon: CATEGORY_ICONS[cat],
      roles: roles.filter((r) => r.category === cat).sort((a, b) => a.sortOrder - b.sortOrder).map((r) => ({
        id: r.id, name: r.name, icon: r.icon || '👤',
        builtIn: r.builtIn, description: r.description,
        skills: r.skills || [],
      })),
    }));
    this.postToWebview({ type: 'roles', categories });
  }

  private pushModels(): void {
    const models = this.store.list();
    const defaultId = this.store.getDefaultId();
    const runtime = this.ctx.getActiveRuntime();
    const sessions = runtime ? runtime.sessionManager.list(runtime.workspace.id).map((s) => {
      const role = runtime.roleManager.get(s.roleId);
      return { id: s.id, title: s.title, roleIcon: role?.icon || '💬', roleName: role?.name || '?', modelId: s.modelId || '' };
    }) : [];
    this.postToWebview({ type: 'models', models, defaultId, sessions });
  }

  private postToWebview(msg: any): void { this.view?.webview?.postMessage(msg); }

  // ============================================================
  // 消息处理
  // ============================================================

  private async handleMessage(msg: any): Promise<void> {
    try {
      switch (msg.type) {
        case 'ready': this.pushAll(); break;
        // 工作区
        case 'switchWorkspace': await this.handleSwitchWorkspace(msg.id); break;
        case 'addWorkspace': await this.handleAddWorkspace(); break;
        case 'renameWorkspace': await this.handleRenameWorkspace(msg.id); break;
        case 'removeWorkspace': await this.handleRemoveWorkspace(msg.id); break;
        // 会话
        case 'openSession': await this.handleOpenSession(msg.id); break;
        case 'deleteSession': await this.handleDeleteSession(msg.id); break;
        // 角色
        case 'startSession': await this.handleStartSession(msg.roleId); break;
        case 'addRole': await this.handleAddRole(); break;
        case 'editRole': await this.handleEditRole(msg.roleId); break;
        case 'deleteRole': await this.handleDeleteRole(msg.roleId); break;
        // 模型
        case 'addModel': await this.handleAddModel(msg.preset); break;
        case 'updateModel': await this.handleUpdateModel(msg.id, msg.patch); break;
        case 'deleteModel': await this.handleDeleteModel(msg.id); break;
        case 'setDefaultModel': await this.handleSetDefaultModel(msg.id); break;
        case 'setSessionModel': await this.handleSetSessionModel(msg.sessionId, msg.modelId); break;
        case 'testConnection': await this.handleTestConnection(msg.data); break;
      }
    } catch (err: any) {
      vscode.window.showErrorMessage(`侧边栏: ${err.message}`);
    }
  }

  // ─── 工作区操作 ───
  private async handleSwitchWorkspace(id: string): Promise<void> {
    await this.ctx.switchWorkspace(id);
    this.pushAll();
  }
  private async handleAddWorkspace(): Promise<void> {
    await this.ctx.addWorkspace();
    this.pushAll();
  }
  private async handleRenameWorkspace(id: string): Promise<void> {
    await this.ctx.renameWorkspace(id);
    this.pushAll();
  }
  private async handleRemoveWorkspace(id: string): Promise<void> {
    const ws = this.ctx.listWorkspaces().find((w) => w.id === id);
    if (!ws) return;
    const choice = await vscode.window.showWarningMessage(`确定删除工作区「${ws.name}」？`, { modal: true }, '删除');
    if (choice !== '删除') return;
    await this.ctx.removeWorkspace(id);
    this.pushAll();
  }

  // ─── 会话操作 ───
  private async handleOpenSession(sessionId: string): Promise<void> {
    const consoleProvider = this.ctx.getConsoleProvider();
    if (consoleProvider) await consoleProvider.openSessionInPanel(sessionId);
  }
  private async handleDeleteSession(sessionId: string): Promise<void> {
    const runtime = this.ctx.getActiveRuntime();
    if (!runtime) return;
    const session = runtime.sessionManager.list(runtime.workspace.id).find((s) => s.id === sessionId);
    if (!session) return;
    const choice = await vscode.window.showWarningMessage(`确定删除会话「${session.title}」？`, { modal: true }, '删除');
    if (choice !== '删除') return;
    runtime.sessionManager.delete(sessionId);
    this.pushSessions();
    this.pushWorkspaces();
    this.ctx.fireSessionsChanged();
  }

  // ─── 角色操作 ───
  private async handleStartSession(roleId: string): Promise<void> {
    const runtime = this.ctx.getActiveRuntime();
    if (!runtime) { vscode.window.showWarningMessage('请先切换到工作区'); return; }
    const role = runtime.roleManager.get(roleId);
    if (!role) return;
    const consoleProvider = this.ctx.getConsoleProvider();
    if (consoleProvider) await consoleProvider.startSessionForRole(role);
  }
  private async handleAddRole(): Promise<void> {
    const runtime = await this.ctx.ensureActiveWorkspace();
    if (!runtime) return;
    await this.ctx.getConsoleProvider()?.showRoleEditor(undefined, true);
  }
  private async handleEditRole(roleId: string): Promise<void> {
    await this.ctx.getConsoleProvider()?.showRoleEditor(roleId);
  }
  private async handleDeleteRole(roleId: string): Promise<void> {
    const runtime = this.ctx.getActiveRuntime();
    if (!runtime) return;
    const role = runtime.roleManager.get(roleId);
    if (!role) return;
    if (role.builtIn) { vscode.window.showWarningMessage('内置角色不可删除'); return; }
    const choice = await vscode.window.showWarningMessage(`确定删除角色「${role.name}」？`, { modal: true }, '删除');
    if (choice !== '删除') return;
    runtime.roleManager.delete(roleId);
    this.pushRoles();
  }

  // ─── 模型操作 ───
  private async handleAddModel(preset: any): Promise<void> {
    if (!preset?.name?.trim()) { vscode.window.showWarningMessage('请填写档案名'); return; }
    if (!preset?.apiKey?.trim()) { vscode.window.showWarningMessage('请填写 API Key'); return; }
    if (!preset?.baseURL?.trim()) { vscode.window.showWarningMessage('请填写 Base URL'); return; }
    await this.store.add({
      name: preset.name.trim(),
      apiKey: preset.apiKey.trim(),
      baseURL: preset.baseURL.trim(),
      model: preset.model?.trim() || 'gpt-5.6-terra',
      apiFormat: (preset.apiFormat || 'responses') as ModelApiFormat,
      thinkingStrength: preset.thinkingStrength || 'xhigh',
      contextWindow: preset.contextWindow ? Number(preset.contextWindow) : 1000000,
      temperature: preset.temperature !== undefined && preset.temperature !== '' ? Number(preset.temperature) : 0.7,
    });
    this.pushModels();
    this._onDidChangeModels.fire();
  }
  private async handleUpdateModel(id: string, patch: any): Promise<void> {
    const clean: any = {};
    if (patch.name !== undefined) clean.name = String(patch.name).trim();
    if (patch.apiKey !== undefined) clean.apiKey = String(patch.apiKey).trim();
    if (patch.baseURL !== undefined) clean.baseURL = String(patch.baseURL).trim();
    if (patch.model !== undefined) clean.model = String(patch.model).trim();
    if (patch.apiFormat !== undefined) clean.apiFormat = String(patch.apiFormat) as ModelApiFormat;
    if (patch.thinkingStrength !== undefined) clean.thinkingStrength = String(patch.thinkingStrength);
    if (patch.contextWindow !== undefined && patch.contextWindow !== '') clean.contextWindow = Number(patch.contextWindow);
    if (patch.temperature !== undefined && patch.temperature !== '') clean.temperature = Number(patch.temperature);
    await this.store.update(id, clean);
    this.pushModels();
    this._onDidChangeModels.fire();
  }
  private async handleDeleteModel(id: string): Promise<void> {
    const m = this.store.get(id);
    if (!m) return;
    const choice = await vscode.window.showWarningMessage(`确定删除模型「${m.name}」？`, { modal: true }, '删除');
    if (choice !== '删除') return;
    await this.store.delete(id);
    this.pushModels();
    this._onDidChangeModels.fire();
  }
  private async handleSetDefaultModel(id: string): Promise<void> {
    await this.store.setDefault(id);
    this.pushModels();
    this._onDidChangeModels.fire();
  }
  private async handleSetSessionModel(sessionId: string, modelId: string): Promise<void> {
    const runtime = this.ctx.getActiveRuntime();
    if (!runtime) return;
    runtime.sessionManager.setModel(sessionId, modelId || null);
    this.pushModels();
    this._onDidChangeModels.fire();
  }

  private async handleTestConnection(data: any): Promise<void> {
    const baseURL = (data.baseURL || '').trim().replace(/\/+$/, '');
    const apiKey = (data.apiKey || '').trim();
    const model = (data.model || 'gpt-5.6-terra').trim();
    const apiFormat = (data.apiFormat || 'responses') as ModelApiFormat;
    if (!baseURL || !apiKey) {
      this.postToWebview({ type: 'testResult', success: false, message: 'Base URL 和 API Key 不能为空' });
      return;
    }
    try {
      const https = await import('https');
      const http = await import('http');
      const { url, headers, body } = prepareLLMRequest(
        [{ role: 'user', content: 'Hi' }],
        { apiKey, baseURL, model, apiFormat, maxTokens: 5 },
        false,
      );
      const lib = url.protocol === 'https:' ? https : http;
      const result = await new Promise<{ success: boolean; message: string }>((resolve) => {
        const req = lib.request(url, {
          method: 'POST',
          headers,
          timeout: 15000,
        }, (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve({ success: true, message: `连接成功 (HTTP ${res.statusCode})` });
            } else if (res.statusCode === 401) {
              resolve({ success: false, message: `认证失败 (HTTP 401) — API Key 无效` });
            } else if (res.statusCode === 404) {
              resolve({ success: false, message: `API 端点不存在 (HTTP 404) — 检查 Base URL 与 API 格式` });
            } else {
              resolve({ success: false, message: `HTTP ${res.statusCode}: ${extractApiError(data) || '请求失败'}` });
            }
          });
        });
        req.on('error', (err) => {
          resolve({ success: false, message: `网络错误: ${err.message}` });
        });
        req.on('timeout', () => {
          req.destroy();
          resolve({ success: false, message: '请求超时 (15s)' });
        });
        req.write(body);
        req.end();
      });
      this.postToWebview({ type: 'testResult', ...result });
    } catch (err: any) {
      this.postToWebview({ type: 'testResult', success: false, message: `错误: ${err.message}` });
    }
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
    --warn: #d4a33a;
    --r-sm: 4px;
    --r-md: 6px;
  }
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { height:100%; }
  body {
    font-family: var(--vscode-font-family, -apple-system, 'Segoe UI', sans-serif);
    font-size: 12px; color: var(--text); background: var(--bg);
    display:flex; flex-direction:column; overflow:hidden; user-select:none;
  }

  /* ─── 内容区 ─── */
  .content { flex:1; min-height:0; display:flex; flex-direction:column; overflow:hidden; }
  .panel { display:none; flex-direction:column; flex:1; min-height:0; }
  .panel.show { display:flex; }

  /* ─── Header 区域 ─── */
  .header-area {
    padding: 12px 12px 10px;
    border-bottom: 1px solid var(--border-subtle);
    flex-shrink: 0;
    display: flex; flex-direction: column; gap: 10px;
    background: color-mix(in srgb, var(--bg) 94%, var(--text) 6%);
  }
  .header-title {
    display: flex; align-items: center; justify-content: space-between;
  }
  .header-title h1 {
    font-size: 14px; font-weight: 700;
    display: flex; align-items: center; gap: 6px;
  }
  .header-version {
    font-size: 10px; color: var(--text3);
    padding: 1px 6px; border-radius: 8px;
    background: var(--bg-card); border: 1px solid var(--border-subtle);
  }
  .header-tabs {
    display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 4px;
  }
  .header-tab {
    min-width:0; padding: 6px 5px; border-radius: var(--r-sm);
    font-size: 11px; font-weight: 600; text-align: center;
    cursor: pointer; transition: background .15s, color .15s, border-color .15s;
    border: 1px solid var(--border-subtle); background: transparent;
    color: var(--text2);
  }
  .header-tab:hover { background: var(--bg-hover); color: var(--text); }
  .header-tab:focus-visible { outline: 1px solid var(--vscode-focusBorder, var(--accent)); outline-offset: 2px; }
  .header-tab.active {
    background: var(--accent); border-color: var(--accent); color: var(--btn-text);
  }

  /* ─── 通用面板头 ─── */
  .panel-header {
    padding: 14px 12px 10px; display:flex; align-items:flex-start; justify-content:space-between; gap:10px;
    border-bottom: 1px solid var(--border-subtle); flex-shrink:0;
  }
  .panel-heading { min-width:0; }
  .panel-header h2 { font-size:13px; line-height:1.2; font-weight:650; }
  .panel-subtitle { margin-top:4px; color:var(--text2); font-size:10.5px; line-height:1.45; text-wrap:pretty; }
  .btn-add {
    display:inline-flex; align-items:center; gap:3px;
    padding:3px 9px; border:none; border-radius:var(--r-sm);
    background:var(--accent); color:var(--btn-text);
    font-size:11px; cursor:pointer; transition:background .15s;
  }
  .btn-add:hover { background:var(--accent-hover); }
  .btn-add:active, .act-btn:active, .header-tab:active { transform:translateY(1px); }
  .btn-add:focus-visible, .act-btn:focus-visible { outline:1px solid var(--vscode-focusBorder, var(--accent)); outline-offset:2px; }

  .list { flex:1; min-height:0; overflow-y:auto; padding:10px 12px 14px; display:flex; flex-direction:column; gap:8px; }
  .list::-webkit-scrollbar { width:5px; }
  .list::-webkit-scrollbar-thumb { background:var(--border); border-radius:3px; }

  /* ─── 模型设置表单 ─── */
  .model-form {
    flex: 1; overflow-y: auto; padding: 10px 12px;
    display: flex; flex-direction: column; gap: 10px;
  }
  .model-form::-webkit-scrollbar { width:5px; }
  .model-form::-webkit-scrollbar-thumb { background:var(--border); border-radius:3px; }
  .model-form > .list { flex:none; overflow:visible; padding:0; }
  .form-section {
    background: var(--bg-card); border: 1px solid var(--border-subtle);
    border-radius: var(--r-md); padding: 10px 12px;
    display: flex; flex-direction: column; gap: 8px;
  }
  .form-section-title {
    font-size: 10px; font-weight: 700; text-transform: uppercase;
    letter-spacing: .5px; color: var(--text2);
    display: flex; align-items: center; gap: 4px;
    padding-bottom: 4px; border-bottom: 1px solid var(--border-subtle);
  }
  .field { display: flex; flex-direction: column; gap: 3px; }
  .field label {
    font-size: 10px; font-weight: 600; color: var(--text2);
    display: flex; align-items: center; gap: 3px;
  }
  .field label .req { color: var(--danger); font-size: 9px; }
  .field input, .field select {
    width: 100%; padding: 5px 8px; border-radius: var(--r-sm);
    border: 1px solid var(--border); background: var(--bg-input);
    color: var(--text); font-size: 11.5px; font-family: inherit;
    outline: none; transition: border-color .15s;
  }
  .field input:focus, .field select:focus { border-color: var(--accent); }
  .field input::placeholder { color: var(--text3); opacity: .7; }
  .field-row { display: flex; gap: 8px; }
  .field-row .field { flex: 1; }
  .quick-presets { display: flex; gap: 3px; flex-wrap: wrap; margin-top: 3px; }
  .qp-chip {
    padding: 2px 7px; border-radius: 10px; font-size: 9.5px;
    cursor: pointer; border: 1px solid var(--border-subtle);
    background: transparent; color: var(--text2); transition: all .15s;
  }
  .qp-chip:hover { border-color: var(--accent); color: var(--accent); }
  .test-btn {
    padding: 6px 12px; border-radius: var(--r-sm); font-size: 11px;
    cursor: pointer; border: 1px solid var(--accent); background: transparent;
    color: var(--accent); transition: all .15s; text-align: center;
  }
  .test-btn:hover { background: var(--accent); color: var(--btn-text); }
  .test-btn.testing { opacity: .6; pointer-events: none; }
  .test-result {
    font-size: 10.5px; padding: 6px 10px; border-radius: var(--r-sm);
    display: none; align-items: center; gap: 5px;
  }
  .test-result.show { display: flex; }
  .test-result.ok { background: rgba(78,201,112,.1); color: var(--success); border: 1px solid rgba(78,201,112,.3); }
  .test-result.fail { background: rgba(241,76,76,.1); color: var(--danger); border: 1px solid rgba(241,76,76,.3); }
  .form-actions {
    display: flex; gap: 6px; padding: 8px 0 2px;
  }
  .btn {
    padding: 5px 14px; border-radius: var(--r-sm); font-size: 11px;
    cursor: pointer; border: 1px solid var(--border); background: transparent;
    color: var(--text2); transition: all .15s;
  }
  .btn:hover { background: var(--bg-hover); color: var(--text); }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: var(--btn-text); }
  .btn.primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); }

  /* ─── 模型卡片列表 ─── */
  .model-card {
    background:var(--bg-card); border:1px solid var(--border-subtle);
    border-radius:var(--r-md); padding:8px 10px;
    transition:border-color .15s;
  }
  .model-card:hover { border-color:var(--border); }
  .model-card.default { border-color:var(--accent); }
  .saved-models-heading { display:flex; align-items:center; justify-content:space-between; gap:8px; }
  .saved-models-heading .form-section-title { margin:0; }
  #btnAddModel { flex:0 0 auto; padding:2px 7px; font-size:10px; }
  .card-row { display:flex; align-items:center; justify-content:space-between; gap:6px; }
  .card-name { font-size:12px; font-weight:600; display:flex; align-items:center; gap:5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .default-badge { font-size:9px; padding:1px 5px; border-radius:8px; background:rgba(78,201,112,.15); color:var(--success); border:1px solid rgba(78,201,112,.3); flex-shrink:0; }
  .card-model { font-size:10.5px; color:var(--text2); margin-top:3px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family:var(--vscode-editor-font-family, Consolas, monospace); }
  .card-meta { font-size: 9.5px; color: var(--text3); margin-top: 2px; }
  .card-actions { display:flex; gap:2px; margin-top:6px; }
  .act-btn { padding:2px 7px; border:1px solid var(--border-subtle); border-radius:var(--r-sm); background:transparent; color:var(--text2); font-size:10px; cursor:pointer; transition:all .15s; }
  .act-btn:hover { border-color:var(--accent); color:var(--accent); }
  .act-btn.danger:hover { border-color:var(--danger); color:var(--danger); }
  .act-btn.set-default:hover { border-color:var(--success); color:var(--success); }

  /* ─── 工作区卡片 ─── */
  .workspace-overview { padding:10px 12px 0; flex-shrink:0; }
  .workspace-scroll { flex:1; min-height:0; overflow-y:auto; }
  .workspace-scroll > .list { flex:none; overflow:visible; }
  .workspace-sessions { padding:0 12px 14px; }
  .workspace-sessions.hidden { display:none; }
  .workspace-sessions-head { display:flex; align-items:center; justify-content:space-between; padding:8px 1px 6px; border-top:1px solid var(--border-subtle); color:var(--text2); font-size:10px; font-weight:650; }
  .workspace-sessions .list { padding:0; overflow:visible; }
  .overview-strip { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:6px; }
  .overview-stat { padding:8px 9px; background:var(--bg-card); border:1px solid var(--border-subtle); border-radius:var(--r-md); }
  .overview-value { font-size:16px; line-height:1; font-weight:700; font-variant-numeric:tabular-nums; }
  .overview-label { margin-top:4px; font-size:9.5px; color:var(--text2); }
  .section-label { padding:2px 1px 0; color:var(--text2); font-size:9.5px; font-weight:650; letter-spacing:.04em; }
  .ws-card {
    background:var(--bg-card); border:1px solid var(--border-subtle);
    border-radius:var(--r-md); padding:10px;
    transition:border-color .15s, background .15s, transform .15s; cursor:pointer;
  }
  .ws-card:hover { border-color:var(--border); background:var(--bg-hover); }
  .ws-card:active { transform:scale(.995); }
  .ws-card.active { border-color:var(--accent); box-shadow:inset 3px 0 0 var(--accent); }
  .ws-card .ws-row { display:flex; align-items:flex-start; gap:8px; }
  .ws-card .ws-icon { width:24px; height:24px; display:flex; align-items:center; justify-content:center; border-radius:var(--r-sm); background:var(--bg-hover); flex-shrink:0; }
  .ws-copy { min-width:0; flex:1; }
  .ws-card .ws-name { font-size:12px; font-weight:650; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .ws-status { flex-shrink:0; font-size:9px; color:var(--text2); }
  .ws-status.active { color:var(--success); }
  .ws-card .ws-path { font-size:10px; color:var(--text2); margin-top:3px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .ws-card .ws-footer { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-top:9px; padding-top:7px; border-top:1px solid var(--border-subtle); color:var(--text3); font-size:9.5px; }
  .inline-actions { display:flex; gap:3px; }
  .inline-actions .act-btn { padding:2px 6px; }

  /* ─── 会话列表 ─── */
  .session-group { margin-bottom: 4px; }
  .sg-header {
    font-size:10.5px; font-weight:600; color:var(--text2);
    padding: 6px 4px 4px; display:flex; align-items:center; gap:5px;
    text-transform:uppercase; letter-spacing:.3px;
  }
  .sg-header .sg-count { font-size:9px; color:var(--text3); font-weight:400; }
  .session-item {
    display:flex; align-items:center; gap:6px;
    padding:5px 8px; border-radius:var(--r-sm);
    background:var(--bg-card); border:1px solid var(--border-subtle);
    cursor:pointer; transition:border-color .15s;
  }
  .session-item:hover { border-color:var(--border); }
  .session-item .si-icon { font-size:12px; flex-shrink:0; }
  .session-item .si-title { flex:1; font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .session-item .si-time { font-size:9px; color:var(--text3); flex-shrink:0; }

  /* ─── 角色列表 ─── */
  .role-toolbar { display:flex; gap:6px; padding:10px 12px 0; flex-shrink:0; }
  .role-search { flex:1; min-width:0; padding:6px 8px; border:1px solid var(--border); border-radius:var(--r-sm); background:var(--bg-input); color:var(--text); font:inherit; outline:none; }
  .role-search:focus { border-color:var(--accent); }
  .role-summary { padding:7px 12px 0; color:var(--text2); font-size:10px; flex-shrink:0; }
  .role-group { margin-bottom: 4px; }
  .rg-header {
    font-size:10px; font-weight:650; color:var(--text2);
    padding: 6px 1px 5px; display:flex; align-items:center; gap:5px;
  }
  .rg-header .rg-count { margin-left:auto; font-size:9px; color:var(--text3); font-weight:400; }
  .role-item {
    padding:9px 10px; border-radius:var(--r-md);
    background:var(--bg-card); border:1px solid var(--border-subtle);
    cursor:pointer; transition:border-color .15s, background .15s;
  }
  .role-item + .role-item { margin-top:5px; }
  .role-item:hover { border-color:var(--border); background:var(--bg-hover); }
  .role-main { display:flex; align-items:flex-start; gap:8px; }
  .role-item .ri-icon { width:26px; height:26px; display:flex; align-items:center; justify-content:center; font-size:14px; border-radius:var(--r-sm); background:var(--bg-hover); flex-shrink:0; }
  .role-copy { min-width:0; flex:1; }
  .role-name-row { display:flex; align-items:center; gap:5px; }
  .role-item .ri-name { min-width:0; font-size:11.5px; font-weight:650; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .role-item .ri-tag { font-size:8.5px; color:var(--text3); flex-shrink:0; }
  .role-desc { margin-top:3px; color:var(--text2); font-size:10px; line-height:1.4; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
  .role-footer { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-top:8px; }
  .skill-list { min-width:0; display:flex; gap:3px; overflow:hidden; }
  .skill-chip { max-width:88px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; padding:1px 5px; border:1px solid var(--border-subtle); border-radius:8px; color:var(--text3); font-size:8.5px; }
  .role-actions { flex-shrink:0; display:flex; gap:3px; }

  /* ─── 会话模型选择区 ─── */
  .sessions-section { flex-shrink:0; border-top:1px solid var(--border-subtle); background:var(--bg); display:flex; flex-direction:column; max-height:45%; }
  .sessions-header { padding:8px 12px 6px; display:flex; align-items:center; justify-content:space-between; }
  .sessions-header h3 { font-size:11px; font-weight:600; color:var(--text2); text-transform:uppercase; letter-spacing:.4px; display:flex; align-items:center; gap:4px; }
  .sessions-header .s-count { font-size:10px; color:var(--text3); font-weight:400; }
  .sessions-list { overflow-y:auto; padding:0 10px 8px; display:flex; flex-direction:column; gap:4px; }
  .sessions-list::-webkit-scrollbar { width:5px; }
  .sessions-list::-webkit-scrollbar-thumb { background:var(--border); border-radius:3px; }
  .session-row { display:flex; align-items:center; gap:6px; padding:5px 8px; background:var(--bg-card); border:1px solid var(--border-subtle); border-radius:var(--r-sm); transition:border-color .15s; }
  .session-row:hover { border-color:var(--border); }
  .session-row .s-ico { font-size:12px; flex-shrink:0; }
  .session-row .s-name { flex:1; font-size:11px; color:var(--text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .session-row select { flex-shrink:0; max-width:42%; padding:2px 4px; border-radius:var(--r-sm); border:1px solid var(--border-subtle); background:var(--bg-input); color:var(--text); font-size:10.5px; font-family:inherit; outline:none; cursor:pointer; transition:border-color .15s; }
  .session-row select:hover { border-color:var(--accent); }
  .sessions-empty { padding:10px 12px; font-size:10.5px; color:var(--text3); text-align:center; }

  /* ─── 空状态 ─── */
  .empty { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; color:var(--text3); text-align:center; gap:8px; padding:30px 16px; }
  .empty .eico { font-size:32px; opacity:.4; }
  .empty .ehint { font-size:11px; line-height:1.6; opacity:.8; }

  /* ─── 右键菜单 ─── */
  .ctx-menu {
    position:fixed; z-index:500; min-width:140px;
    background:var(--vscode-menu-background, var(--bg-card));
    border:1px solid var(--border); border-radius:var(--r-md);
    box-shadow:0 4px 20px rgba(0,0,0,.4); padding:4px;
    display:none; flex-direction:column; gap:1px;
  }
  .ctx-menu.show { display:flex; }
  .ctx-item {
    padding:5px 10px; border-radius:var(--r-sm); cursor:pointer;
    font-size:11px; color:var(--text); transition:background .1s;
    display:flex; align-items:center; gap:6px;
  }
  .ctx-item:hover { background:var(--accent); color:var(--btn-text); }
  .ctx-item.danger:hover { background:var(--danger); }
  .ctx-sep { height:1px; background:var(--border-subtle); margin:2px 0; }
</style>
</head>
<body>

<header class="header-area">
  <div class="header-title">
    <h1>AI Agent Coordinator</h1>
    <span class="header-version">v0.1.0</span>
  </div>
  <nav class="header-tabs" aria-label="侧边栏功能">
    <button class="header-tab active" type="button" data-tab="models">模型设置</button>
    <button class="header-tab" type="button" data-tab="workspaces">工作区</button>
    <button class="header-tab" type="button" data-tab="roles">角色库</button>
  </nav>
</header>

<!-- 内容区 -->
<main class="content">

  <!-- 模型设置面板（默认显示） -->
  <section class="panel show" id="panel-models">
    <div class="panel-header">
      <div class="panel-heading">
        <h2 id="modelFormTitle">默认模型配置</h2>
        <div class="panel-subtitle" id="modelFormHint">当前会话默认使用此档案；修改后点击保存配置。</div>
      </div>
    </div>
    <!-- 模型表单区 -->
    <div class="model-form" id="modelForm">
      <!-- 配置表单 -->
      <div class="form-section">
        <div class="form-section-title">配置信息</div>
        <div class="field">
          <label>档案名 <span class="req">*</span></label>
          <input type="text" id="fName" placeholder="如：GPT-5.6 Terra / DeepSeek V4 Pro">
        </div>
        <div class="field">
          <label>Base URL <span class="req">*</span></label>
          <input type="text" id="fBaseURL" placeholder="https://api.openai.com/v1">
        </div>
        <div class="field">
          <label>API Key <span class="req">*</span></label>
          <input type="password" id="fApiKey" placeholder="sk-...">
        </div>
      </div>

      <!-- 选项区 -->
      <div class="form-section">
        <div class="form-section-title">🔧 接口选项</div>
        <div class="field">
          <label>接口格式</label>
          <select id="fApiFormat">
            <option value="anthropic-messages">Anthropic Messages (/v1/messages)</option>
            <option value="chat-completions">Chat Completions (/chat/completions)</option>
            <option value="responses">Responses (/responses)</option>
          </select>
        </div>
        <div class="field">
          <label>模型选择</label>
          <input type="text" id="fModel" placeholder="gpt-5.6-terra">
          <div class="quick-presets" id="quickPresets"></div>
        </div>
      </div>

      <!-- 扩展参数区 -->
      <div class="form-section">
        <div class="form-section-title">⚡ 扩展参数</div>
        <div class="field">
          <label>思考强度</label>
          <select id="fThinking">
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="xhigh" selected>XHigh (默认)</option>
          </select>
        </div>
        <div class="field">
          <label>上下文窗口 (tokens)</label>
          <input type="number" id="fContextWindow" placeholder="1000000" value="1000000">
        </div>
        <div class="field">
          <label>Temperature</label>
          <input type="number" id="fTemp" min="0" max="2" step="0.1" placeholder="0.7">
        </div>
      </div>

      <!-- 测试连接 -->
      <div class="form-section">
        <div class="form-section-title">🔌 连接测试</div>
        <button class="test-btn" id="btnTest">测试模型连接</button>
        <div class="test-result" id="testResult"></div>
      </div>

      <!-- 操作按钮 -->
      <div class="form-actions">
        <button class="btn primary" id="btnSave">保存配置</button>
        <button class="btn" id="btnReset">恢复</button>
      </div>

      <!-- 已保存模型列表 -->
      <div class="saved-models-heading">
        <div class="form-section-title">已保存档案</div>
        <button class="act-btn" id="btnAddModel" type="button">新增档案</button>
      </div>
      <div class="list" id="modelList" style="display:none"></div>
    </div>

    <!-- 会话模型选择区 -->
    <div class="sessions-section" id="sessionsSection" style="display:none">
      <div class="sessions-header">
        <h3>🗂️ 会话模型</h3>
        <span class="s-count" id="sCount"></span>
      </div>
      <div class="sessions-list" id="sessionsList"></div>
    </div>
  </section>

  <!-- 工作区面板 -->
  <section class="panel" id="panel-workspaces">
    <div class="panel-header">
      <div class="panel-heading">
        <h2>工作区</h2>
        <div class="panel-subtitle">管理 AI 可读取的项目集合；当前项目承载会话与协调数据，AI 可同时分析全部已引入项目。</div>
      </div>
      <button class="btn-add" id="btnAddWs">添加</button>
    </div>
    <div class="workspace-scroll">
      <div class="workspace-overview" id="wsOverview"></div>
      <div class="list" id="wsList"></div>
      <div class="empty" id="wsEmpty" style="display:none">
        <div class="eico">▱</div>
        <div>还没有工作区</div>
        <div class="ehint">添加本地项目后，AI 会自动知道项目名称、路径和项目总数，并可跨项目读取相关文本文件。</div>
        <button class="btn primary" id="btnAddWsEmpty">添加工作区</button>
      </div>
      <div class="workspace-sessions" id="workspaceSessions">
        <div class="workspace-sessions-head"><span>当前工作区会话</span><span id="workspaceSessionCount">0</span></div>
        <div class="list" id="sessionList"></div>
        <div class="sessions-empty" id="sessionEmpty">暂无会话，从角色库选择角色开始协作。</div>
      </div>
    </div>
  </section>

  <!-- 角色库面板 -->
  <section class="panel" id="panel-roles">
    <div class="panel-header">
      <div class="panel-heading">
        <h2>角色库</h2>
        <div class="panel-subtitle">选择角色立即开始会话，或维护当前工作区的自定义角色。</div>
      </div>
      <button class="btn-add" id="btnAddRole">新增</button>
    </div>
    <div class="role-toolbar">
      <input class="role-search" id="roleSearch" type="search" placeholder="搜索角色、描述或技能" aria-label="搜索角色">
    </div>
    <div class="role-summary" id="roleSummary"></div>
    <div class="list" id="roleList"></div>
    <div class="empty" id="roleEmpty" style="display:none">
      <div class="eico">◇</div>
      <div id="roleEmptyTitle">没有匹配的角色</div>
      <div class="ehint" id="roleEmptyHint">调整搜索词，或新建一个自定义角色。</div>
    </div>
  </section>

</main>

<!-- 右键菜单 -->
<div class="ctx-menu" id="ctxMenu"></div>

<script>
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const QUICK_PRESETS = ${presetsJson};

  let curTab = 'models';
  let curWorkspaces = [];
  let curSessionGroups = [];
  let curRoleCategories = [];
  let curModels = [];
  let curDefaultModelId = '';
  let curSessionsForModel = [];
  let modelEditMode = 'edit';
  let modelEditId = null;
  let modelAdding = false;

  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function maskKey(k) {
    if (!k) return '<span style="color:var(--text3)">未设置</span>';
    if (k.length <= 8) return '••••';
    return esc(k.slice(0,4)) + '••••' + esc(k.slice(-4));
  }
  function fmtRelative(iso) {
    const d = Date.parse(iso); if (!d) return '';
    const diff = Date.now() - d;
    const min = Math.floor(diff / 60000);
    if (min < 1) return '刚刚';
    if (min < 60) return min + '分钟前';
    const hr = Math.floor(min / 60);
    if (hr < 24) return hr + '小时前';
    const day = Math.floor(hr / 24);
    if (day < 30) return day + '天前';
    return new Date(d).toLocaleDateString();
  }

  // ─── Tab 切换 ───
  function switchTab(tab) {
    curTab = tab;
    document.querySelectorAll('.header-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.panel').forEach(p => p.classList.toggle('show', p.id === 'panel-' + tab));
  }
  document.querySelectorAll('.header-tab').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // ─── 工作区渲染 ───
  function renderWorkspaces(items) {
    curWorkspaces = items || [];
    const listEl = $('wsList'), emptyEl = $('wsEmpty'), overviewEl = $('wsOverview');
    const active = curWorkspaces.find(w => w.isActive);
    overviewEl.innerHTML = '<div class="overview-strip">' +
      '<div class="overview-stat"><div class="overview-value">' + curWorkspaces.length + '</div><div class="overview-label">可读项目</div></div>' +
      '<div class="overview-stat"><div class="overview-value">' + (active ? active.name : '未选择') + '</div><div class="overview-label">当前项目</div></div>' +
      '</div>';
    if (curWorkspaces.length === 0) { overviewEl.style.display = 'none'; listEl.style.display = 'none'; emptyEl.style.display = 'flex'; $('workspaceSessions').classList.add('hidden'); return; }
    overviewEl.style.display = 'block'; listEl.style.display = 'flex'; emptyEl.style.display = 'none'; $('workspaceSessions').classList.remove('hidden');
    listEl.innerHTML = '<div class="section-label">已引入项目（AI 可跨项目读取）</div>' + curWorkspaces.map(w =>
      '<article class="ws-card' + (w.isActive ? ' active' : '') + '" data-id="' + esc(w.id) + '">' +
        '<div class="ws-row">' +
          '<span class="ws-icon">▱</span>' +
          '<div class="ws-copy"><div class="ws-name">' + esc(w.name) + '</div><div class="ws-path" title="' + esc(w.folderPath) + '">' + esc(w.folderPath) + '</div></div>' +
          '<span class="ws-status' + (w.isActive ? ' active' : '') + '">' + (w.isActive ? '当前项目' : '可读取') + '</span>' +
        '</div>' +
        '<div class="ws-footer"><span>' + (w.isActive ? w.sessionCount + ' 个会话' : (w.lastActiveAt ? '使用于 ' + fmtRelative(w.lastActiveAt) : '尚未使用')) + '</span>' +
          '<div class="inline-actions"><button class="act-btn" data-act="rename">重命名</button><button class="act-btn danger" data-act="delete">删除</button></div>' +
        '</div>' +
      '</article>'
    ).join('');
    listEl.querySelectorAll('.ws-card').forEach(el => {
      el.addEventListener('click', () => vscode.postMessage({ type:'switchWorkspace', id: el.dataset.id }));
      el.querySelectorAll('.act-btn').forEach(btn => btn.addEventListener('click', e => {
        e.stopPropagation();
        vscode.postMessage({ type: btn.dataset.act === 'rename' ? 'renameWorkspace' : 'removeWorkspace', id: el.dataset.id });
      }));
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showCtxMenu(e.clientX, e.clientY, [
          { label: '切换到此工作区', action: () => vscode.postMessage({ type:'switchWorkspace', id: el.dataset.id }) },
          { label: '重命名', action: () => vscode.postMessage({ type:'renameWorkspace', id: el.dataset.id }) },
          { sep: true },
          { label: '删除', danger: true, action: () => vscode.postMessage({ type:'removeWorkspace', id: el.dataset.id }) },
        ]);
      });
    });
  }

  // ─── 会话渲染 ───
  function renderSessions(groups) {
    curSessionGroups = groups || [];
    const listEl = $('sessionList'), emptyEl = $('sessionEmpty');
    const count = (groups || []).reduce((sum, group) => sum + group.sessions.length, 0);
    $('workspaceSessionCount').textContent = String(count);
    if (!groups || groups.length === 0) { listEl.style.display = 'none'; emptyEl.style.display = 'block'; return; }
    listEl.style.display = 'flex'; emptyEl.style.display = 'none';
    listEl.innerHTML = groups.map(g =>
      '<div class="session-group">' +
        '<div class="sg-header">' + esc(g.roleIcon) + ' ' + esc(g.roleName) + ' <span class="sg-count">' + g.sessions.length + '</span></div>' +
        g.sessions.map(s =>
          '<div class="session-item" data-id="' + esc(s.id) + '">' +
            '<span class="si-icon">💬</span>' +
            '<span class="si-title">' + esc(s.title) + '</span>' +
            '<span class="si-time">' + fmtRelative(s.updatedAt) + '</span>' +
          '</div>'
        ).join('') +
      '</div>'
    ).join('');
    listEl.querySelectorAll('.session-item').forEach(el => {
      el.addEventListener('click', () => vscode.postMessage({ type:'openSession', id: el.dataset.id }));
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showCtxMenu(e.clientX, e.clientY, [
          { label: '打开会话', action: () => vscode.postMessage({ type:'openSession', id: el.dataset.id }) },
          { sep: true },
          { label: '删除', danger: true, action: () => vscode.postMessage({ type:'deleteSession', id: el.dataset.id }) },
        ]);
      });
    });
  }

  // ─── 角色渲染 ───
  function renderRoles(categories) {
    curRoleCategories = categories || [];
    const query = $('roleSearch').value.trim().toLowerCase();
    const filtered = curRoleCategories.map(cat => ({
      ...cat,
      roles: cat.roles.filter(r => !query || [r.name, r.description, ...(r.skills || [])].join(' ').toLowerCase().includes(query)),
    })).filter(cat => cat.roles.length > 0);
    const total = curRoleCategories.reduce((sum, cat) => sum + cat.roles.length, 0);
    const visible = filtered.reduce((sum, cat) => sum + cat.roles.length, 0);
    $('roleSummary').textContent = query ? '找到 ' + visible + ' / ' + total + ' 个角色' : total + ' 个角色 · 点击卡片开始会话';
    const listEl = $('roleList'), emptyEl = $('roleEmpty');
    if (visible === 0) {
      const hasWorkspace = curWorkspaces.some(w => w.isActive);
      $('roleEmptyTitle').textContent = hasWorkspace ? (query ? '没有匹配的角色' : '当前工作区暂无角色') : '请先添加工作区';
      $('roleEmptyHint').textContent = hasWorkspace ? (query ? '调整搜索词，或新建一个自定义角色。' : '新建自定义角色，或检查工作区角色配置。') : '角色库按工作区隔离，添加工作区后即可使用。';
      listEl.style.display = 'none'; emptyEl.style.display = 'flex'; return;
    }
    listEl.style.display = 'flex'; emptyEl.style.display = 'none';
    listEl.innerHTML = filtered.map(cat =>
      '<section class="role-group">' +
        '<div class="rg-header"><span>' + esc(cat.icon) + '</span><span>' + esc(cat.label) + '</span><span class="rg-count">' + cat.roles.length + '</span></div>' +
        cat.roles.map(r => {
          const skills = (r.skills || []).slice(0, 3).map(skill => '<span class="skill-chip">' + esc(skill) + '</span>').join('');
          return '<article class="role-item" data-id="' + esc(r.id) + '" data-builtin="' + r.builtIn + '">' +
            '<div class="role-main"><span class="ri-icon">' + esc(r.icon) + '</span><div class="role-copy">' +
              '<div class="role-name-row"><span class="ri-name">' + esc(r.name) + '</span><span class="ri-tag">' + (r.builtIn ? '内置' : '自定义') + '</span></div>' +
              '<div class="role-desc">' + esc(r.description || '暂无角色说明') + '</div>' +
            '</div></div>' +
            '<div class="role-footer"><div class="skill-list">' + skills + '</div><div class="role-actions">' +
              '<button class="act-btn" data-act="start">开始</button><button class="act-btn" data-act="edit">编辑</button>' +
              (r.builtIn ? '' : '<button class="act-btn danger" data-act="delete">删除</button>') +
            '</div></div>' +
          '</article>';
        }).join('') +
      '</section>'
    ).join('');
    listEl.querySelectorAll('.role-item').forEach(el => {
      el.addEventListener('click', () => vscode.postMessage({ type:'startSession', roleId: el.dataset.id }));
      el.querySelectorAll('.act-btn').forEach(btn => btn.addEventListener('click', e => {
        e.stopPropagation();
        const type = btn.dataset.act === 'start' ? 'startSession' : btn.dataset.act === 'edit' ? 'editRole' : 'deleteRole';
        vscode.postMessage({ type, roleId: el.dataset.id });
      }));
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const isBuiltin = el.dataset.builtin === 'true';
        const items = [
          { label: '开始会话', action: () => vscode.postMessage({ type:'startSession', roleId: el.dataset.id }) },
          { label: '编辑角色', action: () => vscode.postMessage({ type:'editRole', roleId: el.dataset.id }) },
        ];
        if (!isBuiltin) { items.push({ sep: true }); items.push({ label: '删除角色', danger: true, action: () => vscode.postMessage({ type:'deleteRole', roleId: el.dataset.id }) }); }
        showCtxMenu(e.clientX, e.clientY, items);
      });
    });
  }

  // ─── 模型渲染 ───
  function renderModels(models, defaultId, sessions) {
    curModels = models || []; curDefaultModelId = defaultId || ''; curSessionsForModel = sessions || [];
    const listEl = $('modelList');
    if (!models || models.length === 0) { listEl.style.display = 'none'; }
    else {
      listEl.style.display = 'flex';
      listEl.innerHTML = models.map(m => {
        const isDef = m.id === defaultId;
        return '<div class="model-card' + (isDef ? ' default' : '') + '" data-id="' + esc(m.id) + '" role="button" tabindex="0">' +
          '<div class="card-row"><div class="card-name">' + esc(m.name) + (isDef ? '<span class="default-badge">默认</span>' : '') + '</div></div>' +
          '<div class="card-model">' + esc(m.model) + ' · ' + maskKey(m.apiKey) + '</div>' +
          '<div class="card-meta">' + esc(normalizeModelFormat(m.apiFormat)) + ' · ' + esc(m.thinkingStrength || 'xhigh') + ' · ' + (m.contextWindow || 1000000) + ' tokens' + '</div>' +
          '<div class="card-actions">' +
            (isDef ? '<span class="card-current">当前配置</span>' : '<button class="act-btn set-default" data-act="default" data-id="' + m.id + '">切换使用</button>') +
            '<button class="act-btn danger" data-act="delete" data-id="' + m.id + '">删除</button>' +
          '</div>' +
        '</div>';
      }).join('');
      listEl.querySelectorAll('.act-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const act = btn.dataset.act, id = btn.dataset.id;
          if (act === 'default') {
            modelAdding = false;
            vscode.postMessage({ type:'setDefaultModel', id });
          } else if (act === 'delete') vscode.postMessage({ type:'deleteModel', id });
        });
      });
      listEl.querySelectorAll('.model-card').forEach(card => {
        const activate = () => {
          const id = card.dataset.id;
          modelAdding = false;
          openModelEdit(id);
          if (id !== curDefaultModelId) vscode.postMessage({ type:'setDefaultModel', id });
        };
        card.addEventListener('click', activate);
        card.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
        });
      });
    }
    if (!models || models.length === 0) startAddModel();
    else if (!modelAdding) openModelEdit(defaultId || models[0].id);
    renderSessionModelSelect(sessions);
  }

  function renderSessionModelSelect(sessions) {
    const sec = $('sessionsSection');
    if (!sessions || sessions.length === 0) { sec.style.display = 'none'; return; }
    sec.style.display = 'flex';
    $('sCount').textContent = String(sessions.length);
    const def = curModels.find(m => m.id === curDefaultModelId);
    const defLabel = def ? def.name : '默认';
    $('sessionsList').innerHTML = sessions.map(s => {
      const opts = curModels.map(m => '<option value="' + esc(m.id) + '"' + (m.id === s.modelId ? ' selected' : '') + '>' + esc(m.name) + '</option>').join('');
      return '<div class="session-row">' +
        '<span class="s-ico">' + esc(s.roleIcon) + '</span>' +
        '<span class="s-name" title="' + esc(s.title) + '">' + esc(s.title) + '</span>' +
        '<select data-sid="' + esc(s.id) + '"><option value=""' + (!s.modelId ? ' selected' : '') + '>默认（' + esc(defLabel) + '）</option>' + opts + '</select>' +
      '</div>';
    }).join('');
    $('sessionsList').querySelectorAll('select').forEach(sel => {
      sel.addEventListener('change', () => vscode.postMessage({ type:'setSessionModel', sessionId: sel.dataset.sid, modelId: sel.value }));
    });
  }

  // ─── 右键菜单 ───
  function showCtxMenu(x, y, items) {
    const menu = $('ctxMenu');
    menu.innerHTML = items.map(it => {
      if (it.sep) return '<div class="ctx-sep"></div>';
      return '<div class="ctx-item' + (it.danger ? ' danger' : '') + '">' + esc(it.label) + '</div>';
    }).join('');
    let idx = 0;
    menu.querySelectorAll('.ctx-item').forEach(el => {
      const item = items.filter(i => !i.sep)[idx++];
      el.addEventListener('click', () => { hideCtxMenu(); item.action(); });
    });
    menu.style.left = x + 'px'; menu.style.top = y + 'px';
    menu.classList.add('show');
  }
  function hideCtxMenu() { $('ctxMenu').classList.remove('show'); }
  document.addEventListener('click', hideCtxMenu);

  // ─── 模型表单 ───
  function renderQuickPresets() {
    $('quickPresets').innerHTML = QUICK_PRESETS.map((p,i) => '<span class="qp-chip" data-i="' + i + '">' + esc(p.name) + '</span>').join('');
    $('quickPresets').querySelectorAll('.qp-chip').forEach(c => {
      c.addEventListener('click', () => {
        const p = QUICK_PRESETS[Number(c.dataset.i)];
        if ($('fName').value.trim() === '') $('fName').value = p.name;
        $('fModel').value = p.model;
        $('fBaseURL').value = p.baseURL;
        $('fApiFormat').value = p.apiFormat;
      });
    });
  }

  function normalizeModelFormat(format) {
    if (format === 'anthropic' || format === 'anthropic-messages') return 'anthropic-messages';
    if (format === 'responses') return 'responses';
    return 'chat-completions';
  }

  function startAddModel() {
    modelAdding = true;
    modelEditMode = 'add'; modelEditId = null;
    $('modelFormTitle').textContent = '新增模型配置';
    $('modelFormHint').textContent = '填写新档案；保存后可在下方切换为默认配置。';
    $('btnSave').textContent = '添加配置';
    $('fName').value = ''; $('fApiKey').value = '';
    $('fBaseURL').value = 'https://api.openai.com/v1';
    $('fModel').value = 'gpt-5.6-terra';
    $('fApiFormat').value = 'responses';
    $('fThinking').value = 'xhigh';
    $('fContextWindow').value = '1000000';
    $('fTemp').value = '0.7';
    $('testResult').classList.remove('show', 'ok', 'fail');
    $('fName').focus();
  }

  function resetForm() {
    if (modelAdding || curModels.length === 0) startAddModel();
    else openModelEdit(curDefaultModelId || curModels[0].id);
  }

  function openModelEdit(id) {
    const m = curModels.find(x => x.id === id); if (!m) return;
    modelAdding = false;
    modelEditMode = 'edit'; modelEditId = id;
    $('modelFormTitle').textContent = '默认模型配置';
    $('modelFormHint').textContent = '当前会话默认使用“' + (m.name || '') + '”；修改后点击保存配置。';
    $('btnSave').textContent = '保存配置';
    $('fName').value = m.name || '';
    $('fApiKey').value = m.apiKey || '';
    $('fBaseURL').value = m.baseURL || '';
    $('fModel').value = m.model || '';
    $('fApiFormat').value = normalizeModelFormat(m.apiFormat);
    $('fThinking').value = m.thinkingStrength || 'xhigh';
    $('fContextWindow').value = String(m.contextWindow || 1000000);
    $('fTemp').value = m.temperature !== undefined ? String(m.temperature) : '0.7';
    $('testResult').classList.remove('show', 'ok', 'fail');
  }

  function saveModel() {
    const data = {
      name: $('fName').value,
      apiKey: $('fApiKey').value,
      baseURL: $('fBaseURL').value,
      model: $('fModel').value,
      apiFormat: $('fApiFormat').value,
      thinkingStrength: $('fThinking').value,
      contextWindow: $('fContextWindow').value,
      temperature: $('fTemp').value,
    };
    if (!data.name.trim()) { $('fName').focus(); return; }
    if (!data.apiKey.trim()) { $('fApiKey').focus(); return; }
    if (!data.baseURL.trim()) { $('fBaseURL').focus(); return; }
    modelAdding = false;
    if (modelEditMode === 'add') vscode.postMessage({ type:'addModel', preset:data });
    else vscode.postMessage({ type:'updateModel', id:modelEditId, patch:data });
  }

  function testConnection() {
    const data = {
      name: $('fName').value,
      apiKey: $('fApiKey').value,
      baseURL: $('fBaseURL').value,
      model: $('fModel').value || 'gpt-5.6-terra',
      apiFormat: $('fApiFormat').value,
    };
    if (!data.baseURL.trim() || !data.apiKey.trim()) {
      const tr = $('testResult');
      tr.className = 'test-result show fail';
      tr.textContent = '⚠ Base URL 和 API Key 不能为空';
      return;
    }
    $('btnTest').classList.add('testing');
    $('btnTest').textContent = '测试中...';
    const tr = $('testResult');
    tr.classList.remove('show', 'ok', 'fail');
    vscode.postMessage({ type:'testConnection', data });
  }

  // ─── 事件绑定 ───
  $('btnAddWs').addEventListener('click', () => vscode.postMessage({ type:'addWorkspace' }));
  $('btnAddWsEmpty').addEventListener('click', () => vscode.postMessage({ type:'addWorkspace' }));
  $('btnAddRole').addEventListener('click', () => vscode.postMessage({ type:'addRole' }));
  $('roleSearch').addEventListener('input', () => renderRoles(curRoleCategories));
  $('btnAddModel').addEventListener('click', startAddModel);
  $('btnSave').addEventListener('click', saveModel);
  $('btnReset').addEventListener('click', resetForm);
  $('btnTest').addEventListener('click', testConnection);
  renderQuickPresets();

  // ─── 消息处理 ───
  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg.type === 'workspaces') renderWorkspaces(msg.items);
    else if (msg.type === 'sessions') renderSessions(msg.groups);
    else if (msg.type === 'roles') renderRoles(msg.categories);
    else if (msg.type === 'models') renderModels(msg.models, msg.defaultId, msg.sessions);
    else if (msg.type === 'testResult') {
      $('btnTest').classList.remove('testing');
      $('btnTest').textContent = '测试模型连接';
      const tr = $('testResult');
      tr.className = 'test-result show ' + (msg.success ? 'ok' : 'fail');
      tr.textContent = (msg.success ? '✅ ' : '❌ ') + (msg.message || '');
    }
  });

  vscode.postMessage({ type:'ready' });
</script>
</body>
</html>`;
  }
}
