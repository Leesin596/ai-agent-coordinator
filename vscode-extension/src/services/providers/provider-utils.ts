/**
 * Provider 共享工具函数。
 * 提取自各 Provider 中重复的 extractText / normalizeReasoningEffort 等逻辑。
 */

/** 从未知类型中递归提取文本（兼容 string / array / object） */
export function extractText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const text = value.map((item) => extractText(item)).filter(Boolean).join('');
    return text || undefined;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return extractText(record.text) || extractText(record.content) || extractText(record.summary);
  }
  return undefined;
}

/** 规范化 reasoning effort 参数 */
export function normalizeReasoningEffort(value?: string): 'low' | 'medium' | 'high' {
  if (value === 'low' || value === 'medium') return value;
  return 'high';
}

/** OpenAI / DeepSeek / Qwen 系列推理模型检测 */
export function supportsOpenAIReasoningControls(model: string): boolean {
  return /(?:^|[-_.])(?:o1|o3|o4)(?:[-_.]|$)|gpt-5|codex|deepseek-(?:r1|reasoner)|qwq|qwen.*(?:thinking|reason)/i.test(model);
}
