// ============================================================
// WorkspaceTreeProvider — 工作区列表 TreeView
// ============================================================
import * as vscode from 'vscode';
import type { CoordinatorContext } from '../backend/coordinator-context';
import type { Workspace } from '../../../src/models/types';

export class WorkspaceTreeProvider
  implements vscode.TreeDataProvider<WorkspaceNode>
{
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(private ctx: CoordinatorContext) {}

  refresh(): void {
    this._onDidChange.fire();
  }

  getTreeItem(element: WorkspaceNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: WorkspaceNode): WorkspaceNode[] {
    if (element) return [];
    const workspaces = this.ctx.listWorkspaces();
    const active = this.ctx.getActiveWorkspace();
    const runtime = this.ctx.getActiveRuntime();

    return workspaces
      .sort((a, b) => {
        const ta = a.lastActiveAt ? Date.parse(a.lastActiveAt) : 0;
        const tb = b.lastActiveAt ? Date.parse(b.lastActiveAt) : 0;
        return tb - ta;
      })
      .map((ws) => {
        let sessionCount = 0;
        if (runtime && ws.id === active?.id) {
          sessionCount = runtime.sessionManager.list(ws.id).length;
        }
        return new WorkspaceNode(ws, ws.id === active?.id, sessionCount);
      });
  }
}

export class WorkspaceNode extends vscode.TreeItem {
  constructor(
    public readonly workspace: Workspace,
    isActive: boolean,
    sessionCount: number,
  ) {
    super(workspace.name, vscode.TreeItemCollapsibleState.None);

    this.id = workspace.id;
    this.contextValue = 'workspace';

    const descParts: string[] = [];
    if (isActive) descParts.push('●');
    if (sessionCount > 0) descParts.push(`${sessionCount} 会话`);
    else descParts.push(workspace.folderPath);
    this.description = descParts.join(' ');

    this.tooltip = new vscode.MarkdownString(
      `**${workspace.name}**${isActive ? ' \\(当前\\)' : ''}\n\n` +
      `路径: \`${workspace.folderPath}\`\n\n` +
      `会话数: ${sessionCount}\n\n` +
      `创建: ${workspace.createdAt}`,
    );

    this.iconPath = isActive
      ? new vscode.ThemeIcon('circle-filled')
      : new vscode.ThemeIcon('circle-outline');
  }
}
