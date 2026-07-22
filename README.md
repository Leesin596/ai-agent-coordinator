# AI Agent Coordinator

[![CI](https://github.com/Leesin596/ai-agent-coordinator/actions/workflows/ci.yml/badge.svg)](https://github.com/Leesin596/ai-agent-coordinator/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933.svg)](package.json)

多 AI Agent 协作的本地中转协调器。解决跨 AI 开发时上下文窗口限制、记忆断层、任务依赖不可见的问题。数据默认仅保存在本机。

## 快速启动

```bash
npm ci

# 启动完整服务 (REST + WebSocket + FileSync)
npm run dev

# 仅启动 MCP Server (供 IDE 原生调用)
npm run mcp
```

服务默认运行在 `http://127.0.0.1:9700`，Dashboard 可视化面板同地址访问。

## 四层接入

| 层级 | 通道 | 用途 |
|------|------|------|
| **Dashboard** | http :9700 | 可视化面板，实时展示 Agents/Tasks/Contracts/Memories/Events |
| **MCP Server** | stdio (IDE 原生) | Windsurf / Cursor 直接调用协调器工具 |
| **REST API** | HTTP :9700/api | 通用 HTTP 接入，适合脚本和非 IDE 客户端 |
| **WebSocket** | ws :9700/ws | 实时事件推送、订阅、Agent 注册 |
| **FileSync** | .coordinator/ 目录 | 不支持 API 的 AI 工具通过读文件获取上下文 |

## VS Code 扩展

项目不只是 MCP/REST 服务，还包含一个完整的 VS Code 扩展，提供图形化界面管理任务、角色、会话和模型。

### 功能

- **侧边栏面板** — 工作区管理、角色库、会话列表、任务派发，全部可视化操作
- **底部控制台** — 实时事件流、Agent 在线状态、事件回放
- **聊天面板** — 按 role 系统提示词开对话，支持上下文注入和模型切换
- **任务中心** — 查看和验收跨会话派发的任务
- **模型管理** — 配置 OpenAI 兼容 API（Key、BaseURL、模型、温度等），支持多预设
- **内置 15 个角色** — Vue/React/Go/Java/PHP/Python/Rust/测试/代码审计/产品/UI/Agent 简报等，开箱即用
- **自动编排** — 复杂任务自动拆解为子任务，按依赖图拓扑序分配给合适角色执行并汇总结果
- **代码库语义搜索** — 基于 embedding 的向量搜索，自然语言查找代码位置
- **检查点回滚** — 影子 Git 仓库自动快照，支持文件级回滚
- **MCP Server 集成** — 连接外部 MCP Server，扩展工具能力
- **Todo List** — 单会话多步任务跟踪，LLM 自管理进度
- **Slash Commands** — `/code`、`/ask`、`/debug`、`/architect` 快速切换模式

### 安装

**方式一：从 VSIX 安装（推荐）**

1. 从 [GitHub Releases](https://github.com/Leesin596/ai-agent-coordinator/releases) 下载 `ai-agent-coordinator-0.2.0.vsix`
2. 在 VS Code 中执行：
   ```
   code --install-extension ai-agent-coordinator-0.2.0.vsix
   ```
3. 重载窗口（`Ctrl+Shift+P` → `Developer: Reload Window`）
4. 左侧活动栏出现 Coordinator 图标，点击即可使用

**方式二：从源码构建**

```bash
cd vscode-extension
npm ci
npm run build
# 打包 VSIX
npx vsce package --no-git-tag-version
# 安装
code --install-extension ai-agent-coordinator-0.2.0.vsix
```

### 配置 LLM

安装后在 VS Code 设置中搜索 `coordinator`：

- `coordinator.llm.apiKey` — LLM API Key（OpenAI 兼容）
- `coordinator.llm.baseURL` — API Base URL，默认 `https://api.openai.com/v1`
- `coordinator.llm.model` — 模型名称

也可以在扩展左侧「模型设置」面板中管理多个模型预设，按会话绑定。

### 数据存储

- 全局数据库：`~/.coordinator/global.db`（工作区列表）
- 工作区数据库：`~/.coordinator/<workspace-id>.db`（任务、契约、记忆、事件、会话）
- 与根项目共享 `.coordinator/` 目录格式，数据互通

## Project Namespace 隔离

所有数据支持按 `project` 隔离，不同团队/项目互不干扰：

```bash
# REST API 通过 query 参数指定
GET /api/tasks?project=商城项目

# MCP 工具通过 project 参数指定
create_task({ title: "...", assignee: "frontend", project: "CRM" })

# 不传 project 默认为 "default"
```

## 核心模块

| 模块 | 作用 |
|------|------|
| Task Manager | 任务 DAG 管理，依赖解析，自动级联调度，乐观锁 |
| Contract Registry | API 契约注册、版本管理、破坏性变更自动检测 |
| Context Compiler | 按角色编译最小必要上下文，适配 token 预算 |
| Event Bus | 事件持久化 + 实时内存分发 |
| Memory Store | 持久化项目记忆、决策、约定，支持搜索 |
| sql.js (SQLite/WASM) | 本地文件持久化，通过文件锁和乐观锁协调并发写入 |

## MCP 工具 (33 个)

IDE 中通过 MCP 直接可用的工具：

| 工具 | 说明 |
|------|------|
| `create_task` | 创建任务到 DAG |
| `list_tasks` | 列出任务（可按角色/状态过滤） |
| `get_task` | 获取单个任务详情 |
| `update_task_status` | 更新任务状态，自动级联 |
| `get_ready_tasks` | 获取可执行任务 |
| `get_task_graph` | 获取完整 DAG |
| `create_contract` | 创建 API 契约 |
| `list_contracts` | 列出契约 |
| `get_contract` | 获取契约详情 |
| `update_contract` | 更新契约（自动检测破坏性变更） |
| `store_memory` | 存储项目知识 |
| `search_memories` | 搜索知识库 |
| `list_memories` | 列出所有记忆 |
| `compile_context` | 编译 Agent 上下文（markdown/json） |
| `get_events` | 获取最近事件 |
| `register_agent` | 注册 AI Agent |
| `list_agents` | 列出在线 Agent |
| `health` | 健康检查 |

角色、会话与跨会话任务工具：

| 工具 | 说明 |
|------|------|
| `list_roles` / `get_role` | 查询内置及自定义角色 |
| `list_sessions` / `create_session` | 查询和创建工作区会话 |
| `dispatch_session_task` | 向另一会话派发带对齐上下文的任务 |
| `get_session_task` | 获取会话任务详情 |
| `list_incoming_session_tasks` / `list_outgoing_session_tasks` | 查询会话收发任务 |
| `review_session_task_context` | 查看已解析的对齐上下文 |
| `align_session_task` | 确认上下文对齐 |
| `request_clarify_session_task` | 请求补充说明 |
| `accept_session_task` | 接受会话任务 |
| `complete_session_task` | 完成会话任务 |
| `reject_session_task` / `cancel_session_task` | 拒绝或取消会话任务 |

### IDE 配置 (Windsurf / Cursor)

将仓库克隆到本机后，在 IDE 的 MCP 设置中添加以下配置。`cwd` 必须替换为克隆目录的**绝对路径**：

```json
{
  "mcpServers": {
    "ai-agent-coordinator": {
      "command": "npx",
      "args": ["tsx", "src/mcp/server.ts"],
      "cwd": "/absolute/path/to/ai-agent-coordinator",
      "env": {
        "COORDINATOR_DB": ".coordinator/coordinator.db"
      }
    }
  }
}
```

仓库中的 `mcp-config.json` 是项目目录内使用的相对路径示例；复制到全局 IDE 配置时不能原样保留 `cwd: "."`。

## REST API 端点

```
GET    /                          # Dashboard 可视化面板
GET    /api/info                  # 服务信息
GET    /api/health                # 健康检查（含统计）

# 任务
POST   /api/tasks                 # 创建任务
GET    /api/tasks                 # 列出任务 (?assignee=&status=)
GET    /api/tasks/ready           # 可执行任务
GET    /api/tasks/graph           # DAG 视图
GET    /api/tasks/:id             # 任务详情
PATCH  /api/tasks/:id             # 更新状态
POST   /api/tasks/:id/complete    # 标记完成
DELETE /api/tasks/:id             # 删除

# 契约
POST   /api/contracts             # 注册契约
GET    /api/contracts             # 列出契约
GET    /api/contracts/:id         # 契约详情
PATCH  /api/contracts/:id         # 更新契约
GET    /api/contracts/:id/history # 变更历史
POST   /api/contracts/:id/agree   # 确认契约

# 记忆
POST   /api/memories              # 创建记忆
GET    /api/memories              # 列出记忆
GET    /api/memories/search?q=    # 搜索记忆
PATCH  /api/memories/:id          # 更新
DELETE /api/memories/:id          # 删除

# 上下文
POST   /api/context/compile       # 编译上下文

# 事件
GET    /api/events?since=0        # 获取事件

# Agent 管理
POST   /api/agents                # 注册 Agent
GET    /api/agents                # 列出 Agent
POST   /api/agents/:role/:id/heartbeat   # 心跳
POST   /api/agents/:role/:id/disconnect  # 断连
```

## WebSocket 协议

连接 `ws://127.0.0.1:9700/ws` 后发送 JSON 消息：

```jsonc
// 注册身份
{ "action": "register", "role": "frontend", "instanceId": "optional-id" }

// 订阅特定事件
{ "action": "subscribe", "types": ["task.*", "contract.breaking_change"] }

// 心跳
{ "action": "heartbeat" }

// 回放历史事件
{ "action": "replay", "since": 0 }
```

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| COORDINATOR_PORT | 9700 | 服务端口 |
| COORDINATOR_HOST | 127.0.0.1 | 绑定地址 |
| COORDINATOR_DB | .coordinator/coordinator.db | 数据库路径 |

## 开发与验证

```bash
npm ci
npm test
npm run build
npm --prefix vscode-extension ci
npm --prefix vscode-extension run build
```

支持 Node.js 18、20 和 22。GitHub Actions 会在这些版本上执行测试、根项目构建和 VS Code 扩展构建。

## 数据与安全

- 协调器默认监听 `127.0.0.1`，不会主动暴露到公网。
- 数据库及锁文件默认位于 `.coordinator/`，已被 Git 忽略。
- 不要将 API Key、私有上下文、真实数据库或 IDE 全局配置提交到仓库。
- VS Code 扩展的 LLM API Key 应通过用户设置提供，仓库中不包含密钥。

## 文档

- [**完整调用指南**](docs/USAGE_GUIDE.md) — REST/WebSocket/MCP/FileSync 所有调用示例
- [完整设计方案](docs/DESIGN.md)
- [边界条件详解](docs/BOUNDARY_CONDITIONS.md)
- [贡献指南](CONTRIBUTING.md)

## 许可证

本项目基于 [MIT License](LICENSE) 开源。
