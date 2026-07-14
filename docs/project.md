# AI Agent Coordinator — 系统设计文档
## 1. 概述

AI Agent Coordinator（以下简称 Coordinator）是一个轻量级本地服务，充当多个 AI 编程助手之间的"中枢大脑"。它解决的核心问题是：**多个 AI Agent（如前端AI、后端AI）在同一项目中并行工作时，缺乏共享记忆、契约同步和任务协调能力**。

## 1.1 功能概览

| 模块 | 功能 | 说明 |
|------|------|------|
| **Task Manager** | 任务 DAG | 创建带依赖的任务图，自动级联调度（完成→就绪→阻塞），乐观锁防并发冲突 |
| **Contract Registry** | API 契约 | 前后端间的接口契约注册、版本管理，自动检测破坏性变更并通知受影响方 |
| **Memory Store** | 项目记忆 | 持久化决策、约定、架构笔记，支持分类检索，AI 重启后不丢失上下文 |
| **Context Compiler** | 上下文编译 | 按角色汇总任务+契约+记忆，裁剪到 token 预算内，输出 markdown/json |
| **Event Bus** | 事件总线 | 所有操作产生持久化事件，支持实时推送和历史回放 |
| **Dashboard** | 可视化面板 | 浏览器访问 `http://127.0.0.1:9700` 查看全局状态 |

**五层接入**：REST API / WebSocket / MCP Server / FileSync / Dashboard

**项目隔离**：所有数据按 `project` 字段隔离，不同项目互不干扰，默认 `"default"`。

### 使用方法

```bash
# 1. 在仓库克隆目录安装依赖
npm ci

# 2. 启动服务（REST + WebSocket + FileSync + Dashboard）
npm run dev
# → http://127.0.0.1:9700       Dashboard
# → http://127.0.0.1:9700/api   REST API
# → ws://127.0.0.1:9700/ws      WebSocket

# 3. MCP 接入（IDE 原生调用，无需手动启动）
# IDE MCP 配置中使用 npx tsx src/mcp/server.ts，
# 并将 cwd 设置为仓库克隆目录的绝对路径。
```

**常用 MCP 工具速查**：

```
create_task        创建任务          list_tasks       列出任务
update_task_status 更新任务状态      get_ready_tasks  获取可执行任务
create_contract    创建契约          update_contract  更新契约（自动检测breaking change）
store_memory       存储知识          search_memories  搜索知识
compile_context    编译Agent上下文   get_events       获取事件流
register_agent     注册Agent         health           健康检查
```


### 1.2 用户场景

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

### AI Agent Coordinator工作流示例

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

### 价值

1. 从人工编码到AI原生开发
2. 多Agent互操作性与上下文一致性
3. 契约驱动的人机协同，消除接口偏差与沟通损耗
4. 非线性优化20%，范式重构带来200%质变