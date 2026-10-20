/**
 * lib/llm_client.js
 * 
 * Unified Multi-Provider LLM Client for Autonomous Agents.
 * Supports Azure OpenAI (Primary) and AWS Bedrock (Fallback),
 * normalizing responses into a single internal tool-calling format:
 *   { text, toolCalls: [{ id, name, args }], usage: { inputTokens, outputTokens, totalTokens }, provider, latencyMs }
 */

import 'dotenv/config';
import OpenAI from 'openai';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';

/**
 * Robust JSON extraction helper
 */
function extractAndParseJson(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;
  let text = rawText.trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch { return null; }
    }
    return null;
  }
}

export class LLMClient {
  /**
   * @param {object} [config]
   * @param {'azure'|'bedrock'} [config.provider='azure']
   */
  constructor(config = {}) {
    this.provider = config.provider || process.env.ACTIVE_PROVIDER || 'azure';

    // 1. Azure OpenAI (Primary)
    const azureEndpoint = process.env.AZURE_OPENAI_ENDPOINT || 'https://oai-strlix-in.openai.azure.com/openai/v1';
    const azureKey = process.env.AZURE_OPENAI_API_KEY;
    this.azureModel = process.env.AZURE_OPENAI_MODEL || 'gpt-6.1-sol';

    if (azureKey) {
      this.azureClient = new OpenAI({
        baseURL: azureEndpoint,
        apiKey: azureKey,
        defaultHeaders: { 'api-key': azureKey },
      });
    }

    // 2. AWS Bedrock (Fallback)
    const awsAccessKey = process.env.AWS_ACCESS_KEY_ID;
    const awsSecretKey = process.env.AWS_SECRET_ACCESS_KEY;
    const awsRegion = process.env.AWS_REGION || 'us-west-2';
    this.bedrockModelId = process.env.BEDROCK_MODEL_ID || 'global.moonshotai.kimi-k3';

    if (awsAccessKey && awsSecretKey) {
      this.bedrockClient = new BedrockRuntimeClient({
        region: awsRegion,
        credentials: {
          accessKeyId: awsAccessKey,
          secretAccessKey: awsSecretKey,
        },
      });
    }
  }

  /**
   * Unified Tool-Calling Interface.
   * Both providers return: { text, toolCalls: [{ id, name, args }], usage, provider, latencyMs }
   * 
   * @param {object} params
   * @param {Array<{role: string, content: string}>} params.messages
   * @param {Array<{name: string, description: string, parameters: object}>} [params.tools=[]]
   * @param {string} [params.systemPrompt]
   * @param {'azure'|'bedrock'} [params.provider]
   */
  async call({ messages, tools = [], systemPrompt = '', provider = this.provider }) {
    const preferredProvider = provider === 'bedrock' ? 'bedrock' : 'azure';

    let failoverError = null;
    try {
      if (preferredProvider === 'azure' && this.azureClient) {
        return await this._callAzure({ messages, tools, systemPrompt });
      }
      if (preferredProvider === 'bedrock' && this.bedrockClient) {
        return await this._callBedrock({ messages, tools, systemPrompt });
      }
    } catch (err) {
      failoverError = err.message;
      console.warn(`[LLM Client] ${preferredProvider.toUpperCase()} failed: ${err.message}. Attempting fallback...`);
    }

    // Fallback logic
    if (preferredProvider === 'azure' && this.bedrockClient) {
      const res = await this._callBedrock({ messages, tools, systemPrompt });
      return { ...res, failoverFrom: 'azure', failoverReason: failoverError };
    }
    if (preferredProvider === 'bedrock' && this.azureClient) {
      const res = await this._callAzure({ messages, tools, systemPrompt });
      return { ...res, failoverFrom: 'bedrock', failoverReason: failoverError };
    }

    // Mock fallback if neither client is configured or reachable
    console.warn('[LLM Client] No live provider available. Falling back to local mock.');
    return this._mockResponse({ messages, tools });
  }

  /**
   * Azure OpenAI execution with JSON-schema tool envelope.
   * Reason: gpt-6.1-sol in /v1/chat/completions enforces reasoning and disallows native function tools,
   * but reliably emits structured JSON tool calls when response_format: { type: 'json_object' } is set.
   */
  async _callAzure({ messages, tools, systemPrompt }) {
    const startTime = Date.now();

    const formattedSystem = `
${systemPrompt || 'You are an autonomous AI employee.'}

${tools.length > 0 ? `Available Tools:
${JSON.stringify(tools, null, 2)}

Respond with a JSON object in this exact schema:
{
  "thought": "brief reasoning or observations",
  "text": "optional message to user or null",
  "toolCalls": [
    {
      "name": "tool_name",
      "args": { ...exact parameters... }
    }
  ]
}` : 'Respond with a JSON object: { "text": "your response", "thought": "your thought" }'}`;

    const apiMessages = [
      { role: 'system', content: formattedSystem },
      ...messages.map(m => ({ role: m.role, content: m.content })),
    ];

    const response = await this.azureClient.chat.completions.create({
      model: this.azureModel,
      messages: apiMessages,
      response_format: { type: 'json_object' },
    });

    const latencyMs = Date.now() - startTime;
    const rawContent = response.choices[0]?.message?.content || '{}';
    const parsed = extractAndParseJson(rawContent) || {};

    const rawCalls = Array.isArray(parsed.toolCalls) ? parsed.toolCalls : [];
    const toolCalls = rawCalls.map((c, idx) => ({
      id: c.id || `call_${Date.now()}_${idx}`,
      name: c.name,
      args: c.args || {},
    }));

    return {
      text: parsed.text || parsed.thought || (toolCalls.length === 0 ? rawContent : null),
      toolCalls,
      usage: {
        inputTokens: response.usage?.prompt_tokens || 0,
        outputTokens: response.usage?.completion_tokens || 0,
        totalTokens: response.usage?.total_tokens || 0,
      },
      provider: 'azure',
      latencyMs,
    };
  }

  /**
   * AWS Bedrock ConverseCommand execution with native toolConfig.
   */
  async _callBedrock({ messages, tools, systemPrompt }) {
    const startTime = Date.now();

    // Bedrock Converse toolSpec format
    const bedrockTools = tools.map(t => ({
      toolSpec: {
        name: t.name,
        description: t.description,
        inputSchema: {
          json: t.parameters || { type: 'object', properties: {} },
        },
      },
    }));

    const bedrockMessages = messages.map(m => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: [{ text: m.content }],
    }));

    const commandPayload = {
      modelId: this.bedrockModelId,
      messages: bedrockMessages,
      ...(systemPrompt ? { system: [{ text: systemPrompt }] } : {}),
      ...(bedrockTools.length > 0 ? { toolConfig: { tools: bedrockTools } } : {}),
    };

    const response = await this.bedrockClient.send(new ConverseCommand(commandPayload));
    const latencyMs = Date.now() - startTime;

    const contentBlocks = response.output?.message?.content || [];
    let text = null;
    const toolCalls = [];

    for (const block of contentBlocks) {
      if (block.text) {
        text = (text ? text + '\n' : '') + block.text;
      }
      if (block.toolUse) {
        toolCalls.push({
          id: block.toolUse.toolUseId || `bedrock_${Date.now()}`,
          name: block.toolUse.name,
          args: block.toolUse.input || {},
        });
      }
    }

    return {
      text,
      toolCalls,
      usage: {
        inputTokens: response.usage?.inputTokens || 0,
        outputTokens: response.usage?.outputTokens || 0,
        totalTokens: response.usage?.totalTokens || 0,
      },
      provider: 'bedrock',
      latencyMs,
    };
  }

  /**
   * Deterministic mock engine for offline testing
   */
  _mockResponse({ messages, tools }) {
    const userMessage = messages[messages.length - 1]?.content || '';
    if (tools.length > 0) {
      const tool = tools[0];
      return {
        text: `Mock call to tool ${tool.name}`,
        toolCalls: [{ id: `mock_${Date.now()}`, name: tool.name, args: { test: true } }],
        usage: { inputTokens: 50, outputTokens: 25, totalTokens: 75 },
        provider: 'mock',
        latencyMs: 5,
      };
    }
    return {
      text: `Mock response to: ${userMessage.slice(0, 50)}`,
      toolCalls: [],
      usage: { inputTokens: 50, outputTokens: 25, totalTokens: 75 },
      provider: 'mock',
      latencyMs: 5,
    };
  }
}
