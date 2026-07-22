import { describe, expect, it, beforeEach, vi } from 'vitest';

const fakeConfig: Record<string, unknown> = {};

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: (section: string) => ({
      get: <T>(key: string, defaultValue: T): T => {
        const fullKey = `${section}.${key}`;
        return (fakeConfig[fullKey] ?? defaultValue) as T;
      },
    }),
  },
}));

import { shouldAutoApprove, isAutoApproveEnabled } from '../../vscode-extension/src/services/approval-helper';

describe('approval-helper (Auto-Approve P0-3)', () => {
  beforeEach(() => {
    // Reset all config keys
    for (const key of Object.keys(fakeConfig)) {
      delete fakeConfig[key];
    }
  });

  it('returns false by default for all tools', () => {
    expect(shouldAutoApprove('workspace_read_file')).toBe(false);
    expect(shouldAutoApprove('workspace_write_file')).toBe(false);
    expect(shouldAutoApprove('run_command')).toBe(false);
    expect(shouldAutoApprove('mcp__server__tool')).toBe(false);
  });

  it('returns true when always is enabled', () => {
    fakeConfig['coordinator.autoApprove.always'] = true;
    expect(shouldAutoApprove('workspace_read_file')).toBe(true);
    expect(shouldAutoApprove('workspace_write_file')).toBe(true);
    expect(shouldAutoApprove('run_command')).toBe(true);
  });

  it('returns true for specific tool names in tools list', () => {
    fakeConfig['coordinator.autoApprove.tools'] = ['workspace_read_file', 'git_status'];
    expect(shouldAutoApprove('workspace_read_file')).toBe(true);
    expect(shouldAutoApprove('git_status')).toBe(true);
    expect(shouldAutoApprove('workspace_write_file')).toBe(false);
    expect(shouldAutoApprove('workspace_search')).toBe(false);
  });

  it('returns true for read tool group', () => {
    fakeConfig['coordinator.autoApprove.toolGroups'] = ['read'];
    expect(shouldAutoApprove('workspace_list_files')).toBe(true);
    expect(shouldAutoApprove('workspace_read_file')).toBe(true);
    expect(shouldAutoApprove('workspace_search')).toBe(true);
    expect(shouldAutoApprove('git_status')).toBe(true);
    expect(shouldAutoApprove('git_diff')).toBe(true);
    // edit tools still require approval
    expect(shouldAutoApprove('workspace_write_file')).toBe(false);
    expect(shouldAutoApprove('workspace_apply_diff')).toBe(false);
    expect(shouldAutoApprove('run_command')).toBe(false);
  });

  it('returns true for edit tool group', () => {
    fakeConfig['coordinator.autoApprove.toolGroups'] = ['edit'];
    expect(shouldAutoApprove('workspace_write_file')).toBe(true);
    expect(shouldAutoApprove('workspace_replace')).toBe(true);
    expect(shouldAutoApprove('workspace_apply_diff')).toBe(true);
    expect(shouldAutoApprove('workspace_search_replace')).toBe(true);
    expect(shouldAutoApprove('workspace_delete')).toBe(true);
    // read tools still require approval
    expect(shouldAutoApprove('workspace_read_file')).toBe(false);
    expect(shouldAutoApprove('run_command')).toBe(false);
  });

  it('returns true for command tool group', () => {
    fakeConfig['coordinator.autoApprove.toolGroups'] = ['command'];
    expect(shouldAutoApprove('run_command')).toBe(true);
    expect(shouldAutoApprove('workspace_read_file')).toBe(false);
    expect(shouldAutoApprove('workspace_write_file')).toBe(false);
  });

  it('returns true for mcp tool group only on MCP tools', () => {
    fakeConfig['coordinator.autoApprove.toolGroups'] = ['mcp'];
    expect(shouldAutoApprove('mcp__server__tool')).toBe(true);
    expect(shouldAutoApprove('workspace_read_file')).toBe(false);
    expect(shouldAutoApprove('run_command')).toBe(false);
  });

  it('combines multiple tool groups', () => {
    fakeConfig['coordinator.autoApprove.toolGroups'] = ['read', 'command'];
    expect(shouldAutoApprove('workspace_read_file')).toBe(true);
    expect(shouldAutoApprove('run_command')).toBe(true);
    expect(shouldAutoApprove('workspace_write_file')).toBe(false);
  });

  it('combines tools list and tool groups', () => {
    fakeConfig['coordinator.autoApprove.tools'] = ['workspace_delete'];
    fakeConfig['coordinator.autoApprove.toolGroups'] = ['read'];
    expect(shouldAutoApprove('workspace_delete')).toBe(true);
    expect(shouldAutoApprove('workspace_read_file')).toBe(true);
    expect(shouldAutoApprove('workspace_write_file')).toBe(false);
  });

  it('always flag overrides everything', () => {
    fakeConfig['coordinator.autoApprove.always'] = true;
    expect(shouldAutoApprove('workspace_read_file')).toBe(true);
    expect(shouldAutoApprove('workspace_write_file')).toBe(true);
    expect(shouldAutoApprove('run_command')).toBe(true);
    expect(shouldAutoApprove('mcp__any__tool')).toBe(true);
  });

  it('isAutoApproveEnabled detects any active config', () => {
    expect(isAutoApproveEnabled()).toBe(false);
    fakeConfig['coordinator.autoApprove.always'] = true;
    expect(isAutoApproveEnabled()).toBe(true);
    delete fakeConfig['coordinator.autoApprove.always'];
    fakeConfig['coordinator.autoApprove.tools'] = ['workspace_read_file'];
    expect(isAutoApproveEnabled()).toBe(true);
    delete fakeConfig['coordinator.autoApprove.tools'];
    fakeConfig['coordinator.autoApprove.toolGroups'] = ['read'];
    expect(isAutoApproveEnabled()).toBe(true);
  });
});
