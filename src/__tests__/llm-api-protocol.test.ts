import { createServer } from 'http';
import { describe, expect, it } from 'vitest';
import {
  COORDINATOR_LLM_TOOLS,
  parseStreamData,
  prepareLLMRequest,
} from '../../vscode-extension/src/services/llm-api';
import { LLMService, type LLMMessage } from '../../vscode-extension/src/services/llm-service';

const config = {
  apiKey: 'test-key',
  baseURL: 'https://example.test/v1',
  model: 'test-model',
  tools: COORDINATOR_LLM_TOOLS,
};

const toolCallMessages: LLMMessage[] = [
  { role: 'user', content: '派发任务' },
  {
    role: 'assistant',
    content: '',
    toolCalls: [{
      id: 'call_1',
      name: 'dispatch_session_task',
      arguments: '{"target":"abc12345","title":"检查","objective":"运行验证"}',
    }],
  },
  { role: 'tool', toolCallId: 'call_1', content: '{"ok":true}' },
];

describe('LLM stream protocol compatibility', () => {
  it('parses fragmented Chat Completions tool calls and reasoning', () => {
    const first = parseStreamData('chat-completions', JSON.stringify({
      choices: [{ delta: {
        reasoning_content: '分析中',
        tool_calls: [{ index: 0, id: 'call_1', function: { name: 'dispatch_', arguments: '{"target":' } }],
      }, finish_reason: null }],
    }));
    const second = parseStreamData('chat-completions', JSON.stringify({
      choices: [{ delta: {
        tool_calls: [{ index: 0, function: { name: 'session_task', arguments: '"abc12345"}' } }],
      }, finish_reason: 'tool_calls' }],
    }));

    expect(first.reasoningDelta).toBe('分析中');
    expect(first.toolCallDeltas?.[0]).toMatchObject({ id: 'call_1', name: 'dispatch_', argumentsDelta: '{"target":' });
    expect(second.toolCallDeltas?.[0]).toMatchObject({ name: 'session_task', argumentsDelta: '"abc12345"}' });
    expect(second.done).toBe(true);
  });

  it('parses legacy function_call deltas', () => {
    const parsed = parseStreamData('chat-completions', JSON.stringify({
      choices: [{ delta: { function_call: { name: 'dispatch_session_task', arguments: '{}' } }, finish_reason: 'function_call' }],
    }));

    expect(parsed.toolCallDeltas?.[0]).toMatchObject({
      id: 'legacy_function_call',
      name: 'dispatch_session_task',
      argumentsDelta: '{}',
      legacy: true,
    });
    expect(parsed.done).toBe(true);
  });

  it('parses Anthropic thinking signatures and tool input', () => {
    expect(parseStreamData('anthropic-messages', JSON.stringify({
      type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '分析' },
    })).reasoningDelta).toBe('分析');
    expect(parseStreamData('anthropic-messages', JSON.stringify({
      type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' },
    })).reasoningSignatureDelta).toBe('sig');
    expect(parseStreamData('anthropic-messages', JSON.stringify({
      type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tool_1', name: 'dispatch_session_task' },
    })).toolCallDeltas?.[0]).toMatchObject({ index: 1, id: 'tool_1', name: 'dispatch_session_task' });
    expect(parseStreamData('anthropic-messages', JSON.stringify({
      type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"target":"abc"}' },
    })).toolCallDeltas?.[0].argumentsDelta).toBe('{"target":"abc"}');
  });

  it('parses Responses reasoning and function events', () => {
    expect(parseStreamData('responses', JSON.stringify({
      type: 'response.reasoning_summary_text.delta', delta: '摘要',
    })).reasoningDelta).toBe('摘要');
    expect(parseStreamData('responses', JSON.stringify({
      type: 'response.output_item.added', output_index: 2,
      item: { type: 'function_call', call_id: 'call_2', name: 'dispatch_session_task', arguments: '' },
    })).toolCallDeltas?.[0]).toMatchObject({ index: 2, id: 'call_2', name: 'dispatch_session_task' });
    expect(parseStreamData('responses', JSON.stringify({
      type: 'response.function_call_arguments.delta', output_index: 2, delta: '{"target":"abc"}',
    })).toolCallDeltas?.[0].argumentsDelta).toBe('{"target":"abc"}');
  });

  it('serializes provider-specific tool continuation messages', () => {
    const chatBody = JSON.parse(prepareLLMRequest(toolCallMessages, {
      ...config,
      apiFormat: 'chat-completions' as const,
    }, true).body);
    expect(chatBody.tools[0].type).toBe('function');
    expect(chatBody.messages[1].tool_calls[0].id).toBe('call_1');
    expect(chatBody.messages[2]).toMatchObject({ role: 'tool', tool_call_id: 'call_1' });

    const anthropicBody = JSON.parse(prepareLLMRequest(toolCallMessages, {
      ...config,
      apiFormat: 'anthropic-messages' as const,
    }, true).body);
    expect(anthropicBody.tools[0].input_schema.required).toEqual(['target', 'title', 'objective']);
    expect(anthropicBody.messages[1].content[0]).toMatchObject({ type: 'tool_use', id: 'call_1' });
    expect(anthropicBody.messages[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'call_1' });

    const responsesBody = JSON.parse(prepareLLMRequest(toolCallMessages, {
      ...config,
      apiFormat: 'responses' as const,
    }, true).body);
    expect(responsesBody.tools[0]).toMatchObject({ type: 'function', name: 'dispatch_session_task', strict: true });
    expect(responsesBody.input[1]).toMatchObject({ type: 'function_call', call_id: 'call_1' });
    expect(responsesBody.input[2]).toMatchObject({ type: 'function_call_output', call_id: 'call_1' });
  });

  it('executes a streamed tool call and continues the request', async () => {
    const bodies: Array<Record<string, any>> = [];
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => { body += chunk.toString(); });
      request.on('end', () => {
        bodies.push(JSON.parse(body));
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        if (bodies.length === 1) {
          response.write('data: {"choices":[{"delta":{"reasoning_content":"分析"},"finish_reason":null}]}\n\n');
          response.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"dispatch_","arguments":"{\\"target\\":\\"abc"}}]},"finish_reason":null}]}\n\n');
          response.end('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"session_task","arguments":"12345\\",\\"title\\":\\"检查\\",\\"objective\\":\\"验证\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n');
        } else {
          response.end('data: {"choices":[{"delta":{"content":"已完成"},"finish_reason":"stop"}]}\n\n');
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('测试服务监听失败');

    try {
      const result = await new Promise<{ text: string; reasoning: string }>((resolve, reject) => {
        new LLMService().streamChat(
          [{ role: 'user', content: '派发任务' }],
          { ...config, baseURL: `http://127.0.0.1:${address.port}/v1`, apiFormat: 'chat-completions' },
          {
            onChunk: () => undefined,
            onReasoningChunk: () => undefined,
            onToolCall: async (call) => {
              expect(call).toMatchObject({
                id: 'call_1',
                name: 'dispatch_session_task',
                arguments: '{"target":"abc12345","title":"检查","objective":"验证"}',
              });
              return '{"ok":true}';
            },
            onDone: (text, reasoning) => resolve({ text, reasoning }),
            onError: reject,
          },
        );
      });

      expect(result).toEqual({ text: '已完成', reasoning: '分析' });
      expect(bodies).toHaveLength(2);
      expect(bodies[1].messages.at(-2).tool_calls[0].id).toBe('call_1');
      expect(bodies[1].messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call_1' });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('exposes the bounded coding-agent tool set', () => {
    expect(COORDINATOR_LLM_TOOLS.map((tool) => tool.name)).toEqual([
      'dispatch_session_task',
      'workspace_list_files',
      'workspace_read_file',
      'workspace_search',
      'workspace_write_file',
      'workspace_replace',
      'workspace_delete',
      'git_status',
      'git_diff',
      'run_command',
    ]);
  });

  it('rejects excessive parallel tool calls before execution', async () => {
    const calls = Array.from({ length: 9 }, (_, index) => ({
      index,
      id: `call_${index}`,
      function: { name: 'workspace_list_files', arguments: '{}' },
    }));
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: calls }, finish_reason: 'tool_calls' }] })}\n\n`);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('测试服务监听失败');
    let executions = 0;

    try {
      const message = await new Promise<string>((resolve) => {
        new LLMService().streamChat(
          [{ role: 'user', content: '测试工具预算' }],
          { ...config, baseURL: `http://127.0.0.1:${address.port}/v1`, apiFormat: 'chat-completions' },
          {
            onChunk: () => undefined,
            onToolCall: async () => { executions++; return '{}'; },
            onDone: () => resolve('unexpected completion'),
            onError: (error) => resolve(error.message),
          },
        );
      });
      expect(message).toContain('工具调用数量超过安全上限');
      expect(executions).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('surfaces HTTP API errors', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: '参数错误' } }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('测试服务监听失败');

    try {
      const message = await new Promise<string>((resolve) => {
        new LLMService().streamChat(
          [{ role: 'user', content: '测试' }],
          { ...config, baseURL: `http://127.0.0.1:${address.port}/v1`, apiFormat: 'chat-completions' },
          {
            onChunk: () => undefined,
            onDone: () => resolve('unexpected completion'),
            onError: (error) => resolve(error.message),
          },
        );
      });
      expect(message).toContain('LLM API 返回 400: 参数错误');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('suppresses callbacks after cancellation', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      setTimeout(() => response.end('data: {"choices":[{"delta":{"content":"迟到"},"finish_reason":"stop"}]}\n\n'), 30);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('测试服务监听失败');
    const events: string[] = [];

    try {
      const abort = new LLMService().streamChat(
        [{ role: 'user', content: '测试' }],
        { ...config, baseURL: `http://127.0.0.1:${address.port}/v1`, apiFormat: 'chat-completions' },
        {
          onChunk: () => events.push('chunk'),
          onDone: () => events.push('done'),
          onError: () => events.push('error'),
        },
      );
      abort();
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(events).toEqual([]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
