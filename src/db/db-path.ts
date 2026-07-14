import * as path from 'path';

export const DEFAULT_DB_DIR = '.coordinator';
export const DEFAULT_DB_FILENAME = 'coordinator.db';
export const DEFAULT_GLOBAL_DB_FILENAME = 'global.db';

export function getDefaultDBPath(cwd?: string): string {
  return path.join(cwd || process.cwd(), DEFAULT_DB_DIR, DEFAULT_DB_FILENAME);
}

export function getGlobalDBPath(globalDir: string): string {
  return path.join(globalDir, DEFAULT_GLOBAL_DB_FILENAME);
}

export function getWorkspaceDBPath(coordinatorDir: string): string {
  return path.join(coordinatorDir, DEFAULT_DB_FILENAME);
}

export function resolveDBPath(): string {
  return process.env.COORDINATOR_DB || getDefaultDBPath();
}
