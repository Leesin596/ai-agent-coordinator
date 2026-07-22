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

export function shouldAutoApprove(toolName: string): boolean {
  const config = vscode.workspace.getConfiguration('coordinator.autoApprove');

  if (config.get<boolean>('always', false)) return true;

  const tools = config.get<string[]>('tools', []);
  if (tools.includes(toolName)) return true;

  const groups = config.get<string[]>('toolGroups', []);
  for (const group of groups) {
    if (group === 'read' && READ_TOOLS.has(toolName)) return true;
    if (group === 'edit' && EDIT_TOOLS.has(toolName)) return true;
    if (group === 'command' && COMMAND_TOOLS.has(toolName)) return true;
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
