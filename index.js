const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

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

const GEMINI_PROMPT = `You are a verification assistant for BeTechified, an African tech education platform.
Check whether this screenshot is a WhatsApp chat that contains a message related to BeTechified (a tech education platform, course, or registration).

Be LENIENT — if there is reasonable evidence of either a group chat or a BeTechified-related message, pass it.
Only reject if the screenshot is clearly not WhatsApp at all, or has absolutely no connection to BeTechified.

Respond with ONLY valid JSON, no markdown, no explanation:
{"valid": true} or {"valid": false, "reason": "short reason"}`;

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

    const year = '26';
    const month = '04';
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

    // Fetch last 500 registrations for this course and pick highest number mathematically
    const { data: existing } = await supabase
      .from('registrants')
      .select('unique_number')
      .like('unique_number', prefix + '%')
      .order('created_at', { ascending: false })
      .limit(500);

    let nextSeq = 1;
    if (existing && existing.length > 0) {
      const nums = existing
        .map(r => parseInt(r.unique_number.replace(prefix, '')))
        .filter(n => !isNaN(n));
      if (nums.length > 0) nextSeq = Math.max(...nums) + 1;
    }
    const generatedNumber = prefix + String(nextSeq);

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

// ── /notify-fixed ──────────────────────────────────────────────────────────
app.post('/notify-fixed', async (req, res) => {
  const { secret } = req.body;
  if (secret !== 'betechfix2026') {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // Fetch all DA registrants in batches of 1000
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