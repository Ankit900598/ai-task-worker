/**
 * scripts/generate_pdf_invoices.js
 * 
 * Generates test PDF invoices using Playwright's page.pdf() (zero external PDF libraries).
 */

import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';

async function generate() {
  const invoicesDir = path.join(process.cwd(), 'invoices');
  if (!fs.existsSync(invoicesDir)) fs.mkdirSync(invoicesDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // Invoice 1: Standard PDF
  const html1 = `
    <html>
      <body style="font-family: sans-serif; padding: 40px;">
        <h1>TAX INVOICE</h1>
        <p><strong>Invoice Number:</strong> INV-2026-PDF1</p>
        <p><strong>Vendor:</strong> Acme Supplies Ltd</p>
        <p><strong>Issue Date:</strong> 2026-11-14</p>
        <hr/>
        <table style="width: 100%; border-collapse: collapse; margin-top: 20px;">
          <tr style="border-bottom: 1px solid #ccc; text-align: left;">
            <th style="padding: 8px;">Description</th>
            <th style="padding: 8px;">Qty</th>
            <th style="padding: 8px;">Amount</th>
          </tr>
          <tr style="border-bottom: 1px solid #eee;">
            <td style="padding: 8px;">Server Rack Accessories</td>
            <td style="padding: 8px;">2</td>
            <td style="padding: 8px;">₹18,000</td>
          </tr>
        </table>
        <h2 style="text-align: right; margin-top: 30px;">Total Amount: ₹18,000</h2>
      </body>
    </html>
  `;
  await page.setContent(html1);
  await page.pdf({ path: path.join(invoicesDir, 'invoice_pdf_1.pdf'), format: 'A4' });
  console.log('✅ Generated invoices/invoice_pdf_1.pdf');

  // Invoice 2: High Value PDF (> ₹50,000)
  const html2 = `
    <html>
      <body style="font-family: sans-serif; padding: 40px;">
        <h1>COMMERCIAL INVOICE</h1>
        <p><strong>Invoice Number:</strong> INV-2026-PDF2</p>
        <p><strong>Vendor:</strong> Global Logistics Corp</p>
        <p><strong>Issue Date:</strong> 2026-11-16</p>
        <hr/>
        <table style="width: 100%; border-collapse: collapse; margin-top: 20px;">
          <tr style="border-bottom: 1px solid #ccc; text-align: left;">
            <th style="padding: 8px;">Service</th>
            <th style="padding: 8px;">Amount</th>
          </tr>
          <tr style="border-bottom: 1px solid #eee;">
            <td style="padding: 8px;">Cross-Border Heavy Freight Transport</td>
            <td style="padding: 8px;">₹65,000</td>
          </tr>
        </table>
        <h2 style="text-align: right; margin-top: 30px;">Total Amount: ₹65,000</h2>
        <p style="color: #666; font-size: 12px;">Notice: Requires executive sign-off for disbursement.</p>
      </body>
    </html>
  `;
  await page.setContent(html2);
  await page.pdf({ path: path.join(invoicesDir, 'invoice_pdf_2.pdf'), format: 'A4' });
  console.log('✅ Generated invoices/invoice_pdf_2.pdf');

  await browser.close();
}

generate().catch(console.error);
