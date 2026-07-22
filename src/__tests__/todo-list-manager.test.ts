import { describe, expect, it, vi } from 'vitest';
import { TodoListManager } from '../../vscode-extension/src/services/todo-list-manager';

describe('TodoListManager', () => {
  it('creates todos for a session', () => {
    const mgr = new TodoListManager();
    const items = mgr.createTodos('session-1', [
      { content: 'Step 1', priority: 'high' },
      { content: 'Step 2' },
    ]);
    expect(items).toHaveLength(2);
    expect(items[0].content).toBe('Step 1');
    expect(items[0].status).toBe('pending');
    expect(items[0].priority).toBe('high');
    expect(items[0].id).toMatch(/^todo_/);
    expect(items[1].priority).toBe('medium');
  });

  it('replaces existing todos on create', () => {
    const mgr = new TodoListManager();
    mgr.createTodos('s1', [{ content: 'A' }]);
    const items = mgr.createTodos('s1', [{ content: 'B' }, { content: 'C' }]);
    expect(items).toHaveLength(2);
    expect(mgr.getTodos('s1')).toHaveLength(2);
    expect(mgr.getTodos('s1')[0].content).toBe('B');
  });

  it('updates todo status and content', () => {
    const mgr = new TodoListManager();
    const [item] = mgr.createTodos('s1', [{ content: 'Task' }]);
    const updated = mgr.updateTodo('s1', item.id, { status: 'in_progress' });
    expect(updated.status).toBe('in_progress');
    expect(updated.updatedAt).toBeGreaterThanOrEqual(item.createdAt);

    const updated2 = mgr.updateTodo('s1', item.id, { content: 'Updated task' });
    expect(updated2.content).toBe('Updated task');
  });

  it('isolates todos by sessionId', () => {
    const mgr = new TodoListManager();
    mgr.createTodos('s1', [{ content: 'A' }]);
    mgr.createTodos('s2', [{ content: 'B' }, { content: 'C' }]);
    expect(mgr.getTodos('s1')).toHaveLength(1);
    expect(mgr.getTodos('s2')).toHaveLength(2);
    expect(mgr.getTodos('s1')[0].content).toBe('A');
  });

  it('clears todos for a session', () => {
    const mgr = new TodoListManager();
    mgr.createTodos('s1', [{ content: 'A' }]);
    mgr.clearTodos('s1');
    expect(mgr.getTodos('s1')).toEqual([]);
  });

  it('disposes todos for a session', () => {
    const mgr = new TodoListManager();
    mgr.createTodos('s1', [{ content: 'A' }]);
    mgr.dispose('s1');
    expect(mgr.getTodos('s1')).toEqual([]);
  });

  it('throws on empty sessionId', () => {
    const mgr = new TodoListManager();
    expect(() => mgr.createTodos('', [{ content: 'A' }])).toThrow('sessionId');
  });

  it('throws on empty items array', () => {
    const mgr = new TodoListManager();
    expect(() => mgr.createTodos('s1', [])).toThrow('至少需要');
  });

  it('throws on non-existent todo update', () => {
    const mgr = new TodoListManager();
    expect(() => mgr.updateTodo('s1', 'fake_id', { status: 'completed' })).toThrow('无 todo 列表');
    mgr.createTodos('s1', [{ content: 'A' }]);
    expect(() => mgr.updateTodo('s1', 'fake_id', { status: 'completed' })).toThrow('不存在');
  });

  it('normalizes invalid status and priority', () => {
    const mgr = new TodoListManager();
    const items = mgr.createTodos('s1', [
      { content: 'A', priority: 'invalid' as any },
    ]);
    expect(items[0].priority).toBe('medium');

    const updated = mgr.updateTodo('s1', items[0].id, { status: 'invalid' as any });
    expect(updated.status).toBe('pending');
  });

  it('trims and limits content', () => {
    const mgr = new TodoListManager();
    const longContent = 'x'.repeat(600);
    const items = mgr.createTodos('s1', [{ content: '  hello  ' }]);
    expect(items[0].content).toBe('hello');

    const items2 = mgr.createTodos('s1', [{ content: longContent }]);
    expect(items2[0].content.length).toBe(500);
  });

  it('notifies change handler', () => {
    const mgr = new TodoListManager();
    const handler = vi.fn();
    mgr.setChangeHandler(handler);
    mgr.createTodos('s1', [{ content: 'A' }]);
    expect(handler).toHaveBeenCalledWith({
      sessionId: 's1',
      items: expect.arrayContaining([expect.objectContaining({ content: 'A' })]),
    });
    handler.mockClear();
    mgr.clearTodos('s1');
    expect(handler).toHaveBeenCalledWith({ sessionId: 's1', items: [] });
  });

  it('does not notify on dispose', () => {
    const mgr = new TodoListManager();
    const handler = vi.fn();
    mgr.setChangeHandler(handler);
    mgr.createTodos('s1', [{ content: 'A' }]);
    handler.mockClear();
    mgr.dispose('s1');
    expect(handler).not.toHaveBeenCalled();
  });
});
