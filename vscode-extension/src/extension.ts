// ============================================================
// extension.ts — 插件入口
// 布局：左侧活动栏（统一侧边栏 Webview）+ 底部面板（Coordinator 控制台 Webview）
// 控制台与 TERMINAL/OUTPUT 并排，点击角色即在底部开新会话标签
// ============================================================
import * as vscode from 'vscode';
import { CoordinatorContext } from './backend/coordinator-context';
import { SidebarViewProvider } from './ui/sidebar-view';
import { ConsoleViewProvider } from './panel/console-provider';
import { ChatPanel } from './ui/chat-panel';
import { registerCommands } from './commands';

let ctx: CoordinatorContext | undefined;

export async function activate(context: vscode.ExtensionContext) {
  console.log('[Coordinator] Activating AI Agent Coordinator...');

  try {
    // 1. 初始化后端（双库 + sql.js + 模型库）
    ctx = new CoordinatorContext(context.extensionUri.fsPath, context);
    await ctx.activate();

    // 2. 创建统一侧边栏 Provider
    const sidebarProvider = new SidebarViewProvider(ctx);

    // 3. 创建底部面板控制台 Provider
    const consoleProvider = new ConsoleViewProvider(ctx);

    // 4. 注册侧边栏 + 底部面板 Webview
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(
        SidebarViewProvider.VIEW_ID,
        sidebarProvider,
        { webviewOptions: { retainContextWhenHidden: true } }
      ),
      vscode.window.registerWebviewViewProvider(
        ConsoleViewProvider.VIEW_ID,
        consoleProvider,
        { webviewOptions: { retainContextWhenHidden: true } }
      ),
    );

    // 5. 绑定引用到 context
    ctx.setConsoleProvider(consoleProvider);
    ctx.setSidebarProvider(sidebarProvider);

    // 6. 注册命令
    const disposables = registerCommands(ctx, sidebarProvider);
    context.subscriptions.push(...disposables);

    // 8. openPanel：聚焦底部控制台 Tab
    context.subscriptions.push(
      vscode.commands.registerCommand('coordinator.openPanel', () => {
        vscode.commands.executeCommand(`${ConsoleViewProvider.VIEW_ID}.focus`);
      }),
    );

    // 8. 监听工作区切换 & LLM 配置变更
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration('coordinator.llm.apiKey') ||
          e.affectsConfiguration('coordinator.llm.baseURL') ||
          e.affectsConfiguration('coordinator.llm.model')
        ) {
          sidebarProvider.refresh();
        }
      }),
    );

    // 工作区切换时刷新侧边栏 + 控制台
    ctx.onDidSwitchWorkspace(() => {
      sidebarProvider.refresh();
      consoleProvider.refresh();
    });

    // 会话增删时刷新侧边栏
    ctx.onDidSessionsChange(() => {
      sidebarProvider.refreshSessions();
      sidebarProvider.refreshWorkspaces();
    });

    // 模型库变更时刷新侧边栏 + 控制台模型显示
    sidebarProvider.onDidChangeModels(() => {
      consoleProvider.refreshModels();
      ChatPanel.refreshAllModels();
    });

    console.log('[Coordinator] ✅ Ready — unified sidebar + bottom panel console active');
  } catch (err) {
    console.error('[Coordinator] ❌ Activation failed:', err);
    vscode.window.showErrorMessage(`Coordinator 初始化失败: ${(err as Error).message}`);
  }
}

export function deactivate() {
  console.log('[Coordinator] Deactivating...');
  ctx?.dispose();
}
