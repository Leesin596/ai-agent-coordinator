# AI Agent Coordinator

多 AI Agent 协作协调器 — 让多个 AI 会话像真正的开发团队一样协作。

## 功能

- **可配置工作区** — 绑定项目文件夹，每个工作区独立数据隔离
- **会话角色库** — 7 个内置角色（前端/后端/全栈/架构师/测试/产品/UI 设计师），支持自定义角色
- **会话间任务派发** — 会话间互相派发任务，两阶段上下文对齐握手协议
- **任务/契约/记忆管理** — 共享任务看板、API 契约注册、项目记忆

## 快速开始

1. 安装本插件
2. 左侧活动栏点击 Coordinator 图标
3. 「工作区」视图中点击 + 号，选择一个项目文件夹
4. 「角色库」视图显示内置角色，可点击 + 号新增自定义角色

## 配置

在 VSCode 设置中搜索 `coordinator`：

- `coordinator.llm.apiKey` — LLM API Key（OpenAI 兼容）
- `coordinator.llm.baseURL` — LLM API Base URL，默认 `https://api.openai.com/v1`
- `coordinator.llm.model` — 默认模型，默认 `gpt-4o-mini`

## 数据存储

- 全局工作区列表：`~/.coordinator/global.db`
- 工作区数据：`{项目文件夹}/.coordinator/coordinator.db`
