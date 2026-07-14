# AI Agent Coordinator — 完整调用指南

本文档详细介绍协调器的四种接入方式和完整调用示例。

---

## 目录

1. [REST API 调用](#1-rest-api-调用)
2. [WebSocket 实时通信](#2-websocket-实时通信)
3. [MCP Server (IDE 原生)](#3-mcp-server-ide-原生)
4. [FileSync 文件读取](#4-filesync-文件读取)
5. [典型工作流程](#5-典型工作流程)

---

## 1. REST API 调用

基础地址：`http://127.0.0.1:9700/api`

### 1.1 任务管理

#### 创建任务

```bash
curl -X POST http://127.0.0.1:9700/api/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "title": "实现用户登录页面",
    "description": "使用 React + Ant Design 实现登录页，含表单验证",
    "assignee": "frontend",
    "priority": "high",
    "dependencies": [],
    "inputs": {
      "designSpec": "参考 Figma 原型 #login-page",
      "apiContract": "contract-id-xxx"
    },
    "metadata": {
      "estimatedHours": 4
    }
  }'
```

响应：
```json
{
  "id": "task-abc123",
  "title": "实现用户登录页面",
  "status": "ready",
  "assignee": "frontend",
  "priority": "high",
  "dependencies": [],
  "dependents": [],
  "version": 1,
  "createdAt": "2026-05-27T03:00:00.000Z",
  ...
}
```

#### 创建有依赖的任务

```bash
# 后端任务依赖前端任务
curl -X POST http://127.0.0.1:9700/api/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "title": "实现登录 API 接口",
    "assignee": "backend",
    "priority": "high",
    "dependencies": ["task-abc123"]
  }'
```

此任务状态会自动设为 `pending`（因为依赖未完成），当依赖完成后自动变为 `ready`。

#### 查询任务

```bash
# 列出所有任务
curl http://127.0.0.1:9700/api/tasks

# 按角色过滤
curl "http://127.0.0.1:9700/api/tasks?assignee=frontend"

# 按状态过滤
curl "http://127.0.0.1:9700/api/tasks?status=ready"

# 同时过滤
curl "http://127.0.0.1:9700/api/tasks?assignee=backend&status=pending"

# 获取可执行任务（ready 状态）
curl http://127.0.0.1:9700/api/tasks/ready
curl "http://127.0.0.1:9700/api/tasks/ready?assignee=frontend"

# 获取任务详情
curl http://127.0.0.1:9700/api/tasks/task-abc123

# 获取 DAG 图（节点 + 边）
curl http://127.0.0.1:9700/api/tasks/graph
```

#### 更新任务状态

```bash
# 开始执行
curl -X PATCH http://127.0.0.1:9700/api/tasks/task-abc123 \
  -H "Content-Type: application/json" \
  -d '{ "status": "in_progress" }'

# 标记完成（附带产出）
curl -X POST http://127.0.0.1:9700/api/tasks/task-abc123/complete \
  -H "Content-Type: application/json" \
  -d '{
    "outputs": {
      "componentPath": "src/pages/Login.tsx",
      "testCoverage": "92%"
    }
  }'

# 标记失败
curl -X PATCH http://127.0.0.1:9700/api/tasks/task-abc123 \
  -H "Content-Type: application/json" \
  -d '{ "status": "failed" }'
```

**状态级联规则**：
- 任务完成 → 自动检查下游任务，依赖全满足则下游变为 `ready`
- 任务失败 → 下游任务自动变为 `blocked`

#### 删除任务

```bash
curl -X DELETE http://127.0.0.1:9700/api/tasks/task-abc123
```

---

### 1.2 契约管理

#### 创建契约

```bash
curl -X POST http://127.0.0.1:9700/api/contracts \
  -H "Content-Type: application/json" \
  -d '{
    "name": "POST /api/auth/login",
    "type": "api",
    "producer": "backend",
    "consumers": ["frontend"],
    "schema": {
      "method": "POST",
      "path": "/api/auth/login",
      "request": {
        "body": {
          "username": "string",
          "password": "string"
        }
      },
      "response": {
        "200": {
          "token": "string",
          "expiresIn": "number"
        },
        "401": {
          "error": "string"
        }
      }
    },
    "examples": [
      {
        "request": { "username": "admin", "password": "123456" },
        "response": { "token": "eyJhbG...", "expiresIn": 3600 }
      }
    ]
  }'
```

#### 查询契约

```bash
# 列出所有
curl http://127.0.0.1:9700/api/contracts

# 按生产者过滤
curl "http://127.0.0.1:9700/api/contracts?producer=backend"

# 按消费者过滤
curl "http://127.0.0.1:9700/api/contracts?consumer=frontend"

# 获取详情
curl http://127.0.0.1:9700/api/contracts/contract-xxx

# 获取变更历史
curl http://127.0.0.1:9700/api/contracts/contract-xxx/history
```

#### 更新契约（自动检测破坏性变更）

```bash
curl -X PATCH http://127.0.0.1:9700/api/contracts/contract-xxx \
  -H "Content-Type: application/json" \
  -d '{
    "schema": {
      "method": "POST",
      "path": "/api/auth/login",
      "request": {
        "body": {
          "username": "string",
          "password": "string",
          "captcha": "string"
        }
      },
      "response": {
        "200": { "token": "string", "refreshToken": "string", "expiresIn": "number" },
        "401": { "error": "string" }
      }
    }
  }'
```

如果检测到破坏性变更（如删除字段、修改类型），会自动发出 `contract.breaking_change` 事件通知消费者。

#### 确认契约

```bash
curl -X POST http://127.0.0.1:9700/api/contracts/contract-xxx/agree \
  -H "Content-Type: application/json" \
  -d '{ "consumer": "frontend" }'
```

---

### 1.3 记忆/知识管理

#### 存储知识

```bash
# 存储架构决策
curl -X POST http://127.0.0.1:9700/api/memories \
  -H "Content-Type: application/json" \
  -d '{
    "category": "decision",
    "title": "状态管理选择 Zustand",
    "content": "对比 Redux/MobX/Zustand 后决定使用 Zustand，因为它更轻量且 TypeScript 支持好",
    "tags": ["frontend", "state-management", "zustand"],
    "scope": "frontend",
    "createdBy": "frontend",
    "references": ["task-abc123"]
  }'

# 存储项目约定
curl -X POST http://127.0.0.1:9700/api/memories \
  -H "Content-Type: application/json" \
  -d '{
    "category": "convention",
    "title": "API 响应统一格式",
    "content": "所有 API 响应使用 { code: number, data: T, message: string } 格式",
    "tags": ["api", "convention"],
    "scope": "global",
    "createdBy": "backend"
  }'

# 存储经验教训
curl -X POST http://127.0.0.1:9700/api/memories \
  -H "Content-Type: application/json" \
  -d '{
    "category": "lesson",
    "title": "SQLite 保留字踩坑",
    "content": "references 是 SQLite 保留字，作为列名需用方括号 [references] 转义",
    "tags": ["sqlite", "pitfall"],
    "scope": "global",
    "createdBy": "backend"
  }'
```

#### 查询和搜索

```bash
# 列出所有记忆
curl http://127.0.0.1:9700/api/memories

# 按分类
curl "http://127.0.0.1:9700/api/memories?category=decision"

# 按范围
curl "http://127.0.0.1:9700/api/memories?scope=frontend"

# 关键词搜索
curl "http://127.0.0.1:9700/api/memories/search?q=zustand"
```

---

### 1.4 上下文编译

为指定 Agent 编译一份最小必要的上下文快照（自动裁剪到 token 预算内）：

```bash
curl -X POST http://127.0.0.1:9700/api/context/compile \
  -H "Content-Type: application/json" \
  -d '{
    "agentRole": "frontend",
    "tokenBudget": 6000,
    "format": "markdown"
  }'
```

响应包含：
- **当前任务**（in_progress / ready）
- **上下游依赖**（其他 Agent 的任务状态）
- **相关契约**（当前角色生产/消费的 API 契约）
- **历史决策**
- **项目约定**
- **警告**（被阻塞的任务）

可选参数：
- `focusTaskId` — 聚焦特定任务
- `tokenBudget` — token 预算（默认 8000，保留 20% 缓冲）
- `format` — `markdown` 或 `json`

---

### 1.5 事件查询

```bash
# 获取所有事件
curl http://127.0.0.1:9700/api/events

# 获取序号 10 以后的事件（增量拉取）
curl "http://127.0.0.1:9700/api/events?since=10"
```

---

### 1.6 Agent 管理

```bash
# 注册 Agent
curl -X POST http://127.0.0.1:9700/api/agents \
  -H "Content-Type: application/json" \
  -d '{ "role": "frontend", "metadata": { "ide": "Windsurf" } }'

# 列出所有 Agent
curl http://127.0.0.1:9700/api/agents

# 心跳（保活）
curl -X POST http://127.0.0.1:9700/api/agents/frontend/instance-id-xxx/heartbeat

# 断连
curl -X POST http://127.0.0.1:9700/api/agents/frontend/instance-id-xxx/disconnect
```

---

### 1.7 健康检查

```bash
curl http://127.0.0.1:9700/api/health
```

响应：
```json
{
  "status": "ok",
  "uptime": 123.456,
  "timestamp": "2026-05-27T03:00:00.000Z",
  "agents": 2,
  "tasks": 5,
  "contracts": 3,
  "events": 42
}
```

---

## 2. WebSocket 实时通信

### 连接

```javascript
const ws = new WebSocket('ws://127.0.0.1:9700/ws');

ws.onopen = () => {
  console.log('Connected to coordinator');
};

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  console.log('Received:', msg);
};
```

### 注册身份

```javascript
ws.send(JSON.stringify({
  action: 'register',
  role: 'frontend',
  instanceId: 'my-unique-id',       // 可选，自动生成
  metadata: { ide: 'Windsurf' }     // 可选
}));
// 响应: { type: 'registered', agent: { role, instanceId, ... } }
```

### 订阅事件

```javascript
// 订阅特定事件类型
ws.send(JSON.stringify({
  action: 'subscribe',
  types: ['task.created', 'task.completed', 'contract.breaking_change']
}));

// 使用通配符
ws.send(JSON.stringify({
  action: 'subscribe',
  types: ['task.*', 'contract.*']    // task.* 匹配所有 task 开头的事件
}));

// 默认已订阅 '*'（所有事件）
```

### 取消订阅

```javascript
ws.send(JSON.stringify({
  action: 'unsubscribe',
  types: ['task.created']
}));
```

### 心跳

```javascript
// 定时发送心跳保持在线状态
setInterval(() => {
  ws.send(JSON.stringify({ action: 'heartbeat' }));
}, 30000);
// 响应: { type: 'pong', timestamp: '...' }
```

### 事件回放

```javascript
// 获取序号 0 以来的所有历史事件（断线重连时使用）
ws.send(JSON.stringify({
  action: 'replay',
  since: 0
}));
// 响应: { type: 'replay', events: [...], count: 42 }
```

### 接收实时事件

```javascript
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);

  if (msg.type === 'event') {
    const e = msg.event;
    switch (e.type) {
      case 'task.created':
        console.log(`新任务: ${e.payload.title}`);
        break;
      case 'task.completed':
        console.log(`任务完成: ${e.payload.id}`);
        break;
      case 'contract.breaking_change':
        console.log(`⚠️ 契约破坏性变更: ${e.payload.contractName}`);
        break;
      case 'agent.connected':
        console.log(`Agent 上线: ${e.payload.role}`);
        break;
    }
  }
};
```

### 事件类型清单

| 事件 | 触发时机 |
|------|----------|
| `task.created` | 新任务创建 |
| `task.status_changed` | 任务状态变更 |
| `task.completed` | 任务完成 |
| `task.blocked` | 任务被阻塞 |
| `task.ready` | 任务就绪可执行 |
| `contract.created` | 新契约创建 |
| `contract.updated` | 契约更新 |
| `contract.breaking_change` | 检测到破坏性变更 |
| `contract.agreed` | 契约被确认 |
| `agent.connected` | Agent 上线 |
| `agent.disconnected` | Agent 下线 |

---

## 3. MCP Server (IDE 原生)

MCP（Model Context Protocol）让 Windsurf / Cursor 等 AI IDE 直接调用协调器工具，无需 HTTP。

### 3.1 配置 MCP

**Windsurf** — 在设置 → MCP Servers 中添加：

```json
{
  "mcpServers": {
    "ai-agent-coordinator": {
      "command": "npx",
      "args": ["tsx", "src/mcp/server.ts"],
      "cwd": "/absolute/path/to/ai-agent-coordinator"
    }
  }
}
```

**Cursor** — 在 `.cursor/mcp.json` 中添加：

```json
{
  "mcpServers": {
    "ai-agent-coordinator": {
      "command": "npx",
      "args": ["tsx", "src/mcp/server.ts"],
      "cwd": "/absolute/path/to/ai-agent-coordinator"
    }
  }
}
```

将 `cwd` 替换为仓库克隆目录的绝对路径；Windows 路径在 JSON 中使用双反斜杠。

### 3.2 MCP 工具列表

配置后，AI 助手可以直接调用以下工具（无需你手动操作）：

| 工具 | 参数 | 说明 |
|------|------|------|
| `create_task` | title, assignee, description?, dependencies?, priority?, inputs?, metadata? | 创建任务 |
| `list_tasks` | assignee?, status? | 列出任务 |
| `get_task` | id | 获取任务 |
| `update_task_status` | id, status, outputs? | 更新任务状态 |
| `get_ready_tasks` | assignee? | 获取就绪任务 |
| `get_task_graph` | — | 获取完整 DAG |
| `create_contract` | name, type, producer, consumers?, schema, examples?, metadata? | 创建契约 |
| `list_contracts` | producer?, consumer?, type?, status? | 列出契约 |
| `get_contract` | id | 获取契约 |
| `update_contract` | id, schema?, status?, examples?, metadata? | 更新契约 |
| `store_memory` | category, title, content, createdBy, tags?, scope?, references? | 存储知识 |
| `search_memories` | query | 搜索知识 |
| `list_memories` | category?, scope?, tag?, createdBy? | 列出知识 |
| `compile_context` | agentRole, tokenBudget?, focusTaskId?, format? | 编译上下文 |
| `get_events` | since? | 获取事件 |
| `register_agent` | role, instanceId?, metadata? | 注册 Agent |
| `list_agents` | — | 列出 Agent |
| `health` | — | 健康检查 |

### 3.3 MCP 使用示例

在 AI IDE 对话中，你可以这样指示 AI：

> "用协调器创建一个任务：实现用户列表页面，分配给 frontend，优先级 high"

AI 会自动调用 `create_task` 工具。

> "查看后端有哪些就绪任务"

AI 调用 `get_ready_tasks` → `{ assignee: "backend" }`

> "把登录 API 契约的状态更新为 implemented"

AI 调用 `update_contract` → `{ id: "...", status: "implemented" }`

> "搜索所有跟状态管理相关的决策记录"

AI 调用 `search_memories` → `{ query: "状态管理" }`

> "帮我编译 frontend 角色的上下文"

AI 调用 `compile_context` → `{ agentRole: "frontend" }` → 返回 Markdown 格式的上下文

---

## 4. FileSync 文件读取

对于不支持 API/MCP 的 AI 工具，协调器会自动将状态同步到 `.coordinator/` 目录。

### 目录结构

```
.coordinator/
├── coordinator.db           # SQLite 数据库
├── tasks.json               # 所有任务快照
├── contracts.json           # 所有契约快照
├── memories.json            # 所有知识快照
├── agents.json              # 在线 Agent 快照
└── context-{role}.md        # 各角色的 Markdown 上下文
    ├── context-frontend.md
    └── context-backend.md
```

### 使用方式

任何 AI 工具只需读取这些文件即可获取最新状态：

```
请阅读 .coordinator/context-frontend.md 了解当前前端开发上下文
```

```
请阅读 .coordinator/tasks.json 查看所有任务的状态
```

文件会在数据变更后自动更新（防抖 2 秒）。

---

## 5. 典型工作流程

### 场景：前后端 Agent 协作开发登录功能

```
时序图：

Frontend Agent                  Coordinator                  Backend Agent
     |                              |                              |
     |  1. register_agent           |                              |
     |  { role: "frontend" }        |                              |
     |----------------------------->|                              |
     |                              |  2. register_agent           |
     |                              |  { role: "backend" }         |
     |                              |<-----------------------------|
     |                              |                              |
     |  3. create_contract          |                              |
     |  { POST /api/auth/login }    |                              |
     |----------------------------->|  event: contract.created      |
     |                              |----------------------------->|
     |                              |                              |
     |                              |  4. agree contract           |
     |                              |<-----------------------------|
     |                              |                              |
     |  5. create_task              |                              |
     |  { "实现登录页面",            |                              |
     |    assignee: "frontend" }    |                              |
     |----------------------------->|                              |
     |                              |  6. create_task              |
     |                              |  { "实现登录API",             |
     |                              |    assignee: "backend",      |
     |                              |    deps: [frontend-task] }   |
     |                              |<-----------------------------|
     |                              |                              |
     |  7. update_task_status       |                              |
     |  { status: "in_progress" }   |                              |
     |----------------------------->|                              |
     |                              |                              |
     |  8. compile_context          |                              |
     |  { agentRole: "frontend" }   |                              |
     |----------------------------->|                              |
     |  <-- 返回当前任务+契约+约定   |                              |
     |                              |                              |
     |  9. store_memory             |                              |
     |  { "登录页使用Ant Design     |                              |
     |    Form组件" }               |                              |
     |----------------------------->|                              |
     |                              |                              |
     | 10. complete task            |                              |
     |  { outputs: { path:          |                              |
     |    "src/pages/Login.tsx" } } |                              |
     |----------------------------->|  event: task.completed        |
     |                              |  → 后端任务自动变 ready       |
     |                              |----------------------------->|
     |                              |                              |
     |                              | 11. update_task_status       |
     |                              |  { status: "in_progress" }   |
     |                              |<-----------------------------|
     |                              |                              |
     |                              | 12. compile_context          |
     |                              |  { agentRole: "backend" }    |
     |                              |<-----------------------------|
     |                              |  <-- 返回：前端已完成登录页 + |
     |                              |      登录API契约schema +     |
     |                              |      前端存的记忆            |
     |                              |                              |
```

### 关键优势

1. **上下文传递** — 前端存储的决策和记忆，后端通过 `compile_context` 自动获得
2. **任务级联** — 前端完成后，后端任务自动从 `pending` → `ready`
3. **契约保障** — 双方基于同一份 schema 开发，变更即时通知
4. **全程可追溯** — 所有操作产生事件，可回放完整协作历史
