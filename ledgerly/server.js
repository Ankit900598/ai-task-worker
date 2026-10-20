/**
 * ledgerly/server.js
 *
 * Mock Enterprise Accounting Application ("Ledgerly").
 * Implemented with zero external dependencies using node:http.
 * Target budget: <= 250 lines.
 */

import http from 'http';
import url from 'url';

export class LedgerlyApp {
  constructor(port = 3000) {
    this.port = port;
    this.server = null;
    this.reset();
  }

  reset() {
    this.state = {
      invoices: [
        { id: 'INV-1001', vendor: 'Acme Supplies Ltd', amount: 12500, date: '2026-10-01', dueDate: '2026-10-15', status: 'Approved', notes: 'Initial seed' },
        { id: 'INV-1002', vendor: 'Global Logistics Corp', amount: 48000, date: '2026-10-05', dueDate: '2026-10-20', status: 'Approved', notes: 'Freight services' },
      ],
      vendors: ['Acme Supplies Ltd', 'Global Logistics Corp', 'Apex Solutions India', 'Apex Solutions Global'],
      config: {
        slowResponseMs: 0,
        flaky500: false,
        maintenanceMode: false,
        alteredFieldNames: false,
        savedThen500: false,
      },
    };
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));
      this.server.listen(this.port, () => {
        console.log(`🏦 Ledgerly mock accounting app running on http://localhost:${this.port}`);
        resolve(this);
      });
      this.server.on('error', reject);
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => {
        console.log(`🛑 Ledgerly app stopped.`);
        resolve();
      });
    });
  }

  async handleRequest(req, res) {
    const { pathname } = url.parse(req.url, true);

    if (this.state.config.slowResponseMs > 0) {
      await new Promise(r => setTimeout(r, this.state.config.slowResponseMs));
    }

    if (this.state.config.flaky500 && !pathname.startsWith('/__admin')) {
      this.state.config.flaky500 = false;
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      return res.end('Internal Server Error (Chaos Injected)');
    }

    if (this.state.config.maintenanceMode && !pathname.startsWith('/__admin')) {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      return res.end('Service Unavailable: Ledgerly undergoing maintenance');
    }

    if (pathname === '/__admin/state' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(this.state, null, 2));
    }

    if (pathname === '/__admin/config' && req.method === 'POST') {
      const body = await this.readBody(req);
      try {
        this.state.config = { ...this.state.config, ...JSON.parse(body) };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, config: this.state.config }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    if (pathname === '/__admin/reset' && req.method === 'POST') {
      this.reset();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, message: 'State reset to initial seed' }));
    }

    if (pathname === '/' && req.method === 'GET') return this.renderDashboard(res);
    if (pathname === '/invoices' && req.method === 'POST') {
      const body = await this.readBody(req);
      return this.processInvoiceSubmission(body, res);
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }

  readBody(req) {
    return new Promise((resolve) => {
      let data = '';
      req.on('data', chunk => { data += chunk; });
      req.on('end', () => resolve(data));
    });
  }

  processInvoiceSubmission(rawBody, res) {
    let payload = {};
    if (rawBody.startsWith('{')) {
      try { payload = JSON.parse(rawBody); } catch {}
    } else {
      payload = Object.fromEntries(new URLSearchParams(rawBody));
    }

    const altered = this.state.config.alteredFieldNames;
    const invoiceId = (payload[altered ? 'invoice_code' : 'invoiceId'] || '').trim();
    const vendor = (payload[altered ? 'supplier' : 'vendor'] || '').trim();
    const rawAmount = payload[altered ? 'total_sum' : 'amount'];
    const date = (payload[altered ? 'issue_date' : 'date'] || '').trim();
    const dueDate = (payload[altered ? 'due_on' : 'dueDate'] || '').trim();
    const notes = (payload.notes || '').trim();

    const amount = typeof rawAmount === 'number'
      ? rawAmount
      : parseFloat(String(rawAmount || '').replace(/[^0-9.]/g, ''));

    if (!invoiceId || !vendor || isNaN(amount) || !date) {
      return this.renderDashboard(res, { error: 'Validation Error: All fields (Invoice ID, Vendor, Amount, Date) are required.' }, 400);
    }

    if (this.state.invoices.some(inv => inv.id.toLowerCase() === invoiceId.toLowerCase())) {
      return this.renderDashboard(res, { error: `Duplicate Error: Invoice ID "${invoiceId}" has already been processed.` }, 409);
    }

    const status = amount > 50000 ? 'Pending Approval' : 'Approved';
    this.state.invoices.unshift({
      id: invoiceId,
      vendor,
      amount,
      date,
      dueDate: dueDate || null,
      status,
      notes: notes || (status === 'Pending Approval' ? 'Requires executive sign-off (> ₹50,000)' : 'Auto-approved'),
      createdAt: new Date().toISOString(),
    });

    if (this.state.config.savedThen500) {
      this.state.config.savedThen500 = false;
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      return res.end('Internal Server Error: Invoice Saved But Network/Server Crashed');
    }

    return this.renderDashboard(res, { success: `Invoice ${invoiceId} processed successfully with status: ${status}` }, 201);
  }

  renderDashboard(res, alert = null, statusCode = 200) {
    const altered = this.state.config.alteredFieldNames;
    const idField = altered ? 'invoice_code' : 'invoiceId';
    const vendorField = altered ? 'supplier' : 'vendor';
    const amountField = altered ? 'total_sum' : 'amount';
    const dateField = altered ? 'issue_date' : 'date';
    const dueField = altered ? 'due_on' : 'dueDate';

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Ledgerly — Accounting Portal</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #f8fafc; color: #0f172a; margin: 0; padding: 24px; }
    .container { max-width: 900px; margin: 0 auto; background: #fff; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); padding: 24px; }
    .badge { background: #e2e8f0; font-size: 12px; padding: 4px 8px; border-radius: 4px; }
    .alert { padding: 12px 16px; border-radius: 6px; margin-bottom: 20px; font-weight: 500; }
    .alert-success { background: #dcfce7; color: #15803d; border: 1px solid #bbf7d0; }
    .alert-error { background: #fee2e2; color: #b91c1c; border: 1px solid #fecaca; }
    form { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; margin-bottom: 32px; background: #f1f5f9; padding: 20px; border-radius: 6px; }
    .form-group { display: flex; flex-direction: column; gap: 6px; }
    .form-group.full, button { grid-column: span 2; }
    label { font-size: 13px; font-weight: 600; color: #475569; }
    input { padding: 10px; border: 1px solid #cbd5e1; border-radius: 4px; font-size: 14px; }
    button { background: #2563eb; color: #fff; border: none; padding: 12px 20px; font-weight: 600; border-radius: 4px; cursor: pointer; }
    table { width: 100%; border-collapse: collapse; margin-top: 16px; font-size: 14px; }
    th, td { text-align: left; padding: 12px; border-bottom: 1px solid #e2e8f0; }
    .status-Approved { color: #16a34a; font-weight: 600; }
    .status-Pending { color: #d97706; font-weight: 600; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Ledgerly <span class="badge">Enterprise Accounts Payable</span></h1>
    ${alert?.success ? `<div class="alert alert-success" id="alert-success">${alert.success}</div>` : ''}
    ${alert?.error ? `<div class="alert alert-error" id="alert-error">${alert.error}</div>` : ''}
    <form method="POST" action="/invoices" id="invoice-form">
      <div class="form-group"><label for="${idField}">Invoice ID / Number</label><input type="text" id="${idField}" name="${idField}" required /></div>
      <div class="form-group"><label for="${vendorField}">Vendor / Supplier</label><input type="text" id="${vendorField}" name="${vendorField}" list="vendors-list" required /><datalist id="vendors-list">${this.state.vendors.map(v => `<option value="${v}">`).join('')}</datalist></div>
      <div class="form-group"><label for="${amountField}">Total Amount (₹)</label><input type="text" id="${amountField}" name="${amountField}" required /></div>
      <div class="form-group"><label for="${dateField}">Invoice Date</label><input type="date" id="${dateField}" name="${dateField}" required /></div>
      <div class="form-group"><label for="${dueField}">Due Date (Optional)</label><input type="date" id="${dueField}" name="${dueField}" /></div>
      <div class="form-group"><label for="notes">Notes / Memo (Optional)</label><input type="text" id="notes" name="notes" /></div>
      <button type="submit" id="submit-invoice-btn">Submit Invoice to Ledgerly</button>
    </form>
    <h2>Processed Invoices (<span id="invoice-count">${this.state.invoices.length}</span>)</h2>
    <table id="invoices-table">
      <thead><tr><th>Invoice ID</th><th>Vendor</th><th>Amount</th><th>Invoice Date</th><th>Due Date</th><th>Status</th><th>Notes</th></tr></thead>
      <tbody>
        ${this.state.invoices.map(inv => `<tr data-invoice-id="${inv.id}"><td><strong>${inv.id}</strong></td><td>${inv.vendor}</td><td>₹${Number(inv.amount).toLocaleString('en-IN')}</td><td>${inv.date}</td><td>${inv.dueDate || '-'}</td><td class="status-${inv.status.split(' ')[0]}">${inv.status}</td><td>${inv.notes || '-'}</td></tr>`).join('')}
      </tbody>
    </table>
  </div>
</body>
</html>`;

    res.writeHead(statusCode, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  new LedgerlyApp(parseInt(process.env.PORT || '3000', 10)).start().catch(console.error);
}
