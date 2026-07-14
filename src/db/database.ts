// ============================================================
// CoordinatorDB — sql.js (WASM) implementation
// 替换 better-sqlite3，规避 VSCode 插件原生模块编译问题。
// 保持所有公共方法签名不变，core 模块零改动。
// ============================================================
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import * as fs from 'fs';
import * as path from 'path';

const FLUSH_DEBOUNCE_MS = 300;

export class CoordinatorDB {
  private db!: SqlJsDatabase;
  private dbPath: string;
  private schemaPath: string;
  private lockFile: string;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private initPromise: Promise<void>;
  private inWriteLock: boolean = false;
  private lastKnownMtime: number = 0;
  private lastKnownSize: number = 0;
  private SQL: any = null;

  private constructor(dbPath: string, schemaPath: string) {
    this.dbPath = dbPath;
    this.schemaPath = schemaPath;
    this.lockFile = dbPath + '.lock';
    this.initPromise = this.init();
  }

  /** 异步工厂：初始化 sql.js + 加载已有数据 + 应用 schema */
  static async create(dbPath: string, schemaPath?: string): Promise<CoordinatorDB> {
    const resolvedSchema = schemaPath || path.join(__dirname, 'schema.sql');
    const instance = new CoordinatorDB(dbPath, resolvedSchema);
    await instance.initPromise;
    return instance;
  }

  get raw(): SqlJsDatabase {
    return this.db;
  }

  close(): void {
    this.flush();
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.releaseLock();
    try { this.db.close(); } catch { /* ignore */ }
  }

  // ============================================================
  // 持久化：写操作后 debounce export 到文件
  // ============================================================
  private scheduleFlush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.flush(), FLUSH_DEBOUNCE_MS);
  }

  flush(): void {
    if (!this.db) return;
    try {
      const data = this.db.export();
      const dir = path.dirname(this.dbPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmp = this.dbPath + '.tmp';
      fs.writeFileSync(tmp, Buffer.from(data));
      fs.renameSync(tmp, this.dbPath);
      const stat = fs.statSync(this.dbPath);
      this.lastKnownMtime = stat.mtimeMs;
      this.lastKnownSize = stat.size;
    } catch (err) {
      console.error('[DB] flush failed:', err);
    }
  }

  // ============================================================
  // 跨进程文件锁 + 磁盘同步
  // 解决：多个进程（VSCode 插件 / MCP Server / REST Server）
  // 各自持有独立 sql.js 内存库实例，并发写同一 DB 文件时
  // 后写入者覆盖前者的数据丢失问题。
  // 策略：写操作前获取独占锁 → 从磁盘重新加载最新数据 →
  // 执行 SQL → 立即刷盘 → 释放锁。
  // 读操作前检查文件 mtime，若被其他进程修改则重新加载。
  // ============================================================

  private acquireLock(): void {
    if (this.inWriteLock) return;
    const maxRetries = 60;
    const retryDelayMs = 50;
    for (let i = 0; i < maxRetries; i++) {
      try {
        const fd = fs.openSync(this.lockFile, 'wx');
        fs.writeSync(fd, String(process.pid));
        fs.closeSync(fd);
        this.inWriteLock = true;
        return;
      } catch (err: any) {
        if (err.code !== 'EEXIST') throw err;
        try {
          const pidStr = fs.readFileSync(this.lockFile, 'utf-8').trim();
          const pid = parseInt(pidStr, 10);
          if (pid && !this.isProcessAlive(pid)) {
            fs.unlinkSync(this.lockFile);
            continue;
          }
        } catch {
          try { fs.unlinkSync(this.lockFile); } catch { /* ignore */ }
          continue;
        }
        this.sleepSync(retryDelayMs);
      }
    }
    throw new Error(`Failed to acquire DB lock after ${maxRetries} retries: ${this.lockFile}`);
  }

  private releaseLock(): void {
    if (!this.inWriteLock) return;
    try { fs.unlinkSync(this.lockFile); } catch { /* ignore */ }
    this.inWriteLock = false;
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private sleepSync(ms: number): void {
    const start = Date.now();
    while (Date.now() - start < ms) { /* busy wait */ }
  }

  private reloadFromDisk(): void {
    if (!this.SQL || !fs.existsSync(this.dbPath)) return;
    const buffer = new Uint8Array(fs.readFileSync(this.dbPath));
    try { this.db.close(); } catch { /* ignore */ }
    this.db = new this.SQL.Database(buffer);
    this.db.run('PRAGMA foreign_keys = ON');
    try {
      const stat = fs.statSync(this.dbPath);
      this.lastKnownMtime = stat.mtimeMs;
      this.lastKnownSize = stat.size;
    } catch { /* ignore */ }
  }

  private checkAndReload(): void {
    if (this.inWriteLock) return;
    try {
      const stat = fs.statSync(this.dbPath);
      if (stat.mtimeMs !== this.lastKnownMtime || stat.size !== this.lastKnownSize) {
        this.reloadFromDisk();
      }
    } catch { /* file might not exist yet */ }
  }

  private withWriteLock<T>(fn: () => T): T {
    const alreadyLocked = this.inWriteLock;
    if (!alreadyLocked) {
      this.acquireLock();
      this.reloadFromDisk();
    }
    try {
      const result = fn();
      if (!alreadyLocked) {
        this.flush();
      }
      return result;
    } finally {
      if (!alreadyLocked) {
        this.releaseLock();
      }
    }
  }

  // ============================================================
  // 底层执行辅助（同步，sql.js 内存库）
  // ============================================================

  /** 把命名参数对象 key 补 @ 前缀以匹配 SQL 占位符 */
  private normalizeParams(params: any): any {
    if (Array.isArray(params)) return params;
    if (!params || typeof params !== 'object') return params;
    const out: Record<string, any> = {};
    for (const k of Object.keys(params)) {
      if (k.startsWith('@') || k.startsWith(':') || k.startsWith('$')) {
        out[k] = params[k];
      } else {
        out['@' + k] = params[k];
      }
    }
    return out;
  }

  private exec(sql: string, params?: any): number {
    let modified = 0;
    this.withWriteLock(() => {
      this.db.run(sql, this.normalizeParams(params));
      modified = this.db.getRowsModified();
    });
    return modified;
  }

  private queryOne(sql: string, params?: any): any | undefined {
    this.checkAndReload();
    const stmt = this.db.prepare(sql);
    try {
      stmt.bind(this.normalizeParams(params));
      let row: any | undefined;
      if (stmt.step()) {
        row = stmt.getAsObject();
      }
      return row;
    } finally {
      stmt.free();
    }
  }

  private queryAll(sql: string, params?: any): any[] {
    this.checkAndReload();
    const stmt = this.db.prepare(sql);
    const rows: any[] = [];
    try {
      stmt.bind(this.normalizeParams(params));
      while (stmt.step()) {
        rows.push(stmt.getAsObject());
      }
      return rows;
    } finally {
      stmt.free();
    }
  }

  transaction<T>(fn: () => T): T {
    this.acquireLock();
    try {
      this.reloadFromDisk();
      this.db.run('BEGIN');
      const result = fn();
      this.db.run('COMMIT');
      this.flush();
      return result;
    } catch (err) {
      try { this.db.run('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    } finally {
      this.releaseLock();
    }
  }

  private async init(): Promise<void> {
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // sql.js 在 Node 下需显式指定 wasm 文件路径（默认 locateFile 仅适用浏览器）
    const wasmDir = path.dirname(require.resolve('sql.js/dist/sql-wasm.js'));
    this.SQL = await initSqlJs({
      locateFile: (file: string) => path.join(wasmDir, file),
    });

    let buffer: Uint8Array | undefined;
    if (fs.existsSync(this.dbPath)) {
      buffer = new Uint8Array(fs.readFileSync(this.dbPath));
      const stat = fs.statSync(this.dbPath);
      this.lastKnownMtime = stat.mtimeMs;
      this.lastKnownSize = stat.size;
    }
    this.db = buffer ? new this.SQL.Database(buffer) : new this.SQL.Database();
    this.db.run('PRAGMA foreign_keys = ON');

    const schemaSQL = fs.readFileSync(this.schemaPath, 'utf-8');
    this.db.exec(schemaSQL);

    // 增量迁移：已有库的表可能缺少新列（CREATE TABLE IF NOT EXISTS 不会补列）
    this.migrateRolesColumns();
    this.migrateSessionsColumns();
    this.migrateSessionTasksColumns();
  }

  /**
   * 迁移 roles 表新增列：检查列是否存在，不存在则 ADD COLUMN。
   * 幂等：多次执行无副作用。
   */
  private migrateRolesColumns(): void {
    const requiredColumns: Record<string, string> = {
      // 列名 → DDL 类型定义
      skill_slug: "TEXT NOT NULL DEFAULT ''",
      skill_content: "TEXT NOT NULL DEFAULT ''",
      llm_config: "TEXT NOT NULL DEFAULT '{}'",
    };
    const existing = new Set(this.listTableColumns('roles'));
    for (const [col, ddl] of Object.entries(requiredColumns)) {
      if (!existing.has(col)) {
        this.exec(`ALTER TABLE roles ADD COLUMN ${col} ${ddl}`);
        console.log(`[DB] migrated roles.${col} (added)`);
      }
    }
  }

  /**
   * 迁移 sessions 表新增列：检查列是否存在，不存在则 ADD COLUMN。
   * 幂等：多次执行无副作用。
   */
  private migrateSessionsColumns(): void {
    const requiredColumns: Record<string, string> = {
      model_id: 'TEXT',
    };
    const existing = new Set(this.listTableColumns('sessions'));
    for (const [col, ddl] of Object.entries(requiredColumns)) {
      if (!existing.has(col)) {
        this.exec(`ALTER TABLE sessions ADD COLUMN ${col} ${ddl}`);
        console.log(`[DB] migrated sessions.${col} (added)`);
      }
    }
  }

  private migrateSessionTasksColumns(): void {
    const requiredColumns: Record<string, string> = {
      version: 'INTEGER NOT NULL DEFAULT 1',
    };
    const existing = new Set(this.listTableColumns('session_tasks'));
    for (const [col, ddl] of Object.entries(requiredColumns)) {
      if (!existing.has(col)) {
        this.exec(`ALTER TABLE session_tasks ADD COLUMN ${col} ${ddl}`);
        console.log(`[DB] migrated session_tasks.${col} (added)`);
      }
    }
  }

  /** 查询表的列名列表（用于迁移判断） */
  private listTableColumns(table: string): string[] {
    const rows = this.queryAll(`PRAGMA table_info(${table})`, {});
    return rows.map((r) => r.name as string);
  }

  // ============================================================
  // Tasks
  // ============================================================

  insertTask(task: Record<string, any>): void {
    this.exec(`
      INSERT INTO tasks (id, project, title, description, status, assignee, dependencies, dependents,
        inputs, outputs, contract_refs, priority, version, created_at, updated_at, completed_at, metadata)
      VALUES (@id, @project, @title, @description, @status, @assignee, @dependencies, @dependents,
        @inputs, @outputs, @contract_refs, @priority, @version, @created_at, @updated_at, @completed_at, @metadata)
    `, {
      id: task.id,
      project: task.project || 'default',
      title: task.title,
      description: task.description,
      status: task.status,
      assignee: task.assignee,
      dependencies: JSON.stringify(task.dependencies),
      dependents: JSON.stringify(task.dependents),
      inputs: JSON.stringify(task.inputs),
      outputs: JSON.stringify(task.outputs),
      contract_refs: JSON.stringify(task.contractRefs),
      priority: task.priority,
      version: task.version,
      created_at: task.createdAt,
      updated_at: task.updatedAt,
      completed_at: task.completedAt || null,
      metadata: JSON.stringify(task.metadata),
    });
  }

  getTask(id: string): Record<string, any> | undefined {
    const row = this.queryOne('SELECT * FROM tasks WHERE id = ?', [id]);
    return row ? this.rowToTask(row) : undefined;
  }

  listTasks(filter?: { assignee?: string; status?: string; project?: string }): Record<string, any>[] {
    let sql = 'SELECT * FROM tasks WHERE project = @project';
    const params: any = { project: filter?.project || 'default' };
    if (filter?.assignee) { sql += ' AND assignee = @assignee'; params.assignee = filter.assignee; }
    if (filter?.status) { sql += ' AND status = @status'; params.status = filter.status; }
    sql += ' ORDER BY created_at ASC';
    return this.queryAll(sql, params).map((r) => this.rowToTask(r));
  }

  updateTask(id: string, updates: Record<string, any>, expectedVersion: number): boolean {
    const setClauses: string[] = [];
    const params: any = { id, expected_version: expectedVersion };

    if (updates.status !== undefined) { setClauses.push('status = @status'); params.status = updates.status; }
    if (updates.outputs !== undefined) { setClauses.push('outputs = @outputs'); params.outputs = JSON.stringify(updates.outputs); }
    if (updates.dependents !== undefined) { setClauses.push('dependents = @dependents'); params.dependents = JSON.stringify(updates.dependents); }
    if (updates.dependencies !== undefined) { setClauses.push('dependencies = @dependencies'); params.dependencies = JSON.stringify(updates.dependencies); }
    if (updates.completedAt !== undefined) { setClauses.push('completed_at = @completed_at'); params.completed_at = updates.completedAt; }
    if (updates.updatedAt !== undefined) { setClauses.push('updated_at = @updated_at'); params.updated_at = updates.updatedAt; }

    setClauses.push('version = version + 1');

    const sql = `UPDATE tasks SET ${setClauses.join(', ')} WHERE id = @id AND version = @expected_version`;
    return this.exec(sql, params) > 0;
  }

  deleteTask(id: string): boolean {
    return this.exec('DELETE FROM tasks WHERE id = ?', [id]) > 0;
  }

  // ============================================================
  // Contracts
  // ============================================================

  insertContract(contract: Record<string, any>): void {
    this.exec(`
      INSERT INTO contracts (id, project, name, type, version, status, producer, consumers,
        schema, examples, breaking_changes, created_at, updated_at, metadata)
      VALUES (@id, @project, @name, @type, @version, @status, @producer, @consumers,
        @schema, @examples, @breaking_changes, @created_at, @updated_at, @metadata)
    `, {
      id: contract.id,
      project: contract.project || 'default',
      name: contract.name,
      type: contract.type,
      version: contract.version,
      status: contract.status,
      producer: contract.producer,
      consumers: JSON.stringify(contract.consumers),
      schema: JSON.stringify(contract.schema),
      examples: JSON.stringify(contract.examples),
      breaking_changes: JSON.stringify(contract.breakingChanges),
      created_at: contract.createdAt,
      updated_at: contract.updatedAt,
      metadata: JSON.stringify(contract.metadata),
    });
  }

  getContract(id: string): Record<string, any> | undefined {
    const row = this.queryOne('SELECT * FROM contracts WHERE id = ?', [id]);
    return row ? this.rowToContract(row) : undefined;
  }

  listContracts(filter?: { producer?: string; consumer?: string; type?: string; status?: string; project?: string }): Record<string, any>[] {
    let sql = 'SELECT * FROM contracts WHERE project = @project';
    const params: any = { project: filter?.project || 'default' };
    if (filter?.producer) { sql += ' AND producer = @producer'; params.producer = filter.producer; }
    if (filter?.type) { sql += ' AND type = @type'; params.type = filter.type; }
    if (filter?.status) { sql += ' AND status = @status'; params.status = filter.status; }
    sql += ' ORDER BY created_at ASC';
    let rows = this.queryAll(sql, params);

    if (filter?.consumer) {
      rows = rows.filter((r) => {
        const consumers: string[] = JSON.parse(r.consumers);
        return consumers.includes(filter.consumer!);
      });
    }
    return rows.map((r) => this.rowToContract(r));
  }

  updateContract(id: string, updates: Record<string, any>, expectedVersion?: number): boolean {
    const setClauses: string[] = [];
    const params: any = { id };

    if (updates.status !== undefined) { setClauses.push('status = @status'); params.status = updates.status; }
    if (updates.schema !== undefined) { setClauses.push('schema = @schema'); params.schema = JSON.stringify(updates.schema); }
    if (updates.consumers !== undefined) { setClauses.push('consumers = @consumers'); params.consumers = JSON.stringify(updates.consumers); }
    if (updates.examples !== undefined) { setClauses.push('examples = @examples'); params.examples = JSON.stringify(updates.examples); }
    if (updates.breakingChanges !== undefined) { setClauses.push('breaking_changes = @breaking_changes'); params.breaking_changes = JSON.stringify(updates.breakingChanges); }
    if (updates.metadata !== undefined) { setClauses.push('metadata = @metadata'); params.metadata = JSON.stringify(updates.metadata); }
    if (updates.updatedAt !== undefined) { setClauses.push('updated_at = @updated_at'); params.updated_at = updates.updatedAt; }

    setClauses.push('version = version + 1');

    let whereClause = 'WHERE id = @id';
    if (expectedVersion !== undefined) {
      whereClause += ' AND version = @expected_version';
      params.expected_version = expectedVersion;
    }

    const sql = `UPDATE contracts SET ${setClauses.join(', ')} ${whereClause}`;
    return this.exec(sql, params) > 0;
  }

  insertContractHistory(contractId: string, version: number, snapshot: Record<string, any>): void {
    this.exec(
      'INSERT INTO contract_history (contract_id, version, snapshot, changed_at) VALUES (@contract_id, @version, @snapshot, @changed_at)',
      { contract_id: contractId, version, snapshot: JSON.stringify(snapshot), changed_at: new Date().toISOString() }
    );
  }

  getContractHistory(contractId: string): Record<string, any>[] {
    const rows = this.queryAll(
      'SELECT * FROM contract_history WHERE contract_id = ? ORDER BY version ASC',
      [contractId]
    );
    return rows.map((r) => JSON.parse(r.snapshot));
  }

  // ============================================================
  // Memories
  // ============================================================

  insertMemory(memory: Record<string, any>): void {
    this.exec(`
      INSERT INTO memories (id, project, category, title, content, tags, scope, created_by, created_at, updated_at, [references])
      VALUES (@id, @project, @category, @title, @content, @tags, @scope, @created_by, @created_at, @updated_at, @references)
    `, {
      id: memory.id,
      project: memory.project || 'default',
      category: memory.category,
      title: memory.title,
      content: memory.content,
      tags: JSON.stringify(memory.tags),
      scope: memory.scope,
      created_by: memory.createdBy,
      created_at: memory.createdAt,
      updated_at: memory.updatedAt,
      references: JSON.stringify(memory.references),
    });
  }

  getMemory(id: string): Record<string, any> | undefined {
    const row = this.queryOne('SELECT * FROM memories WHERE id = ?', [id]);
    return row ? this.rowToMemory(row) : undefined;
  }

  listMemories(filter?: { category?: string; scope?: string; tag?: string; createdBy?: string; project?: string }): Record<string, any>[] {
    let sql = 'SELECT * FROM memories WHERE project = @project';
    const params: any = { project: filter?.project || 'default' };
    if (filter?.category) { sql += ' AND category = @category'; params.category = filter.category; }
    if (filter?.scope) { sql += ' AND scope = @scope'; params.scope = filter.scope; }
    if (filter?.createdBy) { sql += ' AND created_by = @created_by'; params.created_by = filter.createdBy; }
    sql += ' ORDER BY created_at DESC';
    let rows = this.queryAll(sql, params);

    if (filter?.tag) {
      rows = rows.filter((r) => {
        const tags: string[] = JSON.parse(r.tags);
        return tags.includes(filter.tag!);
      });
    }
    return rows.map((r) => this.rowToMemory(r));
  }

  searchMemories(query: string, project: string = 'default'): Record<string, any>[] {
    const pattern = `%${query}%`;
    const rows = this.queryAll(
      'SELECT * FROM memories WHERE project = @project AND (title LIKE @p OR content LIKE @p OR tags LIKE @p) ORDER BY updated_at DESC',
      { project, p: pattern }
    );
    return rows.map((r) => this.rowToMemory(r));
  }

  updateMemory(id: string, updates: Record<string, any>): boolean {
    const setClauses: string[] = [];
    const params: any = { id };

    if (updates.title !== undefined) { setClauses.push('title = @title'); params.title = updates.title; }
    if (updates.content !== undefined) { setClauses.push('content = @content'); params.content = updates.content; }
    if (updates.tags !== undefined) { setClauses.push('tags = @tags'); params.tags = JSON.stringify(updates.tags); }
    if (updates.scope !== undefined) { setClauses.push('scope = @scope'); params.scope = updates.scope; }
    if (updates.references !== undefined) { setClauses.push('[references] = @ref'); params.ref = JSON.stringify(updates.references); }
    if (updates.updatedAt !== undefined) { setClauses.push('updated_at = @updated_at'); params.updated_at = updates.updatedAt; }

    if (setClauses.length === 0) return false;

    const sql = `UPDATE memories SET ${setClauses.join(', ')} WHERE id = @id`;
    return this.exec(sql, params) > 0;
  }

  deleteMemory(id: string): boolean {
    return this.exec('DELETE FROM memories WHERE id = ?', [id]) > 0;
  }

  // ============================================================
  // Events
  // ============================================================

  insertEvent(event: Record<string, any>): number {
    const result = this.exec(`
      INSERT INTO events (id, project, type, source, target, payload, timestamp)
      VALUES (@id, @project, @type, @source, @target, @payload, @timestamp)
    `, {
      id: event.id,
      project: event.project || 'default',
      type: event.type,
      source: event.source,
      target: event.target || null,
      payload: JSON.stringify(event.payload),
      timestamp: event.timestamp,
    });
    // sql.js 不直接返回 lastInsertRowid，用查询获取
    const row = this.queryOne('SELECT last_insert_rowid() AS seq');
    return row ? Number(row.seq) : 0;
  }

  getEventsSince(sinceSeq: number, limit: number = 200, project: string = 'default'): Record<string, any>[] {
    const rows = this.queryAll(
      'SELECT * FROM events WHERE project = @project AND seq > @seq ORDER BY seq ASC LIMIT @limit',
      { project, seq: sinceSeq, limit }
    );
    return rows.map((r) => ({
      seq: r.seq,
      id: r.id,
      type: r.type,
      source: r.source,
      target: r.target,
      payload: JSON.parse(r.payload),
      timestamp: r.timestamp,
    }));
  }

  getEventCount(project: string = 'default'): number {
    const row = this.queryOne('SELECT COUNT(*) AS cnt FROM events WHERE project = @project', { project });
    return row ? Number(row.cnt) : 0;
  }

  getMaxEventSeq(project: string = 'default'): number {
    const row = this.queryOne('SELECT MAX(seq) AS max_seq FROM events WHERE project = @project', { project });
    return row?.max_seq ? Number(row.max_seq) : 0;
  }

  // ============================================================
  // Agents
  // ============================================================

  upsertAgent(agent: Record<string, any>): void {
    this.exec(`
      INSERT INTO agents (project, role, instance_id, status, last_seen, last_event_seq, metadata)
      VALUES (@project, @role, @instance_id, @status, @last_seen, @last_event_seq, @metadata)
      ON CONFLICT(project, role, instance_id) DO UPDATE SET
        status = @status, last_seen = @last_seen, last_event_seq = @last_event_seq, metadata = @metadata
    `, {
      project: agent.project || 'default',
      role: agent.role,
      instance_id: agent.instanceId,
      status: agent.status,
      last_seen: agent.lastSeen,
      last_event_seq: agent.lastEventSeq || 0,
      metadata: JSON.stringify(agent.metadata || {}),
    });
  }

  getAgent(role: string, instanceId: string, project: string = 'default'): Record<string, any> | undefined {
    const row = this.queryOne(
      'SELECT * FROM agents WHERE project = @project AND role = @role AND instance_id = @instance_id',
      { project, role, instance_id: instanceId }
    );
    if (!row) return undefined;
    return {
      project: row.project,
      role: row.role,
      instanceId: row.instance_id,
      status: row.status,
      lastSeen: row.last_seen,
      lastEventSeq: row.last_event_seq,
      metadata: JSON.parse(row.metadata),
    };
  }

  listAgents(project: string = 'default'): Record<string, any>[] {
    const rows = this.queryAll(
      'SELECT * FROM agents WHERE project = @project ORDER BY role, instance_id',
      { project }
    );
    return rows.map((r) => ({
      project: r.project,
      role: r.role,
      instanceId: r.instance_id,
      status: r.status,
      lastSeen: r.last_seen,
      lastEventSeq: r.last_event_seq,
      metadata: JSON.parse(r.metadata),
    }));
  }

  // ============================================================
  // Workspaces (全局库)
  // ============================================================

  insertWorkspace(ws: Record<string, any>): void {
    this.exec(`
      INSERT INTO workspaces (id, name, folder_path, db_path, created_at, last_active_at)
      VALUES (@id, @name, @folder_path, @db_path, @created_at, @last_active_at)
    `, {
      id: ws.id,
      name: ws.name,
      folder_path: ws.folderPath,
      db_path: ws.dbPath,
      created_at: ws.createdAt,
      last_active_at: ws.lastActiveAt || null,
    });
  }

  getWorkspace(id: string): Record<string, any> | undefined {
    const row = this.queryOne('SELECT * FROM workspaces WHERE id = ?', [id]);
    return row ? this.rowToWorkspace(row) : undefined;
  }

  getWorkspaceByPath(folderPath: string): Record<string, any> | undefined {
    const row = this.queryOne('SELECT * FROM workspaces WHERE folder_path = ?', [folderPath]);
    return row ? this.rowToWorkspace(row) : undefined;
  }

  listWorkspaces(): Record<string, any>[] {
    // NULL last_active_at 排到最后：先按是否为空分组，再按时间倒序
    return this.queryAll(
      'SELECT * FROM workspaces ORDER BY (last_active_at IS NULL), last_active_at DESC, created_at DESC'
    ).map((r) => this.rowToWorkspace(r));
  }

  updateWorkspace(id: string, updates: Record<string, any>): boolean {
    const setClauses: string[] = [];
    const params: any = { id };
    if (updates.name !== undefined) { setClauses.push('name = @name'); params.name = updates.name; }
    if (updates.lastActiveAt !== undefined) { setClauses.push('last_active_at = @last_active_at'); params.last_active_at = updates.lastActiveAt; }
    if (setClauses.length === 0) return false;
    return this.exec(`UPDATE workspaces SET ${setClauses.join(', ')} WHERE id = @id`, params) > 0;
  }

  deleteWorkspace(id: string): boolean {
    return this.exec('DELETE FROM workspaces WHERE id = ?', [id]) > 0;
  }

  // ============================================================
  // Roles (全局库)
  // ============================================================

  insertRole(role: Record<string, any>): void {
    this.exec(`
      INSERT INTO roles (id, name, category, description, skill_slug, skills, skill_content, system_prompt, icon, built_in, sort_order, llm_config, created_at, updated_at)
      VALUES (@id, @name, @category, @description, @skill_slug, @skills, @skill_content, @system_prompt, @icon, @built_in, @sort_order, @llm_config, @created_at, @updated_at)
    `, {
      id: role.id,
      name: role.name,
      category: role.category,
      description: role.description || '',
      skill_slug: role.skillSlug || '',
      skills: JSON.stringify(role.skills || []),
      skill_content: role.skillContent || '',
      system_prompt: role.systemPrompt || '',
      icon: role.icon || null,
      built_in: role.builtIn ? 1 : 0,
      sort_order: role.sortOrder || 0,
      llm_config: JSON.stringify(role.llmConfig || {}),
      created_at: role.createdAt,
      updated_at: role.updatedAt,
    });
  }

  getRole(id: string): Record<string, any> | undefined {
    const row = this.queryOne('SELECT * FROM roles WHERE id = ?', [id]);
    return row ? this.rowToRole(row) : undefined;
  }

  listRoles(filter?: { category?: string; builtIn?: boolean }): Record<string, any>[] {
    let sql = 'SELECT * FROM roles';
    const params: any = {};
    const conditions: string[] = [];
    if (filter?.category) { conditions.push('category = @category'); params.category = filter.category; }
    if (filter?.builtIn !== undefined) { conditions.push('built_in = @built_in'); params.built_in = filter.builtIn ? 1 : 0; }
    if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY sort_order ASC, created_at ASC';
    return this.queryAll(sql, params).map((r) => this.rowToRole(r));
  }

  updateRole(id: string, updates: Record<string, any>): boolean {
    const setClauses: string[] = [];
    const params: any = { id };
    if (updates.name !== undefined) { setClauses.push('name = @name'); params.name = updates.name; }
    if (updates.category !== undefined) { setClauses.push('category = @category'); params.category = updates.category; }
    if (updates.description !== undefined) { setClauses.push('description = @description'); params.description = updates.description; }
    if (updates.skillSlug !== undefined) { setClauses.push('skill_slug = @skill_slug'); params.skill_slug = updates.skillSlug; }
    if (updates.skills !== undefined) { setClauses.push('skills = @skills'); params.skills = JSON.stringify(updates.skills); }
    if (updates.skillContent !== undefined) { setClauses.push('skill_content = @skill_content'); params.skill_content = updates.skillContent; }
    if (updates.systemPrompt !== undefined) { setClauses.push('system_prompt = @system_prompt'); params.system_prompt = updates.systemPrompt; }
    if (updates.icon !== undefined) { setClauses.push('icon = @icon'); params.icon = updates.icon; }
    if (updates.sortOrder !== undefined) { setClauses.push('sort_order = @sort_order'); params.sort_order = updates.sortOrder; }
    if (updates.llmConfig !== undefined) { setClauses.push('llm_config = @llm_config'); params.llm_config = JSON.stringify(updates.llmConfig || {}); }
    setClauses.push('updated_at = @updated_at'); params.updated_at = new Date().toISOString();
    if (setClauses.length === 1) return false;
    return this.exec(`UPDATE roles SET ${setClauses.join(', ')} WHERE id = @id`, params) > 0;
  }

  deleteRole(id: string): boolean {
    return this.exec('DELETE FROM roles WHERE id = ? AND built_in = 0', [id]) > 0;
  }

  // ============================================================
  // Sessions (工作区库)
  // ============================================================

  insertSession(session: Record<string, any>): void {
    this.exec(`
      INSERT INTO sessions (id, workspace_id, role_id, title, model_id, created_at, updated_at)
      VALUES (@id, @workspace_id, @role_id, @title, @model_id, @created_at, @updated_at)
    `, {
      id: session.id,
      workspace_id: session.workspaceId,
      role_id: session.roleId,
      title: session.title,
      model_id: session.modelId || null,
      created_at: session.createdAt,
      updated_at: session.updatedAt,
    });
  }

  getSession(id: string): Record<string, any> | undefined {
    const row = this.queryOne('SELECT * FROM sessions WHERE id = ?', [id]);
    return row ? this.rowToSession(row) : undefined;
  }

  listSessions(workspaceId: string): Record<string, any>[] {
    return this.queryAll(
      'SELECT * FROM sessions WHERE workspace_id = @wid ORDER BY updated_at DESC',
      { wid: workspaceId }
    ).map((r) => this.rowToSession(r));
  }

  updateSession(id: string, updates: Record<string, any>): boolean {
    const setClauses: string[] = [];
    const params: any = { id };
    if (updates.title !== undefined) { setClauses.push('title = @title'); params.title = updates.title; }
    if (updates.modelId !== undefined) { setClauses.push('model_id = @model_id'); params.model_id = updates.modelId || null; }
    if (updates.updatedAt !== undefined) { setClauses.push('updated_at = @updated_at'); params.updated_at = updates.updatedAt; }
    if (setClauses.length === 0) return false;
    return this.exec(`UPDATE sessions SET ${setClauses.join(', ')} WHERE id = @id`, params) > 0;
  }

  deleteSession(id: string): boolean {
    return this.exec('DELETE FROM sessions WHERE id = ?', [id]) > 0;
  }

  // ============================================================
  // Messages (工作区库)
  // ============================================================

  insertMessage(msg: Record<string, any>): void {
    this.exec(`
      INSERT INTO messages (id, session_id, role, content, created_at)
      VALUES (@id, @session_id, @role, @content, @created_at)
    `, {
      id: msg.id,
      session_id: msg.sessionId,
      role: msg.role,
      content: msg.content,
      created_at: msg.createdAt,
    });
  }

  listMessages(sessionId: string): Record<string, any>[] {
    return this.queryAll(
      'SELECT * FROM messages WHERE session_id = @sid ORDER BY created_at ASC',
      { sid: sessionId }
    ).map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      role: r.role,
      content: r.content,
      createdAt: r.created_at,
    }));
  }

  deleteMessage(id: string): boolean {
    return this.exec('DELETE FROM messages WHERE id = ?', [id]) > 0;
  }

  updateMessageContent(id: string, content: string): boolean {
    return this.exec('UPDATE messages SET content = ? WHERE id = ?', [content, id]) > 0;
  }

  // ============================================================
  // Session Tasks (工作区库) — 会话间任务派发 + 上下文对齐
  // ============================================================

  insertSessionTask(st: Record<string, any>): void {
    this.exec(`
      INSERT INTO session_tasks
        (id, workspace_id, source_session_id, target_session_id, source_role_id, target_role_id,
         title, brief, context_payload, alignment_status, alignment_note, status, result,
         parent_task_id, priority, created_at, aligned_at, accepted_at, completed_at, metadata, version)
      VALUES
        (@id, @workspace_id, @source_session_id, @target_session_id, @source_role_id, @target_role_id,
         @title, @brief, @context_payload, @alignment_status, @alignment_note, @status, @result,
         @parent_task_id, @priority, @created_at, @aligned_at, @accepted_at, @completed_at, @metadata, @version)
    `, {
      id: st.id,
      workspace_id: st.workspaceId,
      source_session_id: st.sourceSessionId,
      target_session_id: st.targetSessionId,
      source_role_id: st.sourceRoleId,
      target_role_id: st.targetRoleId,
      title: st.title,
      brief: st.brief || '',
      context_payload: JSON.stringify(st.contextPayload || {}),
      alignment_status: st.alignmentStatus || 'pending',
      alignment_note: st.alignmentNote || '',
      status: st.status || 'proposed',
      result: st.result || '',
      parent_task_id: st.parentTaskId || null,
      priority: st.priority || 'medium',
      created_at: st.createdAt,
      aligned_at: st.alignedAt || null,
      accepted_at: st.acceptedAt || null,
      completed_at: st.completedAt || null,
      metadata: JSON.stringify(st.metadata || {}),
      version: st.version || 1,
    });
  }

  getSessionTask(id: string): Record<string, any> | undefined {
    const row = this.queryOne('SELECT * FROM session_tasks WHERE id = ?', [id]);
    return row ? this.rowToSessionTask(row) : undefined;
  }

  listIncomingSessionTasks(sessionId: string): Record<string, any>[] {
    return this.queryAll(
      'SELECT * FROM session_tasks WHERE target_session_id = @sid ORDER BY created_at DESC',
      { sid: sessionId }
    ).map((r) => this.rowToSessionTask(r));
  }

  listOutgoingSessionTasks(sessionId: string): Record<string, any>[] {
    return this.queryAll(
      'SELECT * FROM session_tasks WHERE source_session_id = @sid ORDER BY created_at DESC',
      { sid: sessionId }
    ).map((r) => this.rowToSessionTask(r));
  }

  listSessionTasksByWorkspace(workspaceId: string): Record<string, any>[] {
    return this.queryAll(
      'SELECT * FROM session_tasks WHERE workspace_id = @wid ORDER BY created_at DESC',
      { wid: workspaceId }
    ).map((r) => this.rowToSessionTask(r));
  }

  updateSessionTask(id: string, updates: Record<string, any>, expectedVersion?: number): boolean {
    const setClauses: string[] = [];
    const params: any = { id };
    if (updates.alignmentStatus !== undefined) { setClauses.push('alignment_status = @alignment_status'); params.alignment_status = updates.alignmentStatus; }
    if (updates.alignmentNote !== undefined) { setClauses.push('alignment_note = @alignment_note'); params.alignment_note = updates.alignmentNote; }
    if (updates.status !== undefined) { setClauses.push('status = @status'); params.status = updates.status; }
    if (updates.result !== undefined) { setClauses.push('result = @result'); params.result = updates.result; }
    if (updates.contextPayload !== undefined) { setClauses.push('context_payload = @context_payload'); params.context_payload = JSON.stringify(updates.contextPayload); }
    if (updates.alignedAt !== undefined) { setClauses.push('aligned_at = @aligned_at'); params.aligned_at = updates.alignedAt || null; }
    if (updates.acceptedAt !== undefined) { setClauses.push('accepted_at = @accepted_at'); params.accepted_at = updates.acceptedAt || null; }
    if (updates.completedAt !== undefined) { setClauses.push('completed_at = @completed_at'); params.completed_at = updates.completedAt || null; }
    if (updates.metadata !== undefined) { setClauses.push('metadata = @metadata'); params.metadata = JSON.stringify(updates.metadata); }
    if (setClauses.length === 0) return false;

    setClauses.push('version = version + 1');

    let whereClause = 'WHERE id = @id';
    if (expectedVersion !== undefined) {
      whereClause += ' AND version = @expected_version';
      params.expected_version = expectedVersion;
    }

    return this.exec(`UPDATE session_tasks SET ${setClauses.join(', ')} ${whereClause}`, params) > 0;
  }

  deleteSessionTask(id: string): boolean {
    return this.exec('DELETE FROM session_tasks WHERE id = ?', [id]) > 0;
  }

  // ============================================================
  // Row 转换辅助
  // ============================================================

  private rowToTask(row: any): Record<string, any> {
    return {
      id: row.id,
      project: row.project,
      title: row.title,
      description: row.description,
      status: row.status,
      assignee: row.assignee,
      dependencies: JSON.parse(row.dependencies),
      dependents: JSON.parse(row.dependents),
      inputs: JSON.parse(row.inputs),
      outputs: JSON.parse(row.outputs),
      contractRefs: JSON.parse(row.contract_refs),
      priority: row.priority,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
      metadata: JSON.parse(row.metadata),
    };
  }

  private rowToContract(row: any): Record<string, any> {
    return {
      id: row.id,
      project: row.project,
      name: row.name,
      type: row.type,
      version: row.version,
      status: row.status,
      producer: row.producer,
      consumers: JSON.parse(row.consumers),
      schema: JSON.parse(row.schema),
      examples: JSON.parse(row.examples),
      breakingChanges: JSON.parse(row.breaking_changes),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      metadata: JSON.parse(row.metadata),
    };
  }

  private rowToMemory(row: any): Record<string, any> {
    return {
      id: row.id,
      project: row.project,
      category: row.category,
      title: row.title,
      content: row.content,
      tags: JSON.parse(row.tags),
      scope: row.scope,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      references: JSON.parse(row.references),
    };
  }

  private rowToWorkspace(row: any): Record<string, any> {
    return {
      id: row.id,
      name: row.name,
      folderPath: row.folder_path,
      dbPath: row.db_path,
      createdAt: row.created_at,
      lastActiveAt: row.last_active_at,
    };
  }

  private rowToRole(row: any): Record<string, any> {
    let llmConfig: any = {};
    if (row.llm_config !== undefined && row.llm_config !== null) {
      try { llmConfig = JSON.parse(row.llm_config) || {}; } catch { llmConfig = {}; }
    }
    return {
      id: row.id,
      name: row.name,
      category: row.category,
      description: row.description,
      skillSlug: row.skill_slug || '',
      skills: JSON.parse(row.skills),
      skillContent: row.skill_content || '',
      systemPrompt: row.system_prompt,
      icon: row.icon,
      builtIn: row.built_in === 1,
      sortOrder: row.sort_order,
      llmConfig,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private rowToSession(row: any): Record<string, any> {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      roleId: row.role_id,
      title: row.title,
      modelId: row.model_id || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private rowToSessionTask(row: any): Record<string, any> {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      sourceSessionId: row.source_session_id,
      targetSessionId: row.target_session_id,
      sourceRoleId: row.source_role_id,
      targetRoleId: row.target_role_id,
      title: row.title,
      brief: row.brief,
      contextPayload: JSON.parse(row.context_payload),
      alignmentStatus: row.alignment_status,
      alignmentNote: row.alignment_note,
      status: row.status,
      result: row.result,
      parentTaskId: row.parent_task_id || undefined,
      priority: row.priority,
      createdAt: row.created_at,
      alignedAt: row.aligned_at || undefined,
      acceptedAt: row.accepted_at || undefined,
      completedAt: row.completed_at || undefined,
      metadata: JSON.parse(row.metadata),
      version: row.version || 1,
    };
  }
}
