// ============================================================
// ContextManager — 上下文压缩与管理工作台
//
// 分级压缩策略（参考 Reasonix cache-first 设计，适配本项目架构）：
//   P0: Turn-end 工具结果裁剪 — 截短超长工具输出，防止单次 turn 内上下文膨胀
//   P1: 分级自动压缩 — preflight 检查按比例触发 snip/prune/fold
//   P2: Fold 机制 — LLM 摘要历史 head + 保留 tail + user 消息原文
//   P3: 历史归档 + BM25 检索 — 归档被压缩的原始消息
//
// 架构约束：
//   - 本项目工具结果不持久化到 DB（仅在 runRounds 内存中存活）
//   - 跨 turn 工具结果自然丢弃，因此 P0 聚焦于单次 turn 内多轮工具调用的膨胀
//   - 截短在"之前轮次"的工具结果上执行，当前轮次保留完整结果供 LLM 决策
// ============================================================

import type { LLMMessage } from './llm-service';
import { estimateTextTokens } from './llm-service';
import * as fs from 'fs';
import * as path from 'path';

// ── 阈值常量 ──────────────────────────────────────────────

/** 单个工具结果截短阈值（字符数）。≈3000 tokens @ 4 chars/token，与 Reasonix TURN_END_RESULT_CAP_TOKENS 对齐 */
export const TOOL_RESULT_CAP_CHARS = 12000;

/** 截短时保留的头部比例 */
const TRIM_HEAD_RATIO = 0.6;

/** 截短标记前缀，让 LLM 知道内容已被裁剪 */
const TRIM_MARKER = '\n\n[…工具输出过长，中间内容已省略，保留首尾各一部分…]\n\n';

// ── 分级压缩阈值（P1 预留） ────────────────────────────────

/** 软通知阈值 — 上下文占比超过此值时仅通知，不处理 */
export const SOFT_NOTICE_RATIO = 0.6;

/** Snip 阈值 — 截短旧工具结果 */
export const SNIP_RATIO = 0.7;

/** Prune 阈值 — 将旧工具结果替换为极简占位符 */
export const PRUNE_RATIO = 0.8;

/** Force fold 阈值 — 强制触发摘要压缩 */
export const FORCE_FOLD_RATIO = 0.9;

/** 紧急阈值 — 请求发出前的本地估计超过此值触发紧急处理 */
export const PREFLIGHT_EMERGENCY_RATIO = 0.95;

// ── P0: 工具结果裁剪 ──────────────────────────────────────

/**
 * 截红单个工具结果到指定字符上限。
 * 保留头部（60%）和尾部（40%），中间用标记替换。
 *
 * @param content 原始工具输出
 * @param capChars 截短阈值，默认 TOOL_RESULT_CAP_CHARS
 * @returns 截短后的内容；若未超限则原样返回
 */
export function trimToolResult(content: string, capChars = TOOL_RESULT_CAP_CHARS): string {
  if (content.length <= capChars) return content;
  const headLength = Math.floor(capChars * TRIM_HEAD_RATIO);
  const tailLength = capChars - headLength;
  const head = content.slice(0, headLength);
  const tail = content.slice(-tailLength);
  return `${head}${TRIM_MARKER}${tail}`;
}

/**
 * 对消息序列中指定索引之前的 tool/function 消息执行截短。
 * 当前轮次（keepFromIndex 之后）的工具结果保留完整。
 *
 * @param messages 完整消息序列（含多轮工具调用）
 * @param keepFromIndex 从此索引开始的消息不截短（当前轮次）
 * @param capChars 截短阈值
 * @returns 截短后的新消息序列和截短计数
 */
export function trimPreviousToolResults(
  messages: LLMMessage[],
  keepFromIndex: number,
  capChars = TOOL_RESULT_CAP_CHARS,
): { messages: LLMMessage[]; trimmedCount: number } {
  let trimmedCount = 0;
  const result = messages.map((msg, index) => {
    if (index >= keepFromIndex) return msg;
    if (msg.role !== 'tool' && msg.role !== 'function') return msg;
    if (msg.content.length <= capChars) return msg;
    const trimmed = trimToolResult(msg.content, capChars);
    if (trimmed !== msg.content) {
      trimmedCount++;
      return { ...msg, content: trimmed };
    }
    return msg;
  });
  return { messages: result, trimmedCount };
}

// ── P1: 上下文占比估算 ────────────────────────────────────

/**
 * 估算消息序列的 token 占用。
 * 使用 CJK 感知的估算（中文 ≈ 1.5 tokens/字，ASCII ≈ 0.25 tokens/char）。
 */
export function estimateContextTokens(messages: Array<{ content: string }>): number {
  return messages.reduce((total, msg) => total + estimateTextTokens(msg.content), 0);
}

/**
 * 计算上下文占比。
 * @param messages 消息序列
 * @param contextWindow 模型上下文窗口大小
 * @returns 占比（0-1）
 */
export function contextRatio(messages: Array<{ content: string }>, contextWindow: number): number {
  if (contextWindow <= 0) return 0;
  return estimateContextTokens(messages) / contextWindow;
}

// ── P1: Snip — 截短旧 assistant 消息中的大段内容 ───────────

/** Snip 阶段对单条消息的截短阈值（字符数） */
const SNIP_MSG_CAP_CHARS = 6000;

/** Snip 截短标记 */
const SNIP_MARKER = '\n\n[…早期回复过长，中间内容已省略…]\n\n';

/**
 * Snip：对消息序列中较早的 assistant 消息做截短。
 * 保留 system 和 user 消息完整，保留最近 tailKeep 条消息完整。
 *
 * @param messages 消息序列
 * @param tailKeep 保留最近的 N 条消息不处理
 * @returns snip 后的新消息序列和截短计数
 */
export function snipOldAssistantMessages(
  messages: LLMMessage[],
  tailKeep: number,
): { messages: LLMMessage[]; snippedCount: number } {
  const cutoff = messages.length - tailKeep;
  if (cutoff <= 0) return { messages, snippedCount: 0 };

  let snippedCount = 0;
  const result = messages.map((msg, index) => {
    if (index >= cutoff) return msg;
    if (msg.role !== 'assistant') return msg;
    if (msg.content.length <= SNIP_MSG_CAP_CHARS) return msg;
    const headLength = Math.floor(SNIP_MSG_CAP_CHARS * TRIM_HEAD_RATIO);
    const tailLength = SNIP_MSG_CAP_CHARS - headLength;
    const head = msg.content.slice(0, headLength);
    const tail = msg.content.slice(-tailLength);
    snippedCount++;
    return { ...msg, content: `${head}${SNIP_MARKER}${tail}` };
  });
  return { messages: result, snippedCount };
}

// ── P1: Prune — 将旧 assistant 消息替换为极简占位符 ─────────

/** Prune 阶段对单条消息的截短阈值（字符数）— 比 snip 更激进 */
const PRUNE_MSG_CAP_CHARS = 1500;

/** Prune 截短标记 */
const PRUNE_MARKER = '\n[…早期回复已压缩…]\n';

/**
 * Prune：对消息序列中较早的 assistant 消息做更激进的截短。
 * 在 snip 之后执行，将旧 assistant 消息压缩到极小体积。
 *
 * @param messages 消息序列
 * @param tailKeep 保留最近的 N 条消息不处理
 * @returns prune 后的新消息序列和截短计数
 */
export function pruneOldAssistantMessages(
  messages: LLMMessage[],
  tailKeep: number,
): { messages: LLMMessage[]; prunedCount: number } {
  const cutoff = messages.length - tailKeep;
  if (cutoff <= 0) return { messages, prunedCount: 0 };

  let prunedCount = 0;
  const result = messages.map((msg, index) => {
    if (index >= cutoff) return msg;
    if (msg.role !== 'assistant') return msg;
    if (msg.content.length <= PRUNE_MSG_CAP_CHARS) return msg;
    const headLength = Math.floor(PRUNE_MSG_CAP_CHARS * TRIM_HEAD_RATIO);
    const tailLength = PRUNE_MSG_CAP_CHARS - headLength;
    const head = msg.content.slice(0, headLength);
    const tail = msg.content.slice(-tailLength);
    prunedCount++;
    return { ...msg, content: `${head}${PRUNE_MARKER}${tail}` };
  });
  return { messages: result, prunedCount };
}

// ── P1: Preflight — 发送前分级压缩入口 ───────────────────

/** 保留最近的消息条数（不被任何压缩处理） */
const TAIL_KEEP_MESSAGES = 10;

/** Snip 阶段保留的最近消息条数 */
const SNIP_TAIL_KEEP = 12;

/** Prune 阶段保留的最近消息条数 */
const PRUNE_TAIL_KEEP = 8;

export type CompactionLevel = 'none' | 'snip' | 'prune' | 'force-fold';

export interface PreflightResult {
  level: CompactionLevel;
  ratio: number;
  messages: LLMMessage[];
  snippedCount: number;
  prunedCount: number;
  /** P2: fold 边界信息，供调用方执行 LLM 摘要 */
  foldBoundary?: FoldBoundary;
}

// ── P2: Fold 机制 — LLM 摘要历史 head ─────────────────────

/** Fold 后 tail 保留的 token 预算占 ctxMax 的比例 */
const FOLD_TAIL_FRACTION = 0.2;

/** Fold 后 head 至少占总 token 的多少比例才值得 fold */
const FOLD_MIN_SAVINGS_FRACTION = 0.3;

/** Fold 摘要标记前缀 */
export const HISTORY_FOLD_MARKER =
  '[CONVERSATION HISTORY SUMMARY — earlier turns folded for context efficiency]\n\n';

export interface FoldBoundary {
  /** head 区域消息（需要被摘要替换） */
  head: LLMMessage[];
  /** tail 区域消息（保留原文） */
  tail: LLMMessage[];
  /** head 估算 token 数 */
  headTokens: number;
  /** tail 估算 token 数 */
  tailTokens: number;
  /** 总 token 数 */
  totalTokens: number;
}

/**
 * 计算 fold 边界：从尾部倒推 token 预算，找到 fold 分界点。
 * 边界对齐到 user 消息，保证 tail 不以孤立 tool 消息开头。
 *
 * @param messages 完整消息序列
 * @param contextWindow 模型上下文窗口大小
 * @returns fold 边界信息，若不值得 fold 则返回 null
 */
export function computeFoldBoundary(
  messages: LLMMessage[],
  contextWindow: number,
): FoldBoundary | null {
  if (messages.length === 0) return null;

  const tailBudget = Math.floor(contextWindow * FOLD_TAIL_FRACTION);
  const tokenCounts = messages.map((m) => estimateContextTokens([m]));
  const totalTokens = tokenCounts.reduce((a, b) => a + b, 0);

  let cumTokens = 0;
  let boundary = messages.length;

  for (let i = messages.length - 1; i >= 0; i--) {
    if (cumTokens + tokenCounts[i]! > tailBudget) break;
    cumTokens += tokenCounts[i]!;
    // 对齐到 user 消息，避免 tail 以孤立 tool 消息开头
    if (messages[i]!.role === 'user') boundary = i;
  }

  if (boundary <= 0) return null;

  const head = messages.slice(0, boundary);
  const tail = messages.slice(boundary);
  const headTokens = totalTokens - cumTokens;

  // 经济性检查：head 至少占总 token 的 30% 才值得 fold
  if (headTokens < totalTokens * FOLD_MIN_SAVINGS_FRACTION) return null;

  return { head, tail, headTokens, tailTokens: cumTokens, totalTokens };
}

/**
 * 构造 fold 摘要请求消息序列（发给 LLM 做摘要）。
 * 提取 head 中的 user 消息和 assistant 消息内容，让 LLM 生成结构化摘要。
 *
 * @param head 需要被摘要的 head 区域消息
 * @returns 用于摘要的 LLM 消息序列
 */
export function buildFoldSummaryRequest(head: LLMMessage[]): LLMMessage[] {
  const transcript = head
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => {
      const label = m.role === 'user' ? '用户' : 'AI';
      // 截短单条消息到 4000 chars，避免摘要请求本身过大
      const content = m.content.length > 4000
        ? `${m.content.slice(0, 2400)}\n[…省略…]\n${m.content.slice(-1600)}`
        : m.content;
      return `### ${label}\n${content}`;
    })
    .join('\n\n');

  return [
    {
      role: 'system',
      content: '你是一个对话摘要助手。请将以下对话历史压缩为简洁的结构化摘要，保留：1) 用户的核心需求和目标 2) 关键决策和约束 3) 已完成的工作 4) 未解决的问题。用简洁的要点格式输出，不要遗漏任何用户明确提出的要求或约束。',
    },
    {
      role: 'user',
      content: `请摘要以下对话历史：\n\n${transcript}`,
    },
  ];
}

/**
 * 执行 fold：用摘要替换 head，保留 tail。
 *
 * @param summary LLM 生成的摘要文本
 * @param tail tail 区域消息（保留原文）
 * @returns fold 后的完整消息序列
 */
export function assembleFoldedMessages(summary: string, tail: LLMMessage[]): LLMMessage[] {
  const summaryMsg: LLMMessage = {
    role: 'assistant',
    content: `${HISTORY_FOLD_MARKER}${summary}`,
  };
  return [summaryMsg, ...tail];
}

/**
 * 从消息序列中提取所有 user 消息的原文（用于 fold 后保留）。
 * 在 fold 边界计算后，确保所有 user 消息都在 tail 中。
 *
 * @param messages 完整消息序列
 * @param boundaryIndex fold 边界索引
 * @returns 调整后的边界索引（确保所有 user 消息在 tail 中）
 */
export function alignBoundaryToUsers(
  messages: LLMMessage[],
  boundaryIndex: number,
): number {
  // 检查 head 中是否有 user 消息需要保留
  // Reasonix 策略：小 user 消息保留原文，不进摘要
  // 这里采用更简单策略：将边界前移到第一个 user 消息之前
  for (let i = 0; i < boundaryIndex; i++) {
    if (messages[i]!.role === 'user') {
      // 找到 head 中第一个 user 消息，将边界移到它之前
      // 但如果前面只有 system 消息，不需要移动
      if (i > 0 && messages[0]!.role === 'system') {
        return i; // head = [system], tail = [user, assistant, ...]
      }
    }
  }
  return boundaryIndex;
}

/**
 * Preflight 压缩入口：在发送请求前检查上下文占比，按分级策略执行压缩。
 *
 * 分级策略：
 *   < 0.7  → none
 *   ≥ 0.7  → snip（截短旧 assistant 消息到 6000 chars）
 *   ≥ 0.8  → prune（截短旧 assistant 消息到 1500 chars）
 *   ≥ 0.9  → force-fold（计算 fold 边界，调用方执行 LLM 摘要）
 *
 * @param messages 即将发送给 LLM 的完整消息序列
 * @param contextWindow 模型上下文窗口大小
 * @returns 压缩结果（可能原样返回）
 */
export function preflightCompaction(
  messages: LLMMessage[],
  contextWindow: number,
): PreflightResult {
  const ratio = contextRatio(messages, contextWindow);

  if (ratio < SNIP_RATIO) {
    return { level: 'none', ratio, messages, snippedCount: 0, prunedCount: 0 };
  }

  // Snip 阶段
  let working = messages;
  let snippedCount = 0;
  if (ratio >= SNIP_RATIO) {
    const result = snipOldAssistantMessages(working, SNIP_TAIL_KEEP);
    working = result.messages;
    snippedCount = result.snippedCount;
  }

  // Prune 阶段（在 snip 基础上进一步压缩）
  let prunedCount = 0;
  if (ratio >= PRUNE_RATIO) {
    const result = pruneOldAssistantMessages(working, PRUNE_TAIL_KEEP);
    working = result.messages;
    prunedCount = result.prunedCount;
  }

  // Force-fold 阶段：计算 fold 边界，供调用方执行 LLM 摘要
  const level: CompactionLevel = ratio >= FORCE_FOLD_RATIO ? 'force-fold' : ratio >= PRUNE_RATIO ? 'prune' : 'snip';

  let foldBoundary: FoldBoundary | undefined;
  if (level === 'force-fold') {
    foldBoundary = computeFoldBoundary(working, contextWindow) ?? undefined;
  }

  return { level, ratio, messages: working, snippedCount, prunedCount, foldBoundary };
}

// ── P3: 历史归档 + BM25 检索 ──────────────────────────────

/** 归档条目结构（JSONL 每行一个） */
export interface ArchiveEntry {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  archivedAt: string;
  /** 触发归档的原因 */
  reason: 'fold' | 'snip' | 'prune';
}

/** BM25 检索结果 */
export interface SearchResult {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  score: number;
  archivedAt: string;
}

/**
 * 获取会话归档文件路径。
 * 归档文件存储在工作区 .coordinator 目录下。
 */
function getArchiveFilePath(workspacePath: string, sessionId: string): string {
  const dir = path.join(workspacePath, '.coordinator', 'archives');
  return path.join(dir, `${sessionId}.jsonl`);
}

/**
 * 将消息归档到 JSONL 文件。
 * 在 fold/snip/prune 压缩前调用，保存原始消息内容。
 *
 * @param workspacePath 工作区根路径
 * @param sessionId 会话 ID
 * @param messages 要归档的消息
 * @param reason 归档原因
 * @returns 归档的条目数
 */
export function archiveMessages(
  workspacePath: string,
  sessionId: string,
  messages: LLMMessage[],
  reason: ArchiveEntry['reason'],
): number {
  if (messages.length === 0) return 0;

  const filePath = getArchiveFilePath(workspacePath, sessionId);
  const dir = path.dirname(filePath);

  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const now = new Date().toISOString();
    const lines = messages
      .filter((m) => m.content.trim().length > 0)
      .map((m) => JSON.stringify({
        id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        sessionId,
        role: m.role,
        content: m.content,
        archivedAt: now,
        reason,
      } as ArchiveEntry));

    if (lines.length === 0) return 0;
    fs.appendFileSync(filePath, lines.join('\n') + '\n', 'utf-8');
    return lines.length;
  } catch {
    // 归档失败不应阻断主流程
    return 0;
  }
}

/**
 * 读取会话的所有归档条目。
 */
export function readArchive(workspacePath: string, sessionId: string): ArchiveEntry[] {
  const filePath = getArchiveFilePath(workspacePath, sessionId);
  try {
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, 'utf-8');
    return content
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => {
        try { return JSON.parse(line) as ArchiveEntry; }
        catch { return null; }
      })
      .filter((entry): entry is ArchiveEntry => entry !== null);
  } catch {
    return [];
  }
}

// ── BM25 检索实现 ─────────────────────────────────────────

/** BM25 参数 */
const BM25_K1 = 1.5;
const BM25_B = 0.75;

/** 简单分词：CJK 字符按单字分词，非 CJK 按非字母数字字符分割，转小写 */
function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens: string[] = [];
  let buffer = '';
  for (const ch of lower) {
    if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(ch)) {
      // CJK 字符：刷新缓冲区，单字作为 token
      if (buffer) { tokens.push(buffer); buffer = ''; }
      tokens.push(ch);
    } else if (/[\p{L}\p{N}]/u.test(ch)) {
      buffer += ch;
    } else {
      if (buffer) { tokens.push(buffer); buffer = ''; }
    }
  }
  if (buffer) tokens.push(buffer);
  return tokens;
}

/**
 * 对归档条目执行 BM25 检索。
 *
 * @param entries 归档条目
 * @param query 搜索查询
 * @param topK 返回结果数，默认 10
 * @returns 按相关度排序的搜索结果
 */
export function searchArchive(
  entries: ArchiveEntry[],
  query: string,
  topK = 10,
): SearchResult[] {
  if (entries.length === 0 || !query.trim()) return [];

  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  // 构建倒排索引
  const docTokens = entries.map((e) => tokenize(e.content));
  const docFreq = new Map<string, number>();
  for (const tokens of docTokens) {
    const seen = new Set(tokens);
    for (const t of seen) {
      docFreq.set(t, (docFreq.get(t) || 0) + 1);
    }
  }

  const N = entries.length;
  const avgDl = docTokens.reduce((sum, t) => sum + t.length, 0) / N || 1;

  const results: SearchResult[] = entries.map((entry, i) => {
    const tokens = docTokens[i]!;
    const tf = new Map<string, number>();
    for (const t of tokens) {
      tf.set(t, (tf.get(t) || 0) + 1);
    }

    let score = 0;
    for (const qt of queryTokens) {
      const df = docFreq.get(qt) || 0;
      if (df === 0) continue;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      const tfVal = tf.get(qt) || 0;
      if (tfVal === 0) continue;
      const dl = tokens.length;
      const bm25 = idf * (tfVal * (BM25_K1 + 1)) / (tfVal + BM25_K1 * (1 - BM25_B + BM25_B * (dl / avgDl)));
      score += bm25;
    }

    return {
      id: entry.id,
      sessionId: entry.sessionId,
      role: entry.role,
      content: entry.content,
      score,
      archivedAt: entry.archivedAt,
    };
  });

  return results
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

/**
 * 搜索会话归档（便捷封装：读取 + 检索）。
 */
export function searchSessionArchive(
  workspacePath: string,
  sessionId: string,
  query: string,
  topK = 10,
): SearchResult[] {
  const entries = readArchive(workspacePath, sessionId);
  return searchArchive(entries, query, topK);
}
