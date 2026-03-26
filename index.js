const express = require('express');
const cors = require('cors');
const multer = require('multer');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');

const app = express();
const upload = multer({ dest: 'uploads/' });

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

app.use(cors());
app.use(express.json());

// Verify screenshot endpoint
app.post('/verify', upload.single('screenshot'), async (req, res) => {
  try {
    const imageData = fs.readFileSync(req.file.path);
    const base64 = imageData.toString('base64');
    const mediaType = req.file.mimetype;

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: base64 }
          },
          {
            type: 'text',
            text: `You are verifying a screenshot for BeTechified, a Nigerian tech education platform.

The screenshot MUST show ALL of the following to pass:
1. A WhatsApp GROUP chat — NOT a private/individual chat. Look for: group name at the top, multiple participants, group icon. If it shows a single person's name/number at the top, it is an individual chat and must FAIL.
2. A message about BeTechified — mentioning BeTechified, tech skills, tuition-free program, scholarship alert, product management, data analysis, or similar tech education content.

STRICT RULES:
- Individual/private WhatsApp chats = FAIL, even if the message is correct
- Group chats with the wrong message = FAIL
- Group chats with a BeTechified-related message = PASS

Respond with ONLY a JSON object: {"passed": true} or {"passed": false, "reason": "brief reason"}`
          }
        ]
      }]
    });

    fs.unlinkSync(req.file.path);

    const text = response.content.find(c => c.type === 'text')?.text || '';
    const clean = text.replace(/```json|```/g, '').trim();
    const result = JSON.parse(clean);

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ passed: false, reason: 'Server error' });
  }
});

// Save registrant endpoint
app.post('/register', async (req, res) => {
  try {
    const { name, email, phone, country, city, course, unique_number } = req.body;

    // Get current month sequence for this course
    const year = '26';
const month = '04'; // ← Update this manually when a new cohort opens
const prefix = `${course}${year}${month}`;`;

    // Count existing registrants with same course+month prefix
    const { count } = await supabase
      .from('registrants')
      .select('*', { count: 'exact', head: true })
.like('unique_number', `${prefix}%`);
``` 
    const seq = String((count || 0) + 1).padStart(3, '0');
    const generatedNumber = `${prefix}${seq}`;

    // Save to database
    const { data, error } = await supabase
      .from('registrants')
      .insert([{ name, email, phone, country, city, course, unique_number: generatedNumber }]);

    if (error) throw error;

    res.json({ success: true, unique_number: generatedNumber });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not save registration' });
  }
});

app.get('/', (req, res) => {
  res.send('BeTechified Verification Server is running ✅');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));