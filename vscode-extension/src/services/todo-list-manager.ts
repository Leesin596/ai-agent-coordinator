import { randomUUID } from 'crypto';

// ============================================================
// TodoListManager — 单会话 LLM 自跟踪多步任务进度
// 与 TaskManager（多 Agent DAG）正交，仅用于单会话内 LLM 自我管理
// ============================================================

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'failed';
export type TodoPriority = 'high' | 'medium' | 'low';

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
  priority: TodoPriority;
  createdAt: number;
  updatedAt: number;
}

export interface TodoListSnapshot {
  sessionId: string;
  items: TodoItem[];
}

/** 变更回调：工具执行后通知 UI 层刷新 */
export type TodoListChangeHandler = (snapshot: TodoListSnapshot) => void;

const MAX_ITEMS = 50;
const MAX_CONTENT_LENGTH = 500;
const VALID_STATUSES: readonly TodoStatus[] = ['pending', 'in_progress', 'completed', 'failed'];
const VALID_PRIORITIES: readonly TodoPriority[] = ['high', 'medium', 'low'];
const ID_PREFIX = 'todo_';

function generateId(): string {
  return ID_PREFIX + randomUUID();
}

function normalizeStatus(value: unknown): TodoStatus {
  if (typeof value === 'string' && (VALID_STATUSES as readonly string[]).includes(value)) {
    return value as TodoStatus;
  }
  return 'pending';
}

function normalizePriority(value: unknown): TodoPriority {
  if (typeof value === 'string' && (VALID_PRIORITIES as readonly string[]).includes(value)) {
    return value as TodoPriority;
  }
  return 'medium';
}

function sanitizeContent(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, MAX_CONTENT_LENGTH);
}

export class TodoListManager {
  private readonly store = new Map<string, TodoItem[]>();
  private changeHandler: TodoListChangeHandler | null = null;

  setChangeHandler(handler: TodoListChangeHandler | null): void {
    this.changeHandler = handler;
  }

  /** 批量创建 todo 项（替换该会话原有列表） */
  createTodos(sessionId: string, inputs: Array<{ content: string; priority?: TodoPriority }>): TodoItem[] {
    if (!sessionId) throw new Error('sessionId 不能为空');
    if (!Array.isArray(inputs) || inputs.length === 0) {
      throw new Error('至少需要 1 条 todo 项');
    }
    if (inputs.length > MAX_ITEMS) {
      throw new Error(`单次最多创建 ${MAX_ITEMS} 条 todo 项`);
    }

    const now = Date.now();
    const items: TodoItem[] = inputs.map((input) => {
      const content = sanitizeContent(input.content);
      if (!content) throw new Error('todo 项 content 不能为空');
      return {
        id: generateId(),
        content,
        status: 'pending' as TodoStatus,
        priority: normalizePriority(input.priority),
        createdAt: now,
        updatedAt: now,
      };
    });

    this.store.set(sessionId, items);
    this.notify(sessionId);
    return items;
  }

  /** 更新指定 todo 项的状态和/或内容 */
  updateTodo(
    sessionId: string,
    id: string,
    patch: { status?: TodoStatus; content?: string },
  ): TodoItem {
    const items = this.store.get(sessionId);
    if (!items) throw new Error(`会话 ${sessionId} 无 todo 列表`);
    const item = items.find((it) => it.id === id);
    if (!item) throw new Error(`todo 项 ${id} 不存在`);

    if (patch.status !== undefined) {
      item.status = normalizeStatus(patch.status);
    }
    if (patch.content !== undefined) {
      const content = sanitizeContent(patch.content);
      if (!content) throw new Error('todo 项 content 不能为空');
      item.content = content;
    }
    item.updatedAt = Date.now();

    this.notify(sessionId);
    return item;
  }

  /** 读取会话的完整 todo 列表 */
  getTodos(sessionId: string): TodoItem[] {
    return this.store.get(sessionId) ?? [];
  }

  /** 删除指定 todo 项 */
  deleteTodo(sessionId: string, id: string): void {
    const items = this.store.get(sessionId);
    if (!items) return;
    const idx = items.findIndex((it) => it.id === id);
    if (idx === -1) return;
    items.splice(idx, 1);
    this.notify(sessionId);
  }

  /** 清除会话的 todo 列表 */
  clearTodos(sessionId: string): void {
    if (this.store.delete(sessionId)) {
      this.notify(sessionId);
    }
  }

  /** 销毁会话 todo（会话关闭时调用） */
  dispose(sessionId: string): void {
    this.store.delete(sessionId);
  }

  private notify(sessionId: string): void {
    if (!this.changeHandler) return;
    this.changeHandler({
      sessionId,
      items: this.getTodos(sessionId),
    });
  }
}
