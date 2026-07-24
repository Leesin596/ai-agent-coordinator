import * as vscode from 'vscode';
import type { TerminalRunResult, TerminalRunner } from './workspace-tools';

const MAX_OUTPUT = 100000;

/*
 * VS Code 终端集成服务。
 * 使用 shellIntegration.executeCommand 在集成终端中执行命令，
 * 实时捕获 stdout/stderr 并返回给 LLM，同时用户可在终端中看到完整输出。
 *
 * 架构说明：
 * - VS Code 1.93+ 提供 terminal.shellIntegration.executeCommand() 返回 TerminalShellExecution，
 *   其 stdout/stderr 是 ReadableStream，可用于捕获输出。
 * - 对于不支持 shellIntegration 的终端，回退到 sendText + 通知用户查看终端。
 */
export class TerminalService {
  private terminal: vscode.Terminal | null = null;
  private terminalExitDisposable: vscode.Disposable | null = null;

  private ensureTerminal(cwd: string): vscode.Terminal {
    if (this.terminal && this.terminal.exitStatus === undefined) {
      return this.terminal;
    }
    if (this.terminalExitDisposable) {
      this.terminalExitDisposable.dispose();
      this.terminalExitDisposable = null;
    }
    this.terminal = vscode.window.createTerminal({ name: 'Coordinator', cwd });
    this.terminalExitDisposable = vscode.window.onDidCloseTerminal((closed) => {
      if (closed === this.terminal) {
        this.terminal = null;
        if (this.terminalExitDisposable) {
          this.terminalExitDisposable.dispose();
          this.terminalExitDisposable = null;
        }
      }
    });
    return this.terminal;
  }

  createRunner(): TerminalRunner {
    return async (command: string, cwd: string, timeoutSeconds: number): Promise<TerminalRunResult> => {
      const terminal = this.ensureTerminal(cwd);

      const shellIntegration = terminal.shellIntegration;
      if (shellIntegration) {
        return this.executeWithShellIntegration(terminal, shellIntegration, command, timeoutSeconds);
      }

      terminal.sendText(command, true);
      vscode.window.showInformationMessage('Coordinator 已在终端执行命令，请在终端查看输出');
      return {
        stdout: '[命令已在 VS Code 终端中执行，请查看终端输出]',
        stderr: '',
        exitCode: null,
        timedOut: false,
        truncated: false,
      };
    };
  }

  private async executeWithShellIntegration(
    terminal: vscode.Terminal,
    shellIntegration: vscode.TerminalShellIntegration,
    command: string,
    timeoutSeconds: number,
  ): Promise<TerminalRunResult> {
    const execution = shellIntegration.executeCommand(command);

    let stdout = '';
    let truncated = false;
    let timedOut = false;
    let exitCode: number | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const append = (current: string, chunk: string): string => {
      if (current.length >= MAX_OUTPUT) { truncated = true; return current; }
      const next = current + chunk;
      if (next.length > MAX_OUTPUT) truncated = true;
      return next.slice(0, MAX_OUTPUT);
    };

    const readPromise = (async () => {
      const stream = execution.read();
      for await (const chunk of stream) {
        stdout = append(stdout, chunk);
      }
    })();

    const exitCodePromise = new Promise<void>((resolve) => {
      const disposable = vscode.window.onDidEndTerminalShellExecution((event) => {
        if (event.execution === execution) {
          if (typeof event.exitCode === 'number') exitCode = event.exitCode;
          disposable.dispose();
          resolve();
        }
      });
    });

    const timeoutPromise = new Promise<void>((resolve) => {
      timer = setTimeout(() => { timedOut = true; resolve(); }, timeoutSeconds * 1000);
    });

    await Promise.race([
      Promise.all([readPromise, exitCodePromise]),
      timeoutPromise,
    ]);

    if (timedOut) {
      terminal.sendText('\x03', false);
      // 等待 readPromise 短暂刷新已缓冲的输出（最多 500ms）
      await Promise.race([
        readPromise.catch(() => {}),
        new Promise<void>((r) => setTimeout(r, 500)),
      ]);
    } else if (timer) {
      clearTimeout(timer);
    }

    // VS Code TerminalShellExecution.read() 合并了 stdout 和 stderr，
    // 无法区分两者。将合并输出放在 stdout，stderr 留空并附注说明。
    return {
      stdout,
      stderr: timedOut ? '(命令超时，已发送 Ctrl+C；stderr 不可区分)' : '(stdout 与 stderr 已合并)',
      exitCode,
      timedOut,
      truncated,
    };
  }

  dispose(): void {
    if (this.terminalExitDisposable) {
      this.terminalExitDisposable.dispose();
      this.terminalExitDisposable = null;
    }
  }
}
