# 边界条件 & 注意事项 — 详细分析

## 一、关键边界条件

### 1. 循环依赖（Circular Dependency）

**场景**：前端 AI 创建 Task A 依赖 Task B，后端 AI 创建 Task B 依赖 Task A。

**检测方案**：
```
每次添加依赖关系时执行增量拓扑排序（Kahn's Algorithm）：
1. 构建临时邻接表（现有 edges + 新 edge）
2. 计算所有节点入度
3. BFS 从入度为 0 的节点开始
4. 如果遍历完成后仍有未访问节点 → 存在环 → 拒绝该依赖
```

**返回信息**：返回完整环路径，如 `A → B → C → A`，帮助用户/AI理解冲突。

---

### 2. 契约冲突（Contract Conflict）

**场景**：
- 前端 AI 提议 `GET /api/users` 返回 `{ users: User[] }`
- 后端 AI 实现为 `{ data: User[], total: number }`

**检测方案**：
```
使用 JSON Schema diff 算法：
1. 深度对比 proposed schema vs implemented schema
2. 分类变更类型：
   - Compatible（兼容）：新增可选字段
   - Breaking（破坏）：删除字段、改变类型、重命名必选字段
   - Warning（警告）：字段新增但类型不同于预期
```

**处理流程**：
```
Compatible → 自动 agree，通知 consumers 更新
Breaking   → 标记 conflict，创建 resolution task，通知双方 + 人类
Warning    → 通知 consumers，建议确认
```

---

### 3. 并发写入（Concurrent Write）

**场景**：两个 AI Agent 同时更新同一个 task 的状态。

**SQLite 层**：
```sql
-- 使用乐观锁
UPDATE tasks
SET status = 'done', version = version + 1, updated_at = NOW()
WHERE id = 'task-xxx' AND version = 5;
-- 如果 affected rows = 0 → 版本冲突，重新读取后重试
```

**文件同步层**：
```json
// .coordinator/lock.json
{
  "holder": "backend-agent",
  "acquiredAt": "2025-01-01T00:00:00Z",
  "ttl": 5000,          // 5秒过期，防止死锁
  "resource": "tasks"
}
```

**策略**：
- SQLite 本身支持 WAL 模式，多读单写不阻塞
- 文件层使用 TTL 锁，超时自动释放
- 冲突时：最后写入者胜（Last Writer Wins）+ 冲突记录保留

---

### 4. Agent 离线与事件补发

**场景**：后端 AI 的 IDE 关闭了 2 小时，期间前端 AI 注册了 3 个新契约。

**方案**：
```
1. 每个 agent 维护一个 lastEventId（游标）
2. 所有事件持久化到 events 表，自增 ID
3. Agent 重连时：
   GET /api/events?since=lastEventId
   → 返回所有未读事件
4. 事件压缩：
   - 同一资源的多次 status_changed → 只保留最终状态
   - 同一契约的多次 updated → 合并为一次 diff
5. 过期清理：> 7天的已读事件自动清理
```

---

### 5. 上下文 Token 预算管理

**场景**：某 agent 关联 50 个 tasks + 20 个 contracts，全部展开超过 token 限制。

**裁剪优先级**（从高到低）：
```
1. 当前正在执行的 task 描述        → 必须包含，不可裁剪
2. 直接阻塞/被阻塞的 task          → 高优先级
3. 关联契约的核心 schema            → 高优先级
4. 上下游一跳内的 task 摘要         → 中优先级
5. 最近的 memory / decisions       → 中优先级
6. 上下游两跳内的 task 标题         → 低优先级
7. 历史事件摘要                     → 低优先级，超预算时首先丢弃
```

**Token 估算**：
```
简易方案：1 token ≈ 4 个英文字符 ≈ 1.5 个中文字符
精确方案（可选）：集成 tiktoken 库，支持 GPT-4/Claude tokenizer
```

---

### 6. Coordinator 崩溃恢复

**场景**：Coordinator 进程意外退出。

**恢复方案**：
```
1. SQLite WAL 模式保证写入原子性，未完成的事务自动回滚
2. 启动时：
   a. 检查 SQLite 完整性（PRAGMA integrity_check）
   b. 重建内存中的 task DAG 索引
   c. 重建 agent 连接状态（所有 agent 标记为 offline）
   d. 广播 system.sync_completed 事件
3. WebSocket 客户端实现自动重连（指数退避，最大 30s）
4. 文件同步层不受影响（无状态）
```

---

### 7. 多 Agent 同名/角色冲突

**场景**：用户打开了两个前端 IDE 窗口，都注册为 "frontend"。

**方案**：
```
Agent 标识 = role + instanceId
- role: "frontend"（逻辑角色，可重复）
- instanceId: UUID（实例唯一，自动生成）

同 role 的多个实例：
- 共享该 role 的任务和上下文
- 事件广播到同 role 的所有实例
- 如果需要区分，使用 instanceId 定向发送
```

---

## 二、注意事项详解

### 1. 安全性

```
本地部署，不暴露到公网：
- REST API 默认绑定 127.0.0.1
- WebSocket 同样只监听本机
- 如需远程访问，需显式配置 + token 认证

敏感数据：
- .coordinator/ 目录应加入项目 .gitignore
- Memory Store 可能包含 API Key 等敏感信息，不应提交到 VCS
```

### 2. 文件同步的一致性

```
问题：AI Agent 可能在文件写入一半时被中断
方案：
- 写入时先写 .tmp 文件，完成后原子 rename
- 每个 JSON 文件包含 checksum 字段
- 读取时校验 checksum，损坏则从 SQLite 重新生成
```

### 3. MCP Server 限制

```
当前 MCP 协议限制：
- 不支持服务端主动推送（只有 request-response）
- 工具调用是同步的
- 不同 IDE 实现的 MCP 版本可能不同

应对：
- MCP 用于同步操作（CRUD）
- WebSocket 用于异步推送
- 提供 polling 备选：coordinator_get_events({ since: lastEventId })
```

### 4. 与现有工作流的集成

```
不要打破现有习惯：
- Coordinator 是可选的，不使用也不影响开发
- .coordinator/ 目录结构简单，人类可直接阅读和编辑
- CLI 提供简单的启动/停止命令，无需复杂配置
- 支持 YAML/JSON 两种配置格式
```

### 5. 测试策略

```
单元测试：
- Task DAG 依赖解析（含环检测）
- Contract Schema diff 算法
- Context Compiler Token 裁剪
- 乐观锁并发处理

集成测试：
- 模拟两个 Agent 交替操作 task 和 contract
- 模拟 Agent 离线重连，验证事件补发
- Coordinator 崩溃后恢复状态一致性

端到端测试：
- 真实 IDE 环境（Windsurf + Cursor）模拟前后端协作
```

---

## 三、风险矩阵

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|---------|
| AI Agent 不按契约实现 | 高 | 中 | 运行时 schema 校验 + 通知人类 |
| Token 估算偏差导致上下文截断 | 中 | 中 | 保留 20% token buffer + 动态调整 |
| SQLite 并发写入超限 | 低 | 高 | WAL 模式 + 写入队列序列化 |
| MCP 协议不兼容 | 中 | 低 | REST API 兜底，MCP 只是增强 |
| 用户不理解协调器概念 | 高 | 中 | 提供 CLI 向导 + 预设模板 |
| 事件风暴（短时间大量事件） | 低 | 中 | 事件合并 + 限流（100 events/s） |
