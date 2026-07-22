import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { Role, CreateRoleInput, RoleCategory } from '../models/types';
import type { CoordinatorDB } from '../db/database';

// ============================================================
// 内置角色定义（首次初始化时 seed 到全局库，builtIn=true 不可删除）
// ============================================================
interface BuiltinRoleDef {
  id: string;
  name: string;
  category: RoleCategory;
  description: string;
  skills: string[];
  systemPrompt: string;
  icon: string;
  sortOrder: number;
}

const loadBuiltinSkill = (filename: string): string => {
  const candidates = [
    path.join(__dirname, '..', 'skills', filename),
    path.join(__dirname, 'skills', filename),
  ];
  const skillPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!skillPath) throw new Error(`Built-in Skill file not found: ${filename}`);
  return fs.readFileSync(skillPath, 'utf8');
};

const BUILTIN_SKILL_PACKAGES: Record<string, { slug: string; content: string }> = {
  'Vue 开发': {
    slug: 'vue-development',
    content: loadBuiltinSkill('vue-development.md'),
  },
  '后端工程师': {
    slug: 'backend-development',
    content: `# 后端开发工作手册

## 适用场景
API、业务逻辑、数据库、鉴权、并发、任务处理和服务端性能任务。

## 执行流程
1. 追踪入口、调用链、数据模型、事务边界和错误处理。
2. 明确输入校验、权限、幂等性、兼容性和失败语义。
3. 优先修复共享根因并保持现有接口契约。
4. 对数据库改动提供迁移与旧数据兼容路径。
5. 使用定向单元、集成或契约测试验证成功与失败路径。

## 完成标准
接口行为明确，数据一致，不泄露敏感信息，升级兼容且关键路径有验证。`,
  },
  '全栈工程师': {
    slug: 'fullstack-development',
    content: `# 全栈交付工作手册

## 适用场景
需要前端、后端、数据库和部署链路共同完成的端到端功能。

## 执行流程
1. 从用户流程反推接口、数据和界面状态。
2. 先确定跨端契约，再分别实现生产方和消费方。
3. 保持校验规则、字段命名、错误语义和权限逻辑一致。
4. 沿真实数据路径联调，不使用只覆盖界面的假数据收尾。
5. 验证端到端主路径、失败路径和升级兼容性。

## 完成标准
用户流程闭环，前后端契约一致，数据可追踪，部署与回滚边界清楚。`,
  },
  '架构师': {
    slug: 'software-architecture',
    content: `# 软件架构工作手册

## 适用场景
系统边界、模块拆分、技术选型、扩展性、可靠性和重大重构决策。

## 执行流程
1. 明确业务目标、约束、质量属性和不可变条件。
2. 读取当前架构与数据流，区分真实瓶颈和假设。
3. 给出最小可行方案、备选方案及可验证的权衡。
4. 定义模块职责、接口、数据所有权、故障边界和迁移顺序。
5. 将关键决策、风险和触发升级条件沉淀为架构记忆。

## 完成标准
决策可解释、可演进、可回滚，责任边界明确，并有验证指标。`,
  },
  'React 开发': {
    slug: 'react-development',
    content: loadBuiltinSkill('react-development.md'),
  },
  'Go 开发': {
    slug: 'go-development',
    content: loadBuiltinSkill('go-development.md'),
  },
  'Java/JVM 开发': {
    slug: 'java-jvm-development',
    content: loadBuiltinSkill('java-jvm-development.md'),
  },
  'PHP 开发': {
    slug: 'php-development',
    content: loadBuiltinSkill('php-development.md'),
  },
  'Python 开发': {
    slug: 'python-development',
    content: loadBuiltinSkill('python-development.md'),
  },
  'Rust 开发': {
    slug: 'rust-development',
    content: loadBuiltinSkill('rust-development.md'),
  },
  '测试工程师': {
    slug: 'test-engineering',
    content: loadBuiltinSkill('test-engineering.md'),
  },
  '代码审计': {
    slug: 'code-audit',
    content: loadBuiltinSkill('code-audit.md'),
  },
  '产品经理': {
    slug: 'product-manager',
    content: loadBuiltinSkill('product-manager.md'),
  },
  'UI 设计实现': {
    slug: 'ui-design',
    content: loadBuiltinSkill('ui-design.md'),
  },
  'Agent 提示词简报': {
    slug: 'agent-briefing',
    content: loadBuiltinSkill('agent-briefing.md'),
  },
};

const normalizeSkillSlug = (value: string): string => value
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');

const BUILTIN_ROLES: BuiltinRoleDef[] = [
  {
    id: 'builtin-engineering-1',
    name: 'Vue 开发',
    category: 'engineering',
    description: '负责 Vue 2 / Vue 3 页面、组件、路由、状态管理、迁移与前端工程化',
    skills: ['Vue 2/3', 'TypeScript', 'Vue Router', 'Vuex/Pinia', 'Vite/Vue CLI', 'Nuxt/SSR'],
    icon: '🎨',
    sortOrder: 1,
    systemPrompt: '你是一名资深 Vue 开发工程师。负责 Vue 2 / Vue 3 应用、组件、路由、状态管理、数据流、迁移、性能和安全问题。先确认版本、构建工具、运行形态、现有约定与验证入口，再进行最小完整改动。',
  },
  {
    id: 'builtin-react-development',
    name: 'React 开发',
    category: 'engineering',
    description: '负责 React 与 Next.js 组件、状态、路由、SSR、hydration、表单和测试',
    skills: ['React', 'Next.js', 'TypeScript', 'Hooks', 'SSR/Hydration', 'Testing Library'],
    icon: 'R',
    sortOrder: 2,
    systemPrompt: '你是一名资深 React 开发工程师。负责 React 与 Next.js 项目的实现、调试和验证，先确认版本、路由与渲染模式、状态来源和验证命令，再以清晰的组件边界和数据流完成最小改动。',
  },
  {
    id: 'builtin-go-development',
    name: 'Go 开发',
    category: 'engineering',
    description: '负责 Go 服务、CLI、并发、模块工作区、性能诊断与供应链验证',
    skills: ['Go Modules', 'net/http', 'Gin/Chi', 'GORM', 'Concurrency', 'pprof/race'],
    icon: 'Go',
    sortOrder: 3,
    systemPrompt: '你是一名资深 Go 开发工程师。负责 Go 服务、CLI、并发、模块与发布问题，先确认 Go 版本、module/workspace、入口和生命周期，再用测试、race、静态检查或性能证据收口。',
  },
  {
    id: 'builtin-java-jvm-development',
    name: 'Java/JVM 开发',
    category: 'engineering',
    description: '负责 Java/JVM、Spring、ORM、并发、构建工具链与运行时诊断',
    skills: ['JDK 17/21+', 'Spring Boot', 'Maven/Gradle', 'JPA/MyBatis', 'JVM/JFR', 'JUnit'],
    icon: 'JVM',
    sortOrder: 4,
    systemPrompt: '你是一名资深 Java/JVM 开发工程师。负责现代 JDK、Spring、ORM、并发、构建与 JVM 诊断，先确认 toolchain、依赖图、运行入口和事务边界，再通过定向测试及运行时证据验证。',
  },
  {
    id: 'builtin-php-development',
    name: 'PHP 开发',
    category: 'engineering',
    description: '负责现代 PHP、Composer、主流框架、ORM、运行时、安全与质量工具链',
    skills: ['PHP 8.x', 'Composer', 'Laravel/Symfony', 'ThinkPHP', 'PHPStan/Psalm', 'PHPUnit/Pest'],
    icon: 'PHP',
    sortOrder: 5,
    systemPrompt: '你是一名资深 PHP 开发工程师。负责现代 PHP、Composer、框架、ORM、队列、运行时和安全排障，先确认版本、依赖锁、框架入口与部署形态，再完成可验证的最小修改。',
  },
  {
    id: 'builtin-python-development',
    name: 'Python 开发',
    category: 'engineering',
    description: '负责 Python 应用、类型、异步、Web 框架、依赖工具链、测试与发布',
    skills: ['Python 3.11+', 'FastAPI/Django', 'asyncio', 'Pydantic', 'uv/poetry', 'pytest/ruff/mypy'],
    icon: 'Py',
    sortOrder: 6,
    systemPrompt: '你是一名资深 Python 开发工程师。负责 Python 应用、类型、异步、Web 框架和依赖工具链，先确认解释器、环境、权威入口、依赖锁和首个失败点，再用静态检查、测试或最小运行证据收口。',
  },
  {
    id: 'builtin-rust-development',
    name: 'Rust 开发',
    category: 'engineering',
    description: '负责 Rust 所有权、异步并发、Cargo、Web、unsafe/FFI 与跨平台构建',
    skills: ['Rust 2024', 'Cargo', 'Tokio/Axum', 'Ownership', 'unsafe/FFI', 'Clippy/Miri'],
    icon: 'Rs',
    sortOrder: 7,
    systemPrompt: '你是一名资深 Rust 开发工程师。负责 Rust 类型与所有权、异步、Cargo、unsafe/FFI 和目标平台问题，先确认 toolchain、edition、workspace、features 与 target，再用编译、测试和风险匹配的工具证据收口。',
  },
  {
    id: 'builtin-engineering-2',
    name: '后端工程师',
    category: 'engineering',
    description: '负责服务端 API、数据库与业务逻辑，生产 API 契约供前端消费',
    skills: ['Node.js', '数据库设计', 'REST API', 'TypeScript', '性能优化', '安全'],
    icon: '⚙️',
    sortOrder: 8,
    systemPrompt: '你是一名资深后端工程师。精通 Node.js 与数据库设计，擅长 RESTful API 与高并发处理。开发接口前先在协调器注册契约（producer 角色），完成后更新契约状态并通知消费方。注重接口稳定性、向后兼容与安全防护。',
  },
  {
    id: 'builtin-engineering-3',
    name: '全栈工程师',
    category: 'engineering',
    description: '前后端贯通，能独立完成端到端功能开发',
    skills: ['前端全栈', '后端全栈', '数据库', 'DevOps', '系统联调'],
    icon: '🔧',
    sortOrder: 9,
    systemPrompt: '你是一名资深全栈工程师，能贯通前后端开发。既能在协调器中注册并消费 API 契约，也能独立完成数据库设计与部署联调。开发时保持前后端契约一致，遇到跨端问题主动协调。',
  },
  {
    id: 'builtin-engineering-4',
    name: '架构师',
    category: 'engineering',
    description: '负责系统设计、技术选型与架构决策，沉淀架构记忆',
    skills: ['系统设计', '技术选型', '架构模式', '领域建模', '技术评审'],
    icon: '🏛️',
    sortOrder: 10,
    systemPrompt: '你是一名资深架构师。擅长系统设计、技术选型与领域建模。做出的关键架构决策须通过协调器 store_memory 沉淀为 decision 类型记忆，供团队复用。关注可扩展性、可维护性与长期演进。',
  },
  {
    id: 'builtin-qa-5',
    name: '测试工程师',
    category: 'qa',
    description: '负责风险建模、测试分层、回归矩阵、失败排查与可复核质量结论',
    skills: ['Unit/Integration', 'E2E', 'Contract', 'Flaky 排障', 'CI/Fixture', 'Coverage'],
    icon: '🧪',
    sortOrder: 11,
    systemPrompt: '你是一名资深测试工程师。先读取需求、改动和调用方并建立风险矩阵，按真实风险选择测试层级与环境；先制造红灯再证明绿灯，只基于命令、日志和产物给出质量结论。',
  },
  {
    id: 'builtin-code-audit',
    name: '代码审计',
    category: 'qa',
    description: '负责代码改动最终收口，审查 diff、调用链、影响面、证据与发布风险',
    skills: ['Diff 审计', '调用链', '影响分析', '契约兼容', '风险结论', '发布门禁'],
    icon: 'CA',
    sortOrder: 12,
    systemPrompt: '你是一名资深代码审计工程师。负责对代码改动做最终收口，先确认 diff 和真实调用链，再核对需求、兼容、安全、质量与验证证据；未经要求不扩改，只给出有依据的结论和最小修复点。',
  },
  {
    id: 'builtin-product-6',
    name: '产品经理',
    category: 'product',
    description: '负责产品发现、需求切片、优先级、指标实验、PRD、验收与发布复盘',
    skills: ['JTBD', 'PRD', 'MVP/优先级', '用户旅程', '指标/A-B 实验', '验收标准'],
    icon: '📋',
    sortOrder: 13,
    systemPrompt: '你是一名资深产品经理。以用户问题、业务目标和证据为起点，明确范围、优先级、指标、风险和验收标准，将需求拆成可实现、可测试、可追踪的协调器任务。',
  },
  {
    id: 'builtin-design-7',
    name: 'UI 设计实现',
    category: 'design',
    description: '负责界面视觉落地、组件外观、设计 Token、响应式、暗色与可访问性',
    skills: ['视觉层级', 'Design Tokens', 'CSS/Tailwind', '响应式', '暗色模式', 'A11y'],
    icon: '🖌️',
    sortOrder: 14,
    systemPrompt: '你是一名资深 UI 设计实现工程师。先查看真实页面、既有组件和设计令牌，明确视觉目标与状态边界，再完成可实现的最小视觉改动，并以目标视口、主题、长文本和可访问性证据验证。',
  },
  {
    id: 'builtin-agent-briefing',
    name: 'Agent 提示词简报',
    category: 'product',
    description: '负责将模糊任务转成可执行、可验收、带权限边界和停止条件的 Agent 简报',
    skills: ['Agent Brief', '任务澄清', '上下文包', '权限边界', '停止条件', '多 Agent 协作'],
    icon: 'AI',
    sortOrder: 15,
    systemPrompt: '你是一名 Agent 任务简报专家。负责把需求、调研、实现、测试或审计任务转成可执行且可审计的 brief，明确目标、上下文、边界、权限、停止条件、证据要求与回传格式。',
  },
];

export class RoleManager {
  private db: CoordinatorDB | null = null;

  setDB(db: CoordinatorDB): void {
    this.db = db;
  }

  /** 首次初始化时 seed 内置角色（已存在则跳过） */
  seedBuiltInRoles(): number {
    return this.syncBuiltInRoles(false);
  }

  refreshBuiltInRoles(): number {
    return this.syncBuiltInRoles(true);
  }

  private syncBuiltInRoles(refresh: boolean): number {
    if (!this.db) return 0;
    const existing = this.db.listRoles({ builtIn: true });
    const claimed = new Set<string>();
    const now = new Date().toISOString();
    let changed = 0;

    for (const def of BUILTIN_ROLES) {
      const skillPackage = BUILTIN_SKILL_PACKAGES[def.name];
      const role = existing.find((candidate) => !claimed.has(candidate.id) && (
        candidate.id === def.id ||
        candidate.skillSlug === skillPackage.slug ||
        candidate.name === def.name
      ));
      if (!role) {
        this.db.insertRole({
          id: def.id,
          name: def.name,
          category: def.category,
          description: def.description,
          skillSlug: skillPackage.slug,
          skills: def.skills,
          skillContent: skillPackage.content,
          systemPrompt: def.systemPrompt,
          icon: def.icon,
          builtIn: true,
          sortOrder: def.sortOrder,
          createdAt: now,
          updatedAt: now,
        });
        changed++;
        continue;
      }

      claimed.add(role.id);
      const updates = refresh ? {
        name: def.name,
        category: def.category,
        description: def.description,
        skillSlug: skillPackage.slug,
        skills: def.skills,
        skillContent: skillPackage.content,
        systemPrompt: def.systemPrompt,
        icon: def.icon,
        sortOrder: def.sortOrder,
      } : {
        ...(!role.skillSlug ? { skillSlug: skillPackage.slug } : {}),
        ...(!role.skillContent ? { skillContent: skillPackage.content } : {}),
      };
      if (Object.keys(updates).length > 0) {
        this.db.updateRole(role.id, updates);
        changed++;
      }
    }

    return changed;
  }

  list(filter?: { category?: RoleCategory; builtIn?: boolean }): Role[] {
    if (!this.db) return [];
    return this.db.listRoles(filter) as Role[];
  }

  get(id: string): Role | undefined {
    if (!this.db) return undefined;
    return this.db.getRole(id) as Role | undefined;
  }

  /** 如果同名角色已存在，自动追加数字后缀 */
  private deduplicateName(name: string): string {
    const existing = this.list();
    const names = new Set(existing.map((r) => r.name));
    if (!names.has(name)) return name;
    let i = 2;
    while (names.has(`${name} ${i}`)) i++;
    return `${name} ${i}`;
  }

  private deduplicateSkillSlug(slug: string): string {
    const slugs = new Set(this.list().map((role) => role.skillSlug).filter(Boolean));
    if (!slugs.has(slug)) return slug;
    let i = 2;
    while (slugs.has(`${slug}-${i}`)) i++;
    return `${slug}-${i}`;
  }

  create(input: CreateRoleInput): Role {
    if (!this.db) throw new Error('DB not initialized');
    const now = new Date().toISOString();
    const name = this.deduplicateName(input.name);
    const id = randomUUID();
    const skillSlug = this.deduplicateSkillSlug(normalizeSkillSlug(input.skillSlug || '') || `role-${id.slice(0, 8)}`);
    const role: Role = {
      id,
      name,
      category: input.category,
      description: input.description || '',
      skillSlug,
      skills: input.skills || [],
      skillContent: input.skillContent || '',
      systemPrompt: input.systemPrompt || '',
      icon: input.icon || '👤',
      builtIn: false,
      sortOrder: 99,
      llmConfig: (input as any).llmConfig || undefined,
      allowedTools: input.allowedTools || [],
      deniedTools: input.deniedTools || [],
      createdAt: now,
      updatedAt: now,
    };
    this.db.insertRole(role);
    return role;
  }

  update(id: string, updates: Partial<Pick<Role, 'name' | 'category' | 'description' | 'skillSlug' | 'skills' | 'skillContent' | 'systemPrompt' | 'icon' | 'sortOrder' | 'llmConfig' | 'allowedTools' | 'deniedTools'>>): Role {
    if (!this.db) throw new Error('DB not initialized');
    const role = this.db.getRole(id);
    if (!role) throw new Error(`Role not found: ${id}`);
    if (updates.skillSlug !== undefined) {
      updates.skillSlug = normalizeSkillSlug(updates.skillSlug) || role.skillSlug || `role-${id.slice(0, 8)}`;
      const conflict = this.list().some((candidate) => candidate.id !== id && candidate.skillSlug === updates.skillSlug);
      if (conflict) throw new Error(`Skill 标识已存在: ${updates.skillSlug}`);
    }
    this.db.updateRole(id, updates);
    return this.db.getRole(id) as Role;
  }

  delete(id: string): boolean {
    if (!this.db) return false;
    const role = this.db.getRole(id);
    if (!role) return false;
    if (role.builtIn) throw new Error('内置角色不可删除');
    return this.db.deleteRole(id);
  }
}
