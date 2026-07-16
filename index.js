// status-lookup.js
// Drop-in route for your existing Express app on Render.
// Reads the three form-response sheets DIRECTLY (via a Google service
// account), caches them in memory for 5 minutes, and answers student
// status lookups by email or phone. No database, no sync scripts.
//
// Wire into your app:
//   const statusLookup = require('./status-lookup');
//   app.use('/api/status', statusLookup);
//
// Env vars to add in Render:
//   SHEET_CERT       - spreadsheet ID of the Certificate responses sheet
//   SHEET_PRO        - spreadsheet ID of the Advanced Pro responses sheet
//   SHEET_FLEXI      - spreadsheet ID of the Advanced Flexi responses sheet
//
// Auth reuses your existing GOOGLE_SERVICE_ACCOUNT_JSON env var (the same
// service account your email campaign system reads sheets with). Just share
// the three response sheets with that service account's email - it's the
// "client_email" field inside the GOOGLE_SERVICE_ACCOUNT_JSON value.
//
// (The spreadsheet ID is the long string in the sheet's URL between /d/ and /edit.)
// New cohort with new sheets? Share them with the service account email
// (Viewer is enough) and update these three env vars. That's the whole setup.
//
// npm install googleapis   (if not already installed)

const express = require('express');
const { google } = require('googleapis');

const router = express.Router();

// ---------------- CONFIG ----------------

const CACHE_MS = 5 * 60 * 1000; // re-read each sheet at most every 5 minutes

// Header fragments used to find columns (case-insensitive "contains").
// Must match how your form questions / added columns are titled.
const H = {
  email: 'email',
  phone: 'phone',
  certName: 'name on',            // e.g. "Name on your Certificate"
  paid: 'payment confirmed',
  platform: 'platform',
  inst1: 'installment 1',
  inst2: 'installment 2',
  cohort: 'cohort',
};

function sheetConfigs() {
  return [
    { id: process.env.SHEET_CERT,  product: 'certificate',    plan: null,    label: 'Certificate' },
    { id: process.env.SHEET_PRO,   product: 'advanced_class', plan: 'pro',   label: 'Advanced Class (Pro)' },
    { id: process.env.SHEET_FLEXI, product: 'advanced_class', plan: 'flexi', label: 'Advanced Class (Flexi)' },
  ].filter(s => s.id);
}

// ---------------- Google Sheets client ----------------

let sheetsClient = null;
function getSheets() {
  if (sheetsClient) return sheetsClient;
  let auth;
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    // Reuses the same service account your email campaign system already uses
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
  } else {
    auth = new google.auth.JWT(
      process.env.GOOGLE_SA_EMAIL,
      null,
      (process.env.GOOGLE_SA_KEY || '').replace(/\\n/g, '\n'),
      ['https://www.googleapis.com/auth/spreadsheets.readonly']
    );
  }
  sheetsClient = google.sheets({ version: 'v4', auth });
  return sheetsClient;
}

// ---------------- normalization (same rules everywhere) ----------------

function normalizeEmail(v) {
  if (!v) return null;
  const e = String(v).trim().toLowerCase();
  return e || null;
}

function normalizePhone(v) {
  if (v === null || v === undefined || v === '') return null;
  let digits = String(v).replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('0')) digits = '234' + digits.slice(1);
  if (digits.length === 10 && !digits.startsWith('234')) digits = '234' + digits;
  return digits;
}

function findCol(headers, fragment) {
  const f = fragment.toLowerCase();
  return headers.findIndex(h => String(h || '').toLowerCase().includes(f));
}

// ---------------- sheet reading + cache ----------------

const cache = new Map(); // sheetId -> { ts, headers, rows, tabTitle }

async function readSheet(cfg) {
  const hit = cache.get(cfg.id);
  if (hit && Date.now() - hit.ts < CACHE_MS) return hit;

  const sheets = getSheets();

  // find the "Form Responses" tab (or fall back to the first tab)
  let tabTitle = hit && hit.tabTitle;
  if (!tabTitle) {
    const meta = await sheets.spreadsheets.get({ spreadsheetId: cfg.id });
    const tabs = meta.data.sheets.map(s => s.properties.title);
    tabTitle = tabs.find(t => t.toLowerCase().startsWith('form responses')) || tabs[0];
  }

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: cfg.id,
    range: `'${tabTitle}'!A:AZ`,
  });

  const values = resp.data.values || [];
  const entry = {
    ts: Date.now(),
    tabTitle,
    headers: values[0] || [],
    rows: values.slice(1),
  };
  cache.set(cfg.id, entry);
  return entry;
}

// If Google is briefly unreachable, serve the last good copy instead of failing
async function readSheetSafe(cfg) {
  try {
    return await readSheet(cfg);
  } catch (err) {
    console.error(`[status] failed to read ${cfg.label}:`, err.message);
    const stale = cache.get(cfg.id);
    return stale || null;
  }
}

// ---------------- matching + status logic ----------------

function buildResult(cfg, headers, row) {
  const col = {
    certName: findCol(headers, H.certName),
    paid: findCol(headers, H.paid),
    inst1: findCol(headers, H.inst1),
    inst2: findCol(headers, H.inst2),
    cohort: findCol(headers, H.cohort),
  };
  const cell = i => (i >= 0 && row[i] !== undefined ? String(row[i]).trim() : '');

  const inst1 = cfg.plan === 'flexi' && cell(col.inst1) !== '';
  const inst2 = cfg.plan === 'flexi' && cell(col.inst2) !== '';
  const paid = cell(col.paid) !== '' || inst1 || inst2;

  let status;
  if (cfg.plan === 'flexi') {
    status = inst2 ? 'complete' : inst1 ? 'flexi_partial' : 'awaiting_payment';
  } else {
    status = paid ? 'complete' : 'awaiting_payment';
  }

  return {
    product: cfg.product,
    plan: cfg.plan,
    label: cfg.label,
    cohort: cell(col.cohort) || null,
    certificate_name: cell(col.certName) || null,
    status, // 'complete' | 'flexi_partial' | 'awaiting_payment'
    installment_1_paid: inst1,
    installment_2_paid: inst2,
  };
}

async function lookup(query) {
  const qEmail = query.includes('@') ? normalizeEmail(query) : null;
  const qPhone = query.includes('@') ? null : normalizePhone(query);
  if (!qEmail && !qPhone) return [];

  const results = [];
  for (const cfg of sheetConfigs()) {
    const data = await readSheetSafe(cfg);
    if (!data) continue;
    const emailCol = findCol(data.headers, H.email);
    const phoneCol = findCol(data.headers, H.phone);

    for (const row of data.rows) {
      const rEmail = emailCol >= 0 ? normalizeEmail(row[emailCol]) : null;
      const rPhone = phoneCol >= 0 ? normalizePhone(row[phoneCol]) : null;
      if ((qEmail && rEmail === qEmail) || (qPhone && rPhone === qPhone)) {
        results.push(buildResult(cfg, data.headers, row));
      }
    }
  }
  return results;
}

// ---------------- rate limiting (protects against bulk probing) ----------------

const hits = new Map(); // ip -> [timestamps]
function rateLimited(ip) {
  const now = Date.now();
  const windowMs = 60 * 1000;
  const list = (hits.get(ip) || []).filter(t => now - t < windowMs);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear(); // crude memory guard
  return list.length > 12; // max 12 checks per minute per IP
}

// ---------------- route ----------------

router.get('/', async (req, res) => {
  // CORS so the page on betechified.com (Hostinger) can call this Render endpoint
  res.set('Access-Control-Allow-Origin', '*');

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
  if (rateLimited(ip)) {
    return res.status(429).json({ error: 'Too many checks. Please wait a minute and try again.' });
  }

  const q = String(req.query.q || '').trim();
  if (q.length < 5) {
    return res.status(400).json({ error: 'Enter the email or phone number you used on the registration form.' });
  }

  try {
    const results = await lookup(q);
    res.json({ found: results.length > 0, results });
  } catch (err) {
    console.error('[status] lookup error:', err.message);
    res.status(500).json({ error: 'Something went wrong on our side. Please try again shortly.' });
  }
});

module.exports = router;