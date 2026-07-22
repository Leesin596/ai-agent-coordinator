/**
 * Slash Commands — /code /ask /debug /architect
 *
 * 用户在输入框以 / 开头时触发对应模式，模式会注入额外的系统指令前缀，
 * 引导 LLM 以对应风格回答。slash 命令本身从用户消息中剥离，不发给 LLM。
 *
 * 架构说明：
 * - slash 命令在 handleSendMessage 入口处解析，修改 content 和注入 system 前缀
 * - 模式仅影响当前轮次，不持久化到会话
 * - 未识别的 / 前缀按普通文本处理（不拦截）
 */

export interface SlashCommandResult {
  /** 剥离 slash 命令后的实际用户消息 */
  content: string;
  /** 注入到 system 消息前缀的模式指令（空字符串=无注入） */
  modePrompt: string;
  /** 匹配到的模式名（用于 UI 展示） */
  mode: string;
}

const SLASH_MODES: Record<string, { prompt: string; label: string }> = {
  code: {
    label: '编码模式',
    prompt: [
      '## 当前模式：编码模式 (/code)',
      '请直接给出可执行的代码实现，遵循以下要求：',
      '- 优先输出完整代码块，用正确的语言标记',
      '- 代码必须可直接复制运行，包含必要的 import/依赖声明',
      '- 修改已有代码时，明确标注修改位置和原因',
      '- 不要冗长解释，仅在关键决策处简短说明',
      '- 使用项目现有的代码风格和约定',
    ].join('\n'),
  },
  ask: {
    label: '问答模式',
    prompt: [
      '## 当前模式：问答模式 (/ask)',
      '请以简洁准确的方式回答问题，遵循以下要求：',
      '- 直接回答核心问题，不要绕弯',
      '- 技术问题给出原理 + 实践建议',
      '- 不确定的内容明确标注「不确定」',
      '- 避免不必要的代码示例，除非问题本身就是关于代码',
    ].join('\n'),
  },
  debug: {
    label: '调试模式',
    prompt: [
      '## 当前模式：调试模式 (/debug)',
      '请以系统化方式排查问题，遵循以下要求：',
      '- 先分析可能的根因（列出 2-3 个最可能的）',
      '- 给出针对性的诊断步骤或命令',
      '- 提供修复方案时区分临时修复和根因修复',
      '- 如果需要更多信息，明确列出需要什么',
      '- 使用工具读取相关文件和日志来辅助判断',
    ].join('\n'),
  },
  architect: {
    label: '架构模式',
    prompt: [
      '## 当前模式：架构模式 (/architect)',
      '请以架构师视角分析和设计，遵循以下要求：',
      '- 从全局视角分析问题，考虑可扩展性、可维护性和性能',
      '- 给出架构方案时包含：模块划分、数据流、关键接口定义',
      '- 评估方案的 trade-off，列出优缺点',
      '- 考虑与现有系统的集成点和冲突',
      '- 必要时使用工具读取项目文件来了解现有架构',
    ].join('\n'),
  },
};

/**
 * 解析用户输入中的 slash 命令。
 * 如果不以已知 slash 命令开头，返回原始内容和空 modePrompt。
 */
export function parseSlashCommand(input: string): SlashCommandResult {
  const trimmed = input.trimStart();
  const match = trimmed.match(/^\/(\w+)\s*/);
  if (!match) {
    return { content: input, modePrompt: '', mode: '' };
  }

  const commandName = match[1].toLowerCase();
  const mode = SLASH_MODES[commandName];
  if (!mode) {
    return { content: input, modePrompt: '', mode: '' };
  }

  const content = trimmed.slice(match[0].length).trim();
  return {
    content: content || input,
    modePrompt: mode.prompt,
    mode: mode.label,
  };
}

/** 获取所有可用的 slash 命令列表（用于 UI 自动补全） */
export function getAvailableSlashCommands(): { command: string; label: string }[] {
  return Object.entries(SLASH_MODES).map(([cmd, cfg]) => ({
    command: `/${cmd}`,
    label: cfg.label,
  }));
}
