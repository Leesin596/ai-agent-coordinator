// ============================================================
// SessionTreeProvider — 会话列表 TreeView（按角色分组）
// ============================================================
import * as vscode from 'vscode';
import type { CoordinatorContext } from '../backend/coordinator-context';
import type { Session, Role } from '../../../src/models/types';

export class SessionTreeProvider
  implements vscode.TreeDataProvider<SessionTreeNode>
{
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(private ctx: CoordinatorContext) {}

  refresh(): void {
    this._onDidChange.fire();
  }

  getTreeItem(element: SessionTreeNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: SessionTreeNode): SessionTreeNode[] {
    const runtime = this.ctx.getActiveRuntime();
    if (!runtime) return [];

    const sessions = runtime.sessionManager.list(runtime.workspace.id);
    if (sessions.length === 0) return [];

    if (!element) {
      // 顶层：按角色分组
      const roleMap = new Map<string, { role: Role; sessions: Session[] }>();
      for (const s of sessions) {
        const role = runtime.roleManager.get(s.roleId);
        if (!role) continue;
        const existing = roleMap.get(s.roleId);
        if (existing) {
          existing.sessions.push(s);
        } else {
          roleMap.set(s.roleId, { role, sessions: [s] });
        }
      }
      return Array.from(roleMap.values())
        .sort((a, b) => b.sessions.length - a.sessions.length)
        .map(({ role, sessions }) => new RoleGroupNode(role, sessions));
    }

    // 二层：会话节点
    if (element instanceof RoleGroupNode) {
      return element.sessions
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
        .map((s) => new SessionNode(s, element.role));
    }

    return [];
  }
}

// ============================================================
// 节点类型
// ============================================================

export class RoleGroupNode extends vscode.TreeItem {
  constructor(
    public readonly role: Role,
    public readonly sessions: Session[],
  ) {
    super(
      `${role.icon || '👤'} ${role.name}`,
      vscode.TreeItemCollapsibleState.Expanded,
    );
    this.description = `${sessions.length} 个会话`;
    this.contextValue = 'role-group';
    this.iconPath = new vscode.ThemeIcon('folder');
  }
}

export class SessionNode extends vscode.TreeItem {
  constructor(
    public readonly session: Session,
    public readonly role: Role,
  ) {
    super(session.title, vscode.TreeItemCollapsibleState.None);
    this.id = session.id;
    this.description = fmtRelative(session.updatedAt);
    this.contextValue = 'session';
    this.tooltip = new vscode.MarkdownString(
      `**${session.title}**\n\n` +
      `角色: ${role.icon || '👤'} ${role.name}\n\n` +
      `更新: ${fmtFull(session.updatedAt)}\n\n` +
      `创建: ${fmtFull(session.createdAt)}`,
    );
    this.iconPath = new vscode.ThemeIcon('comment-discussion');
    this.command = {
      command: 'coordinator.openSession',
      title: 'Open Session',
      arguments: [session.id],
    };
  }
}

export type SessionTreeNode = RoleGroupNode | SessionNode;

function fmtRelative(iso: string): string {
  const d = Date.parse(iso);
  if (!d) return '';
  const diff = Date.now() - d;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min}分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}天前`;
  return new Date(d).toLocaleDateString();
}

function fmtFull(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
