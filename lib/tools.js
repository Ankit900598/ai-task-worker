/**
 * lib/tools.js
 *
 * Tool Registry with Risk Tiers and Standardized Execution.
 * Risk Tiers: 'read' | 'write' | 'destructive'
 * Target budget: <= 200 lines.
 */

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { VerificationGuard } from './guard.js';

const require = createRequire(import.meta.url);
const { PDFParse } = require('pdf-parse');

export class ToolRegistry {
  constructor(context = {}) {
    this.page = context.page || null;
    this.state = context.state || null;
    this.tracer = context.tracer || null;
    this.tools = new Map();
    this.registerDefaultTools();
  }

  setContext({ page, state, tracer }) {
    if (page) this.page = page;
    if (state) this.state = state;
    if (tracer) this.tracer = tracer;
  }

  register(tool) { this.tools.set(tool.name, tool); }
  get(name) { return this.tools.get(name); }

  getAllDefinitions() {
    return Array.from(this.tools.values()).map(({ name, description, riskTier, parameters }) => ({
      name, description, riskTier, parameters,
    }));
  }

  registerDefaultTools() {
    this.register({
      name: 'file_list',
      description: 'List all available invoice files in the invoices/ directory',
      riskTier: 'read',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        const dir = path.join(process.cwd(), 'invoices');
        const files = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
        return VerificationGuard.wrapUntrusted('invoices_dir', `Files in invoices/: ${files.join(', ')}`);
      },
    });

    this.register({
      name: 'file_read',
      description: 'Read an invoice file (.txt or .pdf) and return content wrapped in untrusted markers',
      riskTier: 'read',
      parameters: {
        type: 'object',
        properties: { filename: { type: 'string', description: 'Filename or path in invoices/' } },
        required: ['filename'],
      },
      execute: async ({ filename }) => {
        let filePath = filename;
        if (!fs.existsSync(filePath)) {
          const inInvoices = path.join(process.cwd(), 'invoices', path.basename(filename));
          if (fs.existsSync(inInvoices)) filePath = inInvoices;
        }
        if (!fs.existsSync(filePath)) {
          throw new Error(`File not found: "${filename}". Checked local path and ./invoices/`);
        }
        let rawText = '';
        if (filePath.toLowerCase().endsWith('.pdf')) {
          const parser = new PDFParse(new Uint8Array(fs.readFileSync(filePath)));
          rawText = (await parser.getText()).text || '';
        } else {
          rawText = fs.readFileSync(filePath, 'utf8');
        }
        return VerificationGuard.wrapUntrusted(filename, rawText);
      },
    });

    this.register({
      name: 'browser_navigate',
      description: 'Navigate browser to a URL',
      riskTier: 'read',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'Full URL to visit' } },
        required: ['url'],
      },
      execute: async ({ url: targetUrl }) => {
        if (!this.page) throw new Error('Browser page not available in tool context.');
        await this.page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        return `Navigated to ${targetUrl}`;
      },
    });

    this.register({
      name: 'browser_observe',
      description: 'Scan page, return numbered interactive elements, save screenshot to runs/',
      riskTier: 'read',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        if (!this.page) throw new Error('Browser page not available in tool context.');
        const observation = await this.page.evaluate(() => {
          document.querySelectorAll('[data-ai-id]').forEach(el => el.removeAttribute('data-ai-id'));
          const candidates = Array.from(document.querySelectorAll('a, button, input, select, textarea, [role="button"]'));
          const lines = [], elementList = [];
          let id = 1;
          for (const el of candidates) {
            const rect = el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0 || window.getComputedStyle(el).display === 'none') continue;
            el.setAttribute('data-ai-id', String(id));
            const tag = el.tagName.toLowerCase();
            const type = el.getAttribute('type') || '';
            const name = el.getAttribute('name') || el.id || '';
            const assocLabel = el.id ? document.querySelector(`label[for="${el.id}"]`)?.innerText : null;
            const label = (assocLabel || el.innerText || el.getAttribute('placeholder') || el.getAttribute('aria-label') || name || '').trim().replace(/\s+/g, ' ');
            const val = 'value' in el && el.value ? ` value="${el.value}"` : '';
            lines.push(`[${id}] <${tag}${type ? ` type="${type}"` : ''} name="${name}"> "${label}"${val}`);
            elementList.push({ id, tag, type, name, label });
            if (++id > 40) break;
          }
          const alert = document.querySelector('.alert')?.innerText.trim() || '';
          const table = Array.from(document.querySelectorAll('table tr'))
            .map(r => Array.from(r.querySelectorAll('th, td')).map(c => c.innerText.trim()).join(' | '))
            .slice(0, 15).join('\n');
          return { title: document.title || 'Untitled', elements: lines.join('\n'), elementList, alert, table };
        });

        if (this.tracer) {
          const ssPath = path.join(this.tracer.runsDir, `${this.tracer.runId}_step_${Date.now()}.png`);
          await this.page.screenshot({ path: ssPath }).catch(() => {});
        }
        let formatted = `PAGE: "${observation.title}"\nURL: ${this.page.url()}\n`;
        if (observation.alert) formatted += `ACTIVE ALERT: "${observation.alert}"\n`;
        formatted += `INTERACTIVE ELEMENTS:\n${observation.elements}\n`;
        if (observation.table) formatted += `TABLE CONTENT:\n${observation.table}\n`;
        if (this.state) this.state.recordObservation(formatted, observation.elementList);
        return VerificationGuard.wrapUntrusted('browser_page', formatted);
      },
    });

    this.register({
      name: 'browser_type',
      description: 'Fill an input element [N] with text',
      riskTier: 'write',
      parameters: {
        type: 'object',
        properties: { elementId: { type: 'number' }, text: { type: 'string' } },
        required: ['elementId', 'text'],
      },
      execute: async ({ elementId, text }) => {
        if (!this.page) throw new Error('Browser page not available in tool context.');
        await this.page.fill(`[data-ai-id="${elementId}"]`, String(text), { timeout: 8000 });
        if (this.state) {
          const meta = this.state.elementMap?.[elementId];
          this.state.recordFormField(`${meta?.name || ''} ${meta?.label || ''}`, text);
          this.state.recordWrite('browser_type', { elementId, text });
        }
        return `Typed "${text}" into [${elementId}]`;
      },
    });

    this.register({
      name: 'browser_click',
      description: 'Click a numbered element [N] on screen',
      riskTier: 'write',
      parameters: {
        type: 'object',
        properties: { elementId: { type: 'number' }, reason: { type: 'string' } },
        required: ['elementId'],
      },
      execute: async ({ elementId }) => {
        if (!this.page) throw new Error('Browser page not available in tool context.');
        await this.page.click(`[data-ai-id="${elementId}"]`, { timeout: 8000 });
        await Promise.race([this.page.waitForLoadState('domcontentloaded'), new Promise(r => setTimeout(r, 1000))]).catch(() => {});
        if (this.state) this.state.recordWrite('browser_click', { elementId });
        return `Clicked element [${elementId}]`;
      },
    });

    this.register({
      name: 'finish',
      description: 'Complete the task. Requires verifiable evidence; rejected if writes are unverified.',
      riskTier: 'read',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['completed', 'rejected_duplicate', 'needs_human', 'failed'] },
          evidence: { type: 'string' },
          summary: { type: 'string' },
        },
        required: ['status', 'evidence', 'summary'],
      },
      execute: async (args) => {
        if (this.state) {
          VerificationGuard.verifyFinish({ state: this.state, args });
          this.state.isDone = true;
          this.state.finishStatus = args.status || 'completed';
          this.state.finalEvidence = args.evidence;
        }
        return `Task finished (${args.status || 'completed'}). Evidence: ${args.evidence}`;
      },
    });
  }
}
