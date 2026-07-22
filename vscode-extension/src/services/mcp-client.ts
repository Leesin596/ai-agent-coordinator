// ============================================================
// MCPClientManager — MCP (Model Context Protocol) 客户端管理
// 支持通过 stdio / SSE 连接外部 MCP Server，将其工具暴露给 LLM
// ============================================================
import * as vscode from 'vscode';
import * as childProcess from 'child_process';
import type { LLMToolDefinition } from './llm-api';
import type { LLMToolCall } from './llm-service';

interface MCPServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
}

interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  serverName: string;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

export class MCPClientManager {
  private servers = new Map<string, { process: childProcess.ChildProcess; tools: MCPTool[] }>();
  private requestId = 0;
  private pendingRequests = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
  private configs: MCPServerConfig[] = [];
  private disposables: vscode.Disposable[] = [];

  constructor() {
    this.loadConfig();
    // 监听配置变更
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('coordinator.mcp.servers')) {
          this.loadConfig();
          void this.reconnectAll();
        }
      }),
    );
  }

  private loadConfig(): void {
    const config = vscode.workspace.getConfiguration('coordinator.mcp');
    this.configs = (config.get<MCPServerConfig[]>('servers') || []).filter(s => s.enabled !== false);
  }

  /** 连接所有已配置的 MCP Server */
  async connectAll(): Promise<void> {
    for (const cfg of this.configs) {
      try {
        await this.connect(cfg);
      } catch (err) {
        vscode.window.showWarningMessage(`MCP Server "${cfg.name}" 连接失败: ${(err as Error).message}`);
      }
    }
  }

  /** 连接单个 MCP Server */
  private async connect(cfg: MCPServerConfig): Promise<void> {
    if (this.servers.has(cfg.name)) return;

    const proc = childProcess.spawn(cfg.command, cfg.args || [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...cfg.env },
    });

    let buffer = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          this.handleMessage(msg);
        } catch { /* ignore non-JSON lines */ }
      }
    });

    proc.on('error', (err) => {
      vscode.window.showErrorMessage(`MCP Server "${cfg.name}" 进程错误: ${err.message}`);
    });

    proc.on('exit', () => {
      this.servers.delete(cfg.name);
    });

    this.servers.set(cfg.name, { process: proc, tools: [] });

    // 初始化握手
    await this.sendRequest(cfg.name, proc, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'ai-agent-coordinator', version: '0.1.1' },
    });
    // notifications/initialized 是 notification（无需响应），直接写入 stdin
    const initNotification = { jsonrpc: '2.0', method: 'notifications/initialized', params: {} };
    proc.stdin?.write(JSON.stringify(initNotification) + '\n');

    // 获取工具列表
    const toolsResult = await this.sendRequest(cfg.name, proc, 'tools/list', {}) as { tools?: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> };
    const tools: MCPTool[] = (toolsResult?.tools || []).map(t => ({
      name: `${cfg.name}__${t.name}`,
      description: `[MCP:${cfg.name}] ${t.description}`,
      inputSchema: t.inputSchema,
      serverName: cfg.name,
    }));
    this.servers.get(cfg.name)!.tools = tools;
  }

  private handleMessage(msg: any): void {
    if (msg.id !== undefined && this.pendingRequests.has(msg.id)) {
      const pending = this.pendingRequests.get(msg.id)!;
      this.pendingRequests.delete(msg.id);
      if (msg.error) {
        pending.reject(new Error(msg.error.message));
      } else {
        pending.resolve(msg.result);
      }
    }
  }

  private sendRequest(serverName: string, proc: childProcess.ChildProcess, method: string, params?: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++this.requestId;
      const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
      this.pendingRequests.set(id, { resolve, reject });
      proc.stdin?.write(JSON.stringify(req) + '\n');
      // 超时
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`MCP 请求超时: ${method} (server: ${serverName})`));
        }
      }, 10000);
    });
  }

  /** 获取所有已连接 MCP Server 的工具定义（转换为 LLMToolDefinition 格式） */
  getToolDefinitions(): LLMToolDefinition[] {
    const tools: LLMToolDefinition[] = [];
    for (const { tools: serverTools } of this.servers.values()) {
      for (const tool of serverTools) {
        tools.push({
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        });
      }
    }
    return tools;
  }

  /** 执行 MCP 工具调用 */
  async executeTool(call: LLMToolCall): Promise<string> {
    // 工具名格式: serverName__toolName
    const sepIdx = call.name.indexOf('__');
    if (sepIdx === -1) throw new Error(`无效的 MCP 工具名: ${call.name}`);
    const serverName = call.name.slice(0, sepIdx);
    const toolName = call.name.slice(sepIdx + 2);
    const entry = this.servers.get(serverName);
    if (!entry) throw new Error(`MCP Server "${serverName}" 未连接`);
    const result = await this.sendRequest(serverName, entry.process, 'tools/call', {
      name: toolName,
      arguments: this.parseToolArguments(call.arguments),
    }) as { content?: Array<{ type: string; text?: string }> };
    const text = result?.content?.map(c => c.text || '').join('\n') || '';
    return text || JSON.stringify(result);
  }

  private parseToolArguments(raw: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(raw || '{}');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  /** 判断工具名是否为 MCP 工具 */
  isMCPTool(toolName: string): boolean {
    return toolName.includes('__') && this.servers.has(toolName.slice(0, toolName.indexOf('__')));
  }

  /** 重新连接所有 Server */
  async reconnectAll(): Promise<void> {
    await this.disconnectAll();
    await this.connectAll();
  }

  /** 断开所有 Server */
  async disconnectAll(): Promise<void> {
    for (const [name, entry] of this.servers) {
      try {
        entry.process.kill();
      } catch { /* ignore */ }
    }
    this.servers.clear();
    this.pendingRequests.clear();
  }

  dispose(): void {
    void this.disconnectAll();
    this.disposables.forEach(d => d.dispose());
  }
}
