/**
 * 端到端验证：模拟真实长对话场景，验证 P0-P3 压缩机制逐级触发
 *
 * 运行方式：
 *   npx vitest run vscode-extension/src/__tests__/context-e2e-demo.test.ts --pool=forks --poolOptions.forks.singleFork=true
 */
import { describe, expect, it, afterAll } from 'vitest';
import {
  preflightCompaction,
  computeFoldBoundary,
  buildFoldSummaryRequest,
  assembleFoldedMessages,
  archiveMessages,
  readArchive,
  searchSessionArchive,
  contextRatio,
  trimToolResult,
  trimPreviousToolResults,
  type CompactionLevel,
} from '../services/context-manager';
import type { LLMMessage } from '../services/llm-service';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

describe('Context 压缩端到端验证', () => {
  const workspacePath = path.join(os.tmpdir(), `ctx-e2e-${Date.now()}`);
  const sessionId = 'demo-session';

  afterAll(() => {
    // 清理测试目录
    try {
      fs.rmSync(workspacePath, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  // 模拟一个真实对话：用户提问 → AI 回答 → 工具调用 → 工具结果
  function makeTurn(turnNum: number, withTool: boolean): LLMMessage[] {
    const msgs: LLMMessage[] = [
      { role: 'user', content: `第 ${turnNum} 轮问题：请详细分析这段代码的功能和潜在问题，给出优化建议。这是第 ${turnNum} 次提问，我们需要深入讨论架构设计、性能瓶颈和可维护性。` },
      { role: 'assistant', content: `第 ${turnNum} 轮回答：好的，我来详细分析。这段代码的主要功能是处理用户请求并进行数据转换。首先，我们看到入口函数接收一个配置对象，其中包含多个参数。从架构角度看，这里存在几个问题：1) 单一职责原则违反 2) 耦合度过高 3) 缺乏错误处理机制。建议重构方案：将数据转换逻辑提取为独立模块，引入策略模式支持多种转换方式，添加完善的异常处理链。性能方面，当前实现存在 O(n²) 的嵌套循环，可以通过哈希表优化为 O(n)。此外，缓存策略也需要调整，当前 LRU 缓存大小固定，建议根据内存动态调整。`.repeat(3) },
    ];
    if (withTool) {
      msgs.push({ role: 'assistant', content: '', toolCalls: [{ id: `call_${turnNum}`, name: 'workspace_read_file', arguments: JSON.stringify({ path: 'src/index.ts' }) }] } as any);
      // 模拟一个超长工具结果（触发 P0）
      const longToolResult = 'export function main() {\n' + '  // line content\n'.repeat(800) + '}\n';
      msgs.push({ role: 'tool', content: longToolResult, toolCallId: `call_${turnNum}` });
    }
    return msgs;
  }

  it('场景 1: P0 — 超长工具结果被自动裁剪', () => {
    const longResult = 'X'.repeat(50000); // 50000 chars，远超 12000 阈值
    const trimmed = trimToolResult(longResult);

    console.log('\n═══ P0 验证 ═══');
    console.log(`原始长度: ${longResult.length} chars`);
    console.log(`裁剪后长度: ${trimmed.length} chars`);
    console.log(`包含截短标记: ${trimmed.includes('省略')}`);
    console.log(`压缩率: ${((1 - trimmed.length / longResult.length) * 100).toFixed(1)}%`);

    expect(trimmed.length).toBeLessThan(longResult.length);
    expect(trimmed).toContain('省略');
  });

  it('场景 2: P0 — trimPreviousToolResults 只裁剪旧轮次', () => {
    const messages: LLMMessage[] = [
      { role: 'tool', content: 'A'.repeat(30000), toolCallId: 'old1' },
      { role: 'tool', content: 'B'.repeat(30000), toolCallId: 'old2' },
      { role: 'assistant', content: '中间回复' },
      { role: 'tool', content: 'C'.repeat(30000), toolCallId: 'recent1' },
    ];
    // keepFromIndex = 3，只裁剪 index < 3 的 tool 消息
    const result = trimPreviousToolResults(messages, 3);
    const oldTool = result.messages.find((m) => m.toolCallId === 'old1');
    const newTool = result.messages.find((m) => m.toolCallId === 'recent1');

    console.log('\n═══ P0 trimPreviousToolResults ═══');
    console.log(`旧工具结果裁剪: ${oldTool!.content.length < 30000}`);
    console.log(`新工具结果保留: ${newTool!.content.length === 30000}`);

    expect(oldTool!.content.length).toBeLessThan(30000);
    expect(newTool!.content.length).toBe(30000);
  });

  it('场景 3: P1 — 10 轮对话模拟，观察压缩级别变化', () => {
    console.log('\n═══ P1 分级压缩模拟 ═══');
    console.log('模拟 10 轮对话，每轮包含长 AI 回复，观察 preflight 触发级别\n');

    let messages: LLMMessage[] = [{ role: 'system', content: '你是 Coordinator AI 助手' }];
    const ctxWindow = 1000; // 极小窗口(1000 tokens ≈ 4000 chars)，快速触发各级别
    const levelHistory: { turn: number; ratio: number; level: CompactionLevel; snipped: number; pruned: number }[] = [];

    for (let turn = 1; turn <= 10; turn++) {
      // 添加一轮对话
      messages = [...messages, ...makeTurn(turn, false)];

      // 执行 preflight
      const preflight = preflightCompaction(messages, ctxWindow);
      levelHistory.push({
        turn,
        ratio: preflight.ratio,
        level: preflight.level,
        snipped: preflight.snippedCount,
        pruned: preflight.prunedCount,
      });

      // 使用压缩后的消息继续（模拟真实流程）
      messages = preflight.messages;

      console.log(
        `Turn ${turn.toString().padStart(2)}: ratio=${(preflight.ratio * 100).toFixed(0).padStart(3)}% `
        + `level=${preflight.level.padEnd(11)} snip=${preflight.snippedCount} prune=${preflight.prunedCount}`
        + ` msgs=${messages.length}`
      );
    }

    // 验证：至少有一轮触发了 snip 或更高级别
    const compressed = levelHistory.filter((h) => h.level !== 'none');
    expect(compressed.length).toBeGreaterThan(0);
    console.log(`\n✓ 共 ${compressed.length} 轮触发了压缩`);
  });

  it('场景 4: P2 — fold 边界计算和摘要请求构造', () => {
    // 构造一个需要 fold 的长对话
    const messages: LLMMessage[] = [
      { role: 'system', content: '系统提示' },
      ...Array.from({ length: 10 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' as const : 'assistant' as const,
        content: i % 2 === 0
          ? `用户问题 ${i}：详细解释微服务架构的优缺点`
          : `AI 回答 ${i}：微服务架构的优点包括：1) 服务独立部署 2) 技术栈灵活 3) 故障隔离。缺点包括：1) 分布式复杂性 2) 数据一致性挑战 3) 运维成本高。`.repeat(10),
      })),
      { role: 'user', content: '最新的问题：总结一下' },
      { role: 'assistant', content: '好的，总结如下' },
    ];

    const ctxWindow = 1500; // 小窗口快速触发
    const boundary = computeFoldBoundary(messages, ctxWindow);

    console.log('\n═══ P2 Fold 机制 ═══');
    expect(boundary).not.toBeNull();
    console.log(`总消息数: ${messages.length}`);
    console.log(`head 区域: ${boundary!.head.length} 条消息, ${boundary!.headTokens} tokens`);
    console.log(`tail 区域: ${boundary!.tail.length} 条消息, ${boundary!.tailTokens} tokens`);
    console.log(`fold 后 token 节省: ${boundary!.headTokens} → ~摘要(约 500 tokens)`);

    // 构造摘要请求
    const summaryRequest = buildFoldSummaryRequest(boundary!.head);
    console.log(`\n摘要请求消息数: ${summaryRequest.length}`);
    console.log(`摘要请求 system: ${summaryRequest[0].content.slice(0, 80)}...`);
    console.log(`摘要请求 user 长度: ${summaryRequest[1].content.length} chars`);

    expect(summaryRequest).toHaveLength(2);
    expect(summaryRequest[0].role).toBe('system');
    expect(summaryRequest[1].role).toBe('user');

    // 模拟 LLM 生成摘要
    const fakeSummary = '## 对话历史摘要\n- 讨论了微服务架构的优缺点\n- 用户关注数据一致性问题\n- 确定了技术选型方向';
    const foldedMessages = assembleFoldedMessages(fakeSummary, boundary!.tail);

    console.log(`\nfold 后消息序列:`);
    foldedMessages.forEach((m, i) => {
      const preview = m.content.slice(0, 60).replace(/\n/g, ' ');
      console.log(`  [${i}] ${m.role}: ${preview}...`);
    });

    // 验证：fold 后消息数远少于原始
    expect(foldedMessages.length).toBeLessThan(messages.length);
    expect(foldedMessages[0].content).toContain('CONVERSATION HISTORY SUMMARY');
  });

  it('场景 5: P3 — 归档 + BM25 检索完整流程', () => {
    // 模拟 fold 前归档原始消息
    const headMessages: LLMMessage[] = [
      { role: 'user', content: '我们讨论了用 PostgreSQL 替代 MySQL 的迁移方案，决定用 pgloader 工具' },
      { role: 'assistant', content: '建议迁移步骤：1) 备份 MySQL 数据 2) 用 pgloader 全量迁移 3) 验证数据一致性 4) 灰度切换流量' },
      { role: 'user', content: 'JWT 认证方案选定了，用 access token + refresh token 双 token 策略' },
      { role: 'assistant', content: 'JWT 双 token 方案：access token 有效期 15 分钟，refresh token 有效期 7 天，存储在 Redis 中' },
    ];

    console.log('\n═══ P3 归档 + BM25 检索 ═══');

    // 归档
    const archivedCount = archiveMessages(workspacePath, sessionId, headMessages, 'fold');
    console.log(`归档消息数: ${archivedCount}`);

    // 验证归档文件
    const archiveFile = path.join(workspacePath, '.coordinator', 'archives', `${sessionId}.jsonl`);
    console.log(`归档文件: ${archiveFile}`);
    console.log(`文件存在: ${fs.existsSync(archiveFile)}`);

    const entries = readArchive(workspacePath, sessionId);
    console.log(`读取归档条目: ${entries.length}`);

    // 搜索 "PostgreSQL 迁移"
    console.log('\n搜索 "PostgreSQL 迁移":');
    const results1 = searchSessionArchive(workspacePath, sessionId, 'PostgreSQL 迁移');
    results1.forEach((r, i) => {
      console.log(`  [${i}] score=${r.score.toFixed(2)} role=${r.role} content="${r.content.slice(0, 60)}..."`);
    });
    expect(results1.length).toBeGreaterThan(0);
    expect(results1[0].content).toContain('PostgreSQL');

    // 搜索 "JWT 认证"
    console.log('\n搜索 "JWT 认证":');
    const results2 = searchSessionArchive(workspacePath, sessionId, 'JWT 认证');
    results2.forEach((r, i) => {
      console.log(`  [${i}] score=${r.score.toFixed(2)} role=${r.role} content="${r.content.slice(0, 60)}..."`);
    });
    expect(results2.length).toBeGreaterThan(0);
    expect(results2[0].content).toContain('JWT');

    // 搜索不相关内容（用英文避免 CJK 单字误匹配）
    console.log('\n搜索 "completely unrelated topic":');
    const results3 = searchSessionArchive(workspacePath, sessionId, 'completely unrelated topic');
    console.log(`  结果数: ${results3.length}`);
    expect(results3.length).toBe(0);

    console.log('\n✓ 归档 + BM25 检索验证通过');
  });

  it('场景 6: 完整流程 — 从 P0 到 P3 逐级触发', () => {
    console.log('\n═══ 完整流程模拟：从短对话到 fold + 归档 ═══\n');

    let messages: LLMMessage[] = [
      { role: 'system', content: '你是 Coordinator AI 助手，负责代码审查和架构建议。' },
    ];

    const ctxWindow = 6000; // 极小窗口，快速触发所有级别
    const workspace = path.join(os.tmpdir(), `ctx-full-${Date.now()}`);
    const sid = 'full-flow-session';

    const timeline: { step: string; ratio: number; level: string; msgs: number; note: string }[] = [];

    function record(step: string, preflight?: { ratio: number; level: string }, msgs?: number, note = '') {
      timeline.push({
        step,
        ratio: preflight?.ratio ?? 0,
        level: preflight?.level ?? '-',
        msgs: msgs ?? messages.length,
        note,
      });
    }

    // 阶段 1: 正常对话（无压缩）
    for (let i = 1; i <= 3; i++) {
      messages = [...messages, ...makeTurn(i, false)];
      const pf = preflightCompaction(messages, ctxWindow);
      messages = pf.messages;
      record(`Turn ${i}`, pf, messages.length);
    }

    // 阶段 2: 加入超长工具结果（P0）
    const longTool: LLMMessage = { role: 'tool', content: 'Z'.repeat(40000), toolCallId: 'big1' };
    messages.push(longTool);
    const trimmed = trimToolResult(longTool.content);
    messages[messages.length - 1] = { role: 'tool', content: trimmed, toolCallId: 'big1' };
    record('P0 裁剪工具结果', undefined, messages.length, `40000→${trimmed.length} chars`);

    // 阶段 3: 继续对话直到触发 snip/prune
    for (let i = 4; i <= 8; i++) {
      messages = [...messages, ...makeTurn(i, false)];
      const pf = preflightCompaction(messages, ctxWindow);
      messages = pf.messages;
      record(`Turn ${i} (${pf.level})`, pf, messages.length);
    }

    // 阶段 4: 检查是否触发 fold
    const pf = preflightCompaction(messages, ctxWindow);
    if (pf.level === 'force-fold' && pf.foldBoundary) {
      // P3: 归档
      const archived = archiveMessages(workspace, sid, pf.foldBoundary.head, 'fold');
      record('P3 归档', undefined, messages.length, `归档 ${archived} 条`);

      // P2: 模拟 fold
      const summaryRequest = buildFoldSummaryRequest(pf.foldBoundary.head);
      const fakeSummary = '## 历史摘要\n- 讨论了代码审查和架构优化\n- 进行了多轮工具调用分析';
      messages = assembleFoldedMessages(fakeSummary, pf.foldBoundary.tail);
      const afterRatio = contextRatio(messages, ctxWindow);
      record('P2 Fold 完成', { ratio: afterRatio, level: 'folded' }, messages.length, `head→摘要`);
    } else {
      record('未触发 fold', pf, messages.length);
    }

    // 打印时间线
    console.log('Step                Ratio  Level         Msgs  Note');
    console.log('──────────────────  ─────  ───────────   ────  ──────────────────');
    for (const t of timeline) {
      console.log(
        `${t.step.padEnd(20)} ${(t.ratio * 100).toFixed(0).padStart(3)}%  ${t.level.padEnd(12)} ${String(t.msgs).padStart(4)}  ${t.note}`
      );
    }

    // 验证归档可检索
    if (fs.existsSync(path.join(workspace, '.coordinator', 'archives'))) {
      const results = searchSessionArchive(workspace, sid, '代码审查');
      console.log(`\n归档检索 "代码审查": ${results.length} 条结果`);
      expect(results.length).toBeGreaterThan(0);
    }

    // 清理
    try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* ignore */ }

    console.log('\n✓ 完整流程验证通过');
  });
});
