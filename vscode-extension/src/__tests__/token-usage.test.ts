import { describe, it, expect } from 'vitest';
import { ChatCompletionsProvider } from '../services/providers/chat-completions-provider';
import { AnthropicProvider } from '../services/providers/anthropic-provider';
import { ResponsesProvider } from '../services/providers/responses-provider';

describe('Token usage 解析', () => {
  describe('ChatCompletionsProvider', () => {
    const provider = new ChatCompletionsProvider();

    it('解析标准 OpenAI usage 字段', () => {
      const sse = JSON.stringify({
        choices: [{ finish_reason: 'stop', delta: {} }],
        usage: {
          prompt_tokens: 1200,
          completion_tokens: 350,
          total_tokens: 1550,
        },
      });
      const parsed = provider.parseStreamData(sse);
      expect(parsed.usage).toBeDefined();
      expect(parsed.usage!.promptTokens).toBe(1200);
      expect(parsed.usage!.completionTokens).toBe(350);
      expect(parsed.usage!.totalTokens).toBe(1550);
      expect(parsed.usage!.cacheHitTokens).toBeUndefined();
    });

    it('解析 DeepSeek cache 字段', () => {
      const sse = JSON.stringify({
        choices: [{ finish_reason: 'stop', delta: {} }],
        usage: {
          prompt_tokens: 1500,
          completion_tokens: 300,
          total_tokens: 1800,
          prompt_cache_hit_tokens: 1000,
          prompt_cache_miss_tokens: 500,
        },
      });
      const parsed = provider.parseStreamData(sse);
      expect(parsed.usage!.cacheHitTokens).toBe(1000);
      expect(parsed.usage!.cacheMissTokens).toBe(500);
    });

    it('解析 OpenAI prompt_tokens_details.cached_tokens', () => {
      const sse = JSON.stringify({
        choices: [{ finish_reason: 'stop', delta: {} }],
        usage: {
          prompt_tokens: 2006,
          completion_tokens: 300,
          total_tokens: 2306,
          prompt_tokens_details: { cached_tokens: 1920 },
        },
      });
      const parsed = provider.parseStreamData(sse);
      expect(parsed.usage!.cacheHitTokens).toBe(1920);
    });

    it('无 usage 时返回 undefined', () => {
      const sse = JSON.stringify({
        choices: [{ delta: { content: 'hello' } }],
      });
      const parsed = provider.parseStreamData(sse);
      expect(parsed.usage).toBeUndefined();
    });

    it('[DONE] 返回 done 且无 usage', () => {
      const parsed = provider.parseStreamData('[DONE]');
      expect(parsed.done).toBe(true);
      expect(parsed.usage).toBeUndefined();
    });
  });

  describe('AnthropicProvider', () => {
    const provider = new AnthropicProvider();

    it('解析 message_start 中的 input_tokens + cache 字段', () => {
      const sse = JSON.stringify({
        type: 'message_start',
        message: {
          usage: {
            input_tokens: 1500,
            output_tokens: 0,
            cache_read_input_tokens: 800,
            cache_creation_input_tokens: 200,
          },
        },
      });
      const parsed = provider.parseStreamData(sse);
      expect(parsed.usage).toBeDefined();
      expect(parsed.usage!.promptTokens).toBe(1500);
      expect(parsed.usage!.completionTokens).toBe(0);
      expect(parsed.usage!.cacheHitTokens).toBe(800);
      expect(parsed.usage!.cacheMissTokens).toBe(200);
    });

    it('解析 message_delta 中的 output_tokens', () => {
      const sse = JSON.stringify({
        type: 'message_delta',
        usage: { output_tokens: 450 },
      });
      const parsed = provider.parseStreamData(sse);
      expect(parsed.usage).toBeDefined();
      expect(parsed.usage!.completionTokens).toBe(450);
      expect(parsed.usage!.promptTokens).toBe(0);
    });

    it('message_start 无 cache 字段时不报错', () => {
      const sse = JSON.stringify({
        type: 'message_start',
        message: {
          usage: { input_tokens: 100, output_tokens: 0 },
        },
      });
      const parsed = provider.parseStreamData(sse);
      expect(parsed.usage!.promptTokens).toBe(100);
      expect(parsed.usage!.cacheHitTokens).toBeUndefined();
      expect(parsed.usage!.cacheMissTokens).toBeUndefined();
    });

    it('content_block_delta 不返回 usage', () => {
      const sse = JSON.stringify({
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'hello' },
      });
      const parsed = provider.parseStreamData(sse);
      expect(parsed.usage).toBeUndefined();
      expect(parsed.textDelta).toBe('hello');
    });
  });

  describe('ResponsesProvider', () => {
    const provider = new ResponsesProvider();

    it('解析 response.completed 中的 usage', () => {
      const sse = JSON.stringify({
        type: 'response.completed',
        response: {
          usage: {
            input_tokens: 2000,
            output_tokens: 500,
            total_tokens: 2500,
            input_tokens_details: { cached_tokens: 1500 },
          },
        },
      });
      const parsed = provider.parseStreamData(sse);
      expect(parsed.usage).toBeDefined();
      expect(parsed.usage!.promptTokens).toBe(2000);
      expect(parsed.usage!.completionTokens).toBe(500);
      expect(parsed.usage!.totalTokens).toBe(2500);
      expect(parsed.usage!.cacheHitTokens).toBe(1500);
    });

    it('response.completed 无 usage 时仍返回 done', () => {
      const sse = JSON.stringify({
        type: 'response.completed',
        response: {},
      });
      const parsed = provider.parseStreamData(sse);
      expect(parsed.done).toBe(true);
      expect(parsed.usage).toBeUndefined();
    });

    it('response.output_text.delta 不返回 usage', () => {
      const sse = JSON.stringify({
        type: 'response.output_text.delta',
        delta: 'hello',
      });
      const parsed = provider.parseStreamData(sse);
      expect(parsed.usage).toBeUndefined();
      expect(parsed.textDelta).toBe('hello');
    });
  });

  describe('mergeUsage 逻辑（模拟 Anthropic 流式合并）', () => {
    it('message_start + message_delta 合并后包含完整数据', () => {
      const provider = new AnthropicProvider();

      // 模拟 message_start
      const startParsed = provider.parseStreamData(JSON.stringify({
        type: 'message_start',
        message: {
          usage: {
            input_tokens: 1500,
            output_tokens: 0,
            cache_read_input_tokens: 800,
            cache_creation_input_tokens: 200,
          },
        },
      }));

      // 模拟 message_delta
      const deltaParsed = provider.parseStreamData(JSON.stringify({
        type: 'message_delta',
        usage: { output_tokens: 450 },
      }));

      // 模拟 mergeUsage 逻辑
      const merged = {
        promptTokens: deltaParsed.usage!.promptTokens || startParsed.usage!.promptTokens,
        completionTokens: deltaParsed.usage!.completionTokens || startParsed.usage!.completionTokens,
        totalTokens: deltaParsed.usage!.totalTokens || startParsed.usage!.totalTokens,
        cacheHitTokens: deltaParsed.usage!.cacheHitTokens ?? startParsed.usage!.cacheHitTokens,
        cacheMissTokens: deltaParsed.usage!.cacheMissTokens ?? startParsed.usage!.cacheMissTokens,
      };

      expect(merged.promptTokens).toBe(1500);
      expect(merged.completionTokens).toBe(450);
      expect(merged.cacheHitTokens).toBe(800);
      expect(merged.cacheMissTokens).toBe(200);
    });
  });
});
