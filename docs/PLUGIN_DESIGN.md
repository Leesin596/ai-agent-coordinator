# AI Agent Coordinator — VSCode 插件设计

> 目标：把现有本地协调器后端封装为 VSCode 插件，补齐「可配置工作区」与「会话角色」两大功能。

## 1. 总体架构

```
┌─────────────────────────────────────────────────────┐
│                   VSCode Extension Host (Node)       │
│                                                       │
│  ┌──────────────┐   postMessage   ┌───────────────┐  │
│  │  Webview UI  │ <─────────────> │ Extension Main│  │
│  │ (聊天/角色/  │                 │  (extension.ts)│  │
│  │  工作区面板) │                 │       │        │  │
│  └──────────────┘                 │       ▼        │  │
│                                   │ ┌────────────┐ │  │
│                                   │ │ Core 引擎  │ │  │
│                                   │ │ TaskMgr    │ │  │
│                                   │ │ ContractReg│ │  │
│                                   │ │ MemoryStore│ │  │
│                                   │ │ ContextCmp │ │  │
│                                   │ │ EventBus   │ │  │
│                                   │ │ WorkspaceMg│ │  │
│                                   │ │ RoleManager│ │  │
│                                   │ │ SessionMgr │ │  │
│                                   │ └─────┬──────┘ │  │
│                                   │       ▼        │  │
│                                   │ ┌────────────┐ │  │
│                                   │ │ sql.js(DB) │ │  │
│                                   │ │ .sqlite 文件│ │  │
│                                   │ └────────────┘ │  │
│                                   └───────────────┘  │
└─────────────────────────────────────────────────────┘
```

**关键决策**：
- 砍掉 express/ws/http 网络层，插件主进程直接实例化核心模块
- `better-sqlite3`（原生模块）→ `sql.js`（纯 WASM），规避 VSCode 原生编译
- Webview ↔ 主进程走 `postMessage`，主进程内直接调用 Core API

## 2. 数据库迁移：better-sqlite3 → sql.js

| 维度 | better-sqlite3 | sql.js |
|------|----------------|--------|
| 类型 | 原生 C++ addon | 纯 WASM |
| 编译 | 需要 node-gyp | 零编译 |
| API | 同步 | 同步（内存） |
| 持久化 | 自动写盘 | 手动 export |
| 适配 VSCode | ❌ ABI 冲突 | ✅ |

**持久化策略**：写入操作后 debounce 300ms `db.export()` 到 `.coordinator/coordinator.db`，启动时 `fs.readFileSync` 加载。

## 3. 工作区（Workspace）

### 3.1 语义
一个工作区 = 一个本地项目文件夹。每个工作区独立 SQLite 文件，数据完全隔离。

### 3.2 数据模型
```sql
CREATE TABLE workspaces (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  folder_path  TEXT NOT NULL UNIQUE,
  db_path      TEXT NOT NULL,          -- {folder}/.coordinator/coordinator.db
  created_at   TEXT NOT NULL,
  last_active_at TEXT
);
```

> 注：workspaces 元数据存在**全局库**（`~/.coordinator/global.db`），各工作区业务数据存在各自目录的 `.coordinator/coordinator.db`。

### 3.3 操作
- 添加：VSCode 文件夹选择器 → 选目录 → 注册工作区 → 初始化该目录的 SQLite
- 切换：切换激活工作区 → 关闭旧 DB → 打开新 DB → 重建所有 Manager
- 移除：从全局库删除记录（不删项目文件，可选是否删 .coordinator 目录）
- 重命名：仅改 name 字段

## 4. 角色库（Roles）

### 4.1 数据模型
```sql
CREATE TABLE roles (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  category     TEXT NOT NULL,          -- engineering/product/design/qa/custom
  description  TEXT NOT NULL DEFAULT '',
  skills       TEXT NOT NULL DEFAULT '[]',  -- JSON array of skill strings
  system_prompt TEXT NOT NULL DEFAULT '',   -- 角色人设 prompt
  icon         TEXT,                          -- emoji
  built_in     INTEGER NOT NULL DEFAULT 0,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
```

### 4.2 内置角色
| 名称 | 分类 | 图标 | 职责 |
|------|------|------|------|
| Vue 开发 | engineering | 🎨 | Vue 2/3、组件、路由、状态与工程化 |
| React 开发 | engineering | R | React/Next.js、SSR、状态与组件测试 |
| Go 开发 | engineering | Go | Go 服务、并发、模块与性能诊断 |
| Java/JVM 开发 | engineering | JVM | Spring、ORM、并发、构建与 JVM 诊断 |
| PHP 开发 | engineering | PHP | Composer、主流框架、运行时与质量工具链 |
| Python 开发 | engineering | Py | Web 框架、异步、类型、依赖与测试 |
| Rust 开发 | engineering | Rs | 所有权、异步、Cargo、unsafe 与跨平台构建 |
| 后端工程师 | engineering | ���️ | API/数据库/服务端逻辑 |
| 全栈工程师 | engineering | 🔧 | 前后端贯通 |
| 架构师 | engineering | 🏛️ | 系统设计/技术选型 |
| 测试工程师 | qa | 🧪 | 风险建模、测试分层与质量结论 |
| 代码审计 | qa | CA | Diff、调用链、影响面与发布风险审计 |
| 产品经理 | product | 📋 | 产品发现、PRD、优先级、指标与验收 |
| UI 设计实现 | design | 🖌️ | 视觉落地、Token、响应式与可访问性 |
| Agent 提示词简报 | product | AI | 可执行 Agent 简报、权限与停止条件 |

### 4.3 操作
- 新增/编辑/删除（内置角色不可删除）
- 普通启动仅补齐缺失内置角色与空 Skill 字段，不覆盖已有编辑
- 命令面板显式刷新内置角色到源码最新版本，自定义角色保持不变
- 按分类分组展示
- 选角色 → 「添加会话」→ 开聊天 Webview

## 5. 会话（Sessions）

### 5.1 数据模型
```sql
CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  role_id      TEXT NOT NULL REFERENCES roles(id),
  title        TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE messages (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role         TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
  content      TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
```

### 5.2 聊天流程
```
选角色 → 新建 session → 打开 Webview
  → 用户输入
  → 组装 system prompt = role.systemPrompt + role.skills
  → 可选：拉 compile_context(role.name) 作为额外上下文
  → 调 LLM API (OpenAI 兼容)
  → 存 message → 渲染
```

### 5.3 LLM 配置
插件设置项：
- `coordinator.llm.apiKey` — API Key
- `coordinator.llm.baseURL` — 默认 `https://api.openai.com/v1`
- `coordinator.llm.model` — 默认 `gpt-4o-mini`

### 5.4 会话间任务派发与上下文对齐

每个会话有独立 ID，可向**其他会话**派发任务。派发时双方需**对齐任务上下文**——派发方打包上下文载荷，接收方 review 后确认对齐或请求澄清，基于同一份上下文协作。这是协调器的核心协作能力。

#### 握手协议（两阶段对齐）
```
派发方                                    接收方
  | 1. dispatch(打包 context_payload)        |
  | ---------------------------------------> | status=proposed, align=pending
  |                                          |
  |                            2. reviewContext(查看完整对齐文档)
  |                                系统解析 related* 引用 → 实际内容
  |                                          |
  |                3a. align(确认对齐)        |
  | <--------------------------------------- | align=aligned
  |                3b. requestClarify(澄清)  |
  | <--------------------------------------- | align=clarify
  |                                          |
  | 4. supplementContext(补充上下文)         |
  | ---------------------------------------> | align=pending
  |                                          |
  |                5. accept(接受)            |
  | <--------------------------------------- | status=accepted→in_progress
  |                                          |
  |                6. complete(完成+结果)     |
  | <--------------------------------------- | status=completed
  |   (任一时刻) reject / cancel             |
```

#### 数据模型
```sql
CREATE TABLE session_tasks (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL,
  source_session_id TEXT NOT NULL,
  target_session_id TEXT NOT NULL,
  source_role_id    TEXT NOT NULL,
  target_role_id    TEXT NOT NULL,
  title             TEXT NOT NULL,
  brief             TEXT NOT NULL DEFAULT '',
  context_payload   TEXT NOT NULL DEFAULT '{}',   -- 派发方打包的对齐上下文
  alignment_status  TEXT NOT NULL DEFAULT 'pending'
                    CHECK(alignment_status IN ('pending','aligned','clarify','rejected')),
  alignment_note    TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'proposed'
                    CHECK(status IN ('proposed','accepted','in_progress','completed','cancelled','failed')),
  result            TEXT NOT NULL DEFAULT '',
  parent_task_id    TEXT,                           -- 可选: 关联项目任务看板
  priority          TEXT NOT NULL DEFAULT 'medium',
  created_at        TEXT NOT NULL,
  aligned_at        TEXT, accepted_at TEXT, completed_at TEXT,
  metadata          TEXT NOT NULL DEFAULT '{}'
);
```

#### 上下文载荷（context_payload）
派发方打包给接收方的对齐上下文，含：目标、验收标准、进展摘要、期望产出、约束、对话摘要，以及 `relatedTasks`/`relatedContracts`/`relatedMemories` **引用**。
`reviewContext` 时系统把这些引用**解析成实际内容**（拉取真实 task/contract/memory），编译成双方共享的 Markdown 对齐文档——这就是"两个会话对齐任务上下文"的落地。

#### 核心 API（SessionTaskDispatcher）
| 方法 | 操作方 | 说明 |
|------|--------|------|
| `dispatch(input)` | 派发方 | 派发任务 + 打包上下文 |
| `reviewContext(taskId)` | 接收方 | 查看完整对齐文档（引用已解析为实际内容） |
| `align(taskId)` | 接收方 | 确认对齐 |
| `requestClarify(taskId, note)` | 接收方 | 请求澄清 |
| `supplementContext(taskId, supplement)` | 派发方 | 补充上下文（回应澄清） |
| `accept(taskId)` | 接收方 | 接受（自动转 in_progress） |
| `reject(taskId, reason)` | 接收方 | 拒绝 |
| `complete(taskId, result)` | 接收方 | 完成 + 回填结果 |
| `cancel(taskId, reason)` | 派发方 | 取消 |

所有状态流转发布 `session_task.*` 系列事件，驱动 UI 实时刷新。

## 6. 插件目录结构

```
vscode-extension/
├── package.json              # extension manifest
├── tsconfig.json
├── src/
│   ├── extension.ts          # activate/deactivate 入口
│   ├── backend/
│   │   ├── db.ts             # sql.js 封装（迁移自 src/db/database.ts）
│   │   ├── schema.sql        # 完整 schema（含 workspaces/roles/sessions/messages）
│   │   ├── workspace-manager.ts
│   │   ├── role-manager.ts
│   │   ├── session-manager.ts
│   │   └── session-task-dispatcher.ts   # 会话间任务派发 + 上下文对齐
│   │   └── (复用) task-manager / contract-registry / memory-store / context-compiler / event-bus
│   ├── ui/
│   │   ├── workspace-tree.ts   # 工作区 TreeView
│   │   ├── role-tree.ts        # 角色库 TreeView
│   │   ├── chat-panel.ts       # 聊天 Webview
│   │   └── role-editor.ts      # 角色编辑 Webview
│   ├── llm/
│   │   └── client.ts           # OpenAI 兼容客户端
│   └── commands/
│       └── index.ts            # 命令注册
├── media/                      # Webview 静态资源
│   ├── chat.css
│   ├── chat.js
│   └── role-editor.js
└── webviews/                   # Webview HTML
    ├── chat.html
    └── role-editor.html
```

## 7. 命令清单

| 命令 | 说明 |
|------|------|
| `coordinator.addWorkspace` | 添加工作区（文件夹选择器） |
| `coordinator.switchWorkspace` | 切换激活工作区 |
| `coordinator.removeWorkspace` | 移除工作区 |
| `coordinator.renameWorkspace` | 重命名工作区 |
| `coordinator.addRole` | 新增角色 |
| `coordinator.editRole` | 编辑角色 |
| `coordinator.deleteRole` | 删除角色 |
| `coordinator.startSession` | 选角色开会话（打开聊天面板） |
| `coordinator.dispatchTask` | 向其他会话派发任务（打包对齐上下文） |
| `coordinator.reviewTaskContext` | 查看任务对齐上下文（接收方） |
| `coordinator.alignTask` | 确认对齐任务上下文 |
| `coordinator.openDashboard` | 打开协调器面板（任务/契约/记忆概览） |

## 8. 实施阶段

1. **阶段 0** — 数据库迁移 sql.js + 数据模型扩展（workspaces/roles/sessions/messages/session_tasks）✅
2. **阶段 1** — 插件骨架 + 后端核心集成 + 命令注册
3. **阶段 2** — 工作区管理 UI
4. **阶段 3** — 角色库管理 UI
5. **阶段 4** — 聊天会话 Webview + LLM 接入
6. **阶段 5** — 会话间任务派发 UI（派发面板 + 对齐上下文查看 + 握手交互）✅ 后端已就绪
