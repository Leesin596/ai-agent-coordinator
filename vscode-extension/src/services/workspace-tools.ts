import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { CheckpointManager } from './checkpoint-manager';
import { TodoListManager } from './todo-list-manager';
import type { IndexingService, SearchResult } from './indexing-service';
import type { Role } from '../../../src/models/types';
import { isToolAllowedByRole } from './tool-filter';

export interface ToolCallInput {
  name: string;
  arguments: string;
}

export interface ToolApprovalRequest {
  title: string;
  detail: string;
  confirmLabel: string;
  toolName?: string;
}

export type ToolApprovalHandler = (request: ToolApprovalRequest) => Promise<boolean>;

export interface TerminalRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
}

export type TerminalRunner = (command: string, cwd: string, timeoutSeconds: number) => Promise<TerminalRunResult>;

const MAX_READ_BYTES = 1024 * 1024;
const MAX_WRITE_BYTES = 2 * 1024 * 1024;
const MAX_SEARCH_FILES = 5000;
const MAX_SEARCH_RESULTS = 100;
const MAX_PROCESS_OUTPUT = 100000;
const IGNORED_DIRECTORIES = new Set([
  '.aws', '.azure', '.git', '.coordinator', '.kube', '.next', '.nuxt', '.output',
  '.ssh', '.turbo', '.venv', 'build', 'coverage', 'dist', 'node_modules', 'out',
  'target', 'vendor',
]);
const DENIED_NAMES = new Set([
  '.env', '.npmrc', '.pypirc', 'credentials', 'credentials.json', 'id_dsa',
  'id_ecdsa', 'id_ed25519', 'id_rsa', 'secrets.json',
]);

function asObject(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value || '{}');
  } catch {
    throw new Error('工具参数不是有效的 JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('工具参数必须是对象');
  }
  return parsed as Record<string, unknown>;
}

function requiredString(values: Record<string, unknown>, key: string, maxLength: number): string {
  const value = typeof values[key] === 'string' ? values[key].trim() : '';
  if (!value) throw new Error(`${key} 必须是非空字符串`);
  if (value.length > maxLength) throw new Error(`${key} 超过允许长度`);
  return value;
}

function requiredText(values: Record<string, unknown>, key: string, maxLength: number): string {
  const value = values[key];
  if (typeof value !== 'string') throw new Error(`${key} 必须是字符串`);
  if (value.length > maxLength) throw new Error(`${key} 超过允许长度`);
  return value;
}

function isDeniedName(name: string): boolean {
  const lower = name.toLowerCase();
  return (DENIED_NAMES.has(lower) || lower.startsWith('.env.')) && lower !== '.env.example';
}

function optionalInteger(values: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const value = values[key];
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${key} 必须是 ${min}-${max} 的整数`);
  }
  return value as number;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function sha256(content: Buffer | string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function isBinary(content: Buffer): boolean {
  return content.subarray(0, Math.min(content.length, 8000)).includes(0);
}

function formatPreview(oldContent: string, newContent: string): string {
  const oldLines = oldContent.split(/\r?\n/);
  const newLines = newContent.split(/\r?\n/);
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  let oldSuffix = oldLines.length - 1;
  let newSuffix = newLines.length - 1;
  while (oldSuffix >= prefix && newSuffix >= prefix && oldLines[oldSuffix] === newLines[newSuffix]) {
    oldSuffix--;
    newSuffix--;
  }
  const removed = oldLines.slice(prefix, oldSuffix + 1).slice(0, 80).map((line) => `- ${line}`);
  const added = newLines.slice(prefix, newSuffix + 1).slice(0, 80).map((line) => `+ ${line}`);
  const preview = [...removed, ...added].join('\n');
  return preview.slice(0, 12000) || '(内容无变化)';
}

export class WorkspaceToolExecutor {
  private readonly root: string;
  private readonly realRoot: string;
  private readonly activeProcesses = new Set<ChildProcess>();
  private cancelled = false;
  private checkpointManager: CheckpointManager | null = null;
  private terminalRunner: TerminalRunner | null = null;
  private role: Role | undefined;
  private todoListManager: TodoListManager | null = null;
  private indexingService: IndexingService | null = null;
  private sessionId: string | null = null;

  constructor(root: string, private readonly approve: ToolApprovalHandler) {
    this.root = path.resolve(root);
    this.realRoot = fs.realpathSync(this.root);
  }

  setRole(role: Role | undefined): void {
    this.role = role;
  }

  setCheckpointManager(manager: CheckpointManager | null): void {
    this.checkpointManager = manager;
  }

  setTerminalRunner(runner: TerminalRunner | null): void {
    this.terminalRunner = runner;
  }

  setTodoListManager(manager: TodoListManager | null): void {
    this.todoListManager = manager;
  }

  setIndexingService(service: IndexingService | null): void {
    this.indexingService = service;
  }

  setSessionId(sessionId: string | null): void {
    this.sessionId = sessionId;
  }

  getCheckpointManager(): CheckpointManager | null {
    return this.checkpointManager;
  }

  begin(): void {
    this.cancelled = false;
  }

  cancel(): void {
    this.cancelled = true;
    for (const child of this.activeProcesses) this.terminate(child);
    this.activeProcesses.clear();
  }

  async execute(call: ToolCallInput): Promise<string> {
    if (this.cancelled) throw new Error('工具执行已取消');
    if (!isToolAllowedByRole(call.name, this.role)) {
      throw new Error(`角色「${this.role?.name || '未知'}」无权使用工具: ${call.name}`);
    }
    const values = asObject(call.arguments);
    let result: unknown;
    switch (call.name) {
      case 'workspace_list_files': result = this.listFiles(values); break;
      case 'workspace_read_file': result = this.readFile(values); break;
      case 'workspace_search': result = this.search(values); break;
      case 'workspace_write_file': result = await this.writeFile(values); break;
      case 'workspace_replace': result = await this.replaceFile(values); break;
      case 'workspace_apply_diff': result = await this.applyDiff(values); break;
      case 'workspace_search_replace': result = await this.searchReplace(values); break;
      case 'workspace_delete': result = await this.deletePath(values); break;
      case 'git_status': result = await this.gitStatus(); break;
      case 'git_diff': result = await this.gitDiff(values); break;
      case 'run_command': result = await this.runCommand(values); break;
      case 'todo_list_create': result = this.todoListCreate(values); break;
      case 'todo_list_update': result = this.todoListUpdate(values); break;
      case 'todo_list_delete': result = this.todoListDelete(values); break;
      case 'todo_list_read': result = this.todoListRead(); break;
      case 'workspace_semantic_search': result = await this.semanticSearch(values); break;
      default: throw new Error(`不支持的工具: ${call.name}`);
    }
    return JSON.stringify({ ok: true, result });
  }

  private resolve(relativePath: string, allowMissing = false): string {
    if (path.isAbsolute(relativePath)) throw new Error('path 必须是工作区相对路径');
    const normalized = relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
    const segments = normalized.split('/').filter(Boolean);
    if (segments.length === 0 || segments.some((segment) => segment === '..')) throw new Error('path 不合法');
    const lowerSegments = segments.map((segment) => segment.toLowerCase());
    if (lowerSegments.some((segment) => IGNORED_DIRECTORIES.has(segment))) {
      throw new Error('禁止访问受保护或忽略目录');
    }
    const name = lowerSegments[lowerSegments.length - 1];
    if (isDeniedName(name)) throw new Error('禁止访问凭据或密钥文件');
    const absolute = path.resolve(this.root, ...segments);
    if (!isInside(this.root, absolute)) throw new Error('path 超出工作区');
    if (fs.existsSync(absolute)) {
      const real = fs.realpathSync(absolute);
      if (!isInside(this.realRoot, real)) throw new Error('path 通过符号链接超出工作区');
      return absolute;
    }
    if (!allowMissing) throw new Error(`路径不存在: ${normalized}`);
    let parent = path.dirname(absolute);
    while (!fs.existsSync(parent) && parent !== this.root) parent = path.dirname(parent);
    const realParent = fs.realpathSync(parent);
    if (!isInside(this.realRoot, realParent)) throw new Error('path 的父目录通过符号链接超出工作区');
    return absolute;
  }

  private relative(absolute: string): string {
    return path.relative(this.root, absolute).replace(/\\/g, '/');
  }

  private listFiles(values: Record<string, unknown>): unknown {
    const inputPath = typeof values.path === 'string' && values.path.trim() ? values.path.trim() : '.';
    const limit = optionalInteger(values, 'limit', 200, 1, 1000);
    const maxDepth = optionalInteger(values, 'maxDepth', 4, 0, 12);
    const start = inputPath === '.' ? this.root : this.resolve(inputPath);
    if (!fs.statSync(start).isDirectory()) throw new Error('path 必须是目录');
    const files: string[] = [];
    const pending: Array<{ dir: string; depth: number }> = [{ dir: start, depth: 0 }];
    while (pending.length && files.length < limit) {
      const current = pending.shift()!;
      const entries = fs.readdirSync(current.dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (files.length >= limit) break;
        if (entry.isSymbolicLink() || isDeniedName(entry.name)) continue;
        const absolute = path.join(current.dir, entry.name);
        if (entry.isDirectory()) {
          if (current.depth < maxDepth && !IGNORED_DIRECTORIES.has(entry.name.toLowerCase())) {
            pending.push({ dir: absolute, depth: current.depth + 1 });
          }
        } else if (entry.isFile()) {
          files.push(this.relative(absolute));
        }
      }
    }
    return { files, truncated: files.length >= limit };
  }

  private readFile(values: Record<string, unknown>): unknown {
    const relativePath = requiredString(values, 'path', 1000);
    const absolute = this.resolve(relativePath);
    const stat = fs.statSync(absolute);
    if (!stat.isFile()) throw new Error('path 必须是文件');
    if (stat.size > MAX_READ_BYTES) throw new Error('文件超过 1MB 读取上限');
    const buffer = fs.readFileSync(absolute);
    if (isBinary(buffer)) throw new Error('不支持读取二进制文件');
    const content = buffer.toString('utf8');
    const lines = content.split(/\r?\n/);
    const startLine = optionalInteger(values, 'startLine', 1, 1, Math.max(lines.length, 1));
    const endLine = optionalInteger(values, 'endLine', Math.min(lines.length, startLine + 499), startLine, lines.length || 1);
    return { path: this.relative(absolute), content: lines.slice(startLine - 1, endLine).join('\n'), startLine, endLine, totalLines: lines.length, sha256: sha256(buffer) };
  }

  private search(values: Record<string, unknown>): unknown {
    const query = requiredString(values, 'query', 500);
    const inputPath = typeof values.path === 'string' && values.path.trim() ? values.path.trim() : '.';
    const maxResults = optionalInteger(values, 'maxResults', 50, 1, MAX_SEARCH_RESULTS);
    const start = inputPath === '.' ? this.root : this.resolve(inputPath);
    if (!fs.statSync(start).isDirectory()) throw new Error('path 必须是目录');
    const results: Array<{ path: string; line: number; text: string }> = [];
    const pending = [start];
    let scanned = 0;
    while (pending.length && results.length < maxResults && scanned < MAX_SEARCH_FILES) {
      const dir = pending.shift()!;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (results.length >= maxResults || scanned >= MAX_SEARCH_FILES) break;
        if (entry.isSymbolicLink() || isDeniedName(entry.name)) continue;
        const absolute = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!IGNORED_DIRECTORIES.has(entry.name.toLowerCase())) pending.push(absolute);
          continue;
        }
        if (!entry.isFile()) continue;
        scanned++;
        const stat = fs.statSync(absolute);
        if (stat.size > 512 * 1024) continue;
        const buffer = fs.readFileSync(absolute);
        if (isBinary(buffer)) continue;
        buffer.toString('utf8').split(/\r?\n/).forEach((line, index) => {
          if (results.length < maxResults && line.toLowerCase().includes(query.toLowerCase())) {
            results.push({ path: this.relative(absolute), line: index + 1, text: line.slice(0, 1000) });
          }
        });
      }
    }
    return { results, scannedFiles: scanned, truncated: results.length >= maxResults || scanned >= MAX_SEARCH_FILES };
  }

  private async writeFile(values: Record<string, unknown>): Promise<unknown> {
    const relativePath = requiredString(values, 'path', 1000);
    const content = requiredText(values, 'content', MAX_WRITE_BYTES);
    if (Buffer.byteLength(content) > MAX_WRITE_BYTES) throw new Error('写入内容超过 2MB 上限');
    const absolute = this.resolve(relativePath, true);
    const exists = fs.existsSync(absolute);
    let oldContent = '';
    if (exists) {
      const stat = fs.statSync(absolute);
      if (!stat.isFile()) throw new Error('path 必须是文件');
      if (stat.size > MAX_WRITE_BYTES) throw new Error('现有文件超过 2MB 修改上限');
      const buffer = fs.readFileSync(absolute);
      if (isBinary(buffer)) throw new Error('不支持覆盖二进制文件');
      oldContent = buffer.toString('utf8');
    }
    const expected = typeof values.expectedSha256 === 'string' ? values.expectedSha256 : '';
    if (exists && (!expected || expected !== sha256(oldContent))) throw new Error('覆盖现有文件前必须提供 read_file 返回的 expectedSha256');
    const approved = await this.approve({ title: exists ? `允许覆盖 ${relativePath}？` : `允许创建 ${relativePath}？`, detail: formatPreview(oldContent, content), confirmLabel: exists ? '覆盖文件' : '创建文件', toolName: 'workspace_write_file' });
    if (!approved) throw new Error('用户拒绝了文件写入');
    if (this.cancelled) throw new Error('工具执行已取消');
    if (exists && sha256(fs.readFileSync(absolute)) !== expected) throw new Error('文件在审批期间已被修改，请重新读取');
    if (this.checkpointManager && exists) this.checkpointManager.createCheckpoint(`写入 ${relativePath}`, [relativePath]);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content, 'utf8');
    return { path: this.relative(absolute), bytes: Buffer.byteLength(content), sha256: sha256(content) };
  }

  private async replaceFile(values: Record<string, unknown>): Promise<unknown> {
    const relativePath = requiredString(values, 'path', 1000);
    const oldText = requiredString(values, 'oldText', MAX_WRITE_BYTES);
    const newText = requiredText(values, 'newText', MAX_WRITE_BYTES);
    const replaceAll = values.replaceAll === true;
    const absolute = this.resolve(relativePath);
    const stat = fs.statSync(absolute);
    if (!stat.isFile()) throw new Error('path 必须是文件');
    if (stat.size > MAX_WRITE_BYTES) throw new Error('文件超过 2MB 修改上限');
    const buffer = fs.readFileSync(absolute);
    if (isBinary(buffer)) throw new Error('不支持修改二进制文件');
    const before = buffer.toString('utf8');
    const occurrences = before.split(oldText).length - 1;
    if (occurrences === 0) throw new Error('oldText 在文件中不存在');
    if (!replaceAll && occurrences !== 1) throw new Error('oldText 不唯一；请提供更多上下文或设置 replaceAll');
    const after = replaceAll ? before.split(oldText).join(newText) : before.replace(oldText, newText);
    if (Buffer.byteLength(after) > MAX_WRITE_BYTES) throw new Error('修改后文件超过 2MB 上限');
    const beforeHash = sha256(before);
    const approved = await this.approve({ title: `允许修改 ${relativePath}？`, detail: formatPreview(before, after), confirmLabel: '应用修改', toolName: 'workspace_replace' });
    if (!approved) throw new Error('用户拒绝了文件修改');
    if (this.cancelled) throw new Error('工具执行已取消');
    if (sha256(fs.readFileSync(absolute)) !== beforeHash) throw new Error('文件在审批期间已被修改，请重新读取');
    if (this.checkpointManager) this.checkpointManager.createCheckpoint(`替换 ${relativePath}`, [relativePath]);
    fs.writeFileSync(absolute, after, 'utf8');
    return { path: this.relative(absolute), replacements: replaceAll ? occurrences : 1, sha256: sha256(after) };
  }

  private async applyDiff(values: Record<string, unknown>): Promise<unknown> {
    const relativePath = requiredString(values, 'path', 1000);
    const diff = requiredText(values, 'diff', MAX_WRITE_BYTES);
    const absolute = this.resolve(relativePath);
    const stat = fs.statSync(absolute);
    if (!stat.isFile()) throw new Error('path 必须是文件');
    if (stat.size > MAX_WRITE_BYTES) throw new Error('文件超过 2MB 修改上限');
    const buffer = fs.readFileSync(absolute);
    if (isBinary(buffer)) throw new Error('不支持修改二进制文件');
    const before = buffer.toString('utf8');
    const beforeHash = sha256(before);
    let after: string;
    try {
      after = applyUnifiedDiff(before, diff);
    } catch (err) {
      throw new Error(`apply_diff 失败: ${(err as Error).message}`);
    }
    if (after === before) throw new Error('diff 未产生任何变化');
    if (Buffer.byteLength(after) > MAX_WRITE_BYTES) throw new Error('修改后文件超过 2MB 上限');
    const approved = await this.approve({ title: `允许应用 diff 到 ${relativePath}？`, detail: formatPreview(before, after), confirmLabel: '应用 Diff', toolName: 'workspace_apply_diff' });
    if (!approved) throw new Error('用户拒绝了 diff 应用');
    if (this.cancelled) throw new Error('工具执行已取消');
    if (sha256(fs.readFileSync(absolute)) !== beforeHash) throw new Error('文件在审批期间已被修改，请重新读取');
    if (this.checkpointManager) this.checkpointManager.createCheckpoint(`Diff ${relativePath}`, [relativePath]);
    fs.writeFileSync(absolute, after, 'utf8');
    return { path: this.relative(absolute), sha256: sha256(after) };
  }

  private async searchReplace(values: Record<string, unknown>): Promise<unknown> {
    const relativePath = requiredString(values, 'path', 1000);
    const searchText = requiredText(values, 'searchText', MAX_WRITE_BYTES);
    const replaceText = requiredText(values, 'replaceText', MAX_WRITE_BYTES);
    const replaceAll = values.replaceAll === true;
    const absolute = this.resolve(relativePath);
    const stat = fs.statSync(absolute);
    if (!stat.isFile()) throw new Error('path 必须是文件');
    if (stat.size > MAX_WRITE_BYTES) throw new Error('文件超过 2MB 修改上限');
    const buffer = fs.readFileSync(absolute);
    if (isBinary(buffer)) throw new Error('不支持修改二进制文件');
    const before = buffer.toString('utf8');
    const occurrences = before.split(searchText).length - 1;
    if (occurrences === 0) throw new Error('searchText 在文件中不存在');
    const after = replaceAll ? before.split(searchText).join(replaceText) : before.replace(searchText, replaceText);
    if (Buffer.byteLength(after) > MAX_WRITE_BYTES) throw new Error('修改后文件超过 2MB 上限');
    const beforeHash = sha256(before);
    const approved = await this.approve({ title: `允许修改 ${relativePath}？`, detail: formatPreview(before, after), confirmLabel: '应用修改', toolName: 'workspace_search_replace' });
    if (!approved) throw new Error('用户拒绝了文件修改');
    if (this.cancelled) throw new Error('工具执行已取消');
    if (sha256(fs.readFileSync(absolute)) !== beforeHash) throw new Error('文件在审批期间已被修改，请重新读取');
    if (this.checkpointManager) this.checkpointManager.createCheckpoint(`搜索替换 ${relativePath}`, [relativePath]);
    fs.writeFileSync(absolute, after, 'utf8');
    return { path: this.relative(absolute), replacements: replaceAll ? occurrences : 1, sha256: sha256(after) };
  }

  private async deletePath(values: Record<string, unknown>): Promise<unknown> {
    const relativePath = requiredString(values, 'path', 1000);
    const absolute = this.resolve(relativePath);
    const stat = fs.statSync(absolute);
    if (!stat.isFile()) throw new Error('仅允许删除文件');
    const approved = await this.approve({ title: `允许删除 ${relativePath}？`, detail: `文件大小: ${stat.size} bytes\n此操作无法由插件自动恢复。`, confirmLabel: '删除文件', toolName: 'workspace_delete' });
    if (!approved) throw new Error('用户拒绝了文件删除');
    if (this.cancelled) throw new Error('工具执行已取消');
    if (this.checkpointManager) this.checkpointManager.createCheckpoint(`删除 ${relativePath}`, [relativePath]);
    fs.unlinkSync(absolute);
    return { path: relativePath, deleted: true };
  }

  private async gitStatus(): Promise<unknown> {
    const output = await this.runProcess('git', ['status', '--short', '--branch'], false, 30);
    return { output: output.stdout, stderr: output.stderr, exitCode: output.exitCode, truncated: output.truncated };
  }

  private async gitDiff(values: Record<string, unknown>): Promise<unknown> {
    const args = ['diff', '--no-ext-diff', '--unified=3'];
    if (values.staged === true) args.push('--cached');
    if (typeof values.path === 'string' && values.path.trim()) {
      const absolute = this.resolve(values.path.trim());
      args.push('--', this.relative(absolute));
    }
    const output = await this.runProcess('git', args, false, 30);
    return { output: output.stdout, stderr: output.stderr, exitCode: output.exitCode, truncated: output.truncated };
  }

  private async runCommand(values: Record<string, unknown>): Promise<unknown> {
    const command = requiredString(values, 'command', 4000);
    if (/\r|\n/.test(command)) throw new Error('command 不能包含换行');
    const timeoutSeconds = optionalInteger(values, 'timeoutSeconds', 60, 1, 300);
    const highRisk = /(?:^|[;&|]\s*)(?:del|erase|format|rd|rmdir|rm|shutdown)\b|git\s+(?:clean|reset\s+--hard)|(?:npm|pnpm|yarn)\s+publish\b|Remove-Item\b/i.test(command);
    const approved = await this.approve({
      title: highRisk ? '允许执行高风险命令？' : '允许执行命令？',
      detail: `风险级别: ${highRisk ? '高' : '普通'}\n工作目录: ${this.root}\n超时: ${timeoutSeconds} 秒\n\n${command}`,
      confirmLabel: highRisk ? '确认高风险执行' : '执行命令',
      toolName: 'run_command',
    });
    if (!approved) throw new Error('用户拒绝了命令执行');
    if (this.cancelled) throw new Error('工具执行已取消');
    if (this.terminalRunner) {
      const output = await this.terminalRunner(command, this.root, timeoutSeconds);
      if (output.timedOut) {
        return { command, ...output, warning: `命令超时（${timeoutSeconds}秒），已发送 Ctrl+C 中断，但进程可能仍在终端中运行。如需确认，请检查 VS Code 终端面板。` };
      }
      return { command, ...output };
    }
    const output = await this.runProcess(command, [], true, timeoutSeconds);
    if (output.timedOut) {
      return { command, ...output, warning: `命令超时（${timeoutSeconds}秒），进程已被终止。` };
    }
    return { command, ...output };
  }

  private todoListCreate(values: Record<string, unknown>): unknown {
    if (!this.todoListManager || !this.sessionId) {
      throw new Error('Todo List 功能未初始化');
    }
    const rawItems = values.items;
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      throw new Error('items 必须是非空数组');
    }
    const inputs = rawItems.map((item: unknown) => {
      if (!item || typeof item !== 'object') throw new Error('items 中每项必须是对象');
      const obj = item as Record<string, unknown>;
      const content = typeof obj.content === 'string' ? obj.content.trim() : '';
      if (!content) throw new Error('items 中每项 content 不能为空');
      return {
        content,
        priority: typeof obj.priority === 'string' ? (obj.priority as 'high' | 'medium' | 'low') : undefined,
      };
    });
    const items = this.todoListManager.createTodos(this.sessionId, inputs);
    return { items };
  }

  private todoListUpdate(values: Record<string, unknown>): unknown {
    if (!this.todoListManager || !this.sessionId) {
      throw new Error('Todo List 功能未初始化');
    }
    const id = typeof values.id === 'string' ? values.id.trim() : '';
    if (!id) throw new Error('id 不能为空');
    const patch: { status?: 'pending' | 'in_progress' | 'completed' | 'failed'; content?: string } = {};
    if (typeof values.status === 'string') patch.status = values.status as 'pending' | 'in_progress' | 'completed' | 'failed';
    if (typeof values.content === 'string') patch.content = values.content;
    const item = this.todoListManager.updateTodo(this.sessionId, id, patch);
    return { item };
  }

  private todoListRead(): unknown {
    if (!this.todoListManager || !this.sessionId) {
      throw new Error('Todo List 功能未初始化');
    }
    const items = this.todoListManager.getTodos(this.sessionId);
    return { items };
  }

  private todoListDelete(values: Record<string, unknown>): unknown {
    if (!this.todoListManager || !this.sessionId) {
      throw new Error('Todo List 功能未初始化');
    }
    const id = requiredString(values, 'id', 100);
    this.todoListManager.deleteTodo(this.sessionId, id);
    return { deleted: true, id };
  }

  private async semanticSearch(values: Record<string, unknown>): Promise<unknown> {
    if (!this.indexingService) {
      throw new Error('语义搜索功能未初始化');
    }
    const query = requiredString(values, 'query', 500);
    const topK = optionalInteger(values, 'topK', 10, 1, 50);
    const results: SearchResult[] = await this.indexingService.semanticSearch(query, topK);
    return { results, query };
  }

  private runProcess(command: string, args: string[], shell: boolean, timeoutSeconds: number): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; truncated: boolean }> {
    return new Promise((resolve, reject) => {
      if (this.cancelled) return reject(new Error('工具执行已取消'));
      const child = spawn(command, args, { cwd: this.root, shell, windowsHide: true, env: process.env, detached: process.platform !== 'win32' });
      this.activeProcesses.add(child);
      let stdout = '';
      let stderr = '';
      let truncated = false;
      let timedOut = false;
      const append = (current: string, chunk: Buffer): string => {
        if (current.length >= MAX_PROCESS_OUTPUT) { truncated = true; return current; }
        const next = current + chunk.toString('utf8');
        if (next.length > MAX_PROCESS_OUTPUT) truncated = true;
        return next.slice(0, MAX_PROCESS_OUTPUT);
      };
      child.stdout?.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
      child.stderr?.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });
      const timer = setTimeout(() => { timedOut = true; this.terminate(child); }, timeoutSeconds * 1000);
      child.on('error', (error) => { clearTimeout(timer); this.activeProcesses.delete(child); reject(error); });
      child.on('close', (exitCode) => {
        clearTimeout(timer);
        this.activeProcesses.delete(child);
        if (this.cancelled) return reject(new Error('工具执行已取消'));
        resolve({ stdout, stderr, exitCode, timedOut, truncated });
      });
    });
  }

  private terminate(child: ChildProcess): void {
    if (child.killed || child.pid === undefined) return;
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    } else {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }
  }
}

function applyUnifiedDiff(content: string, diff: string): string {
  const lines = content.split(/\r?\n/);
  const diffLines = diff.split(/\r?\n/);
  const result: string[] = [];
  let currentLine = 0;
  let i = 0;
  let inHunk = false;

  while (i < diffLines.length) {
    const line = diffLines[i];

    // hunk 外部：跳过文件头和空行
    if (!inHunk) {
      if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('diff ') || line.startsWith('index ') || line.trim() === '') {
        i++;
        continue;
      }
    }

    const hunkMatch = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
    if (hunkMatch) {
      inHunk = true;
      const oldStart = parseInt(hunkMatch[1], 10) - 1;
      const oldCount = hunkMatch[2] !== undefined ? parseInt(hunkMatch[2], 10) : 1;

      while (currentLine < oldStart && currentLine < lines.length) {
        result.push(lines[currentLine]);
        currentLine++;
      }
      i++;
      let consumed = 0;
      while (i < diffLines.length) {
        const hunkLine = diffLines[i];
        if (hunkLine.startsWith('@@') || hunkLine.startsWith('---') || hunkLine.startsWith('+++')) {
          inHunk = false;
          break;
        }
        // "\ No newline at end of file" 标记：跳过
        if (hunkLine.startsWith('\\')) {
          i++;
          continue;
        }
        // hunk 内的裸空行视为空上下文行（某些 diff 生成器不补前导空格）
        if (hunkLine === '') {
          result.push('');
          currentLine++;
          consumed++;
          i++;
          continue;
        }
        if (hunkLine.startsWith(' ')) {
          const expected = hunkLine.slice(1);
          const actual = lines[currentLine] ?? '';
          if (expected !== actual) {
            throw new Error(`diff 上下文不匹配：第 ${currentLine + 1} 行期望 "${expected}"，实际 "${actual}"`);
          }
          result.push(actual);
          currentLine++;
          consumed++;
        } else if (hunkLine.startsWith('-')) {
          const actual = lines[currentLine] ?? '';
          const expected = hunkLine.slice(1);
          if (actual !== expected) {
            throw new Error(`diff 删除行不匹配：第 ${currentLine + 1} 行期望 "${expected}"，实际 "${actual}"`);
          }
          currentLine++;
          consumed++;
        } else if (hunkLine.startsWith('+')) {
          result.push(hunkLine.slice(1));
        } else {
          break;
        }
        i++;
      }
      continue;
    }

    // hunk 外部的非空非头行：跳过
    i++;
  }

  while (currentLine < lines.length) {
    result.push(lines[currentLine]);
    currentLine++;
  }

  return result.join('\n');
}
