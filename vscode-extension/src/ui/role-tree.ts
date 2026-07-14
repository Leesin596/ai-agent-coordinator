// ============================================================
// RoleTreeProvider — 角色库 TreeView（按分类分组）
// ============================================================
import * as vscode from 'vscode';
import type { CoordinatorContext } from '../backend/coordinator-context';
import type { Role, RoleCategory } from '../../../src/models/types';
import { ROLE_CATEGORY_LABELS } from '../../../src/models/types';

const CATEGORY_ORDER: RoleCategory[] = [
  'engineering',
  'product',
  'design',
  'qa',
  'custom',
];

const CATEGORY_ICONS: Record<RoleCategory, string> = {
  engineering: 'tools',
  product: 'lightbulb',
  design: 'palette',
  qa: 'shield',
  custom: 'symbol-misc',
};

export class RoleTreeProvider
  implements vscode.TreeDataProvider<RoleTreeNode>
{
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(private ctx: CoordinatorContext) {}

  refresh(): void {
    this._onDidChange.fire();
  }

  getTreeItem(element: RoleTreeNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: RoleTreeNode): RoleTreeNode[] {
    const runtime = this.ctx.getActiveRuntime();
    if (!runtime) return []; // 无激活工作区时不显示

    if (!element) {
      // 顶层：分类节点
      const roles = runtime.roleManager.list();
      const presentCategories = new Set(roles.map((r) => r.category));
      return CATEGORY_ORDER.filter((c) => presentCategories.has(c)).map(
        (cat) => new CategoryNode(cat, roles.filter((r) => r.category === cat)),
      );
    }

    // 二层：角色节点
    if (element instanceof CategoryNode) {
      return element.roles
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((r) => new RoleNode(r));
    }

    return [];
  }
}

// ============================================================
// 节点类型
// ============================================================

export class CategoryNode extends vscode.TreeItem {
  constructor(
    public readonly category: RoleCategory,
    public readonly roles: Role[],
  ) {
    super(
      ROLE_CATEGORY_LABELS[category],
      vscode.TreeItemCollapsibleState.Expanded,
    );
    this.description = `${roles.length} 个角色`;
    this.contextValue = 'category';
    this.iconPath = new vscode.ThemeIcon(CATEGORY_ICONS[category] || 'folder');
  }
}

export class RoleNode extends vscode.TreeItem {
  constructor(public readonly role: Role) {
    const icon = role.icon || '👤';
    super(`${icon} ${role.name}`, vscode.TreeItemCollapsibleState.None);

    this.id = role.id;
    this.description = role.builtIn ? '内置' : '自定义';
    // 所有角色均可编辑，仅自定义角色可删除
    this.contextValue = role.builtIn ? 'role' : 'role-custom';
    this.tooltip = this.buildTooltip();
    this.command = {
      command: 'coordinator.startSession',
      title: 'Start Session',
      arguments: [{ role }],
    };
  }

  private buildTooltip(): vscode.MarkdownString {
    const lines: string[] = [
      `**${this.role.icon || '👤'} ${this.role.name}**`,
      '',
      `分类: ${ROLE_CATEGORY_LABELS[this.role.category]}  |  类型: ${this.role.builtIn ? '内置' : '自定义'}`,
    ];
    if (this.role.description) {
      lines.push('', `**职责**`, this.role.description);
    }
    if (this.role.skills && this.role.skills.length > 0) {
      lines.push('', `**技能**`, this.role.skills.map(s => `- ${s}`).join('\n'));
    }
    const md = new vscode.MarkdownString(lines.join('\n'));
    md.supportHtml = true;
    return md;
  }
}

export type RoleTreeNode = CategoryNode | RoleNode;
