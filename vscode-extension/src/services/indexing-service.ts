// ============================================================
// IndexingService — 代码库语义索引 + 向量搜索
// 独立 sql.js 库存储 embedding BLOB，搜索时加载到内存做余弦相似度。
// 无原生依赖，复用 sql.js 基础设施。
// ============================================================
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { EmbeddingService } from './embedding-service';

const IGNORED_DIRECTORIES = new Set([
  '.aws', '.azure', '.git', '.coordinator', '.kube', '.next', '.nuxt', '.output',
  '.ssh', '.turbo', '.venv', 'build', 'coverage', 'dist', 'node_modules', 'out',
  'target', 'vendor',
]);

const DENIED_NAMES = new Set([
  '.env', '.npmrc', '.pypirc', 'credentials', 'credentials.json', 'id_dsa',
  'id_ecdsa', 'id_ed25519', 'id_rsa', 'secrets.json',
]);

const TEXT_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.cs', '.css', '.go', '.h', '.html', '.java', '.js',
  '.json', '.jsx', '.kt', '.md', '.php', '.ps1', '.py', '.rb', '.rs', '.scss',
  '.sh', '.sql', '.svelte', '.swift', '.toml', '.ts', '.tsx', '.txt', '.vue',
  '.xml', '.yaml', '.yml',
]);

const MAX_FILE_SIZE = 512 * 1024;
const MAX_FILES = 10000;
const SNIPPET_LENGTH = 200;
const FLUSH_DEBOUNCE_MS = 300;

export interface SearchResult {
  path: string;
  line: number;
  endLine: number;
  snippet: string;
  score: number;
}

export interface IndexStatus {
  indexed: boolean;
  fileCount: number;
  chunkCount: number;
  indexing: boolean;
}

type ProgressCallback = (done: number, total: number) => void;

function isBinary(content: Buffer): boolean {
  return content.subarray(0, Math.min(content.length, 8000)).includes(0);
}

function sha256(content: Buffer | string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

interface ChunkRow {
  id: number;
  file_path: string;
  start_line: number;
  end_line: number;
  content: string;
  embedding: Float32Array | null;
}

export class IndexingService {
  private root: string;
  private dbPath: string;
  private schemaPath: string;
  private embeddingService: EmbeddingService;
  private db: SqlJsDatabase | null = null;
  private SQL: any = null;
  private initPromise: Promise<void> | null = null;
  private indexing = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private chunkSize: number;
  private chunkOverlap: number;
  private vectorCache: ChunkRow[] | null = null;
  private vectorCacheDirty = true;

  constructor(rootPath: string, embeddingService: EmbeddingService, schemaPath?: string) {
    this.root = path.resolve(rootPath);
    this.dbPath = path.join(this.root, '.coordinator', 'index.db');
    this.embeddingService = embeddingService;

    // schema 路径：多路径 fallback
    const candidates = [
      schemaPath,
      path.join(__dirname, 'index-schema.sql'),
      path.join(__dirname, '..', 'index-schema.sql'),
      path.join(this.root, '..', 'vscode-extension', 'index-schema.sql'),
    ].filter(Boolean) as string[];
    this.schemaPath = candidates.find((p) => fs.existsSync(p)) || candidates[0];

    // 从 VSCode 配置读取分块参数
    const config = vscode.workspace.getConfiguration('coordinator.indexing');
    this.chunkSize = config.get<number>('chunkSize', 100);
    this.chunkOverlap = config.get<number>('chunkOverlap', 20);
  }

  async ensureInitialized(): Promise<void> {
    if (this.db) return;
    if (!this.initPromise) {
      this.initPromise = this.init();
    }
    await this.initPromise;
  }

  private async init(): Promise<void> {
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const wasmDir = path.dirname(require.resolve('sql.js/dist/sql-wasm.js'));
    this.SQL = await initSqlJs({ locateFile: (file: string) => path.join(wasmDir, file) });

    let buffer: Uint8Array | undefined;
    if (fs.existsSync(this.dbPath)) {
      buffer = new Uint8Array(fs.readFileSync(this.dbPath));
    }
    this.db = buffer ? new this.SQL.Database(buffer) : new this.SQL.Database();
    this.db!.run('PRAGMA foreign_keys = ON');

    if (fs.existsSync(this.schemaPath)) {
      const schemaSQL = fs.readFileSync(this.schemaPath, 'utf-8');
      this.db!.exec(schemaSQL);
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.flush(), FLUSH_DEBOUNCE_MS);
  }

  private flush(): void {
    if (!this.db) return;
    try {
      const data = this.db.export();
      const tmp = this.dbPath + '.tmp';
      fs.writeFileSync(tmp, Buffer.from(data));
      fs.renameSync(tmp, this.dbPath);
    } catch (err) {
      console.error('[IndexingService] flush failed:', err);
    }
  }

  /** 收集工作区所有可索引文件 */
  private collectFiles(): string[] {
    const files: string[] = [];
    const pending = [this.root];
    while (pending.length > 0 && files.length < MAX_FILES) {
      const dir = pending.shift()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (files.length >= MAX_FILES) break;
        if (entry.isSymbolicLink() || DENIED_NAMES.has(entry.name.toLowerCase())) continue;
        const absolute = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!IGNORED_DIRECTORIES.has(entry.name.toLowerCase())) pending.push(absolute);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (TEXT_EXTENSIONS.has(ext)) {
            files.push(absolute);
          }
        }
      }
    }
    return files;
  }

  private relative(absolute: string): string {
    return path.relative(this.root, absolute).replace(/\\/g, '/');
  }

  /** 将文件内容按行分块 */
  private chunkFile(content: string): Array<{ startLine: number; endLine: number; content: string }> {
    const lines = content.split(/\r?\n/);
    const chunks: Array<{ startLine: number; endLine: number; content: string }> = [];
    const step = this.chunkSize - this.chunkOverlap;
    for (let start = 0; start < lines.length; start += step) {
      const end = Math.min(start + this.chunkSize, lines.length);
      const chunkContent = lines.slice(start, end).join('\n');
      if (chunkContent.trim().length > 0) {
        chunks.push({ startLine: start + 1, endLine: end, content: chunkContent });
      }
      if (end >= lines.length) break;
    }
    return chunks;
  }

  /** 全量索引工作区 */
  async indexWorkspace(onProgress?: ProgressCallback): Promise<void> {
    await this.ensureInitialized();
    if (!this.db) throw new Error('索引数据库未初始化');
    if (this.indexing) throw new Error('索引正在执行中');
    this.indexing = true;
    this.vectorCacheDirty = true;

    try {
      const files = this.collectFiles();
      let done = 0;
      for (const absolutePath of files) {
        const relativePath = this.relative(absolutePath);
        try {
          await this.indexFileInternal(relativePath, absolutePath);
        } catch (err) {
          console.error(`[IndexingService] 索引失败 ${relativePath}:`, err);
        }
        done++;
        if (onProgress && done % 10 === 0) onProgress(done, files.length);
      }
      // 清理已删除文件的索引
      this.cleanDeletedFiles(files.map((f) => this.relative(f)));
      this.scheduleFlush();
      if (onProgress) onProgress(files.length, files.length);
    } finally {
      this.indexing = false;
    }
  }

  /** 增量索引单个文件（文件保存时触发） */
  async indexFile(relativePath: string): Promise<void> {
    await this.ensureInitialized();
    if (!this.db) return;
    const absolute = path.resolve(this.root, relativePath);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      this.removeFileIndex(relativePath);
      this.scheduleFlush();
      return;
    }
    const ext = path.extname(absolute).toLowerCase();
    if (!TEXT_EXTENSIONS.has(ext)) return;

    try {
      await this.indexFileInternal(relativePath, absolute);
      this.scheduleFlush();
    } catch (err) {
      console.error(`[IndexingService] 增量索引失败 ${relativePath}:`, err);
    }
  }

  private async indexFileInternal(relativePath: string, absolutePath: string): Promise<void> {
    if (!this.db) return;
    const stat = fs.statSync(absolutePath);
    if (stat.size > MAX_FILE_SIZE) return;
    const buffer = fs.readFileSync(absolutePath);
    if (isBinary(buffer)) return;
    const content = buffer.toString('utf8');
    const hash = sha256(buffer);

    // 检查是否需要重新索引（sql.js exec 不支持参数，用 prepare 代替）
    const stmt = this.db.prepare('SELECT hash FROM indexed_files WHERE path = ?');
    stmt.bind([relativePath]);
    let oldHash: string | null = null;
    if (stmt.step()) {
      oldHash = stmt.getAsObject().hash as string;
    }
    stmt.free();
    if (oldHash !== null && oldHash === hash) return; // 文件未变更，跳过

    const chunks = this.chunkFile(content);
    if (chunks.length === 0) return;

    // 生成 embeddings
    const embeddings = await this.embeddingService.embed(chunks.map((c) => c.content));

    // 删除旧索引
    this.removeFileIndex(relativePath);

    // 插入文件记录
    this.db.run(
      `INSERT INTO indexed_files (path, hash, chunk_count, indexed_at) VALUES (?, ?, ?, ?)`,
      [relativePath, hash, chunks.length, new Date().toISOString()],
    );

    // 插入 chunk 记录
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const embedding = embeddings[i];
      const embeddingBlob = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
      this.db.run(
        `INSERT INTO indexed_chunks (file_path, start_line, end_line, content, embedding) VALUES (?, ?, ?, ?, ?)`,
        [relativePath, chunk.startLine, chunk.endLine, chunk.content, embeddingBlob],
      );
    }

    this.vectorCacheDirty = true;
  }

  private removeFileIndex(relativePath: string): void {
    if (!this.db) return;
    this.db.run(`DELETE FROM indexed_chunks WHERE file_path = ?`, [relativePath]);
    this.db.run(`DELETE FROM indexed_files WHERE path = ?`, [relativePath]);
    this.vectorCacheDirty = true;
  }

  private cleanDeletedFiles(currentFiles: string[]): void {
    if (!this.db) return;
    const currentSet = new Set(currentFiles);
    const rows = this.db.exec('SELECT path FROM indexed_files');
    if (rows.length === 0) return;
    for (const row of rows[0].values) {
      const p = row[0] as string;
      if (!currentSet.has(p)) {
        this.removeFileIndex(p);
      }
    }
  }

  /** 全量重建索引 */
  async rebuildIndex(onProgress?: ProgressCallback): Promise<void> {
    await this.ensureInitialized();
    if (!this.db) return;
    this.db.exec('DELETE FROM indexed_chunks');
    this.db.exec('DELETE FROM indexed_files');
    this.vectorCacheDirty = true;
    this.flush();
    await this.indexWorkspace(onProgress);
  }

  /** 语义搜索 */
  async semanticSearch(query: string, topK: number = 10): Promise<SearchResult[]> {
    await this.ensureInitialized();
    if (!this.db) throw new Error('索引数据库未初始化');

    // 检查是否有索引数据
    const countResult = this.db.exec('SELECT COUNT(*) FROM indexed_chunks');
    const totalChunks = countResult.length > 0 ? (countResult[0].values[0][0] as number) : 0;
    if (totalChunks === 0) {
      throw new Error('代码库尚未建立索引，请先执行索引（命令面板搜索 "Rebuild Code Index"）');
    }

    // 生成查询向量
    const queryVector = await this.embeddingService.embedOne(query);

    // 加载所有 chunk embeddings（带缓存）
    const chunks = this.loadAllChunksCached();
    if (chunks.length === 0) {
      throw new Error('索引为空');
    }

    // 计算余弦相似度
    const scored: Array<{ chunk: ChunkRow; score: number }> = [];
    for (const chunk of chunks) {
      if (!chunk.embedding) continue;
      const score = cosineSimilarity(queryVector, chunk.embedding);
      scored.push({ chunk, score });
    }

    // 排序取 topK
    scored.sort((a, b) => b.score - a.score);
    const topResults = scored.slice(0, topK);

    return topResults.map(({ chunk, score }) => ({
      path: chunk.file_path,
      line: chunk.start_line,
      endLine: chunk.end_line,
      snippet: chunk.content.slice(0, SNIPPET_LENGTH),
      score: Math.round(score * 1000) / 1000,
    }));
  }

  /** 带缓存的 loadAllChunks，避免每次搜索都从数据库重新加载 */
  private loadAllChunksCached(): ChunkRow[] {
    if (this.vectorCache && !this.vectorCacheDirty) {
      return this.vectorCache;
    }
    this.vectorCache = this.loadAllChunks();
    this.vectorCacheDirty = false;
    return this.vectorCache;
  }

  private loadAllChunks(): ChunkRow[] {
    if (!this.db) return [];
    const rows = this.db.exec('SELECT id, file_path, start_line, end_line, content, embedding FROM indexed_chunks');
    if (rows.length === 0) return [];

    const result: ChunkRow[] = [];
    for (const row of rows[0].values) {
      const embeddingData = row[5] as Uint8Array | null;
      let embedding: Float32Array | null = null;
      if (embeddingData && embeddingData.byteLength > 0) {
        embedding = new Float32Array(embeddingData.buffer, embeddingData.byteOffset, embeddingData.byteLength / 4);
      }
      result.push({
        id: row[0] as number,
        file_path: row[1] as string,
        start_line: row[2] as number,
        end_line: row[3] as number,
        content: row[4] as string,
        embedding,
      });
    }
    return result;
  }

  /** 获取索引状态 */
  getStatus(): IndexStatus {
    if (!this.db) {
      return { indexed: false, fileCount: 0, chunkCount: 0, indexing: this.indexing };
    }
    try {
      const fileResult = this.db.exec('SELECT COUNT(*) FROM indexed_files');
      const chunkResult = this.db.exec('SELECT COUNT(*) FROM indexed_chunks');
      const fileCount = fileResult.length > 0 ? (fileResult[0].values[0][0] as number) : 0;
      const chunkCount = chunkResult.length > 0 ? (chunkResult[0].values[0][0] as number) : 0;
      return {
        indexed: chunkCount > 0,
        fileCount,
        chunkCount,
        indexing: this.indexing,
      };
    } catch {
      return { indexed: false, fileCount: 0, chunkCount: 0, indexing: this.indexing };
    }
  }

  dispose(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush();
    try { this.db?.close(); } catch { /* ignore */ }
    this.db = null;
    this.vectorCache = null;
  }
}

/** 余弦相似度 */
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}
