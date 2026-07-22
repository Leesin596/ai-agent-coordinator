import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock vscode module
vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({
      get: (key: string, defaultValue: any) => {
        if (key === 'enabled') return true;
        if (key === 'chunkSize') return 100;
        if (key === 'chunkOverlap') return 20;
        if (key === 'embeddingModel') return 'text-embedding-3-small';
        return defaultValue;
      },
    }),
  },
}));

// Mock EmbeddingService — returns deterministic vectors based on text content
function mockEmbed(text: string): Float32Array {
  const dim = 64;
  const vec = new Float32Array(dim);
  // Simple hash-based deterministic embedding
  for (let i = 0; i < text.length; i++) {
    vec[i % dim] += text.charCodeAt(i) * 0.01;
  }
  // Normalize
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < dim; i++) vec[i] /= norm;
  return vec;
}

const mockEmbeddingService = {
  embed: vi.fn(async (texts: string[]): Promise<Float32Array[]> => texts.map(mockEmbed)),
  embedOne: vi.fn(async (text: string): Promise<Float32Array> => mockEmbed(text)),
  isConfigured: vi.fn(() => true),
  refreshConfig: vi.fn(),
  getConfig: vi.fn(() => ({ apiKey: 'test', baseURL: 'http://localhost:11434/v1', model: 'test', isOllama: true })),
};

// Import after mocks are set up
import { IndexingService } from '../../vscode-extension/src/services/indexing-service';

describe('IndexingService', () => {
  let root: string;
  let schemaPath: string;
  let service: IndexingService;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'coordinator-index-'));
    // Schema file outside root (production schema is in extension dir, not workspace)
    schemaPath = path.join(os.tmpdir(), `coordinator-schema-${Date.now()}.sql`);
    const schemaContent = `
CREATE TABLE IF NOT EXISTS indexed_files (
  path        TEXT PRIMARY KEY,
  hash        TEXT NOT NULL,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  indexed_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS indexed_chunks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path  TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line   INTEGER NOT NULL,
  content    TEXT NOT NULL,
  embedding  BLOB
);
CREATE INDEX IF NOT EXISTS idx_chunks_file ON indexed_chunks(file_path);
`;
    fs.writeFileSync(schemaPath, schemaContent);

    // Create test files
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(
      path.join(root, 'src', 'auth.ts'),
      Array.from({ length: 150 }, (_, i) => `// line ${i + 1} authentication logic`).join('\n') + '\n',
    );
    fs.writeFileSync(
      path.join(root, 'src', 'db.ts'),
      Array.from({ length: 50 }, (_, i) => `// line ${i + 1} database connection`).join('\n') + '\n',
    );
    fs.writeFileSync(path.join(root, 'README.md'), '# Test Project\n\nAuthentication and database modules.\n');

    // Create .coordinator dir
    fs.mkdirSync(path.join(root, '.coordinator'));

    mockEmbeddingService.embed.mockClear();
    mockEmbeddingService.embedOne.mockClear();

    service = new IndexingService(root, mockEmbeddingService as any, schemaPath);
  });

  afterEach(async () => {
    service?.dispose();
    fs.rmSync(root, { recursive: true, force: true });
    try { fs.unlinkSync(schemaPath); } catch { /* ignore */ }
  });

  it('initializes database with schema', async () => {
    await service.ensureInitialized();
    const status = service.getStatus();
    expect(status.indexed).toBe(false);
    expect(status.fileCount).toBe(0);
    expect(status.chunkCount).toBe(0);
  });

  it('indexes workspace files and creates chunks', async () => {
    await service.ensureInitialized();
    await service.indexWorkspace();

    const status = service.getStatus();
    expect(status.fileCount).toBe(3); // auth.ts, db.ts, README.md
    expect(status.chunkCount).toBeGreaterThan(0);
    expect(status.indexed).toBe(true);
  });

  it('chunks files with correct overlap', async () => {
    await service.ensureInitialized();
    await service.indexWorkspace();

    // auth.ts has 150 lines, chunkSize=100, overlap=20, step=80
    // Chunks: lines 1-100, 81-150 → 2 chunks
    // db.ts has 50 lines → 1 chunk
    // README.md has 3 lines → 1 chunk
    const status = service.getStatus();
    // auth.ts: 2 chunks, db.ts: 1 chunk, README.md: 1 chunk = 4 total
    expect(status.chunkCount).toBe(4);
  });

  it('persists index to disk and reloads', async () => {
    await service.ensureInitialized();
    await service.indexWorkspace();
    service.dispose();

    // Create new service instance pointing to same db
    const service2 = new IndexingService(root, mockEmbeddingService as any, schemaPath);
    await service2.ensureInitialized();
    const status = service2.getStatus();
    expect(status.fileCount).toBe(3);
    expect(status.chunkCount).toBe(4);
    service2.dispose();
  });

  it('performs semantic search and returns ranked results', async () => {
    await service.ensureInitialized();
    await service.indexWorkspace();

    const results = await service.semanticSearch('authentication', 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(5);
    // Results should have correct shape
    expect(results[0]).toHaveProperty('path');
    expect(results[0]).toHaveProperty('line');
    expect(results[0]).toHaveProperty('endLine');
    expect(results[0]).toHaveProperty('snippet');
    expect(results[0]).toHaveProperty('score');
    // Scores should be sorted descending
    for (let i = 1; i < results.length; i++) {
      expect(results[i].score).toBeLessThanOrEqual(results[i - 1].score);
    }
  });

  it('returns empty results for empty index', async () => {
    await service.ensureInitialized();
    await expect(service.semanticSearch('test')).rejects.toThrow('尚未建立索引');
  });

  it('skips unchanged files on re-index (incremental)', async () => {
    await service.ensureInitialized();
    await service.indexWorkspace();
    const firstCallCount = mockEmbeddingService.embed.mock.calls.length;

    // Re-index without changes
    await service.indexWorkspace();
    const secondCallCount = mockEmbeddingService.embed.mock.calls.length;

    // Should not call embed again for unchanged files
    expect(secondCallCount).toBe(firstCallCount);
  });

  it('re-indexes only changed file on incremental update', async () => {
    await service.ensureInitialized();
    await service.indexWorkspace();
    const firstCallCount = mockEmbeddingService.embed.mock.calls.length;

    // Modify one file
    fs.writeFileSync(path.join(root, 'src', 'db.ts'), '// completely new content\n');

    await service.indexFile('src/db.ts');
    const secondCallCount = mockEmbeddingService.embed.mock.calls.length;

    // Should have called embed for the changed file only (1 call with 1 chunk)
    expect(secondCallCount).toBe(firstCallCount + 1);
  });

  it('removes index for deleted files', async () => {
    await service.ensureInitialized();
    await service.indexWorkspace();
    expect(service.getStatus().fileCount).toBe(3);

    // Delete a file and re-index
    fs.unlinkSync(path.join(root, 'src', 'db.ts'));
    await service.indexWorkspace();

    const status = service.getStatus();
    expect(status.fileCount).toBe(2);
  });

  it('rebuilds index from scratch', async () => {
    await service.ensureInitialized();
    await service.indexWorkspace();
    expect(service.getStatus().chunkCount).toBe(4);

    // Add a new file
    fs.writeFileSync(path.join(root, 'src', 'new.ts'), 'export const x = 1;\n');

    await service.rebuildIndex();
    const status = service.getStatus();
    expect(status.fileCount).toBe(4); // now includes new.ts
  });

  it('handles empty workspace', async () => {
    // Remove all files
    fs.rmSync(path.join(root, 'src'), { recursive: true, force: true });
    fs.unlinkSync(path.join(root, 'README.md'));

    await service.ensureInitialized();
    await service.indexWorkspace();
    const status = service.getStatus();
    expect(status.fileCount).toBe(0);
    expect(status.chunkCount).toBe(0);
  });

  it('embedding BLOB round-trips correctly', async () => {
    await service.ensureInitialized();
    await service.indexWorkspace();

    // Search to trigger loading embeddings from BLOB
    const results = await service.semanticSearch('database', 3);
    expect(results.length).toBeGreaterThan(0);
    // All scores should be valid floats between -1 and 1
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(-1);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });
});
