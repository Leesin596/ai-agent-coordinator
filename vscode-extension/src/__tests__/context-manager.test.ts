import { describe, expect, it } from 'vitest';
import {
  trimToolResult,
  trimPreviousToolResults,
  TOOL_RESULT_CAP_CHARS,
  snipOldAssistantMessages,
  pruneOldAssistantMessages,
  preflightCompaction,
  contextRatio,
  SNIP_RATIO,
  PRUNE_RATIO,
  computeFoldBoundary,
  buildFoldSummaryRequest,
  assembleFoldedMessages,
  HISTORY_FOLD_MARKER,
  archiveMessages,
  readArchive,
  searchArchive,
  searchSessionArchive,
  type ArchiveEntry,
} from '../services/context-manager';
import type { LLMMessage } from '../services/llm-service';

describe('ContextManager P0 — 工具结果裁剪', () => {

  it('trimToolResult: 未超限内容原样返回', () => {
    const content = 'short tool output';
    expect(trimToolResult(content)).toBe(content);
  });

  it('trimToolResult: 超限内容被截短并包含标记', () => {
    const content = 'A'.repeat(TOOL_RESULT_CAP_CHARS + 5000);
    const trimmed = trimToolResult(content);
    expect(trimmed.length).toBeLessThan(content.length);
    expect(trimmed).toContain('已省略');
    expect(trimmed.startsWith('A')).toBe(true);
    expect(trimmed.endsWith('A')).toBe(true);
  });

  it('trimToolResult: 截短后长度不超过 cap + marker', () => {
    const content = 'B'.repeat(TOOL_RESULT_CAP_CHARS * 3);
    const trimmed = trimToolResult(content);
    expect(trimmed.length).toBeLessThanOrEqual(TOOL_RESULT_CAP_CHARS + 200);
  });

  it('trimToolResult: 自定义 cap 生效', () => {
    const content = 'C'.repeat(500);
    const trimmed = trimToolResult(content, 100);
    expect(trimmed.length).toBeLessThan(content.length);
    expect(trimmed).toContain('已省略');
  });

  it('trimPreviousToolResults: 只截短 keepFromIndex 之前的 tool 消息', () => {
    const messages: LLMMessage[] = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'let me read a file', toolCalls: [] },
      { role: 'tool', content: 'X'.repeat(TOOL_RESULT_CAP_CHARS + 1000), toolCallId: 'call-1' },
      { role: 'assistant', content: 'now let me run a command', toolCalls: [] },
      { role: 'tool', content: 'command output', toolCallId: 'call-2' },
    ];
    const { messages: result, trimmedCount } = trimPreviousToolResults(messages, 4);
    expect(trimmedCount).toBe(1);
    expect(result[3].content.length).toBeLessThan(messages[3].content.length);
    expect(result[5].content).toBe(messages[5].content);
  });

  it('trimPreviousToolResults: 不截短非 tool 消息', () => {
    const messages: LLMMessage[] = [
      { role: 'user', content: 'A'.repeat(TOOL_RESULT_CAP_CHARS + 1000) },
      { role: 'assistant', content: 'B'.repeat(TOOL_RESULT_CAP_CHARS + 1000) },
    ];
    const { trimmedCount } = trimPreviousToolResults(messages, 2);
    expect(trimmedCount).toBe(0);
  });

  it('trimPreviousToolResults: 已截短的内容不会二次截短', () => {
    const longContent = 'D'.repeat(TOOL_RESULT_CAP_CHARS + 5000);
    const messages: LLMMessage[] = [
      { role: 'tool', content: longContent, toolCallId: 'call-1' },
      { role: 'tool', content: longContent, toolCallId: 'call-2' },
    ];
    const { messages: firstPass } = trimPreviousToolResults(messages, 2);
    const { trimmedCount } = trimPreviousToolResults(firstPass, 2);
    expect(trimmedCount).toBe(0);
  });
});

describe('ContextManager P1 — 分级自动压缩', () => {

  it('snipOldAssistantMessages: 截短旧 assistant 消息，保留 user/system', () => {
    const longAssistant = 'A'.repeat(8000);
    const messages: LLMMessage[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: longAssistant },
      { role: 'user', content: 'next question' },
      { role: 'assistant', content: 'short reply' },
    ];
    const { messages: result, snippedCount } = snipOldAssistantMessages(messages, 2);
    expect(snippedCount).toBe(1);
    expect(result[2].content.length).toBeLessThan(longAssistant.length);
    expect(result[2].content).toContain('已省略');
    // user 和 system 不变
    expect(result[0].content).toBe('system');
    expect(result[1].content).toBe('hello');
    // tail 保留
    expect(result[4].content).toBe('short reply');
  });

  it('snipOldAssistantMessages: 短消息不截短', () => {
    const messages: LLMMessage[] = [
      { role: 'assistant', content: 'short' },
      { role: 'user', content: 'q' },
    ];
    const { snippedCount } = snipOldAssistantMessages(messages, 1);
    expect(snippedCount).toBe(0);
  });

  it('pruneOldAssistantMessages: 比 snip 更激进', () => {
    const longAssistant = 'B'.repeat(10000);
    const messages: LLMMessage[] = [
      { role: 'assistant', content: longAssistant },
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'recent' },
    ];
    const { messages: snipped } = snipOldAssistantMessages(messages, 1);
    const { messages: pruned, prunedCount } = pruneOldAssistantMessages(snipped, 1);
    expect(prunedCount).toBe(1);
    expect(pruned[0].content.length).toBeLessThan(snipped[0].content.length);
    expect(pruned[0].content).toContain('已压缩');
  });

  it('preflightCompaction: 低占比不压缩', () => {
    const messages: LLMMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ];
    const result = preflightCompaction(messages, 1000000);
    expect(result.level).toBe('none');
    expect(result.messages).toBe(messages);
  });

  it('preflightCompaction: 高占比触发 snip', () => {
    const big = 'X'.repeat(200000);
    const messages: LLMMessage[] = [
      { role: 'system', content: 'sys' },
      ...Array.from({ length: 20 }, (_, i) => ({
        role: i % 2 === 0 ? 'assistant' as const : 'user' as const,
        content: i % 2 === 0 ? big : `question ${i}`,
      })),
    ];
    const ctxWindow = 200000; // 小窗口触发高占比
    const result = preflightCompaction(messages, ctxWindow);
    expect(result.ratio).toBeGreaterThan(SNIP_RATIO);
    expect(result.level).not.toBe('none');
    expect(result.snippedCount).toBeGreaterThan(0);
  });

  it('preflightCompaction: 极高占比触发 force-fold', () => {
    const big = 'Y'.repeat(500000);
    const messages: LLMMessage[] = [
      { role: 'system', content: 'sys' },
      ...Array.from({ length: 20 }, (_, i) => ({
        role: i % 2 === 0 ? 'assistant' as const : 'user' as const,
        content: i % 2 === 0 ? big : `question ${i}`,
      })),
    ];
    const ctxWindow = 100000;
    const result = preflightCompaction(messages, ctxWindow);
    expect(result.ratio).toBeGreaterThanOrEqual(PRUNE_RATIO);
    expect(result.level).toBe('force-fold');
    expect(result.prunedCount).toBeGreaterThan(0);
  });

  it('contextRatio: 正确计算占比', () => {
    const messages = [{ content: 'a'.repeat(400) }]; // 100 tokens
    expect(contextRatio(messages, 1000)).toBeCloseTo(0.1, 1);
    expect(contextRatio(messages, 0)).toBe(0);
  });
});

describe('ContextManager P2 — Fold 机制', () => {

  it('computeFoldBoundary: 正确分割 head 和 tail', () => {
    const messages: LLMMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a'.repeat(200000) },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'a'.repeat(200000) },
      { role: 'user', content: 'q3' },
      { role: 'assistant', content: 'recent reply' },
    ];
    const boundary = computeFoldBoundary(messages, 100000);
    expect(boundary).not.toBeNull();
    expect(boundary!.head.length).toBeGreaterThan(0);
    expect(boundary!.tail.length).toBeGreaterThan(0);
    expect(boundary!.headTokens).toBeGreaterThan(boundary!.tailTokens);
  });

  it('computeFoldBoundary: 短消息序列不值得 fold 返回 null', () => {
    const messages: LLMMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];
    const boundary = computeFoldBoundary(messages, 1000000);
    expect(boundary).toBeNull();
  });

  it('computeFoldBoundary: 空消息返回 null', () => {
    expect(computeFoldBoundary([], 100000)).toBeNull();
  });

  it('buildFoldSummaryRequest: 只包含 user 和 assistant 消息', () => {
    const head: LLMMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'do something' },
      { role: 'assistant', content: 'done' },
      { role: 'tool', content: 'tool result', toolCallId: 'c1' },
    ];
    const request = buildFoldSummaryRequest(head);
    expect(request).toHaveLength(2);
    expect(request[0].role).toBe('system');
    expect(request[1].role).toBe('user');
    expect(request[1].content).toContain('do something');
    expect(request[1].content).toContain('done');
    // system 和 tool 消息不应出现在 transcript 中
    expect(request[1].content).not.toContain('sys');
  });

  it('buildFoldSummaryRequest: 超长消息被截短', () => {
    const head: LLMMessage[] = [
      { role: 'user', content: 'X'.repeat(10000) },
    ];
    const request = buildFoldSummaryRequest(head);
    expect(request[1].content.length).toBeLessThan(10000);
    expect(request[1].content).toContain('省略');
  });

  it('assembleFoldedMessages: 摘要消息带标记前缀', () => {
    const tail: LLMMessage[] = [
      { role: 'user', content: 'recent question' },
      { role: 'assistant', content: 'recent answer' },
    ];
    const result = assembleFoldedMessages('这是摘要', tail);
    expect(result).toHaveLength(3);
    expect(result[0].content).toContain(HISTORY_FOLD_MARKER);
    expect(result[0].content).toContain('这是摘要');
    expect(result[1].content).toBe('recent question');
    expect(result[2].content).toBe('recent answer');
  });

  it('preflightCompaction: force-fold 时返回 foldBoundary', () => {
    const big = 'Z'.repeat(500000);
    const messages: LLMMessage[] = [
      { role: 'system', content: 'sys' },
      ...Array.from({ length: 20 }, (_, i) => ({
        role: i % 2 === 0 ? 'assistant' as const : 'user' as const,
        content: i % 2 === 0 ? big : `question ${i}`,
      })),
    ];
    const ctxWindow = 100000;
    const result = preflightCompaction(messages, ctxWindow);
    expect(result.level).toBe('force-fold');
    expect(result.foldBoundary).toBeDefined();
    expect(result.foldBoundary!.head.length).toBeGreaterThan(0);
    expect(result.foldBoundary!.tail.length).toBeGreaterThan(0);
  });
});

describe('ContextManager P3 — 历史归档 + BM25 检索', () => {
  const testDir = require('path').join(require('os').tmpdir(), `ctx-mgr-test-${Date.now()}`);
  const sessionId = 'test-session-p3';

  it('archiveMessages: 归档消息并可通过 readArchive 读取', () => {
    const messages: LLMMessage[] = [
      { role: 'user', content: '如何实现用户认证？' },
      { role: 'assistant', content: '建议使用 JWT + Redis 方案' },
    ];
    const count = archiveMessages(testDir, sessionId, messages, 'fold');
    expect(count).toBe(2);

    const entries = readArchive(testDir, sessionId);
    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(entries[0].role).toBe('user');
    expect(entries[0].content).toContain('用户认证');
    expect(entries[0].reason).toBe('fold');
  });

  it('archiveMessages: 空消息列表返回 0', () => {
    expect(archiveMessages(testDir, sessionId, [], 'fold')).toBe(0);
  });

  it('readArchive: 不存在的文件返回空数组', () => {
    const entries = readArchive(testDir, 'nonexistent-session');
    expect(entries).toEqual([]);
  });

  it('searchArchive: BM25 正确排序结果', () => {
    const entries: ArchiveEntry[] = [
      { id: '1', sessionId, role: 'user', content: '如何实现用户认证和授权', archivedAt: '2025-01-01', reason: 'fold' },
      { id: '2', sessionId, role: 'assistant', content: '建议使用 JWT 方案做认证', archivedAt: '2025-01-01', reason: 'fold' },
      { id: '3', sessionId, role: 'user', content: '数据库迁移到 PostgreSQL', archivedAt: '2025-01-01', reason: 'fold' },
    ];
    const results = searchArchive(entries, '用户认证');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain('认证');
    // 不相关的文档分数应低于相关文档
    const dbResult = results.find((r) => r.content.includes('数据库'));
    const authResult = results.find((r) => r.content.includes('认证') && !r.content.includes('数据库'));
    if (dbResult && authResult) {
      expect(authResult.score).toBeGreaterThan(dbResult.score);
    }
  });

  it('searchArchive: 空查询返回空数组', () => {
    const entries: ArchiveEntry[] = [
      { id: '1', sessionId, role: 'user', content: 'test', archivedAt: '2025-01-01', reason: 'fold' },
    ];
    expect(searchArchive(entries, '')).toEqual([]);
    expect(searchArchive(entries, '   ')).toEqual([]);
  });

  it('searchArchive: 空归档返回空数组', () => {
    expect(searchArchive([], 'anything')).toEqual([]);
  });

  it('searchArchive: topK 限制结果数量', () => {
    const entries: ArchiveEntry[] = Array.from({ length: 10 }, (_, i) => ({
      id: String(i),
      sessionId,
      role: 'user',
      content: `认证方案 ${i}`,
      archivedAt: '2025-01-01',
      reason: 'fold' as const,
    }));
    const results = searchArchive(entries, '认证', 3);
    expect(results.length).toBe(3);
  });

  it('searchSessionArchive: 端到端归档+检索', () => {
    const messages: LLMMessage[] = [
      { role: 'user', content: '讨论数据库迁移到 PostgreSQL 的方案' },
      { role: 'assistant', content: '建议先做数据备份，然后用 pgloader 工具迁移' },
    ];
    archiveMessages(testDir, 'e2e-session', messages, 'fold');
    const results = searchSessionArchive(testDir, 'e2e-session', 'PostgreSQL 迁移');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain('PostgreSQL');
  });
});
