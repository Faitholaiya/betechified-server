const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const OpenAI = require('openai');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');

const app = express();
const upload = multer({ dest: 'uploads/' });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const ses = new SESClient({
  region: 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

app.use(cors());
app.use(express.json());

app.post('/verify', upload.single('screenshot'), async (req, res) => {
  try {
    const imageData = fs.readFileSync(req.file.path);
    const base64 = imageData.toString('base64');
    const mediaType = req.file.mimetype;

    let response;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        response = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          max_tokens: 200,
          messages: [{
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: { url: 'data:' + mediaType + ';base64,' + base64 }
              },
              {
                type: 'text',
                text: 'You are verifying a screenshot for BeTechified, a Nigerian tech education platform. The screenshot MUST show: 1. A WhatsApp GROUP chat (not a private/individual chat). 2. A message about BeTechified, tech skills, tuition-free program, scholarship alert, product management, data analysis, or similar tech education content. RULES: Individual/private WhatsApp chats = FAIL. Group chats with wrong message = FAIL. Group chats with BeTechified message = PASS. Respond with ONLY a JSON object: {"passed": true} or {"passed": false, "reason": "brief reason"}'
              }
            ]
          }]
        });
        break;
      } catch (err) {
        if (attempt === 2) throw err;
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    fs.unlinkSync(req.file.path);

    const text = response.choices[0].message.content || '';
    const clean = text.replace(/```json/g, '').replace(/```/g, '').trim();
    const result = JSON.parse(clean);

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ passed: false, reason: 'Server error' });
  }
});

app.post('/register', async (req, res) => {
  try {
    const { name, email, phone, country, city, course } = req.body;

    const year = '26';
    const month = '04';
    const prefix = course + year + month;

    const { data: existingEmail } = await supabase
      .from('registrants')
      .select('unique_number')
      .eq('email', email)
      .like('unique_number', prefix + '%');

    if (existingEmail && existingEmail.length > 0) {
      return res.json({ success: false, already_registered: true, unique_number: existingEmail[0].unique_number });
    }

    const { data: existing } = await supabase
      .from('registrants')
      .select('unique_number')
      .like('unique_number', prefix + '%');

    let nextSeq = 1;
    if (existing && existing.length > 0) {
      const numbers = existing.map(r => parseInt(r.unique_number.slice(-3)));
      nextSeq = Math.max(...numbers) + 1;
    }
    const seq = String(nextSeq).padStart(3, '0');
    const generatedNumber = prefix + seq;

    const { error } = await supabase
      .from('registrants')
      .insert([{ name, email, phone, country, city, course, unique_number: generatedNumber }]);

    if (error) throw error;

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

app.get('/', (req, res) => {
  res.send('BeTechified Verification Server is running ✅');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));