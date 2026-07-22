-- AI Agent Coordinator — SQLite Schema
-- 适用于 sql.js (WASM) 内存库，所有表 IF NOT EXISTS 幂等创建
-- 全局库（workspaces/roles）与工作区库共用此 schema，空表不占空间

PRAGMA foreign_keys = ON;

-- ============================================================
-- Tasks
-- ============================================================
CREATE TABLE IF NOT EXISTS tasks (
  id            TEXT PRIMARY KEY,
  project       TEXT NOT NULL DEFAULT 'default',
  title         TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK(status IN ('pending','ready','in_progress','blocked','done','failed')),
  assignee      TEXT NOT NULL,
  dependencies  TEXT NOT NULL DEFAULT '[]',
  dependents    TEXT NOT NULL DEFAULT '[]',
  inputs        TEXT NOT NULL DEFAULT '{}',
  outputs       TEXT NOT NULL DEFAULT '{}',
  contract_refs TEXT NOT NULL DEFAULT '[]',
  priority      TEXT NOT NULL DEFAULT 'medium'
                CHECK(priority IN ('critical','high','medium','low')),
  version       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  completed_at  TEXT,
  metadata      TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_tasks_project  ON tasks(project);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee);
CREATE INDEX IF NOT EXISTS idx_tasks_status   ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);

-- ============================================================
-- Contracts
-- ============================================================
CREATE TABLE IF NOT EXISTS contracts (
  id               TEXT PRIMARY KEY,
  project          TEXT NOT NULL DEFAULT 'default',
  name             TEXT NOT NULL,
  type             TEXT NOT NULL CHECK(type IN ('api','data_model','event','config')),
  version          INTEGER NOT NULL DEFAULT 1,
  status           TEXT NOT NULL DEFAULT 'draft'
                   CHECK(status IN ('draft','proposed','agreed','implemented','deprecated')),
  producer         TEXT NOT NULL,
  consumers        TEXT NOT NULL DEFAULT '[]',
  schema           TEXT NOT NULL DEFAULT '{}',
  examples         TEXT NOT NULL DEFAULT '[]',
  breaking_changes TEXT NOT NULL DEFAULT '[]',
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  metadata         TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_contracts_project  ON contracts(project);
CREATE INDEX IF NOT EXISTS idx_contracts_producer ON contracts(producer);
CREATE INDEX IF NOT EXISTS idx_contracts_status   ON contracts(status);
CREATE INDEX IF NOT EXISTS idx_contracts_type     ON contracts(type);

-- ============================================================
-- Contract History (append-only)
-- ============================================================
CREATE TABLE IF NOT EXISTS contract_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project     TEXT NOT NULL DEFAULT 'default',
  contract_id TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  snapshot    TEXT NOT NULL,
  changed_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_contract_history_cid ON contract_history(contract_id);

-- ============================================================
-- Memories
-- ============================================================
CREATE TABLE IF NOT EXISTS memories (
  id         TEXT PRIMARY KEY,
  project    TEXT NOT NULL DEFAULT 'default',
  category   TEXT NOT NULL CHECK(category IN ('decision','convention','architecture','lesson','note')),
  title      TEXT NOT NULL,
  content    TEXT NOT NULL,
  tags       TEXT NOT NULL DEFAULT '[]',
  scope      TEXT NOT NULL DEFAULT 'global',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  [references] TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS idx_memories_project    ON memories(project);
CREATE INDEX IF NOT EXISTS idx_memories_category   ON memories(category);
CREATE INDEX IF NOT EXISTS idx_memories_scope      ON memories(scope);
CREATE INDEX IF NOT EXISTS idx_memories_created_by ON memories(created_by);

-- ============================================================
-- Events (append-only log)
-- ============================================================
CREATE TABLE IF NOT EXISTS events (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  id        TEXT NOT NULL UNIQUE,
  project   TEXT NOT NULL DEFAULT 'default',
  type      TEXT NOT NULL,
  source    TEXT NOT NULL,
  target    TEXT,
  payload   TEXT NOT NULL DEFAULT '{}',
  timestamp TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_type   ON events(type);
CREATE INDEX IF NOT EXISTS idx_events_source ON events(source);
CREATE INDEX IF NOT EXISTS idx_events_target ON events(target);

-- ============================================================
-- Agents
-- ============================================================
CREATE TABLE IF NOT EXISTS agents (
  project        TEXT NOT NULL DEFAULT 'default',
  role           TEXT NOT NULL,
  instance_id    TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'online' CHECK(status IN ('online','offline')),
  last_seen      TEXT NOT NULL,
  last_event_seq INTEGER DEFAULT 0,
  metadata       TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (project, role, instance_id)
);

-- ============================================================
-- Workspaces (全局库)
-- 一个工作区 = 一个本地项目文件夹，数据按目录隔离
-- ============================================================
CREATE TABLE IF NOT EXISTS workspaces (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  folder_path    TEXT NOT NULL UNIQUE,
  db_path        TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  last_active_at TEXT
);

-- ============================================================
-- Roles (全局库) — 会话角色定义
-- ============================================================
CREATE TABLE IF NOT EXISTS roles (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  category      TEXT NOT NULL,           -- engineering/product/design/qa/custom
  description   TEXT NOT NULL DEFAULT '',
  skill_slug    TEXT NOT NULL DEFAULT '',
  skills        TEXT NOT NULL DEFAULT '[]',     -- JSON array of skill strings
  skill_content TEXT NOT NULL DEFAULT '',
  system_prompt TEXT NOT NULL DEFAULT '',        -- 角色人设 prompt
  icon          TEXT,                              -- emoji
  built_in      INTEGER NOT NULL DEFAULT 0,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  llm_config    TEXT NOT NULL DEFAULT '{}',       -- JSON: 角色级 LLM 配置（apiKey/baseURL/model/temperature，留空回退全局）
  allowed_tools TEXT NOT NULL DEFAULT '[]',       -- JSON: 允许的工具名称白名单
  denied_tools  TEXT NOT NULL DEFAULT '[]',       -- JSON: 禁止的工具名称黑名单
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_roles_category ON roles(category);
CREATE INDEX IF NOT EXISTS idx_roles_builtin  ON roles(built_in);

-- ============================================================
-- Sessions (工作区库) — AI 会话
-- ============================================================
CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  role_id      TEXT NOT NULL,
  title        TEXT NOT NULL,
  model_id     TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_id);
CREATE INDEX IF NOT EXISTS idx_sessions_role      ON sessions(role_id);

-- ============================================================
-- Messages (工作区库) — 会话消息
-- ============================================================
CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role       TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);

-- ============================================================
-- Session Tasks (工作区库) — 会话间任务派发 + 上下文对齐
-- 一个会话(source)向另一个会话(target)派发任务，派发时打包对齐上下文(context_payload)，
-- 接收方 review 后确认对齐 / 请求澄清，双方基于同一份上下文协作。
-- 握手: proposed → (align|clarify) → accepted → in_progress → completed
-- ============================================================
CREATE TABLE IF NOT EXISTS session_tasks (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL,
  source_session_id TEXT NOT NULL,
  target_session_id TEXT NOT NULL,
  source_role_id    TEXT NOT NULL,
  target_role_id    TEXT NOT NULL,
  title             TEXT NOT NULL,
  brief             TEXT NOT NULL DEFAULT '',
  context_payload   TEXT NOT NULL DEFAULT '{}',   -- 派发方打包的对齐上下文 (JSON: TaskContextPayload)
  alignment_status  TEXT NOT NULL DEFAULT 'pending'
                    CHECK(alignment_status IN ('pending','aligned','clarify','rejected')),
  alignment_note    TEXT NOT NULL DEFAULT '',      -- 接收方对齐反馈 / 澄清问题 / 拒绝原因
  status            TEXT NOT NULL DEFAULT 'proposed'
                    CHECK(status IN ('proposed','accepted','in_progress','completed','cancelled','failed')),
  result            TEXT NOT NULL DEFAULT '',      -- 接收方完成后回填的结果
  parent_task_id    TEXT,                           -- 可选: 关联到项目任务看板 (tasks.id)
  priority          TEXT NOT NULL DEFAULT 'medium'
                    CHECK(priority IN ('critical','high','medium','low')),
  created_at        TEXT NOT NULL,
  aligned_at        TEXT,
  accepted_at       TEXT,
  completed_at      TEXT,
  metadata          TEXT NOT NULL DEFAULT '{}',
  version           INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_session_tasks_source    ON session_tasks(source_session_id);
CREATE INDEX IF NOT EXISTS idx_session_tasks_target    ON session_tasks(target_session_id);
CREATE INDEX IF NOT EXISTS idx_session_tasks_status    ON session_tasks(status);
CREATE INDEX IF NOT EXISTS idx_session_tasks_align     ON session_tasks(alignment_status);
CREATE INDEX IF NOT EXISTS idx_session_tasks_workspace ON session_tasks(workspace_id);
