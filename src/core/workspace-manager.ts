import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { Workspace, CreateWorkspaceInput } from '../models/types';
import type { CoordinatorDB } from '../db/database';
import { getWorkspaceDBPath } from '../db/db-path';

/**
 * WorkspaceManager — 管理全局工作区列表（存于全局库的 workspaces 表）。
 * 一个工作区 = 一个本地项目文件夹，业务数据隔离在该目录的 .coordinator/coordinator.db。
 *
 * 注意：本类只管元数据 CRUD；切换工作区时的 DB 实例重建由插件层（extension.ts）负责，
 * 因为涉及关闭旧 CoordinatorDB + 打开新 CoordinatorDB + 重建所有 core manager。
 */
export class WorkspaceManager {
  private db: CoordinatorDB | null = null;

  setDB(db: CoordinatorDB): void {
    this.db = db;
  }

  list(): Workspace[] {
    if (!this.db) return [];
    return this.db.listWorkspaces() as Workspace[];
  }

  get(id: string): Workspace | undefined {
    if (!this.db) return undefined;
    return this.db.getWorkspace(id) as Workspace | undefined;
  }

  getByPath(folderPath: string): Workspace | undefined {
    if (!this.db) return undefined;
    return this.db.getWorkspaceByPath(folderPath) as Workspace | undefined;
  }

  /**
   * 注册新工作区。
   * - 在目标文件夹下创建 .coordinator/ 目录（业务 db 将存于此）
   * - 写入全局 workspaces 表
   * 返回的 workspace.dbPath 指向该目录的 coordinator.db（首次切换时由插件层初始化）
   */
  add(input: CreateWorkspaceInput): Workspace {
    if (!this.db) throw new Error('DB not initialized');
    const folderPath = path.resolve(input.folderPath);
    if (!fs.existsSync(folderPath)) {
      throw new Error(`文件夹不存在: ${folderPath}`);
    }
    if (this.db.getWorkspaceByPath(folderPath)) {
      throw new Error(`该文件夹已注册为工作区: ${folderPath}`);
    }

    // 确保目标目录有 .coordinator/ 子目录
    const coordDir = path.join(folderPath, '.coordinator');
    if (!fs.existsSync(coordDir)) {
      fs.mkdirSync(coordDir, { recursive: true });
    }

    const now = new Date().toISOString();
    const workspace: Workspace = {
      id: randomUUID(),
      name: input.name,
      folderPath,
      dbPath: getWorkspaceDBPath(coordDir),
      createdAt: now,
      lastActiveAt: now,
    };
    this.db.insertWorkspace(workspace);
    return workspace;
  }

  rename(id: string, name: string): Workspace {
    if (!this.db) throw new Error('DB not initialized');
    const ws = this.db.getWorkspace(id);
    if (!ws) throw new Error(`Workspace not found: ${id}`);
    this.db.updateWorkspace(id, { name });
    return this.db.getWorkspace(id) as Workspace;
  }

  /** 更新最后激活时间（切换工作区时调用） */
  touchActive(id: string): void {
    if (!this.db) return;
    this.db.updateWorkspace(id, { lastActiveAt: new Date().toISOString() });
  }

  /**
   * 移除工作区记录。
   * @param deleteFiles 是否同时删除项目目录下的 .coordinator/ 文件夹（含业务 db）
   */
  remove(id: string, deleteFiles: boolean = false): boolean {
    if (!this.db) return false;
    const ws = this.db.getWorkspace(id);
    if (!ws) return false;

    if (deleteFiles) {
      const coordDir = path.join(ws.folderPath, '.coordinator');
      if (fs.existsSync(coordDir)) {
        try {
          fs.rmSync(coordDir, { recursive: true, force: true });
        } catch (err) {
          console.error('[WorkspaceManager] 删除 .coordinator 目录失败:', err);
        }
      }
    }
    return this.db.deleteWorkspace(id);
  }
}
