const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { google } = require('googleapis');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const ses = new SESClient({
  region: 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const statusLookup = require('./status-lookup');
app.use('/api/status', statusLookup);

const GEMINI_PROMPT = `You are a verification assistant for BeTechified, an African tech education platform.
Check whether this screenshot is a WhatsApp chat that contains a message related to BeTechified (a tech education platform, course, or registration).

Be LENIENT — if there is reasonable evidence of either a group chat or a BeTechified-related message, pass it.
Only reject if the screenshot is clearly not WhatsApp at all, or has absolutely no connection to BeTechified.

Respond with ONLY valid JSON, no markdown, no explanation:
{"valid": true} or {"valid": false, "reason": "short reason"}`;


// ── Google Sheets helper ───────────────────────────────────────────────────
const getEmailList = async (sheetId, range) => {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
  });

  const sheets = google.sheets({ version: 'v4', auth });
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: range
  });

  const rows = response.data.values || [];
  return rows
    .slice(1) // skip header row
    .map(row => ({ name: (row[0] || '').trim(), email: (row[1] || '').trim() }))
    .filter(r => r.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email));
};

// ── Campaign send helper ───────────────────────────────────────────────────
const sendCampaignEmails = async (recipients, subject, htmlTemplate) => {
  const BATCH_SIZE = 14; // SES default rate limit is 14/sec
  let sent = 0;
  let failed = 0;

  for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
    const batch = recipients.slice(i, i + BATCH_SIZE);

    await Promise.allSettled(batch.map(async (recipient) => {
      try {
        const personalised = `
          <div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:32px;">
            ${htmlTemplate
              .replace(/{{name}}/g, recipient.name)
              .replace(/{{email}}/g, recipient.email)}
            <hr style="margin:32px 0;border:none;border-top:1px solid #eee;" />
            <p style="color:#888;font-size:12px;">BeTechified — Tech Education for Africa</p>
          </div>`;

        await ses.send(new SendEmailCommand({
          Source: 'BeTechified <newsletter@betechified.com>',
          Destination: { ToAddresses: [recipient.email] },
          Message: {
            Subject: { Data: subject },
            Body: { Html: { Data: personalised } }
          }
        }));
        sent++;
      } catch (e) {
        console.error('Failed to send to ' + recipient.email + ':', e.message);
        failed++;
      }
    }));

    // Pause 1 second between batches to respect SES rate limits
    if (i + BATCH_SIZE < recipients.length) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  return { sent, failed };
};


// ── /verify ────────────────────────────────────────────────────────────────
app.post('/verify', upload.array('screenshots', 5), async (req, res) => {
  try {
    const files = req.files;

    if (!files || files.length === 0) {
      return res.status(400).json({ passed: false, message: 'No screenshots uploaded.' });
    }
    if (files.length < 5) {
      return res.status(400).json({ passed: false, message: `Please upload all 5 screenshots. You only uploaded ${files.length}.` });
    }

    // Duplicate detection
    const fingerprints = files.map(f => f.size + '-' + f.buffer.slice(0, 16).toString('hex'));
    if (new Set(fingerprints).size < files.length) {
      return res.status(400).json({ passed: false, message: 'Duplicate screenshots detected. Each screenshot must be from a different WhatsApp group.' });
    }

    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      let parsed;
      try {
        const result = await model.generateContent([
          GEMINI_PROMPT,
          { inlineData: { mimeType: file.mimetype || 'image/jpeg', data: file.buffer.toString('base64') } }
        ]);
        const text = result.response.text().trim().replace(/```json|```/g, '').trim();
        parsed = JSON.parse(text);
      } catch (err) {
        console.error('Gemini error on screenshot ' + (i + 1) + ':', err.message);
        return res.status(400).json({
          passed: false,
          screenshotIndex: i + 1,
          message: 'Screenshot ' + (i + 1) + ' could not be verified. Please re-upload a clearer image.'
        });
      }

      if (!parsed.valid) {
        return res.status(400).json({
          passed: false,
          screenshotIndex: i + 1,
          message: 'Screenshot ' + (i + 1) + ' was rejected: ' + (parsed.reason || 'does not show a WhatsApp group chat with a BeTechified message') + '. Please re-upload that screenshot.'
        });
      }
    }

    res.json({ passed: true });
  } catch (err) {
    console.error('Verify error:', err);
    res.status(500).json({ passed: false, message: 'Server error during verification.' });
  }
});

// ── /register ──────────────────────────────────────────────────────────────
app.post('/register', async (req, res) => {
  try {
    const { name, email, phone, country, city, course } = req.body;

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ success: false, error: 'Invalid email address.' });
    }

    const year = '26';
    const month = '07';
    const prefix = course + year + month;

    // Check if already registered
    const { data: existingEmail } = await supabase
      .from('registrants')
      .select('unique_number')
      .eq('email', email)
      .like('unique_number', prefix + '%');

    if (existingEmail && existingEmail.length > 0) {
      return res.json({ success: false, already_registered: true, unique_number: existingEmail[0].unique_number });
    }

    // Fetch ALL numbers for this course prefix and pick highest mathematically
    let allExisting = [];
    let from = 0;
    const PAGE = 1000;
    while (true) {
      const { data, error } = await supabase
        .from('registrants')
        .select('unique_number')
        .like('unique_number', prefix + '%')
        .range(from, from + PAGE - 1);
      if (error) throw error;
      if (!data || data.length === 0) break;
      allExisting = allExisting.concat(data);
      if (data.length < PAGE) break;
      from += PAGE;
    }

    let nextSeq = 1;
    if (allExisting.length > 0) {
      const nums = allExisting
        .map(r => parseInt(r.unique_number.replace(prefix, '')))
        .filter(n => !isNaN(n));
      if (nums.length > 0) nextSeq = Math.max(...nums) + 1;
    }
    const generatedNumber = prefix + String(nextSeq).padStart(4, '0');

    // Save to Supabase
    const { error } = await supabase
      .from('registrants')
      .insert([{ name, email, phone, country, city, course, unique_number: generatedNumber }]);

    if (error) throw error;

    // Send confirmation email
    try {
      await ses.send(new SendEmailCommand({
        Source: 'newsletter@betechified.com',
        Destination: { ToAddresses: [email] },
        Message: {
          Subject: { Data: 'Your BeTechified Unique Number - ' + generatedNumber },
          Body: {
            Html: {
              Data: '<div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:32px;"><h2 style="color:#D40000;">You\'re verified! 🎉</h2><p>Hi ' + name + ',</p><p>Your unique number for the <strong>' + course + '</strong> track is:</p><div style="background:#f5f5f5;border-left:4px solid #D40000;padding:16px 24px;margin:24px 0;font-size:28px;font-weight:bold;letter-spacing:4px;">' + generatedNumber + '</div><p>Use this number to submit your assignments and access the full beginner class.</p><p>Welcome to BeTechified! 🚀</p><hr style="margin:32px 0;border:none;border-top:1px solid #eee;" /><p style="color:#888;font-size:12px;">BeTechified — Tech Education for Africa</p></div>'
            }
          }
        }
      }));
    } catch (emailErr) {
      console.error('Email error:', emailErr);
    }

    res.json({ success: true, unique_number: generatedNumber });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not save registration' });
  }
});

// ── /send-bulk ─────────────────────────────────────────────────────────────
app.post('/send-bulk', async (req, res) => {
  try {
    const { recipients, subject, body } = req.body;
    let sent = 0;

    for (const recipient of recipients) {
      try {
        await ses.send(new SendEmailCommand({
          Source: 'newsletter@betechified.com',
          Destination: { ToAddresses: [recipient.email] },
          Message: {
            Subject: { Data: subject },
            Body: {
              Html: {
                Data: '<div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:32px;"><h2 style="color:#D40000;">BeTechified</h2><p>Hi ' + recipient.name + ',</p>' + body.replace(/\n/g, '<br/>') + '<hr style="margin:32px 0;border:none;border-top:1px solid #eee;" /><p style="color:#888;font-size:12px;">BeTechified — Tech Education for Africa</p></div>'
              }
            }
          }
        }));
        sent++;
        await new Promise(r => setTimeout(r, 100));
      } catch (emailErr) {
        console.error('Failed to send to ' + recipient.email + ':', emailErr.message);
      }
    }

    res.json({ success: true, sent });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Bulk send failed' });
  }
});

// ── /preview-recipients ────────────────────────────────────────────────────
// Used by the campaign UI to check how many valid recipients are in a sheet
app.post('/preview-recipients', async (req, res) => {
  try {
    const { sheetUrl, sheetRange } = req.body;

    const sheetId = sheetUrl.match(/\/d\/([a-zA-Z0-9-_]+)/)?.[1];
    if (!sheetId) return res.status(400).json({ error: 'Invalid Google Sheet URL.' });

    const recipients = await getEmailList(sheetId, sheetRange || 'Sheet1!A:B');
    res.json({ count: recipients.length });
  } catch (err) {
    console.error('Preview error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── /send-campaign ─────────────────────────────────────────────────────────
// Reads recipients from a Google Sheet and sends a campaign email to all of them
app.post('/send-campaign', async (req, res) => {
  try {
    const { sheetUrl, sheetRange, subject, htmlTemplate } = req.body;

    if (!sheetUrl || !subject || !htmlTemplate) {
      return res.status(400).json({ error: 'sheetUrl, subject, and htmlTemplate are required.' });
    }

    const sheetId = sheetUrl.match(/\/d\/([a-zA-Z0-9-_]+)/)?.[1];
    if (!sheetId) return res.status(400).json({ error: 'Invalid Google Sheet URL.' });

    const recipients = await getEmailList(sheetId, sheetRange || 'Sheet1!A:B');
    if (!recipients.length) {
      return res.status(400).json({ error: 'No valid recipients found in that sheet. Check the URL, tab name, and column range.' });
    }

    console.log(`Campaign starting: "${subject}" → ${recipients.length} recipients`);

    const { sent, failed } = await sendCampaignEmails(recipients, subject, htmlTemplate);

    console.log(`Campaign done. Sent: ${sent}, Failed: ${failed}`);
    res.json({ success: true, total: recipients.length, sent, failed });
  } catch (err) {
    console.error('Campaign error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── /notify-fixed ──────────────────────────────────────────────────────────
app.post('/notify-fixed', async (req, res) => {
  const { secret } = req.body;
  if (secret !== 'betechfix2026') {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // Fetch all DA registrants in batches
    let allDA = [];
    let from = 0;
    const PAGE = 1000;
    while (true) {
      const { data, error } = await supabase
        .from('registrants')
        .select('name, email, unique_number')
        .eq('course', 'DA')
        .range(from, from + PAGE - 1);
      if (error) throw error;
      if (!data || data.length === 0) break;
      allDA = allDA.concat(data);
      if (data.length < PAGE) break;
      from += PAGE;
    }

    // Filter: only DA numbers above 1000
    const toNotify = allDA.filter(r => {
      const numPart = r.unique_number.replace('DA2604', '');
      const num = parseInt(numPart);
      return !isNaN(num) && num > 1000;
    });

    console.log('Total DA fetched:', allDA.length, 'To notify:', toNotify.length);

    let sent = 0;
    let failed = 0;

    for (const person of toNotify) {
      try {
        await ses.send(new SendEmailCommand({
          Source: 'newsletter@betechified.com',
          Destination: { ToAddresses: [person.email] },
          Message: {
            Subject: { Data: 'Your Correct BeTechified Unique Number' },
            Body: {
              Html: {
                Data: `<div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:32px;">
                  <h2 style="color:#D40000;">Important Update 🔔</h2>
                  <p>Hi ${person.name},</p>
                  <p>Due to a technical issue, your BeTechified unique number was updated. Your correct number is:</p>
                  <div style="background:#f5f5f5;border-left:4px solid #D40000;padding:16px 24px;margin:24px 0;font-size:28px;font-weight:bold;letter-spacing:4px;">${person.unique_number}</div>
                  <p>Please use this number going forward for assignments and class access. We apologise for any confusion.</p>
                  <p>Welcome to BeTechified! 🚀</p>
                  <hr style="margin:32px 0;border:none;border-top:1px solid #eee;" />
                  <p style="color:#888;font-size:12px;">BeTechified — Tech Education for Africa</p>
                </div>`
              }
            }
          }
        }));
        sent++;
        await new Promise(r => setTimeout(r, 150));
      } catch (emailErr) {
        console.error('Failed to notify ' + person.email + ':', emailErr.message);
        failed++;
      }
    }

    res.json({ success: true, sent, failed });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Notification failed' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// BEGINNER CLASS REGISTRATION (permanent registration page)
// Uses the beginner_settings, beginner_tracks, and beginner_registrations
// tables in Supabase. Reuses the existing supabase and ses clients above.
// Needs ONE new environment variable on Render: ADMIN_KEY
// ═══════════════════════════════════════════════════════════════════════════

const formatRegNumber = (id) => 'BT-' + String(id).padStart(4, '0');

function buildWelcomeHtml({ firstName, regNumber, trackName, cohortName, whatsappLink }) {
  return `
<!DOCTYPE html>
<html>
<body style="margin:0; padding:0; background:#FAFAFA; font-family:Arial, Helvetica, sans-serif; color:#111111;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FAFAFA; padding:32px 0;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#FFFFFF; border:1px solid #E6E6E6; border-top:4px solid #D40000; max-width:560px; width:100%;">
        <tr><td style="padding:32px 32px 0;">
          <p style="font-size:20px; font-weight:bold; margin:0 0 24px;">Be<span style="color:#D40000;">Techified</span></p>
          <h1 style="font-size:24px; margin:0 0 12px;">You are in, ${firstName}.</h1>
          <p style="font-size:15px; line-height:1.6; color:#444444; margin:0 0 24px;">
            Your registration for the BeTechified Beginner Class is confirmed. Here are your details:
          </p>
        </td></tr>
        <tr><td style="padding:0 32px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #E6E6E6;">
            <tr>
              <td style="padding:12px 16px; font-size:14px; color:#6B6B6B; border-bottom:1px solid #E6E6E6;">Registration number</td>
              <td style="padding:12px 16px; font-size:16px; font-weight:bold; color:#D40000; text-align:right; border-bottom:1px solid #E6E6E6;">${regNumber}</td>
            </tr>
            <tr>
              <td style="padding:12px 16px; font-size:14px; color:#6B6B6B; border-bottom:1px solid #E6E6E6;">Track</td>
              <td style="padding:12px 16px; font-size:14px; font-weight:bold; text-align:right; border-bottom:1px solid #E6E6E6;">${trackName}</td>
            </tr>
            <tr>
              <td style="padding:12px 16px; font-size:14px; color:#6B6B6B;">Cohort</td>
              <td style="padding:12px 16px; font-size:14px; font-weight:bold; text-align:right;">${cohortName}</td>
            </tr>
          </table>
        </td></tr>
        <tr><td style="padding:24px 32px;">
          <a href="${whatsappLink}" style="display:block; background:#D40000; color:#FFFFFF; text-decoration:none; text-align:center; font-size:15px; font-weight:bold; padding:14px 20px;">Join your class group on WhatsApp</a>
          <p style="font-size:13px; line-height:1.6; color:#6B6B6B; margin:20px 0 0;">
            Keep this email safe. Your registration number will be requested during the program, and this link gets you back into your class group if you lose it.
          </p>
        </td></tr>
        <tr><td style="padding:20px 32px; border-top:1px solid #E6E6E6;">
          <p style="font-size:12px; color:#6B6B6B; margin:0;">BeTechified. Learn practical tech skills, free.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

async function sendBeginnerWelcomeEmail({ email, fullName, regNumber, trackName, cohortName, whatsappLink }) {
  const firstName = fullName.split(' ')[0];
  try {
    await ses.send(new SendEmailCommand({
      Source: 'BeTechified <newsletter@betechified.com>',
      Destination: { ToAddresses: [email] },
      Message: {
        Subject: { Data: `You are in: ${trackName}, ${cohortName} Cohort (${regNumber})` },
        Body: {
          Html: { Data: buildWelcomeHtml({ firstName, regNumber, trackName, cohortName, whatsappLink }) },
          Text: {
            Data:
              `You are in, ${firstName}.\n\n` +
              `Registration number: ${regNumber}\n` +
              `Track: ${trackName}\n` +
              `Cohort: ${cohortName}\n\n` +
              `Join your class group on WhatsApp: ${whatsappLink}\n\n` +
              `Keep this email safe. Your registration number will be requested during the program.\n\n` +
              `BeTechified`,
          },
        },
      },
    }));
  } catch (err) {
    console.error('Beginner welcome email failed for', email, err.message);
  }
}

// Public: page config. Deliberately does NOT include WhatsApp links.
app.get('/api/registration/config', async (req, res) => {
  try {
    const [{ data: settings, error: sErr }, { data: tracks, error: tErr }] =
      await Promise.all([
        supabase.from('beginner_settings').select('cohort_name, registration_open').eq('id', 1).single(),
        supabase.from('beginner_tracks').select('slug, track_name').eq('active', true).order('sort_order'),
      ]);

    if (sErr || tErr) throw sErr || tErr;

    res.json({
      cohortName: settings.cohort_name,
      registrationOpen: settings.registration_open,
      tracks,
    });
  } catch (err) {
    console.error('config error:', err);
    res.status(500).json({ error: 'Could not load registration details. Please refresh the page.' });
  }
});

// Public: register. Saves the lead first, then returns the WhatsApp link.
// link_served records which group each person got, so when a group fills
// up and the link is swapped mid-cohort, you know who is in which group.
app.post('/api/registration/register', async (req, res) => {
  try {
    const fullName = String(req.body.fullName || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const phone = String(req.body.phone || '').trim();
    const trackSlug = String(req.body.trackSlug || '').trim();

    if (!fullName || fullName.length < 2) {
      return res.status(400).json({ error: 'Please enter your full name.' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    if (!/^\+?[\d\s-]{7,20}$/.test(phone)) {
      return res.status(400).json({ error: 'Please enter a valid WhatsApp number.' });
    }

    const [{ data: settings, error: sErr }, { data: track, error: tErr }] =
      await Promise.all([
        supabase.from('beginner_settings').select('cohort_name, registration_open').eq('id', 1).single(),
        supabase.from('beginner_tracks').select('slug, track_name, whatsapp_link, active').eq('slug', trackSlug).single(),
      ]);

    if (sErr) throw sErr;
    if (!settings.registration_open) {
      return res.status(403).json({ error: 'Registration is currently closed. Please check back soon.' });
    }
    if (tErr || !track || !track.active) {
      return res.status(400).json({ error: 'Please select a valid track.' });
    }
    if (!track.whatsapp_link) {
      return res.status(503).json({ error: 'This class group is not open yet. Please try again shortly.' });
    }

    const { data: inserted, error: iErr } = await supabase
      .from('beginner_registrations')
      .insert({
        full_name: fullName,
        email,
        phone,
        track_slug: track.slug,
        cohort_name: settings.cohort_name,
        link_served: track.whatsapp_link,
      })
      .select('id')
      .single();

    // Already registered for this track this cohort: return the link they
    // were originally served, so group 1 people are not pointed to group 2.
    if (iErr && iErr.code === '23505') {
      const { data: existing } = await supabase
        .from('beginner_registrations')
        .select('id, link_served')
        .eq('email', email)
        .eq('cohort_name', settings.cohort_name)
        .eq('track_slug', track.slug)
        .single();

      return res.json({
        alreadyRegistered: true,
        registrationNumber: existing ? formatRegNumber(existing.id) : null,
        trackName: track.track_name,
        cohortName: settings.cohort_name,
        whatsappLink: (existing && existing.link_served) || track.whatsapp_link,
      });
    }
    if (iErr) throw iErr;

    const regNumber = formatRegNumber(inserted.id);

    // Send welcome email in the background; do not make the user wait.
    sendBeginnerWelcomeEmail({
      email,
      fullName,
      regNumber,
      trackName: track.track_name,
      cohortName: settings.cohort_name,
      whatsappLink: track.whatsapp_link,
    });

    res.json({
      alreadyRegistered: false,
      registrationNumber: regNumber,
      trackName: track.track_name,
      cohortName: settings.cohort_name,
      whatsappLink: track.whatsapp_link,
    });
  } catch (err) {
    console.error('register error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Admin: protected by the x-admin-key header, checked against ADMIN_KEY on Render
function requireAdmin(req, res, next) {
  const key = req.get('x-admin-key');
  if (!process.env.ADMIN_KEY || !key || key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Invalid admin key.' });
  }
  next();
}

app.get('/api/registration/admin/links', requireAdmin, async (req, res) => {
  try {
    const [{ data: settings, error: sErr }, { data: tracks, error: tErr }] =
      await Promise.all([
        supabase.from('beginner_settings').select('cohort_name, registration_open').eq('id', 1).single(),
        supabase.from('beginner_tracks').select('slug, track_name, whatsapp_link, active').order('sort_order'),
      ]);
    if (sErr || tErr) throw sErr || tErr;
    res.json({ settings, tracks });
  } catch (err) {
    console.error('admin links error:', err);
    res.status(500).json({ error: 'Could not load links.' });
  }
});

app.put('/api/registration/admin/links', requireAdmin, async (req, res) => {
  try {
    const { cohortName, registrationOpen, links } = req.body;

    const { error: sErr } = await supabase
      .from('beginner_settings')
      .update({
        cohort_name: String(cohortName || '').trim(),
        registration_open: Boolean(registrationOpen),
        updated_at: new Date().toISOString(),
      })
      .eq('id', 1);
    if (sErr) throw sErr;

    for (const link of links || []) {
      const { error: lErr } = await supabase
        .from('beginner_tracks')
        .update({
          whatsapp_link: String(link.whatsappLink || '').trim(),
          active: Boolean(link.active),
          updated_at: new Date().toISOString(),
        })
        .eq('slug', link.slug);
      if (lErr) throw lErr;
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('admin save error:', err);
    res.status(500).json({ error: 'Could not save changes.' });
  }
});

// ── Keep Supabase alive ────────────────────────────────────────────────────
const FOUR_DAYS = 4 * 24 * 60 * 60 * 1000;
setInterval(async () => {
  try {
    await supabase.from('registrants').select('id').limit(1);
    console.log('Supabase keep-alive ping sent');
  } catch (err) {
    console.error('Keep-alive ping failed:', err.message);
  }
}, FOUR_DAYS);

// ── Start ──────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.send('BeTechified Verification Server is running ✅');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));