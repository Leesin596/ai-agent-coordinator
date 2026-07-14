import type { Message, Role, Session } from '../../../src/models/types';
import { estimateMessageTokens } from './llm-service';

export type ContextTransferMode = 'continue' | 'align';

export interface SessionContextOption {
  id: string;
  title: string;
  roleName: string;
  roleIcon: string;
  messageCount: number;
  tokenEstimate: number;
  updatedAt: string;
}

const CONTEXT_MARKER = '[Coordinator 会话上下文包]';
const MAX_CONTEXT_CHARS = 32000;
const MAX_EARLY_MESSAGES = 4;
const MIN_RECENT_MESSAGES = 12;
const MAX_MESSAGE_CHARS = 12000;
const IMPORTANT_CONTENT_PATTERN = /(?:决定|决策|必须|禁止|不要|约束|要求|目标|验收|待办|TODO|FIXME|错误|失败|根因|修复|完成|未完成|下一步|接口|API|路径|文件|配置|命令|测试|验证|decision|constraint|requirement|acceptance|error|root cause|pending|next step)/i;

export function listContextSessionOptions(
  sessions: Session[],
  currentSessionId: string,
  getRole: (roleId: string) => Role | undefined,
  getMessages: (sessionId: string) => Message[],
): SessionContextOption[] {
  return sessions
    .filter((session) => session.id !== currentSessionId)
    .map((session) => {
      const role = getRole(session.roleId);
      const messages = getTransferableMessages(getMessages(session.id));
      return {
        id: session.id,
        title: session.title,
        roleName: role?.name || '未知角色',
        roleIcon: role?.icon || '💬',
        messageCount: messages.length,
        tokenEstimate: estimateMessageTokens(messages),
        updatedAt: session.updatedAt,
      };
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function buildSessionContextPackage(
  sourceSession: Session,
  sourceRole: Role | undefined,
  messages: Message[],
  mode: ContextTransferMode,
): { content: string; tokenEstimate: number; includedMessages: number } {
  const transferable = getTransferableMessages(messages);
  const selected = selectMessages(transferable, MAX_CONTEXT_CHARS);
  const transcript = selected
    .map((message) => `### ${getRoleLabel(message.role)}\n${clipMessageContent(message.content)}`)
    .join('\n\n');
  const purpose = mode === 'continue'
    ? '这是源会话的接力上下文。请基于这些目标、决策、约束、进度和未解决事项继续对话，不要要求用户重复已经提供的信息。'
    : '这是另一会话的对齐上下文。请将其中的目标、决策、约束、进度和未解决事项纳入当前会话；如与当前信息冲突，先指出冲突再继续。';
  const omitted = transferable.length - selected.length;
  const content = [
    CONTEXT_MARKER,
    `## ${mode === 'continue' ? '会话接力' : '跨会话对齐'}`,
    `> 来源会话: ${sourceSession.title}`,
    `> 来源角色: ${sourceRole?.name || '未知角色'}`,
    `> 来源会话 ID: ${sourceSession.id}`,
    `> 生成时间: ${new Date().toISOString()}`,
    '',
    purpose,
    omitted > 0 ? `\n> 已保留开场目标、中途关键决策/约束和最近消息；另有 ${omitted} 条低优先级消息因接力预算未包含。` : '',
    '',
    '## 来源会话内容',
    transcript || '源会话暂无可转移的用户或助手消息。',
  ].filter(Boolean).join('\n');

  return {
    content,
    tokenEstimate: estimateMessageTokens([{ content }]),
    includedMessages: selected.length,
  };
}

export function isSessionContextPackage(content: string): boolean {
  return content.startsWith(CONTEXT_MARKER);
}

function getTransferableMessages(messages: Message[]): Message[] {
  const personaMessageId = messages.find((message) => message.role === 'system')?.id;
  return messages.filter((message) =>
    message.id !== personaMessageId &&
    message.content.trim().length > 0 &&
    !isSessionContextPackage(message.content),
  );
}

function selectMessages(messages: Message[], maxChars: number): Message[] {
  if (messages.length === 0) return [];

  const selected = new Map<string, Message>();
  let usedChars = 0;
  const add = (message: Message): boolean => {
    if (selected.has(message.id)) return true;
    const messageChars = Math.min(message.content.length, MAX_MESSAGE_CHARS);
    if (usedChars + messageChars > maxChars) return false;
    selected.set(message.id, message);
    usedChars += messageChars;
    return true;
  };

  for (const message of messages.slice(0, MAX_EARLY_MESSAGES)) add(message);

  const recentStart = Math.max(MAX_EARLY_MESSAGES, messages.length - MIN_RECENT_MESSAGES);
  for (let index = messages.length - 1; index >= recentStart; index--) {
    add(messages[index]);
  }

  const important = messages
    .slice(MAX_EARLY_MESSAGES, recentStart)
    .filter((message) => IMPORTANT_CONTENT_PATTERN.test(message.content))
    .sort((a, b) => getImportanceScore(b) - getImportanceScore(a));
  for (const message of important) add(message);

  for (let index = recentStart - 1; index >= MAX_EARLY_MESSAGES; index--) {
    add(messages[index]);
  }

  return messages.filter((message) => selected.has(message.id));
}

function getImportanceScore(message: Message): number {
  const matches = message.content.match(new RegExp(IMPORTANT_CONTENT_PATTERN.source, 'gi'))?.length || 0;
  const structureBonus = /(?:^|\n)(?:#{1,4}\s|[-*]\s|\d+\.\s|```)/m.test(message.content) ? 3 : 0;
  return matches * 2 + structureBonus + Math.min(5, Math.floor(message.content.length / 1000));
}

function clipMessageContent(content: string): string {
  const trimmed = content.trim();
  if (trimmed.length <= MAX_MESSAGE_CHARS) return trimmed;
  const headLength = Math.floor(MAX_MESSAGE_CHARS * 0.6);
  const tailLength = MAX_MESSAGE_CHARS - headLength;
  return `${trimmed.slice(0, headLength)}\n\n[该消息中间内容过长，接力时已省略]\n\n${trimmed.slice(-tailLength)}`;
}

function getRoleLabel(role: Message['role']): string {
  if (role === 'user') return '用户';
  if (role === 'assistant') return 'AI 助手';
  return '系统';
}
