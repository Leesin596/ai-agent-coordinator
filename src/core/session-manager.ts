// ============================================================
// SessionManager — AI 会话管理业务层
// 封装会话 CRUD + 消息管理 + 角色人设注入
// ============================================================
import type { CoordinatorDB } from '../db/database';
import type { Role, Session, Message, MessageRole } from '../models/types';
import { randomUUID } from 'crypto';

export class SessionManager {
  private db!: CoordinatorDB;

  setDB(db: CoordinatorDB): void {
    this.db = db;
  }

  // ============================================================
  // 会话 CRUD
  // ============================================================

  /**
   * 创建新会话。自动注入角色人设（systemPrompt + skills）作为首条 system 消息。
   */
  create(workspaceId: string, role: Role, title?: string): Session {
    const now = new Date().toISOString();
    const session: Session = {
      id: randomUUID(),
      workspaceId,
      roleId: role.id,
      title: title || `${role.icon || '💬'} ${role.name}`,
      createdAt: now,
      updatedAt: now,
    };
    this.db.insertSession(session);

    // 自动注入角色人设 system 消息
    const systemContent = this.buildSystemPrompt(role);
    if (systemContent) {
      this.addMessage(session.id, 'system', systemContent);
    }

    return session;
  }

  get(id: string): Session | undefined {
    const row = this.db.getSession(id);
    if (!row) return undefined;
    return row as unknown as Session;
  }

  list(workspaceId: string): Session[] {
    return this.db.listSessions(workspaceId) as unknown as Session[];
  }

  rename(id: string, title: string): boolean {
    return this.db.updateSession(id, { title, updatedAt: new Date().toISOString() });
  }

  /** 设置会话绑定的模型预设 ID（传空字符串/null 清除绑定，回退默认模型） */
  setModel(id: string, modelId: string | null): boolean {
    return this.db.updateSession(id, {
      modelId: modelId || null,
      updatedAt: new Date().toISOString(),
    });
  }

  delete(id: string): boolean {
    // 删除会话下的所有消息（messages 表有 ON DELETE CASCADE 约束，但保险起见显式清理）
    const msgs = this.db.listMessages(id);
    for (const m of msgs) {
      this.db.deleteMessage(m.id);
    }
    return this.db.deleteSession(id);
  }

  // ============================================================
  // 消息管理
  // ============================================================

  addMessage(sessionId: string, role: MessageRole, content: string): Message {
    const msg: Message = {
      id: randomUUID(),
      sessionId,
      role,
      content,
      createdAt: new Date().toISOString(),
    };
    this.db.insertMessage(msg);
    // 更新会话的 updatedAt
    this.db.updateSession(sessionId, { updatedAt: msg.createdAt });
    return msg;
  }

  listMessages(sessionId: string): Message[] {
    return this.db.listMessages(sessionId) as unknown as Message[];
  }

  /**
   * 获取发送给 LLM 的消息序列（排除首条 system 人设，由调用方自行拼接）。
   * 实际上保留 system 消息让 LLM 知道角色人设。
   */
  getConversationMessages(sessionId: string): Array<{ role: MessageRole; content: string }> {
    const messages = this.listMessages(sessionId).map((m) => ({
      role: m.role,
      content: m.content,
    }));
    const session = this.get(sessionId);
    const role = session ? this.db.getRole(session.roleId) as Role | undefined : undefined;
    if (!role) return messages;

    const systemContent = this.buildSystemPrompt(role);
    const systemIndex = messages.findIndex((message) => message.role === 'system');
    if (systemIndex >= 0) {
      messages[systemIndex] = { role: 'system', content: systemContent };
    } else {
      messages.unshift({ role: 'system', content: systemContent });
    }
    return messages;
  }

  /**
   * 清空会话历史（保留首条 system 人设消息），重新开始对话。
   */
  clearHistory(sessionId: string): void {
    const msgs = this.listMessages(sessionId);
    // 保留第一条 system 消息
    const systemMsg = msgs.find((m) => m.role === 'system');
    for (const m of msgs) {
      if (m.id !== systemMsg?.id) {
        this.db.deleteMessage(m.id);
      }
    }
    this.db.updateSession(sessionId, { updatedAt: new Date().toISOString() });
  }

  /**
   * 角色更新后，同步所有该角色的已有会话的 system 消息。
   */
  syncRoleToSessions(role: Role, workspaceId: string): void {
    const sessions = this.list(workspaceId).filter((s) => s.roleId === role.id);
    const newSystemContent = this.buildSystemPrompt(role);
    for (const session of sessions) {
      const msgs = this.listMessages(session.id);
      const systemMsg = msgs.find((m) => m.role === 'system');
      if (systemMsg) {
        this.db.updateMessageContent(systemMsg.id, newSystemContent);
      } else if (newSystemContent) {
        this.addMessage(session.id, 'system', newSystemContent);
      }
    }
  }

  // ============================================================
  // 私有辅助
  // ============================================================

  /**
   * 构建角色 system prompt：人设 + 技能 + 协调器协作能力说明。
   */
  private buildSystemPrompt(role: Role): string {
    const parts: string[] = [];

    if (role.systemPrompt) {
      parts.push(role.systemPrompt);
    } else {
      // 无自定义 prompt 时，用默认人设
      parts.push(`你是一名${role.name}。`);
    }

    if (role.skills && role.skills.length > 0) {
      parts.push(`\n## Skill 能力目录\n${role.skills.map((s) => `- ${s}`).join('\n')}`);
    }

    if (role.skillContent) {
      const skillName = role.skillSlug || role.name;
      parts.push(`\n## 已激活 Skill: ${skillName}\n以下内容是当前角色必须遵循的操作手册。先判断当前任务适用的章节，再按执行流程工作，并以完成标准自检；它不是背景介绍或可忽略的建议。\n\n${role.skillContent}`);
    } else if (role.skills && role.skills.length > 0) {
      parts.push(`\n## Skill 应用要求\n以上能力不是背景标签。处理用户任务时，主动采用与任务相关的方法和最佳实践，并在方案、实现、检查和验收中体现其专业性。不要虚构未验证的事实；信息不足时明确说明假设。`);
    }

    if (role.description) {
      parts.push(`\n## 职责边界\n${role.description}`);
    }

    parts.push(
      `\n## 输出要求\n围绕当前角色职责给出准确、可执行、可验证的结果。优先解决根因，指出关键风险与边界条件；涉及实现时保持与现有项目约定一致。`,
      `\n## 协作能力\n你是 AI Agent Coordinator 协作体系中的一员。你可以通过会话间任务派发机制向其他角色会话派发任务，并在派发时对齐任务上下文。`,
    );

    return parts.join('\n');
  }
}
