import type { Role } from '../../../src/models/types';
import type { LLMToolDefinition } from './llm-api';

/**
 * 按角色配置过滤可用工具列表。
 *
 * 规则：
 * 1. deniedTools 优先级最高 — 即使在 allowedTools 中也会被排除
 * 2. allowedTools 为空数组 → 继承全部默认工具
 * 3. allowedTools 非空 → 仅保留白名单中的工具
 * 4. MCP 工具 (格式 serverName__toolName) 不受角色工具过滤限制，由 MCP 配置独立控制
 *    — 仅当 __ 前缀部分匹配已注册的 MCP server 名时才豁免
 *
 * 架构影响说明：
 * - 当前 COORDINATOR_LLM_TOOLS 是静态数组，过滤后产生新数组传给 LLM
 * - WorkspaceToolExecutor.execute 仍需做运行时校验，防止 LLM 幻觉调用未授权工具
 */
export function filterToolsByRole(
  tools: LLMToolDefinition[],
  role: Role | undefined,
  mcpServerNames?: Set<string>,
): LLMToolDefinition[] {
  if (!role) return tools;

  const denied = new Set(role.deniedTools || []);
  const allowed = role.allowedTools || [];
  const mcpNames = mcpServerNames || new Set<string>();

  return tools.filter((tool) => {
    // MCP 工具不受角色过滤（仅当 serverName 已注册时豁免）
    if (isMCPToolName(tool.name, mcpNames)) return true;
    // deniedTools 优先
    if (denied.has(tool.name)) return false;
    // allowedTools 为空 = 继承全部
    if (allowed.length === 0) return true;
    return allowed.includes(tool.name);
  });
}

/**
 * 运行时校验：工具名称是否被角色允许执行。
 * 与 filterToolsByRole 逻辑一致，但用于 WorkspaceToolExecutor 中的防御性检查。
 */
export function isToolAllowedByRole(
  toolName: string,
  role: Role | undefined,
  mcpServerNames?: Set<string>,
): boolean {
  if (!role) return true;
  if (isMCPToolName(toolName, mcpServerNames || new Set<string>())) return true;

  const denied = role.deniedTools || [];
  if (denied.includes(toolName)) return false;

  const allowed = role.allowedTools || [];
  if (allowed.length === 0) return true;
  return allowed.includes(toolName);
}

/**
 * 判断工具名是否为已注册的 MCP 工具。
 * 格式: serverName__toolName，且 serverName 必须在已注册集合中。
 * 如果未提供 mcpServerNames 集合（向后兼容），则仅检查 __ 分隔符。
 */
function isMCPToolName(toolName: string, mcpServerNames: Set<string>): boolean {
  const sepIdx = toolName.indexOf('__');
  if (sepIdx === -1) return false;
  if (mcpServerNames.size === 0) return true; // 向后兼容：无注册信息时按原逻辑豁免
  const serverName = toolName.slice(0, sepIdx);
  return mcpServerNames.has(serverName);
}
