---
name: ui-design
cn: UI 设计实现
icon: 🎨
description: UI Design技能 - 负责界面视觉落地、组件外观、样式排障、设计 Token、响应式密度、暗色模式、可访问性与设计交付证据；涉及 UI 视图、CSS、Tailwind、颜色、排版、间距、动效、图标使用、空/加载/错误态时使用。
---

# UI Design实战排障版

定位：本技能只收口 UI Design 的视觉落地与排障，不替代品牌方向、信息架构、图标绘制、前端逻辑、测试工程或代码审计。核心目标是让界面改动有目标、有画面、有组件边界、有可验证证据，避免凭主观“更好看”硬改。

## 快速总则：目标 / 画面 / 组件 / 证据

- 目标：先写清本次解决 visual hierarchy、spacing scale、typography、contrast/APCA、color tokens、dark mode、responsive density、motion duration、state、a11y、Figma Dev Mode 中哪几项；目标不清先不改。
- 画面：必须看真实页面或截图，覆盖正常、长文本、空、加载、错误、禁用、窄屏、暗色、high contrast、缩放和键盘路径；只看设计稿不够。
- 组件：先查项目组件库、CSS variables、design tokens、第三方 UI 主题入口、Figma Dev Mode 标注，再决定新增样式；共享组件改动必须搜消费方。
- 证据：结论要落到文件、组件、Token 名、断点、截图、浏览器检查、contrast/APCA 数值、Figma 节点或验证命令；未验证写“需验证”。

## 场景执行卡

### 1. 页面视觉层级 / 局部美化

- 先查：同类页面、品牌色、字号阶梯、间距基准、卡片/列表/表单密度、现有空态和错误态。
- 动作：建立 1 个主视觉锚点，控制 2-3 层层级；用字号、字重、留白、对比和位置组织信息，不靠高饱和色堆叠。
- 易漏：只改首屏，漏折叠区、弹层、长标题、批量操作、移动端和暗色主题。
- 验证：320/375/768/1024/1440、容器窄宽、亮暗主题、长文本、空/加载/错误、hover/focus。
- 输出证据：复用组件/Token、视觉目标、影响页面、断点和截图或浏览器检查点。

### 2. 组件外观 / Design Tokens / CSS Variables

- 先查：Button/Input/Card/Table/Dialog 等组件变体，主题变量、CSS variables、Tailwind config、Figma variables/modes、第三方 UI slot/state class。
- 动作：颜色分 raw/alias/semantic/component 层；spacing scale、radius、shadow、border、font 使用 Token 或集中变量；变体和尺寸命名稳定。
- 易漏：default 统一但 hover、active、disabled、focus-visible、loading、error、selected、pressed 不一致。
- 验证：全部 variant/size/state，light/dark/high contrast，消费方页面，第三方升级后的覆盖选择器。
- 输出证据：Token 名、变量名、组件路径、消费方搜索结果、状态矩阵。

### 3. 表单 / 搜索 / 筛选 / 提交反馈

- 先查：验证时机、错误来源、必填提示、重复提交、键盘 Tab、移动端虚拟键盘遮挡、RTL/长语言标签。
- 动作：错误贴近字段；按钮有 disabled/loading；提交失败给原因、影响、下一步；图标按钮有可访问名称；touch target 不小于项目目标或 WCAG 2.2 口径。
- 易漏：回车提交、聚焦首个错误、远程校验防抖、密码显隐、筛选清空、loading 时布局跳动。
- 验证：成功、格式错、服务端错、重复点击、Tab/Shift+Tab、200% 缩放、触屏、RTL。
- 输出证据：状态流程、错误文案、按钮状态、aria-label 或可见标签、触控尺寸。

### 4. 列表 / 表格 / 数据展示 / 图表

- 先查：数据量、列优先级、数值格式、零值含义、横向滚动、分页/筛选联动、图表色板和图例。
- 动作：数字右对齐，关键列优先；长文本截断/换行有规则；skeleton 预留最终高度；empty/error 有说明和行动；颜色不作为唯一信息载体。
- 易漏：0 被当空、操作列挤压、sticky 表头遮挡 focus、图表暗色不可读、虚拟列表行高不稳。
- 验证：空、少量、大量、长文本、窄容器、弱网、导出、分页、筛选、暗色、高对比。
- 输出证据：列宽策略、骨架高度、空态文案、图表 Token、contrast/APCA 检查。

### 5. 弹窗 / 抽屉 / Toast / Tooltip / 导航

- 先查：z-index 系统、滚动锁、focus trap、ESC/遮罩关闭、路由切换、safe-area、Toast 队列和当前态规则。
- 动作：弹层锁背景滚动；危险操作保留取消；Toast 不挡关键操作；Tooltip 不承载必需信息；导航当前态和焦点态可见。
- 易漏：Dropdown 被 overflow 裁切、多层弹窗焦点丢失、移动端底部手势条遮挡、Toast 堆叠盖住按钮。
- 验证：ESC、遮罩、滚动穿透、叠层、Tab 循环、路由刷新、深链接、safe-area。
- 输出证据：层级值、关闭路径、焦点路径、滚动锁结果、当前态截图。

### 6. 响应式密度 / 暗色 / 高对比 / RTL

- 先查：断点、container query、responsive density、主题切换、forced-colors、high contrast 目标、RTL 是否支持。
- 动作：mobile first + container-aware；用语义 Token 做 light/dark/high contrast；使用 logical properties 支持 RTL；保留可见 focus。
- 易漏：只测 viewport 不测容器、100vh 被移动端地址栏影响、暗色边框消失、RTL 图标方向和间距未翻转。
- 验证：320/375/768/1024/1440、关键容器宽度、dvh/svh、亮暗、高对比、RTL、200% 缩放。
- 输出证据：断点截图、容器宽度、Token 映射、contrast/APCA 数值、RTL 检查点。

### 7. 图标 / 图片 / Motion / 性能感知

- 先查：图标库、SVG 规范、图片比例、懒加载、占位策略、动画属性、prefers-reduced-motion。
- 动作：图标尺寸/描边/圆角一致，按需导入；图片保比例占位；motion duration 控制在 100-300ms，优先 opacity/transform，不引发布局抖动。
- 易漏：emoji 当 icon、整包导入图标库、图片无 alt、hover 位移影响布局、减少动态仍播放复杂动画。
- 验证：首屏、弱网、滚动、长列表、低端设备、CLS、reduced-motion。
- 输出证据：图标来源、资源大小、动画时长、CLS/布局稳定观察、alt/aria 结果。

### 8. Figma Dev Mode / Handoff / Pixel Perfect

- 先查：Figma 文件版本、branch、Figma Dev Mode 标注、variables/modes、组件变体、Token 映射、切图命名和真实字体栈。
- 动作：按产品目标追求 pixel perfect；设计稿过期、真实数据更长、平台字体不同、响应式不适配时，记录差异原因而非机械照抄。
- 易漏：只复制像素值，忽略 CSS variables、浏览器字体渲染、缩放、国际化、暗色 mode。
- 验证：关键屏对齐、真实数据、字体 fallback、设计师确认点、Token 对照。
- 输出证据：Figma 节点/版本、mode、Token 对照、差异清单、需确认项。

## 高频坑 / 防遗漏

- 改颜色：查 semantic token、品牌色、状态色、暗色、高对比、图表色、APCA/WCAG，不新增孤立 hex。
- 改间距：查 4px/8px spacing scale、容器 padding、组内/组间 gap、表单密度、touch target、safe-area。
- 改字体：查 typography scale、line-height、font-weight、tabular numbers、fallback、国际化长文本。
- 改组件：查 variant、size、state、slot、消费页面、第三方覆盖入口，不只看 default。
- 改布局：查断点、container query、侧栏、虚拟键盘、dvh/svh/lvh、滚动条、RTL logical properties。
- 改弹层：查 z-index、portal、focus trap、滚动锁、ESC、遮罩、多层叠加、Tooltip 可访问性。
- 改主题：查 light/dark/high contrast、forced-colors、Token alias、图片/图表/阴影/边框。
- 改图标：查图标库、尺寸、描边、方向、aria-label、按需导入；绘制新图标交给 icon-design。
- 改动效：查 duration/easing、opacity/transform、reduced-motion、CLS、低端设备。
- 改文案：查 microcopy 是否说明原因、影响、下一步；UI 只收口界面文案，不替代产品策略。

## 输出要求

最终回复必须给出：

- 场景卡：命中哪类 UI Design 场景。
- 视觉目标：本次解决的 hierarchy / spacing / typography / color / state / responsive / accessibility 等目标。
- 影响面：页面、组件、design tokens、Figma/handoff、断点、主题、第三方覆盖。
- 关键证据：已查看的文件、组件、截图、Token、断点、contrast/APCA、Figma 或命令结果。
- 状态覆盖：default、hover、active、disabled、focus-visible、selected/pressed/loading、empty/loading/error 是否覆盖。
- 验证结果：多断点、亮暗主题、高对比、键盘、长文本、空/错/加载、必要截图或命令产出。
- 缺口：未验证项必须写“需验证”，不能把假设写成完成。
- 联动技能：是否需要 design-director、ui-architect、design-md-builder、icon-design、js-ts-dev、test-engineering、code-audit，并说明原因。

## 约束

- 不重复全局触发规则，只定义 UI 视觉执行口径。
- 不凭主观审美直接改；先找项目规范、真实页面和证据。
- 不越权修改业务逻辑、接口、权限、数据结构、缓存、发布脚本或测试框架。
- 不用 emoji 当 icon；不默认蓝紫渐变、玻璃拟态、大阴影、高饱和装饰。
- 不散写 magic number；长期样式进入 Token、CSS variables、组件或集中覆盖文件。
- 不为了 pixel perfect 破坏 responsive、accessibility、真实数据可用性或国际化。
- 不删除 focus outline，除非提供同等或更强 focus-visible 样式。
- 不只用颜色传达状态；错误、成功、警告必须有文本或图标/形状辅助。
- 不让 loading、error、empty 引发布局跳动或阻断关键操作。
- 不把 APCA/WCAG、Figma Dev Mode、浏览器检查写成已验证，除非真实执行。

## 高频 Bug 反例库

- 反例 1：visual hierarchy 写错法：标题、按钮、标签都用大字号和品牌色。对法：限定一个主视觉锚点，用字号、字重、留白、位置和对比形成 2-3 层。根因：把“突出”理解成全部加重。
- 反例 2：spacing scale 写错法：卡片 12px、列表 14px、表单 18px 随手写。对法：回到 4px/8px 阶梯，定义容器、组内、组间距离。根因：没有间距系统。
- 反例 3：typography 写错法：正文行高过低，数字列不齐，中英混排跳动。对法：使用字号/行高阶梯，数值列用 tabular-nums。根因：未用真实内容验证排版。
- 反例 4：contrast/APCA 写错法：浅灰文本放浅卡片，暗色下辅助字不可读。对法：按目标 WCAG/APCA 记录数值，不达标改语义文本色。根因：肉眼判断替代可测标准。
- 反例 5：color tokens 写错法：新增 #7c3aed 覆盖按钮、标签、图表。对法：拆分 brand、semantic、surface、border、text、chart token。根因：原始色值被当语义。
- 反例 6：dark mode 写错法：把背景反黑，阴影、边框、图表和空态直接沿用亮色。对法：为 surface/text/border/status/chart 建暗色 token 并逐态验证。根因：暗色被当简单反色。
- 反例 7：responsive density 写错法：桌面卡片美观，320px 或窄容器里按钮挤爆。对法：mobile first，补 container query 或密度降级。根因：只测 viewport。
- 反例 8：component state 写错法：只写 default，disabled 看起来可点，focus 不可见。对法：建立 hover/active/disabled/focus-visible/loading/selected 状态矩阵。根因：状态没进入组件契约。
- 反例 9：skeleton/empty/error 写错法：空数据白屏，骨架高度跳动，错误只写“失败”。对法：空态给原因和行动，骨架预留最终尺寸，错误给重试和影响。根因：只交付成功态。
- 反例 10：touch target 写错法：移动端图标按钮 24px 且间距很小。对法：按项目目标或 WCAG 2.2 target size 增大命中区并保留视觉尺寸。根因：只按鼠标点击验收。
- 反例 11：Figma Dev Mode 写错法：照抄过期像素值，忽略 variables/modes 和真实字体栈。对法：确认文件版本、mode、Token 映射和差异原因。根因：设计源未校准。
- 反例 12：CSS variables 写错法：组件内散写颜色和半径，主题切换后失效。对法：接入语义 CSS variables 或组件 token。根因：局部样式绕过主题系统。
- 反例 13：container query 写错法：组件在页面宽屏正常，放进窄侧栏崩。对法：按容器宽度定义布局切换，不只依赖 viewport media query。根因：组件复用场景没验证。
- 反例 14：high contrast 写错法：forced-colors 下背景色被覆盖，边框和 focus 消失。对法：用系统色、边框、outline 和文本冗余表达状态。根因：高对比模式未纳入验收。
- 反例 15：RTL 写错法：margin-left、左箭头和步骤方向写死。对法：用 logical properties，检查图标方向和阅读顺序。根因：把 LTR 当唯一布局。
- 反例 16：motion duration 写错法：弹窗 600ms、hover 位移导致布局抖动，reduced-motion 仍播放。对法：100-300ms，优先 transform/opacity，尊重 prefers-reduced-motion。根因：动效追求炫而非反馈。
- 反例 17：icon consistency 写错法：emoji、Lucide、FontAwesome、手写 SVG 混用。对法：统一图标库、尺寸、描边、圆角和 aria-label；新资产交 icon-design。根因：图标被当临时装饰。
- 反例 18：microcopy 写错法：按钮写“确定”，错误写“异常”。对法：按钮说明动作，错误说明原因、影响、下一步。根因：文案没有服务用户决策。

## 提交前自检清单

- [ ] 已确认视觉目标、页面/组件/Token、断点、主题、状态范围。
- [ ] 已搜索同类组件、既有样式、CSS variables、design tokens、Figma Dev Mode 来源。
- [ ] 已覆盖 default、hover、active、disabled、focus-visible、selected/pressed/loading 等必要状态。
- [ ] 已覆盖 empty、loading、error、长文本、极端数据、弱网或明确需验证。
- [ ] 已验证 contrast/APCA 或标明目标与未验证缺口。
- [ ] 已验证 320/375/768/1024/1440 和关键 container query 场景。
- [ ] 已验证 light/dark/high contrast 或明确项目不支持。
- [ ] 已检查 touch target、键盘路径、aria-label、200% 缩放。
- [ ] 已检查 RTL、safe-area、dvh/svh/lvh、虚拟键盘遮挡风险。
- [ ] 已检查 icon 来源、尺寸、描边、替代文本和按需导入。
- [ ] 已检查 motion duration、属性、CLS 和 reduced-motion。
- [ ] 已回归共享组件消费方、全局覆盖和第三方 UI 主题入口。
- [ ] 已列出未验证项；未跑不报，需验证不伪装完成。

## 2024-2026 新坑速查

- WCAG 2.2：focus appearance、dragging movements、target size 等口径更容易暴露旧组件缺陷。
- APCA：很多团队开始用 APCA 评估感知对比；与 WCAG ratio 不完全等价，必须按项目标准说明。
- Figma variables / modes / Dev Mode：Token、主题、组件变体可能来自 variables 和 mode，不要只抄 Inspect 像素。
- Tailwind v4：主题变量和构建方式变化会影响旧配置、插件和 class 经验。
- CSS container queries：组件响应式要看容器，不只看 viewport。
- CSS variables theming：语义变量、别名变量和组件变量要分层，避免散写 hex。
- High contrast / forced-colors：系统会覆盖颜色，状态必须有文本、边框、outline 或形状冗余。
- Dynamic viewport units：移动端 100vh 易受地址栏影响，弹层/全屏页检查 dvh/svh/lvh。
- Safe area / foldables：底部操作栏、Toast、抽屉要考虑手势条、刘海和折叠屏。
- RTL / logical properties：国际化产品避免写死 left/right、margin-left、箭头方向。
- Variable fonts / font fallback：不同平台字体度量差异会破坏 pixel perfect 和表格对齐。
- Motion sensitivity：复杂转场、滚动视差、自动播放必须尊重 prefers-reduced-motion。
- AI 生成 UI：常见问题是渐变堆叠、假数据、emoji icon、不可用 contrast、组件状态缺失。
- Component library theming：Radix、shadcn、MUI、Ant、Element Plus 升级可能改变量、slot、状态类名。

## 与相邻技能的边界

- design-director：负责品牌气质、视觉方向、审美取舍、风格路线；ui-design 负责把方向落到组件外观、状态、Token 和验证证据。
- ui-architect：负责信息架构、多端布局策略、复杂流程结构、导航组织；ui-design 负责局部视觉层级、间距、排版、密度和状态细节。
- design-md-builder：负责长期设计系统、Token 文档、规范沉淀、可复用资产治理；ui-design 发现可复用规则后交给它固化。
- icon-design：负责图标绘制、SVG 资产、图标语义、图标系统；ui-design 只检查图标使用一致性、可访问名称和视觉适配。
- js-ts-dev：负责 Vue/React/TS 逻辑、状态流、请求、路由、构建；ui-design 不越权改业务逻辑。
- test-engineering：负责测试矩阵、自动化、视觉回归、跨状态回归证据；UI 改动涉及多状态、多端或关键链路时联动。
- code-audit：负责最终代码审计、影响面复核和风险收口；UI 改动涉及共享组件、全局样式、状态逻辑或关键交互时联动。
