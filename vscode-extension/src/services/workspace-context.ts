import * as fs from 'fs';
import * as path from 'path';
import type { Workspace } from '../../../src/models/types';
import type { ActiveWorkspaceRuntime, CoordinatorContext } from '../backend/coordinator-context';

const IGNORED_DIRECTORIES = new Set([
  '.git', '.coordinator', '.next', '.nuxt', '.output', '.turbo', '.venv',
  'build', 'coverage', 'dist', 'node_modules', 'out', 'target', 'vendor',
]);

const IMPORTANT_FILES = new Set([
  'cargo.toml', 'composer.json', 'go.mod', 'package.json', 'pyproject.toml',
  'readme', 'readme.md', 'requirements.txt', 'tsconfig.json',
]);

const TEXT_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.cs', '.css', '.go', '.h', '.html', '.java', '.js',
  '.json', '.jsx', '.kt', '.md', '.php', '.ps1', '.py', '.rb', '.rs', '.scss',
  '.sh', '.sql', '.svelte', '.swift', '.toml', '.ts', '.tsx', '.txt', '.vue',
  '.xml', '.yaml', '.yml',
]);

interface ProjectSnapshot {
  workspace: Workspace;
  files: string[];
}

function collectFiles(root: string, limit: number): string[] {
  const files: string[] = [];
  const pending = [''];
  while (pending.length > 0 && files.length < limit) {
    const relativeDir = pending.shift()!;
    const absoluteDir = path.join(root, relativeDir);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absoluteDir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= limit) break;
      if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
      const relativePath = path.join(relativeDir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name.toLowerCase())) pending.push(relativePath);
      } else if (entry.isFile()) {
        files.push(relativePath);
      }
    }
  }
  return files;
}

function queryTerms(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}_.-]+/u).filter((term) => term.length >= 3))];
}

function fileScore(relativePath: string, terms: string[]): number {
  const normalized = relativePath.toLowerCase().replace(/\\/g, '/');
  const name = path.basename(normalized);
  let score = IMPORTANT_FILES.has(name) || name.startsWith('readme') ? 20 : 0;
  for (const term of terms) {
    if (name.includes(term)) score += 8;
    else if (normalized.includes(term)) score += 3;
  }
  return score;
}

function readSelectedFiles(snapshot: ProjectSnapshot, query: string, budget: number): string[] {
  const terms = queryTerms(query);
  const selected = snapshot.files
    .map((relativePath) => ({ relativePath, score: fileScore(relativePath, terms) }))
    .filter(({ relativePath, score }) => score > 0 && (
      TEXT_EXTENSIONS.has(path.extname(relativePath).toLowerCase()) ||
      IMPORTANT_FILES.has(path.basename(relativePath).toLowerCase())
    ))
    .sort((a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath))
    .slice(0, 8);

  const sections: string[] = [];
  let used = 0;
  for (const { relativePath } of selected) {
    if (used >= budget) break;
    try {
      const content = fs.readFileSync(path.join(snapshot.workspace.folderPath, relativePath), 'utf8');
      const remaining = budget - used;
      const excerpt = content.slice(0, Math.min(remaining, 5000));
      used += excerpt.length;
      sections.push(`### ${snapshot.workspace.name}/${relativePath.replace(/\\/g, '/')}\n\`\`\`text\n${excerpt}\n\`\`\``);
    } catch {
      continue;
    }
  }
  return sections;
}

export function buildWorkspaceContext(
  ctx: CoordinatorContext,
  runtime: ActiveWorkspaceRuntime,
  currentSessionId: string,
  query: string,
): string {
  const workspaces = ctx.listWorkspaces();
  const snapshots = workspaces.map((workspace) => ({
    workspace,
    files: collectFiles(workspace.folderPath, 1200),
  }));
  const sessions = runtime.sessionManager.list(runtime.workspace.id);
  const lines: string[] = [
    '## Coordinator 工作区环境',
    `当前激活项目：${runtime.workspace.name}`,
    `当前项目根目录：${runtime.workspace.folderPath}`,
    `已引入项目数：${workspaces.length}`,
    '你可以同时基于下列所有已引入项目的只读上下文进行分析，不要声称自己不知道当前项目或项目数量。',
    '',
    '### 已引入项目',
  ];

  for (const snapshot of snapshots) {
    const activeLabel = snapshot.workspace.id === runtime.workspace.id ? '（当前激活）' : '';
    lines.push(`- ${snapshot.workspace.name}${activeLabel}: ${snapshot.workspace.folderPath}`);
    const visibleFiles = snapshot.files.slice(0, 80).map((file) => file.replace(/\\/g, '/'));
    lines.push(`  文件概览 (${snapshot.files.length}${snapshot.files.length >= 1200 ? '+' : ''}): ${visibleFiles.join(', ') || '空目录'}`);
  }

  lines.push('', '### 当前项目协作会话');
  if (sessions.length === 0) {
    lines.push('- 暂无会话');
  } else {
    for (const session of sessions) {
      const role = runtime.roleManager.get(session.roleId);
      const self = session.id === currentSessionId ? '（你自己）' : `[可派发: ${session.id.slice(0, 8)}]`;
      lines.push(`- ${role?.name || '未知角色'} ${self}: ${session.title}`);
      if (role?.skills?.length) lines.push(`  技能: ${role.skills.join(', ')}`);
    }
  }

  const perProjectBudget = Math.max(3000, Math.floor(24000 / Math.max(snapshots.length, 1)));
  const fileSections = snapshots.flatMap((snapshot) => readSelectedFiles(snapshot, query, perProjectBudget));
  if (fileSections.length > 0) {
    lines.push('', '## 与当前问题相关的跨项目文件内容', ...fileSections);
  }

  if (sessions.length > 1) {
    lines.push(
      '',
      '## 派发任务',
      '需要其他会话协助时使用：',
      '```dispatch',
      'target: <目标会话ID>',
      'title: <任务标题>',
      'objective: <任务目标/详细描述>',
      '```',
    );
  }

  return lines.join('\n');
}
