import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CoordinatorDB } from '../db/database';
import { EventBus } from '../core/event-bus';
import { RoleManager } from '../core/role-manager';
import { SessionManager } from '../core/session-manager';
import * as fs from 'fs';
import * as path from 'path';

const TEST_DIR = path.join(__dirname, '../../.coordinator');
const TEST_DB = path.join(TEST_DIR, 'test-mcp-core-modules.db');
const SCHEMA = path.join(__dirname, '../db/schema.sql');

describe('MCP core module initialization (RoleManager + SessionManager)', () => {
  let db: CoordinatorDB;
  let eventBus: EventBus;
  let roleManager: RoleManager;
  let sessionManager: SessionManager;

  beforeEach(async () => {
    try { fs.unlinkSync(TEST_DB); } catch {}
    try { fs.unlinkSync(TEST_DB + '.lock'); } catch {}
    fs.mkdirSync(TEST_DIR, { recursive: true });
    db = await CoordinatorDB.create(TEST_DB, SCHEMA);
    eventBus = new EventBus();
    eventBus.setDB(db);
    roleManager = new RoleManager();
    roleManager.setDB(db);
    sessionManager = new SessionManager();
    sessionManager.setDB(db);
    roleManager.seedBuiltInRoles();
  });

  afterEach(() => {
    db.close();
    try { fs.unlinkSync(TEST_DB); } catch {}
    try { fs.unlinkSync(TEST_DB + '.lock'); } catch {}
  });

  it('should seed the complete built-in role catalog from standalone Skills', () => {
    const roles = roleManager.list({ builtIn: true });
    expect(roles).toHaveLength(15);
    const expectedSkills: Record<string, [string, string]> = {
      'Vue 开发': ['vue-development', '## 验证门禁'],
      'React 开发': ['react-development', '## 不适用范围'],
      'Go 开发': ['go-development', '## 单技能铁律：先防低级错'],
      'Java/JVM 开发': ['java-jvm-development', 'Spring Boot'],
      'PHP 开发': ['php-development', 'Composer'],
      'Python 开发': ['python-development', '## 单技能工程门禁'],
      'Rust 开发': ['rust-development', 'Cargo'],
      '测试工程师': ['test-engineering', '风险 / 入口 / 环境 / 证据'],
      '代码审计': ['code-audit', '变更面 / 调用链 / 证据 / 结论'],
      '产品经理': ['product-manager', 'JTBD'],
      'UI 设计实现': ['ui-design', '目标 / 画面 / 组件 / 证据'],
      'Agent 提示词简报': ['agent-briefing', '## 场景执行卡'],
    };
    for (const [name, [slug, section]] of Object.entries(expectedSkills)) {
      const role = roles.find(candidate => candidate.name === name);
      expect(role, name).toBeDefined();
      expect(role!.skillSlug).toBe(slug);
      expect(role!.skillContent).toContain(section);
    }
    expect(roles.map(role => role.name)).toEqual(expect.arrayContaining([
      '后端工程师', '全栈工程师', '架构师',
    ]));
  });

  it('should backfill missing skill packages without overwriting role edits', () => {
    const vueRole = roleManager.list().find(r => r.name === 'Vue 开发')!;
    roleManager.update(vueRole.id, {
      name: '我的前端专家',
      skillSlug: '',
      skillContent: '',
      systemPrompt: '保留我的角色提示词',
    });

    db.updateRole(vueRole.id, { skillSlug: '', skillContent: '' });
    roleManager.seedBuiltInRoles();

    const migrated = roleManager.get(vueRole.id)!;
    expect(migrated.name).toBe('我的前端专家');
    expect(migrated.systemPrompt).toBe('保留我的角色提示词');
    expect(migrated.skillSlug).toBe('vue-development');
    expect(migrated.skillContent).toContain('## 验证门禁');
  });

  it('should add missing built-ins without overwriting existing role edits', () => {
    db.close();
    try { fs.unlinkSync(TEST_DB); } catch {}
    try { fs.unlinkSync(TEST_DB + '.lock'); } catch {}

    return CoordinatorDB.create(TEST_DB, SCHEMA).then((legacyDB) => {
      db = legacyDB;
      roleManager.setDB(db);
      const now = new Date().toISOString();
      db.insertRole({
        id: 'builtin-engineering-1',
        name: '我的 Vue 专家',
        category: 'engineering',
        description: '保留说明',
        skillSlug: 'custom-vue',
        skills: ['保留能力'],
        skillContent: '# 保留手册',
        systemPrompt: '保留提示词',
        builtIn: true,
        sortOrder: 1,
        createdAt: now,
        updatedAt: now,
      });
      const custom = roleManager.create({
        name: '我的自定义角色',
        category: 'custom',
        skillSlug: 'my-custom-role',
        skillContent: '# 自定义手册',
      });

      expect(roleManager.seedBuiltInRoles()).toBe(14);
      expect(roleManager.list({ builtIn: true })).toHaveLength(15);
      const preserved = roleManager.get('builtin-engineering-1')!;
      expect(preserved.name).toBe('我的 Vue 专家');
      expect(preserved.skillSlug).toBe('custom-vue');
      expect(preserved.skillContent).toBe('# 保留手册');
      expect(roleManager.get(custom.id)?.skillContent).toBe('# 自定义手册');
    });
  });

  it('should explicitly refresh built-ins while preserving custom roles and session bindings', () => {
    const vue = roleManager.list().find(role => role.name === 'Vue 开发')!;
    const session = sessionManager.create('ws-1', vue, 'Refresh Role Session');
    const custom = roleManager.create({
      name: '自定义审阅者',
      category: 'custom',
      skillSlug: 'custom-reviewer',
      skillContent: '# 自定义正文',
    });
    roleManager.update(vue.id, {
      name: '修改后的 Vue',
      skillSlug: 'modified-vue',
      skillContent: '# 已修改正文',
      systemPrompt: '已修改提示词',
    });

    expect(roleManager.refreshBuiltInRoles()).toBe(15);
    const refreshed = roleManager.get(vue.id)!;
    expect(refreshed.name).toBe('Vue 开发');
    expect(refreshed.skillSlug).toBe('vue-development');
    expect(refreshed.skillContent).toContain('## 验证门禁');
    expect(roleManager.get(custom.id)?.skillContent).toBe('# 自定义正文');
    expect(sessionManager.get(session.id)?.roleId).toBe(vue.id);
    expect(sessionManager.getConversationMessages(session.id)[0].content).toContain('已激活 Skill: vue-development');
  });

  it('should create a custom skill package with a stable slug', () => {
    const role = roleManager.create({
      name: 'DevOps 工程师',
      category: 'engineering',
      skillSlug: '  DevOps Delivery  ',
      skillContent: '# DevOps\n\n## 执行流程\n1. 验证流水线。',
    });

    expect(role.skillSlug).toBe('devops-delivery');
    expect(role.skillContent).toContain('验证流水线');

    const duplicate = roleManager.create({
      name: '发布工程师',
      category: 'engineering',
      skillSlug: 'devops-delivery',
    });
    expect(duplicate.skillSlug).toBe('devops-delivery-2');
  });

  it('should get a role by ID', () => {
    const roles = roleManager.list();
    const first = roles[0];
    const got = roleManager.get(first.id);
    expect(got).toBeDefined();
    expect(got!.name).toBe(first.name);
  });

  it('should create a session with role system prompt', () => {
    const roles = roleManager.list();
    const feRole = roles.find(r => r.name === 'Vue 开发')!;
    expect(feRole).toBeDefined();

    const session = sessionManager.create('ws-1', feRole, 'Test Session');
    expect(session.workspaceId).toBe('ws-1');
    expect(session.roleId).toBe(feRole.id);
    expect(session.title).toBe('Test Session');

    const messages = sessionManager.listMessages(session.id);
    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(messages[0].role).toBe('system');
  });

  it('should apply updated role capabilities to an existing session', () => {
    const role = roleManager.list().find(r => r.name === 'Vue 开发')!;
    const session = sessionManager.create('ws-1', role, 'Role Update Session');

    roleManager.update(role.id, {
      systemPrompt: '你是专注可访问性的前端专家。',
      skillSlug: 'accessible-frontend',
      skills: ['WCAG 2.2', '键盘导航'],
      skillContent: '# 无障碍交付\n\n## 执行流程\n1. 先完成键盘操作审计。\n2. 再验证焦点顺序。\n\n## 完成标准\n所有关键流程无需鼠标即可完成。',
      description: '交付可验证的无障碍界面',
    });

    const messages = sessionManager.getConversationMessages(session.id);
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('你是专注可访问性的前端专家。');
    expect(messages[0].content).toContain('WCAG 2.2');
    expect(messages[0].content).toContain('已激活 Skill: accessible-frontend');
    expect(messages[0].content).toContain('先完成键盘操作审计');
    expect(messages[0].content).toContain('所有关键流程无需鼠标即可完成');
    expect(messages[0].content).toContain('交付可验证的无障碍界面');
  });

  it('should list sessions by workspace', () => {
    const roles = roleManager.list();
    const role = roles[0];

    sessionManager.create('ws-a', role, 'Session A1');
    sessionManager.create('ws-a', role, 'Session A2');
    sessionManager.create('ws-b', role, 'Session B1');

    const wsA = sessionManager.list('ws-a');
    const wsB = sessionManager.list('ws-b');

    expect(wsA.length).toBe(2);
    expect(wsB.length).toBe(1);
  });

  it('should be idempotent on seedBuiltInRoles', () => {
    const countBefore = roleManager.list().length;
    roleManager.seedBuiltInRoles();
    const countAfter = roleManager.list().length;
    expect(countAfter).toBe(countBefore);
  });
});
