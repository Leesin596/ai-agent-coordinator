# Vue 开发

Vue 开发（vue-development，兼容 slug: vue）负责本技能描述范围内的定位、执行、验证和交接边界；旧短 slug 仅作兼容 alias/URL 主键，不作为规范技能名。

定位：把 Vue 2 / Vue 3 需求从“页面能跑”收敛为“版本边界明确、组件边界清楚、状态来源单一、路由和数据流可验证、性能和安全有门禁、上线可回滚”。先确认 Vue 版本、构建工具、路由、状态、UI 库、SSR/SPA 形态、兼容范围和测试入口，再进入实现。

## 适用范围

- Vue 2 / Vue 3 应用、组件、页面、布局、路由、表单、状态管理和组合式函数开发。
- Vue CLI / Vite + Vue、Vue Router 3/4、Vuex/Pinia、Vitest/Jest、Vue Test Utils、Playwright/Cypress、Vue DevTools 相关调试。
- Vue SFC、Options API、Composition API、`<script setup>`、TypeScript、模板编译、响应式系统和渲染性能排障。
- Vue 2 到 Vue 3 迁移、兼容构建、生态库升级、Vuex→Pinia、Router 3→4、生命周期/API 差异处理。
- Nuxt 2/3、SSR、SSG、Hydration、SEO 和服务端渲染相关问题；涉及 Nuxt 专项时按 Nuxt/发布技能联动。
- Vue 前端安全、XSS、`v-html`、动态 URL/style、依赖风险和接口鉴权协作。

## 不适用范围

- 纯 React、Angular、Svelte、原生小程序或 Flutter 需求。
- 只读学习 Vue、了解项目结构、仅识别技术栈且不改代码。
- 纯 UI 视觉设计、海报、文案、Figma 评审；优先 UI/设计技能。
- 后端 API、数据库、认证策略本身；只在 Vue 调用和契约层处理。
- 普通 JavaScript/TypeScript 语法学习，无 Vue 页面、组件或运行时问题。

## 铁律

1. 未确认 Vue 2 / Vue 3 版本、运行形态、入口页面、数据来源、状态归属、兼容范围和验证命令，不直接改组件。
2. Vue 状态只能有明确 owner：本地组件状态、props/emits、Vuex/Pinia、路由 query/params、URL、服务端缓存或表单库，不能多处互相覆盖。
3. Vue 2 与 Vue 3 语法、生命周期、响应式、插件注册和路由/store API 不能混用；迁移必须列兼容策略和旧入口回归。
4. 组件边界按业务语义切，不按文件大小切；抽象必须服务复用、测试或渲染性能。
5. props 向下、events 向上；跨层共享才用 provide/inject 或 store，不能用全局变量绕过数据流。
6. 列表必须有稳定 key；表单必须有初始值、校验、提交中、失败态、重复提交和可恢复路径。
7. 用户输入默认不可信；禁止把不可信内容作为模板、HTML、URL、style 或事件代码执行。
8. 性能先测量再优化；先看 bundle、路由拆分、数据量和渲染范围，再动 `v-memo`、`shallowRef`、`Object.freeze` 等版本相关细节。
9. 未跑类型检查、lint、相关测试或页面手测，不报告“已完成”。
10. 涉及列表、详情、编辑、删除、导入导出、筛选或提交的业务数据时，必须先补字段映射矩阵；后端字段、前端模型、表单字段、展示列、校验规则、错误字段和 mock/fixture 不能靠猜。
11. 禁止直接操作 DOM 绕过 Vue 状态；除聚焦、测量、第三方库挂载等必要场景外，不用 `document.querySelector`、手动改 class/style 或手动同步输入值。
12. 禁止把 API response 原样直灌 UI；必须在 adapter/mapper 边界处理字段缺失、null、枚举、权限字段、旧数据和展示格式。
13. watcher、computed、effect 和路由监听必须说明触发源、停止条件和副作用；不能写会自我触发的 watch 循环。
14. 发请求的页面、组件、store action 和 composable 必须处理取消、卸载、快速切换、重复点击和旧响应覆盖新状态。

## 快速总则

- 新 Vue 需求先建页面契约：路由、角色、数据请求、空态、加载态、错误态、权限态、提交态和回滚态。
- 新组件先定公共 API：props、emits、slots、expose、v-model、可访问性、样式边界和测试入口。
- Vue 3 新功能默认优先 Composition API 与 `<script setup>`；Vue 2 维护项目尊重现有 Options API、Vuex、Vue Router 3 和 Vue CLI 约束，不为风格统一强行迁移。
- 复杂逻辑可抽到 composable；Vue 2 项目若使用 `@vue/composition-api` 或兼容构建，必须先确认插件和生态兼容。
- Pinia 用于 Vue 3 或已迁移项目的跨页面状态；Vue 2 既有 Vuex 项目优先保持 Vuex，除非任务明确要求迁移。
- Vue Router 负责 URL 状态和导航守卫；权限校验不能只靠前端路由守卫，后端/API 必须兜底。
- TypeScript 类型来自 API schema、DTO、store 和组件 props；不要用 `any` 掩盖契约不清。
- API、表单和表格字段必须有显式映射；禁止把接口响应整包塞进组件状态后在模板里临时猜字段。
- 样式优先局部化和设计系统一致；全局样式、CSS reset、主题变量改动要评估全站影响。
- 测试按风险分层：组件单测守交互和分支，integration 守 store/router/API 协作，E2E 守关键旅程。
- 每个真实功能至少闭合 props、state、store、router、form、API、error、loading、empty、permission、i18n、a11y、responsive；没有涉及的项要说明“不涉及”的证据。
- 任何展示列表、可编辑表单、详情页、权限按钮、上传、富文本、批量操作和跨页缓存，都默认按旧数据、弱网、权限变化和刷新回退验证。

## 强制流程：需求 → 边界 → 数据流 → 实现 → 验证

1. 输入锁定：确认业务目标、目标页面/组件、用户角色、数据来源、权限、浏览器/设备、i18n、SSR/SPA、UI 库和验收标准。
2. 项目画像：读取 `package.json`、Vue/Vite/Vue CLI/Nuxt 配置、router、store、组件目录、测试命令和现有风格；先判定 Vue 2、Vue 3、Nuxt 2/3 或兼容构建。
3. 路由与入口：确认新增或修改的 route、layout、query/params、meta、导航守卫、懒加载和返回路径。
4. 状态归属：列出每个状态字段的 owner、初始化来源、更新者、持久化方式、重置时机和失败恢复。
5. 组件契约：定义 props/emits/slots/v-model、默认值、受控/非受控行为、a11y 标签和样式扩展点。
6. 字段映射：列字段映射矩阵，至少覆盖 API response/request、DTO/type、store、form model、table/detail 展示、校验、错误回填、mock/fixture 和测试断言；每个字段要有 owner、默认值、空值策略、格式化/反格式化和提交名。
7. 数据请求：确认 API 契约、loading/error/empty、取消/防抖、并发、缓存失效、重试和权限错误处理。
8. 交互状态：为每个主区域定义初始、加载、成功、空、错误、无权限、提交中、提交失败、离线/超时和恢复路径，不能只做 happy path。
9. i18n/a11y/responsive：确认文案来源、数字/时间/金额格式、键盘路径、焦点管理、ARIA/label、颜色对比、断点和移动端溢出。
10. 实现：优先最小改动；复用现有组件、store、composable、样式 token 和测试工具。
11. 验证：运行 typecheck/lint/test/build；UI 改动必须用浏览器验证主链路、错误态、边界态、移动端和回归入口。
12. 交付：输出改动点、验证证据、未覆盖风险、需要联动的 API/设计/测试/发布事项。

## 场景执行卡

### 0. 真实开发闭环与低级错门禁

- 需求切片：先列页面入口、角色、数据对象、操作动作、成功结果、失败结果和回滚路径；没有验收标准时先补最小验收清单。
- 全链路：props/state/store/router/form/API/error/loading/empty/permission/i18n/a11y/responsive 必须逐项过一遍，避免只写模板和接口调用。
- 数据边界：API response 只进 mapper/store/composable 的边界层；组件模板消费稳定 view model，不在模板里拼接深层可选字段和业务规则。
- 状态边界：同一字段不能同时由 props、store、route query 和本地 ref 争抢；需要双向同步时写明主从方向、防抖和停止条件。
- 交互边界：loading 不遮挡可恢复操作，empty 不替代 error，permission 不替代登录态，submit 不替代保存态。
- DOM 边界：除 focus、scroll、selection、尺寸测量和第三方库容器外，不直接改 DOM；必须直接操作时要有卸载清理和 Vue 状态同步策略。
- 验证证据：至少给出命令结果、页面路径、浏览器/设备、关键截图或文字说明、network/error 样本和未覆盖原因。

### 1. 新增页面或功能模块

- 证据：路由位置、布局、角色权限、数据接口、设计稿、空态/错误态、埋点和回退路径。
- 动作：先接入路由和页面骨架，再接数据流和组件；route component 默认懒加载；重页面拆分二级 chunk。
- 状态：URL 可表达的筛选、分页、tab、搜索词优先放 query；跨页面缓存用 Pinia 或数据请求层。
- 验证：直接访问、刷新、返回、无权限、接口失败、空数据、慢网、重复操作和移动端布局。

### 2. 组件设计与重构

- 证据：调用方列表、props 使用、slot 需求、样式覆盖、事件语义和现有测试。
- 动作：稳定公共 API；避免组件同时管理业务请求、全局状态和展示细节；复杂表格/表单拆成领域组件。
- 契约：props 必填/默认值、emits payload、slot scope、v-model 命名、暴露方法和 a11y 行为写清。
- props：不要在子组件内改 props；需要本地副本时说明同步来源、重置时机和外部变更处理。
- slots：slot scope 只暴露必要字段和动作；不要让父组件绕过子组件内部状态直接改实现细节。
- 验证：旧调用方、默认状态、边界 props、事件触发、slot 渲染、键盘操作和视觉回归。

### 3. Composition API 与 composable

- 适用：复用状态逻辑、订阅生命周期、异步请求、表单控制、浏览器 API、权限判断。
- 动作：composable 命名 `useXxx`；输入输出明确；副作用有生命周期清理；异步有取消、竞态和错误状态。
- 禁止：把只用一次的页面细节抽成复杂 composable；在 composable 中隐式读写不相关全局状态。
- watch：监听 props、route、store 或表单字段时，必须避免在回调里写回同一触发源造成循环；需要双向同步时加等值判断、节流或明确停止条件。
- 清理：事件监听、定时器、IntersectionObserver、ResizeObserver、AbortController、WebSocket 和第三方实例必须在卸载或作用域失效时释放。
- 验证：初始值、参数变化、卸载清理、并发返回顺序、异常分支和复用场景。

### 4. Vuex / Pinia 状态管理

- 适用：跨页面共享、登录态、权限、购物车、缓存、复杂筛选、可复用业务状态。
- Vue 2 既有项目：优先识别 Vuex module、namespace、mutation/action/getter、插件和持久化策略，不为单个需求强迁 Pinia。
- Vue 3 新项目：Pinia store 每个 store 有唯一职责；state/getters/actions 或 setup store 边界清楚；异步 action 写 loading/error。
- 响应性：Pinia 解构 state/getters 用 `storeToRefs`；Vuex 注意 mutation 同步约束和 module 边界。
- SSR：不能把请求级状态泄漏到全局；setup store 要返回全部 state，避免隐藏状态破坏 SSR/devtools。
- 验证：初始状态、action 成功/失败、重置、并发、持久化恢复、登出清理和组件订阅。

### 5. Vue Router 与权限

- 证据：route name/path、params/query、meta、layout、权限、动态路由、404/403、登录回跳。
- 动作：参数解析集中；路由跳转处理重复导航；数据加载和权限失败有可见反馈；次要页面懒加载。
- 安全：前端守卫只做体验，不做最终授权；敏感数据必须由 API 权限控制。
- query/params：进入组件前做解析、默认值、非法值兜底和类型转换；不要在多个组件里重复猜 query 结构。
- 权限态：按钮隐藏、禁用、403 页面、登录过期、角色切换和接口拒绝必须一致；不能只靠菜单是否显示判断有无权限。
- 验证：直接 URL、刷新、非法 params、query 变更、浏览器前进后退、登录过期和无权限。

### 6. 表单与用户输入

- 证据：字段 schema、默认值、必填、校验、服务端错误、草稿、提交副作用和幂等要求。
- 动作：区分输入态、校验态、提交态和保存态；提交中禁重复；服务端字段错误回填到对应控件。
- 字段映射：编辑表单必须明确 API 字段、页面字段、组件 `v-model`、校验字段、提交 payload 字段和后端错误字段的对应关系；字段改名、嵌套对象、枚举、日期、金额、布尔值和数组都要写清转换规则。
- 编辑场景：进入编辑页或弹窗时，先从详情/列表行/API 回填到 form model，再做格式化；提交成功后按契约回填列表、详情、store 或重新拉取，禁止只关闭弹窗造成旧数据残留。
- 错误回填：服务端 field errors 要落到对应控件；全局错误落到表单级提示；未知字段错误要保留可见提示和日志线索，不能吞掉。
- 安全：HTML、URL、style、文件名、富文本和 Markdown 输入按安全边界处理；后端负责最终清洗和鉴权。
- 验证：空值、非法值、边界长度、组合校验、重复提交、取消、接口失败、权限失败和恢复编辑。

### 7. API 数据请求与异步状态

- 证据：接口契约、缓存策略、分页、筛选、排序、鉴权错误、并发刷新和离线/弱网体验。
- 动作：请求状态显式建模；并发响应要防旧请求覆盖新状态；列表操作要处理乐观更新失败和回滚。
- 契约：API 类型、错误码、空态、分页游标、权限和幂等需要与后端对齐。
- 取消：route 变化、筛选快速切换、弹窗关闭、组件卸载和重复提交时要取消旧请求或丢弃旧响应。
- 缓存：缓存 key 必须包含租户、用户、角色、query、分页、筛选和语言等影响结果的维度；提交、删除、权限变化和登出要失效相关缓存。
- API 类型：请求、响应、分页、详情、创建、编辑、删除和错误体都要有明确类型；字段不确定时先补契约或局部 unknown + 显式解析，不能用 `any` 扩散到组件、store、mock 或测试。
- mock/fixture 同步：改 API 字段、枚举、默认值、错误结构或分页结构时，同步更新 mock handler、fixture、factory、snapshot 和组件测试数据；fixture 必须覆盖成功、空态、字段缺失、字段为 null、权限失败和字段级错误。
- 验证：2xx、4xx、5xx、超时、取消、重复点击、快速切换筛选和旧数据刷新。

### 8. 字段映射矩阵

- 必填列：业务字段名、后端 response 字段、后端 request 字段、前端 DTO/type、store 字段、form model 字段、table/detail 展示字段、组件 prop/v-model、校验规则、错误回填字段、mock/fixture 字段、默认值、空值策略、格式化/反格式化、测试断言。
- 来源约束：后端契约、OpenAPI、真实 response、现有 fixture、页面旧逻辑和数据库含义要分清；没有证据的字段标为待确认，不写成已确认。
- 命名约束：同一字段只能有一个前端 owner；跨层改名必须在 mapper、adapter 或 normalizer 中集中处理，不在模板和多个组件里散落处理。
- 空值约束：区分 missing、null、空字符串、空数组、0、false；展示、编辑回填、提交和校验分别定义，不让默认值掩盖真实缺失。
- 枚举约束：枚举值、展示文案、禁用态、未知值兜底和提交值要成对维护；后端新增枚举时测试必须失败或有 unknown fallback。
- 时间/金额/单位：时区、精度、币种、单位换算、四舍五入和输入格式必须写清；展示格式不能直接反向当提交值。
- 嵌套/数组：嵌套对象、标签、多选、图片、附件、地址和动态表单项要定义稳定 key、增删顺序、脏字段判断和局部错误路径。
- 验证：字段矩阵变更后至少跑类型检查、mapper 单测或组件测试，并用一份真实/fixture response 验证展示、编辑回填和提交 payload。

### 9. 编辑场景：回填、提交、错误回填

- 入口：从列表行进入编辑时，只允许使用列表行中已证明完整的字段；缺字段、权限敏感字段或详情字段必须重新请求详情。
- 回填：API response 先进入 DTO/mapper，再进入 form model；不要让表单组件直接依赖原始 response。
- 脏字段：明确全量提交还是 patch 提交；patch 提交要区分未改、清空、置零和置 false。
- 提交：提交中禁重复，保留取消/关闭策略；成功后按契约刷新当前页、局部替换列表项、更新详情或失效缓存。
- 错误回填：字段级错误按字段路径回填；数组项错误要定位到具体行；跨字段错误放表单级；权限/登录/冲突错误给出可恢复动作。
- 并发：编辑期间被刷新、筛选切换、详情重拉或 route 变化时，必须避免旧响应覆盖用户正在编辑的草稿。
- 回滚：乐观更新失败时恢复旧列表项、详情、store 和选中态；保留用户输入以便修正后重试。
- 验证：新增/编辑同组件复用时，分别验证创建默认值、编辑回填、提交 payload、字段错误、取消关闭、重复提交和刷新后数据一致。

### 10. 删除场景：确认、刷新、回滚

- 确认：删除必须有明确对象名、关键字段或数量；批量删除要展示选中数和不可删除项，避免只用 ID 让用户误删。
- 权限：前端按钮隐藏只做体验；删除接口失败、无权限、已删除、有关联数据和冲突状态必须有可见反馈。
- 提交：删除中锁定当前对象按钮；批量删除要记录每项成功/失败，不能把部分失败报成全成功。
- 刷新：成功后按数据 owner 刷新列表、分页总数、详情页、缓存、store、选择态和空态；删除当前页最后一条时要处理页码回退。
- 回滚：乐观删除失败时恢复原行、排序、选中态、分页计数和详情入口；失败原因保留在对应行或全局提示。
- 联动：删除影响筛选计数、树结构、面包屑、tab、关联列表或详情侧栏时，必须同步刷新或标记失效。
- 验证：确认弹窗取消、单删、批删、部分失败、重复点击、删除后刷新、删除后回退、最后一条和无权限。

### 10.5 Loading / Error / Empty / Permission

- loading：区分整页首次加载、局部刷新、按钮提交、后台静默刷新和骨架屏；加载中不能误清空旧数据，除非需求明确要求。
- empty：空数据要说明筛选条件、创建入口、权限限制或下一步动作；不能把接口失败显示成空态。
- error：网络、超时、取消、登录过期、无权限、字段错误、并发冲突和服务端异常要有不同恢复动作。
- permission：前端权限只做体验；按钮、路由、API 错误和页面级提示要一致，角色变化后要刷新菜单、store、缓存和当前页状态。
- old data：刷新失败时说明是否保留旧数据；提交或删除成功后不能让列表、详情、store、缓存和面包屑继续显示旧数据。
- 验证：慢网、断网、403、401、500、空列表、筛选无结果、重复点击、返回上一页和移动端下的状态布局。

### 11. 性能排障

- 证据：页面规模、LCP/INP、bundle 报告、网络瀑布、性能面板、Vue DevTools profiler、真实数据量。
- 动作：优先减首屏 JS、懒加载路由、拆分重组件、移除重依赖、稳定 props、虚拟列表和减少深层响应式开销。
- 工具：生产构建、bundle analyzer、Chrome Performance、Vue DevTools、WebPageTest/PageSpeed。
- 验证：优化前后指标、真实数据量、弱机/慢网、列表滚动、输入响应和回归页面。

### 12. 安全门禁

- 禁止不可信模板：用户内容不能进入 Vue template 编译链或挂载点模板。
- `v-html` 只允许可信或已安全清洗内容；富文本优先 sandbox/iframe 或严格 sanitizer 策略。
- URL、style、class、src、href、HTML、文件预览和第三方组件都要审查注入风险。
- 动态组件、动态指令、动态 import、URL query 回填、Markdown/富文本预览和第三方渲染器必须确认输入来源和清洗策略。
- 文件上传、图片预览和下载链接要检查文件名、MIME、大小、预览 URL 生命周期和对象 URL 释放。
- SSR 场景禁止执行不可信模板或动态代码；避免请求级数据跨用户泄漏。
- 前端不能替代后端安全：CSRF/XSSI、鉴权、URL 清洗、权限和敏感数据过滤必须后端兜底。

### 13. TypeScript 与工程化

- 证据：`tsconfig`、Volar/vue-tsc、Vetur、路径别名、API 类型来源、组件 props 类型和构建目标。
- 动作：props/emits/store/API 响应使用明确类型；泛型组件谨慎；模板类型错误必须修，不用 `as any` 压掉。
- 字段类型：字段映射矩阵里的每个 API 字段都要落到类型、mapper、fixture 和测试；临时 unknown 必须在边界解析，不能下沉成组件内部的 `any`。
- Vue 2：识别 Vue CLI、Webpack、Babel、Vetur、class-component、decorator、Vuex 类型和老浏览器 polyfill 约束。
- Vue 3：识别 Vite、Volar、vue-tsc、`defineProps/defineEmits`、宏类型推导和构建目标。
- Vite/Vue CLI：插件、env、alias、define、CSS、assets 和 build target 改动要评估 dev/build/preview 三种环境。
- 验证：`vue-tsc` 或项目等价 typecheck、lint、unit、build、preview 和目标浏览器兼容。

### 14. 测试策略

- 单测：纯 composable、store action、格式化、权限判断、复杂组件分支。
- 组件测试：props/emits/slot、表单、loading/error/empty、键盘和 a11y。
- 集成测试：router + store + API mock/fake server，验证页面真实数据流。
- E2E：登录、核心流程、提交、权限、回退、发布前冒烟。
- 字段测试：字段映射 mapper、表单回填、提交 payload、服务端字段错误、删除刷新、乐观更新回滚、mock/fixture 与 API 类型一致性必须有对应断言。
- 反例测试：字段缺失、null、未知枚举、金额/时间格式异常、数组项错误、删除部分失败、旧请求覆盖新状态和 `any` 掩盖类型错误都要纳入高风险用例。
- 证据：命令、用例名、截图/video、network 样本、失败日志和未覆盖风险。

### 15. Vue 2 → Vue 3 迁移

- 证据：Vue、Router、Vuex、UI 库、构建工具、测试工具、浏览器支持、第三方插件和全局 API 使用清单。
- 动作：先跑迁移扫描和兼容矩阵；分阶段处理全局 API、生命周期、filters、v-model、slots、emits、响应式边界、Router 3→4、Vuex→Pinia 或保留 Vuex。
- 策略：能小步兼容就不大爆改；保留旧入口回归；UI 库不兼容时先定替代和视觉回归范围。
- 验证：旧页面冒烟、关键表单、路由刷新、store 初始化、SSR hydration、构建体积和浏览器兼容。

### 16. 发布与回滚

- 证据：build 产物、base path、静态资源路径、环境变量、CDN 缓存、SSR/SPA 部署形态和回滚方式。
- 动作：生产构建、预览、路由 history fallback、chunk 缓存策略、错误监控、灰度和旧版本兼容。
- 验证：刷新深链、静态资源 404、旧 chunk、环境变量、Sourcemap 策略、监控告警和回滚后页面可用。

### 17. i18n / a11y / responsive

- i18n：新增文案不硬编码在业务逻辑；日期、时间、金额、百分比、数量、复数、空态、错误和校验文案要跟语言环境一致。
- a11y：表单控件要有关联 label、错误提示、焦点顺序和键盘路径；弹窗、下拉、toast、loading 和确认框要处理焦点进入、返回和 Escape。
- responsive：页面、表格、表单、弹窗、侧栏和空态要在移动端、窄屏、长文本、放大字体和横竖屏下不遮挡、不溢出、不丢关键操作。
- 视觉状态：禁用、聚焦、hover、active、选中、错误、成功和加载态要可区分；颜色不能作为唯一信息来源。
- 验证：至少覆盖一个桌面宽屏、一个移动窄屏、键盘操作、长文案/多语言、错误提示和弹窗滚动。

## 验证门禁

- Vue 2 / Vue 3 版本、构建工具、路由、store、UI 库、SSR/SPA 形态和兼容范围已确认。
- typecheck、lint、相关 unit/component/e2e 或项目等价验证命令已运行；无法运行时必须说明原因和剩余风险。
- UI 改动已在浏览器验证主路径、loading、empty、error、permission、submit、slow network 和 mobile/响应式边界。
- Vue 安全风险已检查：不可信模板、`v-html`、URL/style 注入、token/session 日志和 SSR 请求级状态泄漏。
- 性能风险已检查：route lazy-load、bundle 体积、列表渲染、props 稳定性、响应式深度和 hydration mismatch。
- 发布风险已检查：生产 build、preview、history fallback、静态资源路径、旧 chunk、环境变量和回滚路径。
- 字段映射矩阵已覆盖 API 类型、DTO/store/form/table/detail、校验、错误回填、mock/fixture 和测试断言。
- props/state/store/router/form/API/error/loading/empty/permission/i18n/a11y/responsive 已逐项检查；未涉及项有证据。
- 编辑场景已验证回填、提交、提交后刷新、字段级错误、并发覆盖、取消和回滚。
- 删除场景已验证确认、权限失败、刷新分页/缓存/选中态、部分失败和乐观删除回滚。
- 异步请求已验证取消、卸载、快速切换、重复点击、旧响应覆盖和缓存失效。
- 列表 key、watch/computed/effect、副作用清理、直接 DOM 操作和第三方组件挂载已检查。
- TypeScript 中没有用 `any` 掩盖新增或变更 API 字段；必须保留的第三方 `any` 已隔离在边界并说明原因。

## 输出要求

- 先给影响面：页面、组件、store、router、API、样式、测试和发布入口。
- 再给改动点：按文件或功能列出，不夸大未验证内容。
- 再给验证证据：命令、页面路径、浏览器/设备、测试用例和结果。
- 最后给剩余风险：未覆盖场景、需要后端/设计/测试/发布联动的事项。

## 安全边界

- 不帮助绕过登录、权限、付费、风控、CSP 或审计机制。
- 不把用户输入直接注入模板、HTML、URL、style、事件处理器或 SSR 执行环境。
- 不把 token、session、个人信息写入前端日志、localStorage 或错误上报明文。
- 不为未授权目标编写攻击脚本；安全测试必须限定在授权项目和防御目的内。

## 反例库

- 只看到 `package.json` 有 Vue 就触发本技能，但用户只是学习项目结构：应跳过，转项目学习。
- 用户说“页面太丑”：应优先 UI 设计实现或设计审计，除非明确要改 Vue 组件代码。
- 新增列表直接渲染上万 DOM 节点：应要求分页、虚拟列表或服务端筛选。
- 把筛选条件同时放本地 state、Pinia 和 query：应选单一事实源并定义同步方向。
- 列表 key 用 index 或随机数：会导致复选框、输入框、动画和缓存错位，必须使用业务稳定 ID 或组合稳定 key。
- 子组件直接改 props：会破坏单向数据流，应通过 emit、v-model 契约或本地副本同步。
- 字段映射只写“接口返回什么就展示什么”：必须补 response/request/form/table/error/mock 的逐字段矩阵。
- 编辑页直接把详情 response spread 到 form：会把只读字段、未知字段、格式化字段和 null 语义混入提交，应通过 mapper 回填。
- 提交成功只提示成功但不刷新列表、详情或缓存：会造成用户看到旧数据，应按 owner 刷新或局部替换。
- 服务端字段错误只弹全局 toast：应回填到对应控件，数组项错误要定位具体行。
- 删除成功只从 DOM 上移除一行：应同步分页总数、选中态、store、缓存、详情入口和空态。
- 乐观删除失败不回滚：必须恢复原行、排序、分页计数和选中态。
- mock/fixture 仍用旧字段但组件改了新字段：测试会给出假通过，应同步 API 类型、fixture、factory 和断言。
- 为了赶进度把 response 标成 `any`：应先补局部类型或 unknown 解析，不能让字段错误逃过 typecheck。
- watcher 里写回被监听字段：会造成无限循环或抖动，应拆来源、加等值判断或改成 computed setter。
- 弹窗关闭后请求仍回填状态：会覆盖下一次打开的草稿，应取消请求或校验请求序号。
- 只测桌面 happy path：会漏掉移动端遮挡、空态、错误态、无权限、弱网和重复点击。
- 直接 querySelector 改样式修 UI：会绕过 Vue 生命周期和响应式，应改状态、class 绑定或组件 API。
- 用 `v-html` 渲染用户输入：必须阻断或要求可信清洗/sandbox 证据。
- 修 hydration mismatch 只改客户端判断：必须查 SSR 数据、时区、随机数、环境分支和请求级状态泄漏。
- 为了复用抽出大而全组件：如果调用方语义不同，应拆领域组件或保留局部实现。
- 接口失败只 console.log：必须有用户可见错误、重试/回退和日志证据。

## 自检清单

- 是否确认 Vue 2 / Vue 3、构建工具、运行形态、路由、store、UI 库、兼容范围和测试命令？
- 是否列出状态 owner、初始化、更新、重置和失败恢复？
- 是否补齐字段映射矩阵，覆盖 response/request、DTO/type、store、form、table/detail、校验、错误回填、mock/fixture 和测试断言？
- 编辑场景是否验证回填、提交 payload、成功刷新、字段错误、取消关闭、并发覆盖和回滚？
- 删除场景是否验证确认文案、权限失败、刷新列表/分页/缓存/选中态、部分失败和乐观回滚？
- API 类型、mock handler、fixture、factory、snapshot 和测试数据是否与字段映射同步？
- 是否检查新增或变更字段没有用 `any` 扩散到组件、store、mapper、mock 或测试？
- 是否逐项检查 props/state/store/router/form/API/error/loading/empty/permission/i18n/a11y/responsive？
- 是否避免直接改 DOM、index key、未消毒 `v-html`、watch 自触发、未取消异步请求和桌面 happy path 假验证？
- 是否覆盖 loading、empty、error、permission、submit、slow network 和 mobile？
- 是否避免不可信模板、`v-html`、危险 URL/style 和敏感日志？
- 是否有 route lazy-load、bundle 体积、列表渲染和响应式开销判断？
- 是否跑过 typecheck/lint/test/build 或说明无法运行？
- UI 改动是否在浏览器验证过主路径和边界？
- 是否说明未覆盖风险和联动技能？

## 相邻技能边界

- `JavaScript/TypeScript 开发/javascript-typescript-development（jsts）`：通用 JavaScript/TypeScript、Node、包管理、Webpack/Vite 基础问题；Vue 2 / Vue 3 页面、组件、状态、迁移专项用本技能。
- `u`/`a`/`q`：视觉设计、UI 架构、设计审计；本技能负责把设计落到 Vue 组件和交互实现。
- `API 工程/api-engineering（api）`：后端接口契约、鉴权、分页、幂等；本技能负责 Vue 调用、错误态和前端契约消费。
- `测试验证/test-engineering（tst）`：测试矩阵、CI gate、质量结论；Vue 复杂改动或发布前验证联动测试技能。
- `Web 安全/web-security（wsec）`：登录、鉴权、XSS/CSRF/越权等安全专项；Vue 安全风险命中时联动。
- `性能工程/perf-engineering（pfe）`：性能专项；Vue 性能问题涉及 CPU、内存、卡顿、bundle 或大列表时联动。
- `发布部署/release-engineering（rls）`：发布、部署、回滚、CDN 和 CI/CD；构建产物或上线问题联动。
