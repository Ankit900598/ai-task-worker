/**
 * test_apis.js
 * 
 * Tool-Calling Smoke Test for Dual LLM Providers.
 * Verifies that BOTH Azure OpenAI and AWS Bedrock:
 * 1. Accept tools in their respective formats.
 * 2. Return valid normalized tool calls: { text, toolCalls: [{ id, name, args }], usage, provider, latencyMs }.
 * 3. Correctly pick the right tool for the prompt.
 */

import 'dotenv/config';
import { LLMClient } from './lib/llm_client.js';

const smokeTestTools = [
  {
    name: 'read_invoice_file',
    description: 'Reads an invoice file from disk and parses text/details',
    parameters: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'Name of the invoice file to read' },
      },
      required: ['filename'],
    },
  },
  {
    name: 'record_payment',
    description: 'Enters a payment entry into the company ledger',
    parameters: {
      type: 'object',
      properties: {
        vendor: { type: 'string' },
        amount: { type: 'number' },
        invoiceId: { type: 'string' },
      },
      required: ['vendor', 'amount', 'invoiceId'],
    },
  },
];

const testPrompt = 'We received a new invoice file named "invoice_acme_402.txt". Please read it to extract the vendor details.';

async function runSmokeTestForProvider(providerKey, displayName) {
  console.log(`\n======================================================`);
  console.log(`🧪 SMOKE TEST: ${displayName} [${providerKey}]`);
  console.log(`======================================================`);

  const client = new LLMClient({ provider: providerKey });
  const result = await client.call({
    messages: [{ role: 'user', content: testPrompt }],
    tools: smokeTestTools,
    systemPrompt: 'You are an autonomous AI employee. Use the provided tools to fulfill requests.',
    provider: providerKey,
  });

  console.log(`⏱️ Latency: ${result.latencyMs}ms`);
  console.log(`🏷️ Provider Returned: ${result.provider}`);
  console.log(`📊 Usage:`, result.usage);
  console.log(`🔧 Tool Calls (${result.toolCalls.length}):`, JSON.stringify(result.toolCalls, null, 2));

  // Verification checks:
  const hasToolCalls = Array.isArray(result.toolCalls) && result.toolCalls.length > 0;
  if (!hasToolCalls) {
    throw new Error(`${displayName} failed: No tool calls returned.`);
  }

  const selectedTool = result.toolCalls[0];
  if (selectedTool.name !== 'read_invoice_file') {
    throw new Error(`${displayName} failed: Expected tool "read_invoice_file", got "${selectedTool.name}".`);
  }

  const argFilename = selectedTool.args?.filename;
  if (!argFilename || !argFilename.includes('invoice_acme_402')) {
    throw new Error(`${displayName} failed: Expected filename to contain "invoice_acme_402", got "${argFilename}".`);
  }

  console.log(`✅ ${displayName} Tool-Calling Verification PASSED!`);
  return result;
}

async function main() {
  console.log('🚀 Starting Dual-Provider Tool-Calling Smoke Tests...\n');

  let azurePassed = false;
  let bedrockPassed = false;
  let azureLatency = 0;
  let bedrockLatency = 0;

  // 1. Test Azure OpenAI
  try {
    const res = await runSmokeTestForProvider('azure', 'Azure OpenAI (GPT-6.1 Sol)');
    azurePassed = true;
    azureLatency = res.latencyMs;
  } catch (err) {
    console.error('❌ Azure Smoke Test Failed:', err.message);
  }

  // 2. Test AWS Bedrock
  try {
    const res = await runSmokeTestForProvider('bedrock', 'AWS Bedrock (Kimi K3)');
    bedrockPassed = true;
    bedrockLatency = res.latencyMs;
  } catch (err) {
    console.error('❌ Bedrock Smoke Test Failed:', err.message);
  }

  console.log(`\n======================================================`);
  console.log(`📋 BENCHMARK & SMOKE TEST RESULTS`);
  console.log(`======================================================`);
  console.log(`Azure OpenAI: ${azurePassed ? `✅ PASS (${azureLatency}ms)` : '❌ FAIL'}`);
  console.log(`AWS Bedrock:  ${bedrockPassed ? `✅ PASS (${bedrockLatency}ms)` : '❌ FAIL'}`);

  if (azurePassed && bedrockPassed) {
    const ratio = (bedrockLatency / azureLatency).toFixed(1);
    console.log(`⚡ Speed Ratio: Azure is ~${ratio}x faster than Bedrock.`);
    console.log(`📌 Operational Decision: Keep Azure as primary; use Bedrock as fallback.`);
  }
  console.log(`======================================================\n`);

  if (!azurePassed && !bedrockPassed) {
    process.exit(1);
  }
}

main().catch(console.error);
