import type { ContextRequest, CompiledContext } from '../models/types';
import type { TaskManager } from './task-manager';
import type { ContractRegistry } from './contract-registry';
import type { MemoryStore } from './memory-store';

const CHARS_PER_TOKEN = 4; // Rough estimate: 1 token ≈ 4 chars (English), ~1.5 chars (Chinese)
const DEFAULT_TOKEN_BUDGET = 8000;

export class ContextCompiler {
  constructor(
    private taskManager: TaskManager,
    private contractRegistry: ContractRegistry,
    private memoryStore: MemoryStore
  ) {}

  compile(request: ContextRequest): CompiledContext {
    const budget = request.tokenBudget || DEFAULT_TOKEN_BUDGET;
    const usableBudget = Math.floor(budget * 0.8); // 20% buffer
    const role = request.agentRole;

    const sections = {
      currentTask: '',
      dependencies: '',
      contracts: '',
      decisions: '',
      conventions: '',
      warnings: '',
    };

    let usedTokens = 0;

    // 1. Current task (highest priority)
    if (request.focusTaskId) {
      const task = this.taskManager.get(request.focusTaskId);
      if (task) {
        sections.currentTask = this.formatCurrentTask(task);
        usedTokens += this.estimateTokens(sections.currentTask);
      }
    } else {
      // Find in-progress or ready tasks for this agent
      const activeTasks = this.taskManager.list({ assignee: role, status: 'in_progress', project: request.project });
      const readyTasks = this.taskManager.list({ assignee: role, status: 'ready', project: request.project });
      const tasks = [...activeTasks, ...readyTasks];
      if (tasks.length > 0) {
        sections.currentTask = tasks.map((t) => this.formatCurrentTask(t)).join('\n\n');
        usedTokens += this.estimateTokens(sections.currentTask);
      }
    }

    // 2. Dependencies (high priority)
    if (usedTokens < usableBudget) {
      const allTasks = this.taskManager.list({ assignee: role, project: request.project });
      const depTaskIds = new Set<string>();
      for (const task of allTasks) {
        task.dependencies.forEach((d) => depTaskIds.add(d));
        task.dependents.forEach((d) => depTaskIds.add(d));
      }

      const depSummaries: string[] = [];
      for (const depId of depTaskIds) {
        const dep = this.taskManager.get(depId);
        if (dep && dep.assignee !== role) {
          depSummaries.push(`- [${dep.status}] ${dep.title} (${dep.assignee})`);
        }
      }

      if (depSummaries.length > 0) {
        sections.dependencies = `## 上下游依赖\n${depSummaries.join('\n')}`;
        usedTokens += this.estimateTokens(sections.dependencies);
      }
    }

    // 3. Contracts (high priority)
    if (usedTokens < usableBudget) {
      const producedContracts = this.contractRegistry.list({ producer: role, project: request.project });
      const consumedContracts = this.contractRegistry.list({ consumer: role, project: request.project });
      const allContracts = [...producedContracts, ...consumedContracts];
      const uniqueContracts = [...new Map(allContracts.map((c) => [c.id, c])).values()];

      if (uniqueContracts.length > 0) {
        const contractTexts = uniqueContracts.map((c) => {
          const roleLabel = c.producer === role ? '(我方提供)' : '(我方消费)';
          return `### ${c.name} ${roleLabel}\n- 状态: ${c.status}\n- Schema: \`\`\`json\n${JSON.stringify(c.schema, null, 2)}\n\`\`\``;
        });

        sections.contracts = `## 相关契约\n${contractTexts.join('\n\n')}`;
        const contractTokens = this.estimateTokens(sections.contracts);

        if (usedTokens + contractTokens > usableBudget) {
          // Truncate: only show names and status
          sections.contracts = `## 相关契约\n${uniqueContracts.map((c) => `- ${c.name} [${c.status}]`).join('\n')}`;
        }

        usedTokens += this.estimateTokens(sections.contracts);
      }
    }

    // 4. Decisions (medium priority)
    if (usedTokens < usableBudget && request.includeHistory !== false) {
      const decisions = this.memoryStore.list({ category: 'decision', scope: role, project: request.project });
      const globalDecisions = this.memoryStore.list({ category: 'decision', scope: 'global', project: request.project });
      const allDecisions = [...decisions, ...globalDecisions].slice(0, 10);

      if (allDecisions.length > 0) {
        sections.decisions = `## 历史决策\n${allDecisions.map((d) => `- **${d.title}**: ${d.content}`).join('\n')}`;
        usedTokens += this.estimateTokens(sections.decisions);
      }
    }

    // 5. Conventions (medium priority)
    if (usedTokens < usableBudget) {
      const conventions = this.memoryStore.list({ category: 'convention', project: request.project });
      if (conventions.length > 0) {
        sections.conventions = `## 项目约定\n${conventions.map((c) => `- **${c.title}**: ${c.content}`).join('\n')}`;
        usedTokens += this.estimateTokens(sections.conventions);
      }
    }

    // 6. Warnings
    const blockedTasks = this.taskManager.list({ assignee: role, status: 'blocked', project: request.project });
    if (blockedTasks.length > 0) {
      sections.warnings = `## ⚠️ 警告\n${blockedTasks.map((t) => `- 任务被阻塞: ${t.title}`).join('\n')}`;
      usedTokens += this.estimateTokens(sections.warnings);
    }

    // Format output
    if (request.format === 'json') {
      return {
        agentRole: role,
        generatedAt: new Date().toISOString(),
        tokenEstimate: usedTokens,
        sections,
      };
    }

    return {
      agentRole: role,
      generatedAt: new Date().toISOString(),
      tokenEstimate: usedTokens,
      sections,
    };
  }

  private formatCurrentTask(task: any): string {
    let text = `## 当前任务: ${task.title}\n- 状态: ${task.status}\n- 优先级: ${task.priority}`;
    if (task.description) text += `\n- 描述: ${task.description}`;
    if (Object.keys(task.inputs).length > 0) text += `\n- 输入: ${JSON.stringify(task.inputs)}`;
    if (task.contractRefs.length > 0) text += `\n- 关联契约: ${task.contractRefs.join(', ')}`;
    return text;
  }

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN);
  }
}
