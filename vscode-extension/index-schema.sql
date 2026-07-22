-- Codebase Indexing — SQLite Schema (sql.js)
-- 独立索引库，存储在 {workspace}/.coordinator/index.db
-- embedding 以 BLOB (Float32Array buffer) 存储，搜索时加载到内存做余弦相似度

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS indexed_files (
  path        TEXT PRIMARY KEY,
  hash        TEXT NOT NULL,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  indexed_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS indexed_chunks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path  TEXT NOT NULL REFERENCES indexed_files(path) ON DELETE CASCADE,
  start_line INTEGER NOT NULL,
  end_line   INTEGER NOT NULL,
  content    TEXT NOT NULL,
  embedding  BLOB
);

CREATE INDEX IF NOT EXISTS idx_chunks_file ON indexed_chunks(file_path);
