import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

export interface Checkpoint {
  id: string;
  timestamp: number;
  label: string;
  files: string[];
}

export class CheckpointManager {
  private readonly shadowRepo: string;
  private readonly workspaceRoot: string;
  private initialized = false;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.shadowRepo = path.join(this.workspaceRoot, '.coordinator', 'checkpoints');
  }

  init(): void {
    if (this.initialized) return;
    if (!fs.existsSync(this.shadowRepo)) {
      fs.mkdirSync(this.shadowRepo, { recursive: true });
    }
    if (!fs.existsSync(path.join(this.shadowRepo, '.git'))) {
      execFileSync('git', ['init'], { cwd: this.shadowRepo, stdio: 'pipe', timeout: 5000 });
      execFileSync('git', ['config', 'user.email', 'coordinator@local'], { cwd: this.shadowRepo, stdio: 'pipe', timeout: 5000 });
      execFileSync('git', ['config', 'user.name', 'Coordinator'], { cwd: this.shadowRepo, stdio: 'pipe', timeout: 5000 });
    }
    this.initialized = true;
  }

  createCheckpoint(label: string, files: string[]): Checkpoint {
    this.init();
    const timestamp = Date.now();
    const id = `${timestamp}-${Math.random().toString(36).slice(2, 8)}`;

    for (const file of files) {
      const src = path.resolve(this.workspaceRoot, file);
      if (!fs.existsSync(src)) continue;
      const dest = path.join(this.shadowRepo, file);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }

    try {
      execFileSync('git', ['add', '-A'], { cwd: this.shadowRepo, stdio: 'pipe', timeout: 10000 });
      execFileSync('git', ['commit', '--allow-empty', '-m', label], {
        cwd: this.shadowRepo,
        stdio: 'pipe',
        timeout: 10000,
      });
    } catch {
      // No changes to commit is fine
    }

    return { id, timestamp, label, files };
  }

  listCheckpoints(): Checkpoint[] {
    this.init();
    try {
      const output = execFileSync('git', ['log', '--pretty=format:%H,%ct,%s'], {
        cwd: this.shadowRepo,
        stdio: 'pipe',
        timeout: 5000,
        encoding: 'utf8',
      });
      return output.trim().split('\n').filter(Boolean).map((line) => {
        const [hash, ts, ...labelParts] = line.split(',');
        const label = labelParts.join(',');
        const files = this.getCheckpointFiles(hash);
        return { id: hash, timestamp: parseInt(ts, 10) * 1000, label, files };
      });
    } catch {
      return [];
    }
  }

  private getCheckpointFiles(hash: string): string[] {
    try {
      const output = execFileSync('git', ['show', '--pretty=format:', '--name-only', hash], {
        cwd: this.shadowRepo,
        stdio: 'pipe',
        timeout: 5000,
        encoding: 'utf8',
      });
      return output.trim().split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }

  getCheckpointDiff(checkpointId: string): string {
    this.init();
    try {
      return execFileSync('git', ['diff', `${checkpointId}~1`, checkpointId], {
        cwd: this.shadowRepo,
        stdio: 'pipe',
        timeout: 10000,
        encoding: 'utf8',
      });
    } catch {
      // 首个 commit 没有 ~1，使用 --root 回退
      try {
        return execFileSync('git', ['diff', '--root', checkpointId], {
          cwd: this.shadowRepo,
          stdio: 'pipe',
          timeout: 10000,
          encoding: 'utf8',
        });
      } catch {
        return '';
      }
    }
  }

  rollback(checkpointId: string): string[] {
    this.init();
    try {
      const output = execFileSync('git', ['show', '--pretty=format:', '--name-only', checkpointId], {
        cwd: this.shadowRepo,
        stdio: 'pipe',
        timeout: 5000,
        encoding: 'utf8',
      });
      const checkpointFiles = output.trim().split('\n').filter(Boolean);

      // 恢复 checkpoint 时的文件
      for (const file of checkpointFiles) {
        const dest = path.join(this.workspaceRoot, file);
        try {
          const content = execFileSync('git', ['show', `${checkpointId}:${file}`], {
            cwd: this.shadowRepo,
            stdio: 'pipe',
            timeout: 10000,
          });
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest, content);
        } catch {
          if (fs.existsSync(dest)) fs.unlinkSync(dest);
        }
      }

      // 删除 checkpoint 之后新增的文件：列出当前 shadow repo 的所有文件，不在 checkpoint 文件列表中的需从工作区删除
      const allFilesOutput = execFileSync('git', ['ls-tree', '-r', '--name-only', checkpointId], {
        cwd: this.shadowRepo,
        stdio: 'pipe',
        timeout: 5000,
        encoding: 'utf8',
      });
      const allCheckpointFiles = new Set(allFilesOutput.trim().split('\n').filter(Boolean));

      // 获取当前工作区中被追踪的文件列表（通过最新 commit）
      const currentFilesOutput = execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD'], {
        cwd: this.shadowRepo,
        stdio: 'pipe',
        timeout: 5000,
        encoding: 'utf8',
      });
      const currentFiles = currentFilesOutput.trim().split('\n').filter(Boolean);

      for (const file of currentFiles) {
        if (!allCheckpointFiles.has(file)) {
          const dest = path.join(this.workspaceRoot, file);
          if (fs.existsSync(dest)) fs.unlinkSync(dest);
        }
      }

      return checkpointFiles;
    } catch (err) {
      throw new Error(`回滚失败: ${(err as Error).message}`);
    }
  }

  dispose(): void {
    // Shadow repo persists across sessions for history
  }
}
