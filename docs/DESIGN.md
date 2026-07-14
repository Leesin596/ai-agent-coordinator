# AI Agent Coordinator — 系统设计文档

## 1. 概述

AI Agent Coordinator（以下简称 Coordinator）是一个轻量级本地服务，充当多个 AI 编程助手之间的"中枢大脑"。它解决的核心问题是：**多个 AI Agent（如前端AI、后端AI）在同一项目中并行工作时，缺乏共享记忆、契约同步和任务协调能力**。

### 1.1 目标用户场景

```
用户同时打开两个 IDE 窗口：
- 窗口A：Windsurf + 前端AI → 开发 React 页面
- 窗口B：Cursor  + 后端AI → 开发 Node.js API

用户对前端AI说："做一个用户列表页面"
前端AI → 向 Coordinator 注册任务，声明依赖 "GET /api/users" 接口
Coordinator → 通知后端AI："前端需要 GET /api/users，schema 如下..."
后端AI → 开发接口，完成后向 Coordinator 注册契约
Coordinator → 通知前端AI："接口已就绪，实际 schema 如下..."
前端AI → 基于真实契约完成对接
```

---

## 2. 核心架构

### 2.1 技术选型

| 层 | 选型 | 理由 |
|----|------|------|
| 运行时 | Node.js + TypeScript | MCP 生态原生支持，AI IDE 通用 |
| 持久化 | sql.js（SQLite/WASM） | 零配置、单文件、无原生模块编译依赖 |
| 实时通信 | WebSocket（ws） | 低延迟事件推送 |
| API | REST（Express/Fastify） | 万能接入层，任何 AI 工具都可调用 |
| AI IDE 集成 | MCP Server Protocol | Windsurf/Cursor 等原生集成 |
| 文件同步层 | .coordinator/ 目录 | 降级方案，纯文件读写即可使用 |

### 2.2 五大核心模块

```
coordinator/
├── src/
│   ├── core/
│   │   ├── task-manager.ts      # 任务管理 & DAG 调度
│   │   ├── contract-registry.ts # 契约注册 & 校验
│   │   ├── context-compiler.ts  # 上下文编译 & 裁剪
│   │   ├── event-bus.ts         # 事件总线 & 通知
│   │   └── memory-store.ts      # 持久化记忆存储
│   ├── transport/
│   │   ├── rest-api.ts          # REST API 接入层
│   │   ├── websocket.ts         # WebSocket 实时通道
│   │   ├── mcp-server.ts        # MCP Protocol 接入层
│   │   └── file-sync.ts         # 文件系统同步（降级方案）
│   ├── models/
│   │   ├── task.ts              # 任务数据模型
│   │   ├── contract.ts          # 契约数据模型
│   │   ├── agent.ts             # Agent 数据模型
│   │   └── event.ts             # 事件数据模型
│   └── index.ts                 # 入口
├── .coordinator/                # 文件同步目录（项目级）
│   ├── tasks.json
│   ├── contracts.json
│   ├── memory.json
│   └── context/                 # 按 agent 分的上下文快照
│       ├── frontend.md
│       └── backend.md
├── package.json
├── tsconfig.json
└── docs/
    └── DESIGN.md                # 本文件
```

---

## 3. 模块详细设计

### 3.1 Task Manager（任务管理器）

**职责**：管理全局任务 DAG，解析依赖关系，自动调度可执行任务。

#### 数据模型

```typescript
interface Task {
  id: string;                          // UUID
  title: string;                       // 任务标题
  description: string;                 // 详细描述
  status: 'pending' | 'ready' | 'in_progress' | 'blocked' | 'done' | 'failed';
  assignee: string;                    // agent 角色标识，如 "frontend", "backend"
  dependencies: string[];              // 依赖的 task IDs
  dependents: string[];                // 被哪些 task 依赖
  inputs: Record<string, any>;         // 输入参数/上下文
  outputs: Record<string, any>;        // 产出物/结果
  contractRefs: string[];              // 关联的契约 IDs
  priority: 'critical' | 'high' | 'medium' | 'low';
  createdAt: string;                   // ISO 时间
  updatedAt: string;
  completedAt?: string;
  metadata: Record<string, any>;       // 扩展字段
}
```

#### 核心行为

1. **依赖解析**：当 task 的所有 dependencies 都为 `done`，自动将其状态从 `pending` → `ready`
2. **阻塞检测**：当某 task 失败，级联标记所有 dependents 为 `blocked`
3. **拓扑排序**：提供全局任务执行顺序视图
4. **环检测**：创建 task 时检测循环依赖，拒绝并报错

#### API

```
POST   /api/tasks                 # 创建任务
GET    /api/tasks                 # 列出所有任务（支持按 assignee/status 过滤）
GET    /api/tasks/:id             # 获取单个任务
PATCH  /api/tasks/:id             # 更新任务状态/内容
DELETE /api/tasks/:id             # 删除任务
GET    /api/tasks/ready           # 获取当前可执行的任务列表
GET    /api/tasks/graph           # 获取完整 DAG 视图
POST   /api/tasks/:id/complete    # 标记完成并传入 outputs
```

---

### 3.2 Contract Registry（契约注册表）

**职责**：管理 AI Agent 之间的接口契约（API 接口、数据模型、事件定义），确保双方对齐。

#### 数据模型

```typescript
interface Contract {
  id: string;                          // UUID
  name: string;                        // 契约名，如 "GET /api/users"
  type: 'api' | 'data_model' | 'event' | 'config';
  version: number;                     // 自增版本号
  status: 'draft' | 'proposed' | 'agreed' | 'implemented' | 'deprecated';
  producer: string;                    // 提供方 agent
  consumers: string[];                 // 消费方 agents
  schema: object;                      // JSON Schema / OpenAPI 片段
  examples: object[];                  // 示例数据
  breakingChanges: BreakingChange[];   // 破坏性变更记录
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, any>;
}

interface BreakingChange {
  version: number;
  description: string;
  affectedConsumers: string[];
  migrateGuide: string;
  timestamp: string;
}
```

#### 核心行为

1. **契约提议 → 协商 → 确认**：producer 提出 draft → consumers 确认 → agreed
2. **版本管理**：每次修改自动递增版本号
3. **破坏性变更检测**：对比 schema diff，自动检测字段删除/类型变更等
4. **自动通知**：契约变更时通过 Event Bus 通知所有 consumers

#### API

```
POST   /api/contracts              # 注册新契约
GET    /api/contracts              # 列出所有契约
GET    /api/contracts/:id          # 获取契约详情（含完整 schema）
PATCH  /api/contracts/:id          # 更新契约（触发版本递增 & 变更检测）
GET    /api/contracts/:id/history  # 契约变更历史
POST   /api/contracts/:id/agree    # consumer 确认契约
```

---

### 3.3 Context Compiler（上下文编译器）

**职责**：为每个 AI Agent 编译最小必要上下文，解决 token 窗口限制问题。

#### 设计思路

```
全局知识库（所有 tasks + contracts + memory）
        │
        ▼
┌─────────────────────────────┐
│    Context Compiler         │
│                             │
│  1. 角色过滤：只取与该 agent 相关的信息  │
│  2. 依赖展开：展开直接依赖的上下游 task  │
│  3. 契约注入：注入关联的 contract schema │
│  4. 预算裁剪：按 token 预算裁剪          │
│  5. 摘要生成：超预算部分生成摘要          │
│                             │
└─────────────────────────────┘
        │
        ▼
  Agent-specific Context（markdown/JSON）
```

#### 数据模型

```typescript
interface ContextRequest {
  agentRole: string;              // "frontend" | "backend" | ...
  tokenBudget: number;            // 可用 token 数（默认 8000）
  focusTaskId?: string;           // 当前聚焦的任务
  includeHistory: boolean;        // 是否包含历史决策
  format: 'markdown' | 'json';   // 输出格式
}

interface CompiledContext {
  agentRole: string;
  generatedAt: string;
  tokenEstimate: number;
  sections: {
    currentTask: string;          // 当前任务描述
    dependencies: string;         // 上下游依赖任务概况
    contracts: string;            // 相关契约 schema
    decisions: string;            // 相关历史决策
    conventions: string;          // 项目约定
    warnings: string;             // 冲突/阻塞警告
  };
}
```

#### API

```
POST   /api/context/compile       # 编译上下文
GET    /api/context/:agentRole    # 获取最新编译的上下文快照
```

---

### 3.4 Event Bus（事件总线）

**职责**：异步事件广播，驱动模块间协作和 Agent 实时通知。

#### 事件类型

```typescript
type EventType =
  // Task 事件
  | 'task.created'
  | 'task.status_changed'
  | 'task.completed'
  | 'task.blocked'
  | 'task.ready'
  // Contract 事件
  | 'contract.created'
  | 'contract.updated'
  | 'contract.breaking_change'
  | 'contract.agreed'
  // Agent 事件
  | 'agent.connected'
  | 'agent.disconnected'
  | 'agent.context_stale'
  // System 事件
  | 'system.conflict_detected'
  | 'system.sync_completed';

interface CoordinatorEvent {
  id: string;
  type: EventType;
  source: string;          // 触发源 agent
  target?: string;         // 目标 agent（空 = 广播）
  payload: any;
  timestamp: string;
}
```

#### 传输机制

| 通道 | 场景 | 延迟 |
|------|------|------|
| WebSocket | Agent 在线时实时推送 | ~ms |
| 文件写入 (.coordinator/events/) | Agent 离线/不支持 WS | poll 间隔 |
| MCP notification | 支持 MCP 的 IDE | ~ms |

---

### 3.5 Memory Store（记忆存储）

**职责**：持久化跨会话的项目知识、决策记录和约定。

#### 数据模型

```typescript
interface Memory {
  id: string;
  category: 'decision' | 'convention' | 'architecture' | 'lesson' | 'note';
  title: string;
  content: string;
  tags: string[];
  scope: string;            // "global" | "frontend" | "backend" | ...
  createdBy: string;        // agent role
  createdAt: string;
  updatedAt: string;
  references: string[];     // 关联的 task/contract IDs
}
```

#### API

```
POST   /api/memories               # 创建记忆
GET    /api/memories               # 列出（支持 category/scope/tag 过滤）
GET    /api/memories/search        # 语义搜索（基于关键词匹配）
PATCH  /api/memories/:id           # 更新
DELETE /api/memories/:id           # 删除
```

---

## 4. 接入层设计

### 4.1 三层接入策略

```
优先级高 ──► MCP Server（AI IDE 原生集成，工具调用最自然）
优先级中 ──► REST API + WebSocket（万能方案，任何 HTTP 客户端可用）
优先级低 ──► 文件同步（降级方案，AI 只需读写 .coordinator/ 目录文件）
```

### 4.2 MCP Server 工具定义

```typescript
// AI Agent 可调用的 MCP 工具：
tools: [
  "coordinator_register_agent",     // 注册 agent 身份
  "coordinator_create_task",        // 创建任务
  "coordinator_update_task",        // 更新任务
  "coordinator_list_tasks",         // 列出任务
  "coordinator_get_ready_tasks",    // 获取可执行任务
  "coordinator_register_contract",  // 注册契约
  "coordinator_get_contract",       // 获取契约
  "coordinator_compile_context",    // 编译上下文
  "coordinator_add_memory",         // 添加记忆
  "coordinator_search_memory",      // 搜索记忆
  "coordinator_get_events",         // 获取未读事件
  "coordinator_send_message",       // 向其他 agent 发消息
]
```

### 4.3 文件同步协议

```
.coordinator/
├── agents.json          # 已注册的 agents
├── tasks.json           # 全量任务列表
├── contracts.json       # 全量契约列表
├── memory.json          # 全量记忆
├── events/
│   ├── pending/         # 未处理的事件
│   │   ├── evt-001.json
│   │   └── evt-002.json
│   └── processed/       # 已处理的事件
├── context/
│   ├── frontend.md      # 前端 agent 的编译上下文
│   └── backend.md       # 后端 agent 的编译上下文
└── lock.json            # 简易锁，防止并发写冲突
```

---

## 5. 边界条件 & 约束

### 5.1 必须处理的边界条件

| # | 边界条件 | 处理策略 |
|---|---------|---------|
| 1 | **循环依赖** | Task 创建时做拓扑排序检测，拒绝形成环的依赖 |
| 2 | **契约冲突** | 同一接口被多个 agent 定义不同 schema → 标记冲突，通知人工介入 |
| 3 | **并发写入** | SQLite WAL 模式 + 乐观锁（version 字段），文件同步用 lock.json |
| 4 | **Agent 离线** | 事件队列持久化，agent 重连后补发未读事件 |
| 5 | **上下文超 token** | Context Compiler 按优先级裁剪：当前任务 > 直接依赖 > 契约 > 历史 |
| 6 | **大型项目** | 分 scope 管理，每个 agent 只加载自己 scope 的数据 |
| 7 | **Coordinator 崩溃** | SQLite 持久化 + WAL 保证崩溃恢复，启动时自动重建内存索引 |
| 8 | **Schema 版本不兼容** | 契约更新时自动 diff，breaking change 强制通知 + 阻塞依赖 task |
| 9 | **多项目隔离** | 每个项目独立的 .coordinator/ 目录和 SQLite 库 |
| 10 | **时钟不同步** | 所有时间戳使用 Coordinator 服务端时间，不依赖客户端时钟 |

### 5.2 不做 / 超出边界

| 不做的事 | 理由 |
|---------|------|
| 替代 AI 做编码决策 | Coordinator 只协调，不干预 AI 的代码生成 |
| 跨机器网络通信 | V1 只支持本机多窗口，不做分布式 |
| AI 模型调用 | 不内置 LLM 调用，摘要/分析由各 agent 自行完成 |
| 代码合并/Git 操作 | 不碰版本控制，只管任务和契约层面的协调 |
| 强制执行契约 | 只做检测和通知，不阻止 agent 编写不合规代码 |

---

## 6. 注意事项

### 6.1 技术风险

1. **MCP 协议兼容性**：不同 IDE 对 MCP 的支持程度不同，需要 REST API 作为保底
2. **文件同步竞争**：多进程同时写 .coordinator/ 文件可能丢数据，需要锁机制
3. **Token 估算精度**：不同模型的 tokenizer 不同，Context Compiler 的预算裁剪只能是估算
4. **Event 积压**：长时间离线的 agent 重连后可能收到大量事件，需要事件压缩/合并策略

### 6.2 设计原则

1. **最小侵入**：Coordinator 不修改项目源代码，所有数据在 `.coordinator/` 和独立 DB 中
2. **渐进式接入**：可以只用文件同步，也可以升级到 REST API，再到 MCP 集成
3. **Agent 自治**：Coordinator 提供信息，不强制 agent 行为，每个 AI 保持自主决策权
4. **人类优先**：任何冲突最终由人类决策，Coordinator 只做检测和通知
5. **可观测性**：所有事件持久化，支持回溯任意时间点的协调状态

### 6.3 性能目标

| 指标 | 目标值 |
|------|--------|
| API 响应延迟 | < 50ms（本地）|
| WebSocket 推送延迟 | < 10ms |
| 上下文编译时间 | < 200ms |
| SQLite 数据库大小 | < 100MB（万级事件） |
| 内存占用 | < 50MB |
| 启动时间 | < 1s |

---

## 7. 实现路线图

### Phase 1 — MVP（核心可用）
- [x] 项目脚手架 & 数据模型
- [ ] Task Manager（CRUD + 依赖解析）
- [ ] Contract Registry（CRUD + 版本管理）
- [ ] Memory Store（CRUD + 搜索）
- [ ] REST API 接入层
- [ ] 文件同步层（.coordinator/ 目录）
- [ ] CLI 工具（启动/停止/状态查看）

### Phase 2 — 实时协作
- [ ] WebSocket 事件推送
- [ ] Event Bus 完整实现
- [ ] Context Compiler（基础版）
- [ ] Agent 注册 & 心跳

### Phase 3 — AI IDE 集成
- [ ] MCP Server 实现
- [ ] Windsurf 集成测试
- [ ] Cursor 集成测试
- [ ] 上下文编译优化（token 预算裁剪）

### Phase 4 — 高级功能
- [ ] 破坏性变更自动检测
- [ ] 任务自动调度建议
- [ ] 多项目支持
- [ ] Web Dashboard（可视化任务 DAG）

---

## 8. 典型工作流示例

### 8.1 前后端协作开发用户管理功能

```
Step 1: 用户告诉前端 AI "做用户列表页面"
        前端 AI → coordinator_create_task({
          title: "用户列表页面",
          assignee: "frontend",
          dependencies: []
        })

Step 2: 前端 AI 分析需要后端接口
        前端 AI → coordinator_register_contract({
          name: "GET /api/users",
          type: "api",
          status: "proposed",
          producer: "backend",
          consumers: ["frontend"],
          schema: { /* 期望的响应 schema */ }
        })

Step 3: Coordinator 自动创建后端 task
        → Event: contract.created → 目标: backend
        → 自动生成 task: "实现 GET /api/users 接口"
          assignee: "backend", dependencies: []

Step 4: 后端 AI 收到通知，查看任务和契约
        后端 AI → coordinator_compile_context({
          agentRole: "backend",
          focusTaskId: "task-xxx"
        })
        → 获得编译后的上下文，包含前端期望的 schema

Step 5: 后端 AI 实现接口，更新契约为 implemented
        后端 AI → coordinator_update_contract({
          id: "contract-xxx",
          status: "implemented",
          schema: { /* 实际实现的 schema */ }
        })

Step 6: Coordinator 检测到 schema diff
        → 如果有 breaking change → 通知前端 AI
        → 如果兼容 → 标记 agreed，通知前端 AI 可对接

Step 7: 前端 AI 基于最终契约完成页面开发
        → coordinator_update_task({ status: "done" })
```
