---
name: react-development
description: React/Next.js 开发技能，覆盖 JSX/TSX、hooks、state、context、router、forms、SSR、hydration、server actions、组件测试和真实项目排障；涉及新增或修改 React 代码时使用。
---

# React Development

React Development 负责 React 与 Next.js 项目的实现、调试和验证。目标是让组件边界、状态归属、数据流、SSR/hydration、表单、路由和测试都可解释、可验证。

## 适用范围

- React、Next.js、JSX、TSX、hooks、components、context、state、router、forms 和 component testing。
- React Router、Next App Router / Pages Router、server components、server actions、SSR、SSG、ISR 和 hydration。
- 表单、列表、详情、弹窗、数据请求、错误态、加载态、权限态、响应式和可访问性。
- Jest、Vitest、React Testing Library、Playwright/Cypress、Storybook 和浏览器调试。

## 不适用范围

- Vue、Angular、Svelte、原生小程序或非 React 前端。
- 普通 JavaScript/TypeScript 类型专项，没有 React 组件或运行时问题。
- 纯 UI 视觉、设计稿点评、颜色间距调整，且不改 React 代码。
- React 只是品牌词、文章标题或依赖里出现，没有实现、修改、调试、运行或测试动作。

## 铁律

1. 未确认 React/Next 版本、路由形态、渲染模式、入口页面、状态来源和验证命令，不直接改组件。
2. 状态必须有唯一 owner：本地 state、props、context、URL、server data、cache 或 form controller，不能多处争抢。
3. hooks 只能在合法位置调用；依赖数组、闭包、清理函数和并发返回顺序必须可解释。
4. Server Component、Client Component、server action 和浏览器 API 边界必须明确，不能随手加 `"use client"` 掩盖架构问题。
5. Hydration mismatch 要先定位服务端/客户端差异、时间随机值、locale、浏览器 API、第三方库和缓存，再修。
6. 表单必须覆盖初始值、校验、提交中、失败态、字段错误、重复提交、取消和恢复。
7. 用户输入默认不可信；HTML、URL、style、Markdown、文件名和富文本必须按安全边界处理。
8. 未跑 typecheck、lint、test、build 或页面手测，不报告“已完成”。

## 强制流程

1. 输入锁定：确认业务目标、页面/组件、用户角色、数据来源、浏览器范围、SSR/CSR、i18n 和验收标准。
2. 项目画像：读取 package、React/Next 配置、router、state、UI 库、测试命令和现有组件风格。
3. 路由入口：确认 route、layout、params/searchParams、metadata、loading/error/not-found 和返回路径。
4. 状态归属：列出每个状态字段的 owner、初始化来源、更新者、持久化方式和重置时机。
5. 组件契约：定义 props、children、callbacks、refs、controlled/uncontrolled、a11y 和样式扩展点。
6. 数据请求：确认 API 契约、缓存、取消、竞态、错误结构、权限失败和刷新策略。
7. 实现：优先复用现有组件、hooks、schema、样式 token 和测试工具；保持最小改动。
8. 验证：运行类型、lint、测试或构建；UI 改动用浏览器验证主链路、错误态、移动端和回归入口。

## 场景执行卡

## 验收矩阵

- 最低验证按项目可用命令选择：typecheck、lint、unit/component test、build、页面 smoke；未跑的必须写未验证。
- React Testing Library 覆盖组件行为、表单错误、键盘操作和可访问性；Playwright 覆盖真实路由、刷新、移动端和 console/network。
- Next.js 必须跑生产 build 或等价检查；首屏刷新不能有 hydration error，server/client 边界和缓存策略必须说明。
- UI 证据包含目标 URL、视口、关键断言、截图、控制台错误、失败接口摘要和回归入口。

### Next.js 页面与路由

- 查：App Router 还是 Pages Router、server/client 边界、layout、loading、error、metadata、params 和缓存策略。
- 做：数据尽量在服务端边界获取；交互状态放 client component；URL 状态用 searchParams 明确解析。
- 验：直接访问、刷新、返回、404/403、慢接口、hydration、移动端和构建。

### Hooks 与状态

- 查：状态 owner、依赖数组、异步请求、订阅、定时器、事件监听和卸载清理。
- 做：effect 只处理副作用；派生值用计算或 memo；避免在 effect 里同步可从 render 推导的状态。
- 验：初始渲染、参数变化、快速切换、卸载、重复点击和旧请求返回。

### 表单与组件

- 查：字段 schema、默认值、校验、服务端错误、提交副作用、重置和无障碍标签。
- 做：明确 controlled/uncontrolled；服务端字段错误落到控件，全局错误落到表单级。
- 验：空值、非法值、边界长度、重复提交、接口失败、权限失败和键盘操作。

### Server State / Cache

- 查：TanStack Query/SWR、Next fetch cache、revalidate、dynamic、mutation、旧请求返回和取消策略。
- 做：服务端状态和本地 UI 状态分离；乐观更新必须有回滚；mutation 要有幂等或重复提交保护。
- 验：快速切换、旧请求回写、网络失败、重新聚焦刷新、缓存失效、权限过期和回滚。

### Hydration 与 SSR

- 查：Date/random、locale、window/document、media query、第三方库、cookie/session、缓存和 feature flag。
- 做：让服务端和客户端首屏输出一致；必要的客户端差异延后到 effect 或 client-only 边界。
- 验：生产 build、首屏刷新、禁缓存、不同 locale/timezone 和控制台无 hydration error。

## 低级错误清单

- 非法 hooks、条件调用 hooks、stale closure、effect 依赖漏项、StrictMode 双执行导致重复请求或重复副作用。
- key 用 index 导致列表状态串位；受控/非受控表单切换；文件输入和 reset 未处理。
- 为了用浏览器 API 随手加 `"use client"`，把服务端数据、secret 或大依赖推到客户端。
- Date/random/locale/window/media query/feature flag 导致 hydration mismatch，却只用 suppressHydrationWarning 掩盖。
- 富文本、Markdown、URL、style、文件名和 HTML 未做安全处理，需交接 web-security。

## 输出要求

- 输出组件/路由改动、状态归属、数据契约、验证命令和未覆盖风险。
- 涉及 Next.js 时必须说明 server/client 边界和缓存策略。
- 未跑验证命令或浏览器验证时，必须写未验证。

## 反例

- Vue 项目或普通 JS/TS 类型修复。
- 只改配色、图标或文案且不触碰 React 代码。
- 文案里出现 React 品牌词，但任务不是 React 开发。

## 相邻技能边界

- `browser-automation` 负责真实浏览器证据、截图、trace 和跨视口 smoke。
- `test-engineering` 负责测试策略、覆盖率和回归矩阵。
- `web-security` 负责 XSS、富文本、URL、文件输入、鉴权和权限边界。