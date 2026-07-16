import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  WorkspaceToolExecutor,
  type ToolApprovalRequest,
} from '../../vscode-extension/src/services/workspace-tools';

function call(name: string, args: Record<string, unknown> = {}): { name: string; arguments: string } {
  return { name, arguments: JSON.stringify(args) };
}

function result(value: string): any {
  return JSON.parse(value).result;
}

describe('WorkspaceToolExecutor', () => {
  let root: string;
  let approvals: ToolApprovalRequest[];
  let approved: boolean;
  let executor: WorkspaceToolExecutor;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'coordinator-tools-'));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'const value = 1;\nconsole.log(value);\n');
    fs.writeFileSync(path.join(root, '.env'), 'SECRET=value\n');
    fs.mkdirSync(path.join(root, '.git'));
    fs.writeFileSync(path.join(root, '.git', 'config'), 'secret');
    approvals = [];
    approved = true;
    executor = new WorkspaceToolExecutor(root, async (request) => {
      approvals.push(request);
      return approved;
    });
    executor.begin();
  });

  afterEach(() => {
    executor.cancel();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('lists and searches normal files without exposing protected files', async () => {
    const listed = result(await executor.execute(call('workspace_list_files')));
    expect(listed.files).toContain('src/app.ts');
    expect(listed.files).not.toContain('.env');
    expect(listed.files.some((file: string) => file.startsWith('.git/'))).toBe(false);

    const searched = result(await executor.execute(call('workspace_search', { query: 'console.log' })));
    expect(searched.results).toEqual([{
      path: 'src/app.ts',
      line: 2,
      text: 'console.log(value);',
    }]);
  });

  it('returns bounded file content and a hash while rejecting protected or escaped paths', async () => {
    const read = result(await executor.execute(call('workspace_read_file', { path: 'src/app.ts', startLine: 2 })));
    expect(read).toMatchObject({
      path: 'src/app.ts',
      content: 'console.log(value);\n',
      startLine: 2,
      totalLines: 3,
    });
    expect(read.sha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(executor.execute(call('workspace_read_file', { path: '.env' }))).rejects.toThrow('凭据');
    await expect(executor.execute(call('workspace_read_file', { path: '../outside.txt' }))).rejects.toThrow('不合法');
    await expect(executor.execute(call('workspace_read_file', { path: '.git/config' }))).rejects.toThrow('受保护');
    await expect(executor.execute(call('workspace_list_files', { path: 'node_modules' }))).rejects.toThrow('忽略目录');
  });

  it('requires approval and a current hash before overwriting files', async () => {
    const read = result(await executor.execute(call('workspace_read_file', { path: 'src/app.ts' })));
    await expect(executor.execute(call('workspace_write_file', {
      path: 'src/app.ts',
      content: 'changed\n',
    }))).rejects.toThrow('expectedSha256');

    approved = false;
    await expect(executor.execute(call('workspace_write_file', {
      path: 'src/app.ts',
      content: 'changed\n',
      expectedSha256: read.sha256,
    }))).rejects.toThrow('用户拒绝');
    expect(fs.readFileSync(path.join(root, 'src', 'app.ts'), 'utf8')).toContain('const value');

    approved = true;
    const written = result(await executor.execute(call('workspace_write_file', {
      path: 'src/app.ts',
      content: 'changed\n',
      expectedSha256: read.sha256,
    })));
    expect(written.path).toBe('src/app.ts');
    expect(fs.readFileSync(path.join(root, 'src', 'app.ts'), 'utf8')).toBe('changed\n');
    expect(approvals.at(-1)?.detail).toContain('+ changed');
  });

  it('creates empty files and performs exact approved replacements', async () => {
    await executor.execute(call('workspace_write_file', { path: 'src/empty.txt', content: '' }));
    expect(fs.readFileSync(path.join(root, 'src', 'empty.txt'), 'utf8')).toBe('');

    const replaced = result(await executor.execute(call('workspace_replace', {
      path: 'src/app.ts',
      oldText: 'const value = 1;',
      newText: 'const value = 2;',
    })));
    expect(replaced.replacements).toBe(1);
    expect(fs.readFileSync(path.join(root, 'src', 'app.ts'), 'utf8')).toContain('value = 2');
  });

  it('only deletes files after approval', async () => {
    approved = false;
    await expect(executor.execute(call('workspace_delete', { path: 'src/app.ts' }))).rejects.toThrow('用户拒绝');
    expect(fs.existsSync(path.join(root, 'src', 'app.ts'))).toBe(true);
    approved = true;
    await executor.execute(call('workspace_delete', { path: 'src/app.ts' }));
    expect(fs.existsSync(path.join(root, 'src', 'app.ts'))).toBe(false);
  });

  it('requires command approval and captures process output', async () => {
    approved = false;
    await expect(executor.execute(call('run_command', { command: 'node -e "console.log(1)"' }))).rejects.toThrow('用户拒绝');
    approved = true;
    const output = result(await executor.execute(call('run_command', {
      command: 'node -e "console.log(42)"',
      timeoutSeconds: 10,
    })));
    expect(output).toMatchObject({ exitCode: 0, timedOut: false, truncated: false });
    expect(output.stdout.trim()).toBe('42');
    expect(approvals.at(-1)?.detail).toContain('node -e');

    approved = false;
    await expect(executor.execute(call('run_command', { command: 'git reset --hard' }))).rejects.toThrow('用户拒绝');
    expect(approvals.at(-1)).toMatchObject({
      title: '允许执行高风险命令？',
      confirmLabel: '确认高风险执行',
    });
  });

  it('cancels a running command and suppresses completion', async () => {
    const running = executor.execute(call('run_command', {
      command: 'node -e "setTimeout(() => {}, 10000)"',
      timeoutSeconds: 30,
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    executor.cancel();
    await expect(running).rejects.toThrow('工具执行已取消');
  });
});
