const express = require('express');
const cors = require('cors');
const multer = require('multer');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');

const app = express();
const upload = multer({ dest: 'uploads/' });
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(cors());
app.use(express.json());

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

Check if this screenshot shows:
1. A WhatsApp group chat (not a private/individual chat)
2. A message about BeTechified — mentioning BeTechified, tech skills, tuition-free program, scholarship alert, product management, data analysis, or similar tech education content

Be reasonably lenient. If the screenshot clearly shows a WhatsApp group with a BeTechified-related message, that counts.

Respond with ONLY a JSON object: {"passed": true} or {"passed": false, "reason": "brief reason"}`
          }
        ]
      }]
    });

    // Clean up uploaded file
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

app.get('/', (req, res) => {
  res.send('BeTechified Verification Server is running ✅');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));