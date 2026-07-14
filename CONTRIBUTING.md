# Contributing to AI Agent Coordinator

感谢你参与 AI Agent Coordinator。提交代码前，请先搜索现有 Issue，避免重复工作。

## 开发环境

- Node.js 18、20 或 22
- npm（使用仓库中的 lockfile）

```bash
npm ci
npm test
npm run build
```

如修改 VS Code 扩展，还需执行：

```bash
npm --prefix vscode-extension ci
npm --prefix vscode-extension run build
```

## 提交变更

1. 从默认分支创建主题分支。
2. 保持改动聚焦，不混入无关格式化或生成文件。
3. 为行为变更和缺陷修复添加测试。
4. 确保测试、根项目构建和扩展构建通过。
5. 提交 Pull Request，说明问题、实现方式、验证步骤及兼容性影响。

## 代码约定

- 遵循现有 TypeScript 风格和严格类型检查。
- 在 REST、MCP、WebSocket 等信任边界验证外部输入。
- 优先复用现有核心模块和数据模型，避免重复实现。
- 数据结构或公共接口变更应同步更新文档和测试。

## Issue 与安全问题

缺陷和功能建议可通过 GitHub Issues 提交。请勿在公开 Issue、日志、测试数据或提交中包含 API Key、真实数据库、私有上下文及本机绝对路径。

如果问题可能导致敏感数据泄露、未授权访问或数据损坏，请不要公开披露利用细节；请先通过仓库所有者提供的私密联系方式报告。

## 许可证

提交贡献即表示你同意按本仓库的 [MIT License](LICENSE) 发布该贡献。
