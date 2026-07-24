import * as vscode from 'vscode';

const READ_TOOLS = new Set([
  'workspace_list_files',
  'workspace_read_file',
  'workspace_search',
  'workspace_semantic_search',
  'git_status',
  'git_diff',
]);

const EDIT_TOOLS = new Set([
  'workspace_write_file',
  'workspace_replace',
  'workspace_apply_diff',
  'workspace_search_replace',
  'workspace_delete',
]);

const COMMAND_TOOLS = new Set([
  'run_command',
]);

const WEB_TOOLS = new Set([
  'web_search',
  'web_fetch',
]);

/** 默认免批准的工具（只读、无副作用） */
const DEFAULT_AUTO_APPROVE_TOOLS = new Set([
  'web_search', // 搜索是只读操作，默认免批准
]);

export function shouldAutoApprove(toolName: string): boolean {
  // web_search 默认免批准（用户可在 autoApprove.tools 中移除）
  if (DEFAULT_AUTO_APPROVE_TOOLS.has(toolName)) {
    const config = vscode.workspace.getConfiguration('coordinator.autoApprove');
    // 如果用户明确配置了 tools 列表且不包含 web_search，则不自动批准
    const tools = config.get<string[]>('tools', []);
    if (tools.length > 0 && !tools.includes(toolName)) {
      // 用户配置了精确列表，但 web_search 不在其中
      // 仍然检查 toolGroups
      const groups = config.get<string[]>('toolGroups', []);
      if (groups.length === 0) return false;
    }
    return true;
  }

  const config = vscode.workspace.getConfiguration('coordinator.autoApprove');

  if (config.get<boolean>('always', false)) return true;

  const tools = config.get<string[]>('tools', []);
  if (tools.includes(toolName)) return true;

  const groups = config.get<string[]>('toolGroups', []);
  for (const group of groups) {
    if (group === 'read' && READ_TOOLS.has(toolName)) return true;
    if (group === 'edit' && EDIT_TOOLS.has(toolName)) return true;
    if (group === 'command' && COMMAND_TOOLS.has(toolName)) return true;
    if (group === 'web' && WEB_TOOLS.has(toolName)) return true;
    if (group === 'mcp' && toolName.includes('__')) return true;
  }

  return false;
}

export function isAutoApproveEnabled(): boolean {
  const config = vscode.workspace.getConfiguration('coordinator.autoApprove');
  return config.get<boolean>('always', false) ||
    (config.get<string[]>('tools', []).length > 0) ||
    (config.get<string[]>('toolGroups', []).length > 0);
}
