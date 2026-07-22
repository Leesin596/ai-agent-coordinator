// ============================================================
// 命令注册 — 连接 CoordinatorContext 与 UI
// ============================================================
import * as vscode from 'vscode';
import type { CoordinatorContext } from '../backend/coordinator-context';
import type { SidebarViewProvider } from '../ui/sidebar-view';
import type { Role } from '../../../src/models/types';
import { ChatPanel } from '../ui/chat-panel';
import { TaskCenterPanel } from '../ui/task-center-panel';
import { DispatchPanel } from '../ui/dispatch-panel';

export function registerCommands(
  ctx: CoordinatorContext,
  sidebar: SidebarViewProvider,
): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];
  const maxContextBytes = 200_000;

  const formatDocumentContext = (
    document: vscode.TextDocument,
    selection?: vscode.Selection,
  ): string => {
    const hasSelection = selection && !selection.isEmpty;
    const content = hasSelection ? document.getText(selection) : document.getText();
    const startLine = hasSelection ? selection.start.line + 1 : 1;
    const endLine = hasSelection
      ? Math.max(startLine, selection.end.line + (selection.end.character === 0 ? 0 : 1))
      : document.lineCount;
    const relativePath = vscode.workspace.asRelativePath(document.uri, false).replace(/\\/g, '/');
    const longestFence = Math.max(2, ...Array.from(content.matchAll(/`+/g), (match) => match[0].length));
    const fence = '`'.repeat(longestFence + 1);
    return `@${relativePath}:L${startLine}-L${endLine}\n${fence}${document.languageId}\n${content}\n${fence}`;
  };

  const appendDocumentContext = async (
    document: vscode.TextDocument,
    selection?: vscode.Selection,
  ): Promise<void> => {
    if (!vscode.workspace.getWorkspaceFolder(document.uri)) {
      vscode.window.showWarningMessage('只能添加当前工作区内的文件');
      return;
    }
    const content = selection && !selection.isEmpty ? document.getText(selection) : document.getText();
    if (Buffer.byteLength(content, 'utf8') > maxContextBytes) {
      vscode.window.showWarningMessage(selection && !selection.isEmpty
        ? '选中内容超过 200 KB，请缩小代码范围'
        : '文件超过 200 KB，请先选择需要的代码片段');
      return;
    }
    await ctx.getConsoleProvider()?.appendContextToInput(formatDocumentContext(document, selection));
  };

  const appendUriContext = async (uri: vscode.Uri): Promise<void> => {
    if (!vscode.workspace.getWorkspaceFolder(uri)) {
      vscode.window.showWarningMessage('只能添加当前工作区内的文件');
      return;
    }
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > maxContextBytes) {
        vscode.window.showWarningMessage('文件超过 200 KB，请在编辑器中选择需要的代码片段');
        return;
      }
      await appendDocumentContext(await vscode.workspace.openTextDocument(uri));
    } catch (error) {
      vscode.window.showErrorMessage(`无法读取所选文件: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  disposables.push(
    vscode.commands.registerCommand('coordinator.addEditorContext', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage('请先打开一个项目文件');
        return;
      }
      await appendDocumentContext(editor.document, editor.selection);
    }),
    vscode.commands.registerCommand('coordinator.addFileContext', async (uri?: vscode.Uri) => {
      const target = uri || vscode.window.activeTextEditor?.document.uri;
      if (!target) {
        vscode.window.showWarningMessage('请选择一个项目文件');
        return;
      }
      await appendUriContext(target);
    }),
    vscode.commands.registerCommand('coordinator.pickContext', async () => {
      const editor = vscode.window.activeTextEditor;
      const choices: Array<{ label: string; description?: string; action: 'selection' | 'file' | 'pick' }> = [];
      if (editor && !editor.selection.isEmpty) {
        choices.push({
          label: '$(selection) 当前选中代码',
          description: `${vscode.workspace.asRelativePath(editor.document.uri, false)}:${editor.selection.start.line + 1}-${editor.selection.end.line + 1}`,
          action: 'selection',
        });
      }
      if (editor) {
        choices.push({
          label: '$(file-code) 当前文件',
          description: vscode.workspace.asRelativePath(editor.document.uri, false),
          action: 'file',
        });
      }
      choices.push({ label: '$(folder-opened) 选择项目文件...', action: 'pick' });
      const choice = await vscode.window.showQuickPick(choices, { placeHolder: '添加代码上下文到当前输入框' });
      if (!choice) return;
      if (choice.action === 'selection' && editor) {
        await appendDocumentContext(editor.document, editor.selection);
        return;
      }
      if (choice.action === 'file' && editor) {
        await appendDocumentContext(editor.document);
        return;
      }
      const root = vscode.workspace.workspaceFolders?.[0]?.uri;
      const picked = await vscode.window.showOpenDialog({
        defaultUri: root,
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        openLabel: '添加到输入框',
      });
      if (picked?.[0]) await appendUriContext(picked[0]);
    }),
  );

  // ============================================================
  // 工作区命令
  // ============================================================

  disposables.push(
    vscode.commands.registerCommand('coordinator.addWorkspace', async () => {
      await ctx.addWorkspace();
      sidebar.refresh();
    }),
  );

  disposables.push(
    vscode.commands.registerCommand(
      'coordinator.switchWorkspace',
      async (node?: any) => {
        // 从 TreeView 点击：node 是 WorkspaceNode
        // 从状态栏点击：node 为空，弹出选择
        let id: string | undefined;
        if (node?.workspace?.id) {
          id = node.workspace.id;
        } else {
          const workspaces = ctx.listWorkspaces();
          if (workspaces.length === 0) {
            vscode.window.showInformationMessage('暂无工作区，请先添加');
            return;
          }
          const active = ctx.getActiveWorkspace();
          const pick = await vscode.window.showQuickPick(
            workspaces
              .sort((a, b) => {
                const ta = a.lastActiveAt ? Date.parse(a.lastActiveAt) : 0;
                const tb = b.lastActiveAt ? Date.parse(b.lastActiveAt) : 0;
                return tb - ta;
              })
              .map((ws) => ({
                label: ws.name + (ws.id === active?.id ? ' $(check)' : ''),
                description: ws.folderPath,
                id: ws.id,
              })),
            { placeHolder: '选择要切换到的工作区' },
          );
          id = pick?.id;
        }
        if (id) {
          await ctx.switchWorkspace(id);
          sidebar.refresh();
        }
      },
    ),
  );

  disposables.push(
    vscode.commands.registerCommand(
      'coordinator.removeWorkspace',
      async (node?: any) => {
        const id = node?.workspace?.id;
        if (!id) return;
        const ok = await ctx.removeWorkspace(id);
        if (ok) {
          sidebar.refresh();
        }
      },
    ),
  );

  disposables.push(
    vscode.commands.registerCommand(
      'coordinator.renameWorkspace',
      async (node?: any) => {
        const id = node?.workspace?.id;
        if (!id) return;
        const ok = await ctx.renameWorkspace(id);
        if (ok) sidebar.refresh();
      },
    ),
  );

  disposables.push(
    vscode.commands.registerCommand('coordinator.refreshWorkspaces', () => {
      sidebar.refreshWorkspaces();
    }),
  );

  // ============================================================
  // 角色库命令
  // ============================================================

  disposables.push(
    vscode.commands.registerCommand('coordinator.addRole', async () => {
      const runtime = await ctx.ensureActiveWorkspace();
      if (!runtime) return;
      await ctx.getConsoleProvider()?.showRoleEditor(undefined, true);
    }),
  );

  disposables.push(
    vscode.commands.registerCommand(
      'coordinator.editRole',
      async (node?: any) => {
        if (!ctx.getActiveRuntime()) {
          vscode.window.showWarningMessage('请先切换到工作区');
          return;
        }
        const role: Role | undefined = node?.role;
        await ctx.getConsoleProvider()?.showRoleEditor(role?.id);
      },
    ),
  );

  disposables.push(
    vscode.commands.registerCommand(
      'coordinator.deleteRole',
      async (node?: any) => {
        const runtime = ctx.getActiveRuntime();
        if (!runtime) return;
        const role: Role | undefined = node?.role;
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
        try {
          runtime.roleManager.delete(role.id);
          vscode.window.showInformationMessage(`已删除角色「${role.name}」`);
          sidebar.refreshRoles();
        } catch (err: any) {
          vscode.window.showErrorMessage(`删除角色失败: ${err.message}`);
        }
      },
    ),
  );

  disposables.push(
    vscode.commands.registerCommand('coordinator.refreshRoles', () => {
      sidebar.refreshRoles();
    }),
  );

  disposables.push(
    vscode.commands.registerCommand('coordinator.refreshBuiltInRoles', async () => {
      const runtime = await ctx.ensureActiveWorkspace();
      if (!runtime) return;
      const choice = await vscode.window.showWarningMessage(
        '将用当前插件内置版本覆盖所有内置角色的名称、能力、提示词和 Skill 工作手册。自定义角色不会被修改。',
        { modal: true },
        '刷新内置角色',
      );
      if (choice !== '刷新内置角色') return;
      const changed = runtime.roleManager.refreshBuiltInRoles();
      sidebar.refreshRoles();
      await ctx.getConsoleProvider()?.refresh();
      vscode.window.showInformationMessage(`已刷新 ${changed} 个内置角色，自定义角色保持不变`);
    }),
  );

  // ============================================================
  // 会话命令
  // ============================================================

  disposables.push(
    vscode.commands.registerCommand(
      'coordinator.startSession',
      async (node?: any) => {
        const runtime = await ctx.ensureActiveWorkspace();
        if (!runtime) return;
        const role: Role | undefined = node?.role;
        if (!role) {
          vscode.window.showWarningMessage('请从角色库中选择一个角色');
          return;
        }
        // 打开底部控制台并创建/聚焦该角色的会话
        const consoleProvider = ctx.getConsoleProvider();
        if (consoleProvider) {
          await consoleProvider.startSessionForRole(role);
        } else {
          await ChatPanel.open(ctx, runtime, role);
        }
      },
    ),
  );

  disposables.push(
    vscode.commands.registerCommand(
      'coordinator.openSession',
      async (node?: any) => {
        const runtime = ctx.getActiveRuntime();
        if (!runtime) {
          vscode.window.showWarningMessage('请先切换到工作区');
          return;
        }
        // 从会话树点击：node 带 session
        if (node?.session?.id) {
          const consoleProvider = ctx.getConsoleProvider();
          if (consoleProvider) {
            await consoleProvider.openSessionInPanel(node.session.id);
          }
          return;
        }
        // 从命令面板触发：弹出选择
        const sessions = runtime.sessionManager.list(runtime.workspace.id);
        if (sessions.length === 0) {
          vscode.window.showInformationMessage('暂无会话，请从角色库选择角色开会话');
          return;
        }
        const pick = await vscode.window.showQuickPick(
          sessions.map((s) => ({
            label: s.title,
            description: new Date(s.updatedAt).toLocaleString(),
            session: s,
          })),
          { placeHolder: '选择要打开的会话' },
        );
        if (!pick) return;
        const role = runtime.roleManager.get(pick.session.roleId);
        if (!role) {
          vscode.window.showErrorMessage('会话对应的角色已被删除');
          return;
        }
        const consoleProvider = ctx.getConsoleProvider();
        if (consoleProvider) {
          await consoleProvider.openSessionInPanel(pick.session.id);
        } else {
          await ChatPanel.open(ctx, runtime, role, pick.session);
        }
      },
    ),
  );

  disposables.push(
    vscode.commands.registerCommand('coordinator.listSessions', async () => {
      const runtime = ctx.getActiveRuntime();
      if (!runtime) return;
      const sessions = runtime.sessionManager.list(runtime.workspace.id);
      if (sessions.length === 0) {
        vscode.window.showInformationMessage('暂无会话');
        return;
      }
      const items = sessions.map((s) => {
        const role = runtime.roleManager.get(s.roleId);
        return `${role?.icon || '💬'} ${s.title} — ${new Date(s.updatedAt).toLocaleString()}`;
      });
      vscode.window.showInformationMessage(`共 ${sessions.length} 个会话:\n${items.join('\n')}`);
    }),
  );

  disposables.push(
    vscode.commands.registerCommand('coordinator.deleteSession', async (node?: any) => {
      const runtime = ctx.getActiveRuntime();
      if (!runtime) return;
      let sessionId: string | undefined;
      let sessionTitle: string | undefined;
      if (node?.session?.id) {
        sessionId = node.session.id;
        sessionTitle = node.session.title;
      } else {
        const sessions = runtime.sessionManager.list(runtime.workspace.id);
        if (sessions.length === 0) {
          vscode.window.showInformationMessage('暂无会话');
          return;
        }
        const pick = await vscode.window.showQuickPick(
          sessions.map((s) => ({
            label: s.title,
            description: new Date(s.createdAt).toLocaleDateString(),
            session: s,
          })),
          { placeHolder: '选择要删除的会话' },
        );
        if (!pick) return;
        sessionId = pick.session.id;
        sessionTitle = pick.session.title;
      }
      const choice = await vscode.window.showWarningMessage(
        `确定删除会话「${sessionTitle}」？所有消息将被删除。`,
        { modal: true },
        '删除',
      );
      if (choice !== '删除') return;
      if (!sessionId) return;
      ChatPanel.close(sessionId);
      runtime.sessionManager.delete(sessionId);
      sidebar.refreshSessions();
      vscode.window.showInformationMessage('会话已删除');
    }),
  );

  disposables.push(
    vscode.commands.registerCommand('coordinator.refreshSessions', () => {
      sidebar.refreshSessions();
    }),
  );

  // ============================================================
  // 会话任务派发命令
  // ============================================================

  disposables.push(
    vscode.commands.registerCommand('coordinator.openTaskCenter', async () => {
      const runtime = await ctx.ensureActiveWorkspace();
      if (!runtime) return;
      // 如果有激活的聊天面板，用它的 sessionId；否则让用户选
      let sessionId: string | undefined;
      // 尝试用 QuickPick 选会话
      const sessions = runtime.sessionManager.list(runtime.workspace.id);
      if (sessions.length === 0) {
        vscode.window.showInformationMessage('暂无会话，请先从角色库开会话');
        return;
      }
      const pick = await vscode.window.showQuickPick(
        sessions.map((s) => ({
          label: s.title,
          description: new Date(s.updatedAt).toLocaleString(),
          session: s,
        })),
        { placeHolder: '选择当前会话（用于过滤收件箱/已派发）' },
      );
      if (!pick) return;
      sessionId = pick.session.id;
      TaskCenterPanel.open(ctx, runtime, sessionId);
    }),
  );

  disposables.push(
    vscode.commands.registerCommand(
      'coordinator.dispatchTask',
      async (sessionId?: string) => {
        const runtime = await ctx.ensureActiveWorkspace();
        if (!runtime) return;
        let sid = sessionId;
        if (!sid) {
          const sessions = runtime.sessionManager.list(runtime.workspace.id);
          if (sessions.length === 0) {
            vscode.window.showInformationMessage('暂无会话，请先从角色库开会话');
            return;
          }
          const pick = await vscode.window.showQuickPick(
            sessions.map((s) => ({
              label: s.title,
              description: new Date(s.updatedAt).toLocaleString(),
              session: s,
            })),
            { placeHolder: '选择派发方会话（你当前的会话）' },
          );
          if (!pick) return;
          sid = pick.session.id;
        }
        DispatchPanel.open(ctx, runtime, sid);
      },
    ),
  );

  // ============================================================
  // Dashboard 命令（占位）
  // ============================================================

  disposables.push(
    vscode.commands.registerCommand('coordinator.rebuildIndex', async () => {
      const runtime = ctx.getActiveRuntime();
      if (!runtime) {
        vscode.window.showWarningMessage('请先切换到工作区');
        return;
      }
      const consoleProvider = ctx.getConsoleProvider();
      if (!consoleProvider || !consoleProvider.getIndexingService) {
        vscode.window.showWarningMessage('索引服务未初始化，请确保已配置模型预设');
        return;
      }
      const indexingService = consoleProvider.getIndexingService();
      if (!indexingService) {
        vscode.window.showWarningMessage('索引服务未初始化，请确保已配置模型预设的 API Key');
        return;
      }
      const choice = await vscode.window.showWarningMessage(
        '将重新索引整个代码库，可能需要几分钟。是否继续？',
        { modal: true },
        '重建索引',
      );
      if (choice !== '重建索引') return;

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: '重建代码索引',
          cancellable: false,
        },
        async (progress) => {
          let lastDone = 0;
          await indexingService.rebuildIndex((done: number, total: number) => {
            if (done > lastDone) {
              progress.report({
                message: `已索引 ${done}/${total} 文件`,
                increment: ((done - lastDone) / total) * 100,
              });
              lastDone = done;
            }
          });
          const status = indexingService.getStatus();
          vscode.window.showInformationMessage(
            `✅ 索引完成：${status.fileCount} 文件，${status.chunkCount} 代码块`,
          );
        },
      );
    }),
  );

  disposables.push(
    vscode.commands.registerCommand('coordinator.openDashboard', async () => {
      const runtime = await ctx.ensureActiveWorkspace();
      if (!runtime) return;
      const ws = ctx.getActiveWorkspace();
      const tasks = runtime.taskManager.list({ project: 'default' });
      const contracts = runtime.contractRegistry.list({ project: 'default' });
      const memories = runtime.memoryStore.list({ project: 'default' });

      const panel = vscode.window.createWebviewPanel(
        'coordinator-dashboard',
        `Coordinator — ${ws?.name ?? ''}`,
        vscode.ViewColumn.One,
        { enableScripts: true },
      );

      panel.webview.html = renderDashboard(ws?.name ?? '', tasks.length, contracts.length, memories.length);
    }),
  );

  return disposables;
}

// ============================================================
// 简易 Dashboard HTML（阶段四会替换为完整面板）
// ============================================================
function renderDashboard(wsName: string, taskCount: number, contractCount: number, memoryCount: number): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<style>
  body { font-family: var(--vscode-font-family); padding: 24px; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  h1 { font-size: 1.5em; margin-bottom: 8px; }
  .sub { color: var(--vscode-descriptionForeground); margin-bottom: 24px; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
  .card { background: var(--vscode-editor-inactive-selection-background); border-radius: 8px; padding: 20px; text-align: center; }
  .card .num { font-size: 2.5em; font-weight: 700; color: var(--vscode-textLink-foreground); }
  .card .label { color: var(--vscode-descriptionForeground); margin-top: 4px; }
</style>
</head>
<body>
  <h1>AI Agent Coordinator</h1>
  <div class="sub">工作区: ${wsName}</div>
  <div class="grid">
    <div class="card"><div class="num">${taskCount}</div><div class="label">任务</div></div>
    <div class="card"><div class="num">${contractCount}</div><div class="label">契约</div></div>
    <div class="card"><div class="num">${memoryCount}</div><div class="label">记忆</div></div>
  </div>
  <p style="margin-top:24px;color:var(--vscode-descriptionForeground)">完整面板将在后续阶段实现</p>
</body>
</html>`;
}
