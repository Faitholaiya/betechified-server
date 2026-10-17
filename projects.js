/*
 * BeTechified track projects module
 * Mount in your existing Render server:
 *   app.set('trust proxy', 1);
 *   app.use('/api/projects', require('./projects'));
 *
 * Env vars:
 *   GOOGLE_SERVICE_ACCOUNT_JSON  service account key JSON (same one the status page uses)
 *   PROJECTS_CONFIG_SHEET_ID     Google Sheet that stores project settings (service account = Editor)
 *   PROJECTS_ADMIN_KEY           key for the admin page
 *   PROJECTS_ALLOWED_ORIGINS     optional, comma separated, e.g. https://betechified.com
 */
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { google } = require('googleapis');

const router = express.Router();
router.use(express.json({ limit: '200kb' }));

/* ---------- CORS ---------- */
const ORIGINS = (process.env.PROJECTS_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
router.use((req, res, next) => {
  const o = req.headers.origin;
  if (!ORIGINS.length || (o && ORIGINS.includes(o))) res.setHeader('Access-Control-Allow-Origin', ORIGINS.length ? o : '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/* ---------- Google Sheets client ---------- */
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}'),
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});
const sheets = google.sheets({ version: 'v4', auth });
const CONFIG_SHEET = process.env.PROJECTS_CONFIG_SHEET_ID;
const CONFIG_TAB = 'projects';

async function firstTab(id) {
  const r = await sheets.spreadsheets.get({ spreadsheetId: id, fields: 'sheets.properties.title' });
  return r.data.sheets[0].properties.title;
}
async function readRows(id, tab, opts = {}) {
  const t = tab || await firstTab(id);
  const r = await sheets.spreadsheets.values.get({ spreadsheetId: id, range: `'${t}'`, ...opts });
  return r.data.values || [];
}
// Sheets date serial (days since 30 Dec 1899, in the sheet's own time zone)
const serialToText = n => new Date(Math.round((n - 25569) * 864e5)).toLocaleString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
const dateToSerial = ymd => { const [y, m, d] = String(ymd).split('-').map(Number); return Date.UTC(y, m - 1, d) / 864e5 + 25569; };

/* ---------- Small cache ---------- */
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.val;
  const val = await fn();
  cache.set(key, { val, exp: Date.now() + ttlMs });
  return val;
}
const clearCache = () => cache.clear();

/* ---------- Project settings (stored in config sheet) ----------
 * Tab "projects", columns: key | updated_at | json
 * key = track:cohort, e.g. pd:oct26
 */
async function ensureConfigTab() {
  const r = await sheets.spreadsheets.get({ spreadsheetId: CONFIG_SHEET, fields: 'sheets.properties.title' });
  if (!r.data.sheets.some(s => s.properties.title === CONFIG_TAB)) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: CONFIG_SHEET, requestBody: { requests: [{ addSheet: { properties: { title: CONFIG_TAB } } }] } });
    await sheets.spreadsheets.values.update({ spreadsheetId: CONFIG_SHEET, range: `${CONFIG_TAB}!A1:C1`, valueInputOption: 'RAW', requestBody: { values: [['key', 'updated_at', 'json']] } });
  }
}
async function loadProjects() {
  return cached('projects', 60e3, async () => {
    await ensureConfigTab();
    const rows = await readRows(CONFIG_SHEET, CONFIG_TAB);
    const out = [];
    rows.slice(1).forEach((r, i) => {
      try { if (r[0]) out.push({ ...JSON.parse(r[2]), _row: i + 2, _updated: r[1] }); } catch (e) { /* skip broken row */ }
    });
    return out;
  });
}
async function saveProject(p) {
  const key = `${p.track}:${p.cohort}`;
  const clean = { ...p }; delete clean._row; delete clean._updated;
  const all = await loadProjects();
  const existing = all.find(x => `${x.track}:${x.cohort}` === key);
  const values = [[key, new Date().toISOString(), JSON.stringify(clean)]];
  if (existing) {
    await sheets.spreadsheets.values.update({ spreadsheetId: CONFIG_SHEET, range: `${CONFIG_TAB}!A${existing._row}:C${existing._row}`, valueInputOption: 'RAW', requestBody: { values } });
  } else {
    await sheets.spreadsheets.values.append({ spreadsheetId: CONFIG_SHEET, range: `${CONFIG_TAB}!A:C`, valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', requestBody: { values } });
  }
  // only one active cohort per track
  if (clean.active) {
    for (const x of all) if (x.track === clean.track && x.cohort !== clean.cohort && x.active) {
      const y = { ...x, active: false }; delete y._row; delete y._updated;
      await sheets.spreadsheets.values.update({ spreadsheetId: CONFIG_SHEET, range: `${CONFIG_TAB}!A${x._row}:C${x._row}`, valueInputOption: 'RAW', requestBody: { values: [[`${x.track}:${x.cohort}`, new Date().toISOString(), JSON.stringify(y)]] } });
    }
  }
  clearCache();
}
async function findProject(track, cohort) {
  const all = await loadProjects();
  if (cohort) return all.find(p => p.track === track && p.cohort === cohort);
  return all.find(p => p.track === track && p.active);
}
const PUBLIC_FIELDS = ['track', 'cohort', 'trackName', 'title', 'aim', 'brief', 'siteUrl', 'videoId', 'steps', 'deliverables',
  'presentation', 'criteria', 'extraNote', 'deadline', 'presentationDate', 'timeline', 'formShortUrl', 'formPrefillBase', 'formFields', 'supportEmail', 'notFoundText', 'siteLabel', 'groupTasks', 'groupTasksLabel'];
const publicView = p => Object.fromEntries(PUBLIC_FIELDS.map(k => [k, p[k]]));

/* ---------- Grouping sheet ---------- */
const norm = v => String(v || '').toUpperCase().replace(/\s+/g, '');
// "26100223.0" or "26100223" become "FD26100223" when the track prefix is known
const normNum = (v, prefix) => { let n = norm(v).replace(/[.,;]+$/, '').replace(/\.0+$/, ''); if (prefix && /^\d{8}$/.test(n)) n = prefix + n; return n; };
// "group 1", "GROUP 1 ", "Group1" all become "Group 1"; "group 1a" becomes "Group 1A"
const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const unitName = v => {
  const t = String(v || '').trim().replace(/\s+/g, ' ');
  let x = t.toLowerCase().replace(/[().,:#]/g, ' ').replace(/\b(group|grp|number|no)\b/g, ' ').replace(/\s+/g, ' ').trim();
  x = x.replace(/^([a-z]+)\b/, w => WORDS[w] ? String(WORDS[w]) : w);
  const m = x.match(/^(\d{1,2})\s*([a-c])?(\s|$)/);
  return m ? `Group ${parseInt(m[1], 10)}${m[2] ? m[2].toUpperCase() : ''}` : t;
};
// a sub-group answer like "Group 6A" still counts for "Group 6" when each group submits
const groupOnly = u => u.replace(/^(Group \d+)[A-Z]$/, '$1');
const normEmail = v => String(v || '').trim().toLowerCase();

function colIndex(headers) {
  const h = headers.map(x => String(x || '').trim().toLowerCase());
  const find = test => h.findIndex(test);
  return {
    group: find(x => x === 'group'),
    subgroup: find(x => x.includes('sub')),
    name: find(x => x.includes('name')),
    number: find(x => x.includes('unique')),
    email: find(x => x.includes('email')),
    whatsapp: find(x => x.includes('whatsapp'))
  };
}

async function loadGroups(p) {
  return cached(`groups:${p.track}:${p.cohort}`, 5 * 60e3, async () => {
    const rows = await readRows(p.groupingSheetId, p.groupingTab);
    const c = colIndex(rows[0] || []);
    if (c.email < 0) { // header missing: find the column that holds email addresses
      const body = rows.slice(1, 100);
      const n = Math.max(...rows.slice(0, 100).map(r => r.length), 0);
      for (let i = 0; i < n; i++) if (body.filter(r => /@/.test(String(r[i] || ''))).length >= Math.max(1, body.filter(r => r[c.name]).length / 2)) { c.email = i; break; }
    }
    if (c.group < 0 || c.name < 0) throw new Error('Grouping sheet needs "Group" and "Member name" columns');
    const units = new Map(); const byNumber = new Map(); const byEmail = new Map();
    const issues = { missingNumber: [], duplicateNumber: [], nameInTwoGroups: [], otherTrackPrefix: [], oddFormat: [] };
    const seenName = new Map();
    let lastGroup = '', lastSub = '';
    rows.slice(1).forEach((r, i) => {
      // if Group or Sub-group is only filled on a group's first row, carry it down
      const gRaw = String(r[c.group] || '').trim(); const sRaw = c.subgroup >= 0 ? String(r[c.subgroup] || '').trim() : '';
      if (gRaw) { lastGroup = unitName(gRaw); if (!sRaw) lastSub = ''; }
      if (sRaw) lastSub = unitName(sRaw);
      const unit = p.projectUnit === 'subgroup' && c.subgroup >= 0 ? lastSub : lastGroup;
      const name = String(r[c.name] || '').trim();
      if (!unit || !name) return;
      if (!units.has(unit)) units.set(unit, { unit, group: lastGroup, whatsapp: '', members: [] });
      const u = units.get(unit);
      const wa = c.whatsapp >= 0 ? String(r[c.whatsapp] || '').trim() : '';
      if (wa && !u.whatsapp) u.whatsapp = wa.replace(/\\&/g, '&');
      const number = normNum(r[c.number], p.numberPrefix); const email = normEmail(r[c.email]);
      const subgroup = lastSub;
      const m = { name, number, email, subgroup, row: i + 2 };
      u.members.push(m);
      if (!number) issues.missingNumber.push(`${name} (row ${m.row})`);
      else {
        if (byNumber.has(number)) issues.duplicateNumber.push(`${number}: rows ${byNumber.get(number).m.row} and ${m.row}`);
        byNumber.set(number, { unit, m });
        const prefix = (number.match(/^[A-Z]+/) || [''])[0];
        if (!/^[A-Z]{2}\d{8}$/.test(number)) issues.oddFormat.push(`${name}: ${number} (row ${m.row})`);
        else if (p.numberPrefix && prefix !== p.numberPrefix) issues.otherTrackPrefix.push(`${name}: ${number}`);
      }
      if (email) byEmail.set(email, { unit, m });
      const key = name.toLowerCase();
      if (seenName.has(key) && seenName.get(key) !== unit) issues.nameInTwoGroups.push(`${name}: ${seenName.get(key)} and ${unit}`);
      seenName.set(key, unit);
    });
    return { units, byNumber, byEmail, issues, total: rows.length - 1 };
  });
}

/* ---------- Submissions (form responses sheet) ---------- */
async function loadSubmissions(p) {
  if (!p.responsesSheetId) return new Map();
  return cached(`subs:${p.track}:${p.cohort}`, 60e3, async () => {
    // read raw values so timestamps come back as date serials we can filter on
    const rows = await readRows(p.responsesSheetId, p.responsesTab, { valueRenderOption: 'UNFORMATTED_VALUE', dateTimeRenderOption: 'SERIAL_NUMBER' });
    const from = /^\d{4}-\d{2}-\d{2}$/.test(p.submissionsFrom || '') ? dateToSerial(p.submissionsFrom) : 0;
    const h = (rows[0] || []).map(x => String(x || '').toLowerCase());
    const ts = h.findIndex(x => x.includes('timestamp'));
    // pick columns by their contents: the group column holds values like "Group 1",
    // the name column has "name" in its title and holds text, not links
    const body = rows.slice(1, 200);
    const share = (i, test) => { const v = body.map(r => String(r[i] ?? '').trim()).filter(Boolean); return v.length ? v.filter(test).length / v.length : 0; };
    const isUnit = p.projectUnit === 'subgroup' ? (v => /^group\s*\d+\s*[a-z]$/i.test(v)) : (v => /^group\s*\d+$/i.test(v));
    let gi = -1, best = 0;
    h.forEach((x, i) => { const sc = share(i, v => /^Group \d+/.test(unitName(v))) + (x.includes('group') ? 0.01 : 0); if (sc > best) { best = sc; gi = i; } });
    if (best < 0.3) gi = h.findIndex(x => x === 'group' || x.startsWith('group'));
    // the submitter's name: skip "Product Name", "Project Name", file or business names, and link columns
    const nameOk = (x, i) => x.includes('name') && i !== gi && !/product|project|file|business|brand|app|solution|team/.test(x) && share(i, v => /^https?:\/\//i.test(v)) < 0.5;
    let ni = h.findIndex((x, i) => nameOk(x, i) && /^(full |your |)name$|full name|your name|leader|submitter|submitted by/.test(x));
    if (ni < 0) ni = h.findIndex(nameOk);
    const ei = h.findIndex(x => x.includes('email'));
    const map = new Map();
    rows.slice(1).forEach(r => {
      let unit = unitName(r[gi]); if (!unit) return;
      if (p.projectUnit !== 'subgroup') unit = groupOnly(unit);
      const t = Number(r[ts]);
      if (from && !(t >= from)) return; // earlier cohort's submission, ignore
      if (!map.has(unit)) map.set(unit, []);
      map.get(unit).push({ name: ni >= 0 ? String(r[ni] || '').trim() : '', email: ei >= 0 ? normEmail(r[ei]) : '', at: t ? serialToText(t) : '' });
    });
    return map;
  });
}

/* ---------- Rate limit for lookups ---------- */
const hits = new Map();
function limited(ip) {
  const now = Date.now(); const win = 10 * 60e3; const max = 30;
  const arr = (hits.get(ip) || []).filter(t => now - t < win);
  arr.push(now); hits.set(ip, arr);
  if (hits.size > 50000) hits.clear();
  return arr.length > max;
}

/* ---------- Public routes ---------- */
router.get('/config', async (req, res) => {
  try {
    const p = await findProject(String(req.query.track || ''), req.query.cohort ? String(req.query.cohort) : null);
    if (!p) return res.status(404).json({ error: 'No project found for this track' });
    res.json(publicView(p));
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not load project' }); }
});

router.get('/lookup', async (req, res) => {
  try {
    if (limited(req.ip)) return res.status(429).json({ error: 'Too many searches. Wait a few minutes and try again.' });
    const p = await findProject(String(req.query.track || ''), req.query.cohort ? String(req.query.cohort) : null);
    if (!p) return res.status(404).json({ found: false });
    const q = String(req.query.q || '').trim();
    const data = await loadGroups(p);
    const hit = q.includes('@') ? data.byEmail.get(normEmail(q)) : data.byNumber.get(normNum(q, p.numberPrefix));
    if (!hit) return res.status(404).json({ found: false });
    const u = data.units.get(hit.unit);
    const subs = (await loadSubmissions(p)).get(hit.unit) || [];
    res.json({
      found: true,
      unit: hit.unit,
      group: u.group,
      subgroup: hit.m.subgroup,
      you: hit.m.name,
      whatsapp: u.whatsapp,
      members: u.members.map((m, i) => ({ name: m.name, subgroup: m.subgroup, isYou: m === hit.m, suggestedLeader: i === 0 })),
      submissions: subs.map(x => ({ name: x.name || (data.byEmail.get(x.email) || {}).m?.name || 'A group member', at: x.at }))
    });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Lookup failed' }); }
});

/* ---------- Submission notifications (called by the form's Apps Script) ---------- */
const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');
const ses = new SESClient({
  region: process.env.PROJECTS_SES_REGION || 'us-east-1',
  credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY }
});
const FROM = process.env.PROJECTS_FROM_EMAIL || 'BeTechified <newsletter@betechified.com>';
const PAGE_URL = process.env.PROJECTS_PAGE_URL || 'https://betechified.com/projects';
const escHtml = s => String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function notifyEmail(p, unit, submitter, at, recipient) {
  const link = `${PAGE_URL}?track=${p.track}`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:32px;color:#1A1A1A;">
    <p style="font-size:20px;font-weight:bold;color:#D40000;margin:0 0 16px;">Your group's project has been submitted</p>
    <p>Hi ${escHtml(recipient.name)},</p>
    <p><strong>${escHtml(submitter)}</strong> submitted the ${escHtml(p.title)} project for <strong>${escHtml(unit)}</strong>${at ? ` on ${escHtml(at)}` : ''}.</p>
    <p>If your group agreed on this, there is nothing else to do. If this was not the final version, agree in your group chat and submit again before the deadline. The most recent submission before the deadline is the one we grade.</p>
    <p><a href="${link}" style="display:inline-block;background:#D40000;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:bold;">See your group's submission status</a></p>
    <hr style="margin:28px 0;border:none;border-top:1px solid #eee;">
    <p style="color:#888;font-size:12px;">BeTechified, Tech Education for Africa</p></div>`;
  return new SendEmailCommand({
    Source: FROM,
    Destination: { ToAddresses: [recipient.email] },
    Message: { Subject: { Data: `${unit}: your project has been submitted` }, Body: { Html: { Data: html } } }
  });
}

async function sendToGroup(p, unit, submitter, at, members) {
  const list = members.filter(m => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(m.email));
  let sent = 0, failed = 0;
  for (let i = 0; i < list.length; i += 14) {
    const batch = list.slice(i, i + 14);
    const r = await Promise.allSettled(batch.map(m => ses.send(notifyEmail(p, unit, submitter, at, m))));
    r.forEach((x, j) => { if (x.status === 'fulfilled') sent++; else { failed++; console.error('Project email failed', batch[j].email, x.reason && x.reason.message); } });
    if (i + 14 < list.length) await new Promise(res => setTimeout(res, 1000));
  }
  console.log(`Project notification ${p.track}:${p.cohort} ${unit}: ${sent} sent, ${failed} failed`);
}

router.post('/notify', async (req, res) => {
  try {
    const b = req.body || {};
    const secret = Buffer.from(String(b.secret || '')); const real = Buffer.from(String(process.env.PROJECTS_NOTIFY_SECRET || ''));
    if (!real.length || secret.length !== real.length || !crypto.timingSafeEqual(secret, real)) return res.status(401).json({ error: 'Wrong secret' });
    const p = await findProject(String(b.track || ''), b.cohort ? String(b.cohort) : null);
    if (!p) return res.status(404).json({ check: 'No project set up for this track' });
    const unit = p.projectUnit === 'subgroup' ? unitName(b.group) : groupOnly(unitName(b.group));
    cache.delete(`subs:${p.track}:${p.cohort}`); // new submission shows on the page straight away
    const data = await loadGroups(p);
    const u = data.units.get(unit);
    if (!u) return res.json({ check: `Group "${unit}" not found in the grouping sheet` });

    // verify the submitter belongs to the group they chose
    let check = 'Not verified (no unique number on form)';
    const num = normNum(b.number, p.numberPrefix);
    if (num) {
      const hit = data.byNumber.get(num);
      check = !hit ? 'Unique number not found' : hit.unit === unit ? 'Verified' : `Submitter is in ${hit.unit}, not ${unit}`;
    }
    res.json({ check, emailsQueued: u.members.filter(m => m.email).length });
    if (check === 'Verified' || !num) sendToGroup(p, unit, String(b.name || 'A group member').trim(), String(b.at || ''), u.members).catch(e => console.error(e));
  } catch (e) { console.error(e); res.status(500).json({ check: 'Server error: ' + e.message }); }
});

/* ---------- Admin ---------- */
function isAdmin(req) {
  const a = Buffer.from(String(req.headers['x-admin-key'] || ''));
  const b = Buffer.from(String(process.env.PROJECTS_ADMIN_KEY || ''));
  return b.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}
const admin = express.Router();
admin.use((req, res, next) => isAdmin(req) ? next() : res.status(401).json({ error: 'Wrong admin key' }));

admin.get('/projects', async (req, res) => {
  try { res.json(await loadProjects()); } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});
admin.put('/projects', async (req, res) => {
  try {
    const p = req.body || {};
    if (!/^[a-z]{2,4}$/.test(p.track || '') || !/^[a-z0-9-]{3,20}$/.test(p.cohort || '')) return res.status(400).json({ error: 'Track and cohort codes are required (lowercase, e.g. pd and oct26)' });
    await saveProject(p); res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});
admin.post('/check', async (req, res) => {
  try {
    const p = req.body || {};
    clearCache();
    const g = await loadGroups(p);
    const subs = await loadSubmissions(p);
    res.json({
      ok: true,
      rows: g.total,
      units: [...g.units.values()].map(u => ({ unit: u.unit, members: u.members.length, suggestedLeader: u.members[0] && u.members[0].name, whatsapp: !!u.whatsapp, submissions: (subs.get(u.unit) || []).length })),
      issues: g.issues
    });
  } catch (e) {
    const msg = /permission|403/i.test(e.message) ? 'The service account cannot open this sheet. Share it with the service account email.' :
      /not supported|400/i.test(e.message) ? 'This looks like an uploaded Excel file. Open it in Google Sheets and use File, Save as Google Sheets, then use the new link.' : e.message;
    res.status(400).json({ ok: false, error: msg });
  }
});
admin.post('/refresh', (req, res) => { clearCache(); res.json({ ok: true }); });
admin.get('/service-account', (req, res) => {
  try { res.json({ email: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}').client_email || '' }); } catch { res.json({ email: '' }); }
});
router.use('/admin/api', admin);
router.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'projects-admin.html')));

module.exports = router;