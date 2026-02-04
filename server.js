require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Load hospitals data from CSV
const HOSPITAL_CSV_PATH = path.join(__dirname, 'data', 'hospitals.csv');
let hospitals = [];

function loadHospitals() {
  return new Promise((resolve, reject) => {
    const rows = [];
    fs.createReadStream(HOSPITAL_CSV_PATH)
      .pipe(csv())
      .on('data', (row) => {
        // Normalize a few common columns (adjust if your headers differ)
        rows.push({
          name: (row['HOSPITAL NAME'] || row['Hospital Name'] || '').trim(),
          address: (row['Address'] || '').trim(),
          city: (row['CITY'] || row['City'] || '').trim()
        });
      })
      .on('end', () => {
        hospitals = rows;
        console.log(`Loaded ${hospitals.length} hospitals`);
        resolve();
      })
      .on('error', (err) => {
        console.error('Error loading hospitals CSV:', err.message);
        reject(err);
      });
  });
}

// Simple in-memory search helpers
function searchHospitalsAroundCity(city, limit = 3) {
  if (!city) return [];
  const cityUpper = city.toUpperCase();
  const matches = hospitals.filter((h) =>
    (h.city || '').toUpperCase().includes(cityUpper)
  );
  return matches.slice(0, limit);
}

function findHospitalInCityByName(name, city) {
  if (!name || !city) return [];
  const nameUpper = name.toUpperCase();
  const cityUpper = city.toUpperCase();
  return hospitals.filter((h) => {
    const n = (h.name || '').toUpperCase();
    const c = (h.city || '').toUpperCase();
    return n.includes(nameUpper) && c.includes(cityUpper);
  });
}

// OpenAI client (used for intent + slot extraction and out-of-scope detection)
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || ''
});

function naiveParse(userText) {
  const lower = userText.toLowerCase();
  let intent = 'IN_SCOPE';
  let city = '';
  let hospitalName = '';
  let maxResults = 3;

  if (lower.includes('around') || lower.includes('near') || lower.includes('nearby')) {
    intent = 'FIND_NEARBY';
  } else if (
    lower.includes('confirm') ||
    lower.includes('in my network') ||
    lower.includes('is')
  ) {
    intent = 'CONFIRM_IN_NETWORK';
  }

  // crude "in <city>" capture
  const inIdx = lower.lastIndexOf(' in ');
  if (inIdx !== -1) {
    city = userText.substring(inIdx + 4).replace(/[.?]/g, '').trim();
  } else if (lower.includes('bangalore')) {
    city = 'Bangalore';
  }

  if (intent === 'CONFIRM_IN_NETWORK') {
    // take words between 'confirm if'/'confirm whether' and 'in <city>'
    const match =
      userText.match(/confirm if (.+?) in/i) ||
      userText.match(/confirm whether (.+?) in/i) ||
      userText.match(/if (.+?) in/i);
    if (match && match[1]) {
      hospitalName = match[1].trim();
    }
  }

  return {
    intent,
    city,
    hospitalName,
    maxResults,
    outOfScope: false
  };
}

async function extractQueryInfo(userText) {
  // If no key, or anything fails with OpenAI, fall back to local parsing
  if (!process.env.OPENAI_API_KEY) {
    return naiveParse(userText);
  }

  try {
    const systemPrompt =
      'You are a parser for a hospital search assistant. ' +
      'Given a user query, you MUST respond with a short JSON object only, no extra text. ' +
      'Fields: intent ("FIND_NEARBY" or "CONFIRM_IN_NETWORK" or "OUT_OF_SCOPE"), ' +
      'city (string, may be empty), hospitalName (string, may be empty), ' +
      'maxResults (integer, default 3). ' +
      'If the question is not about hospitals in the provided network, set intent to "OUT_OF_SCOPE".';

    const result = await openai.responses.create({
      model: 'gpt-4.1-mini',
      input: [
        {
          role: 'system',
          content: systemPrompt
        },
        {
          role: 'user',
          content: userText
        }
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'HospitalQuery',
          schema: {
            type: 'object',
            properties: {
              intent: { type: 'string' },
              city: { type: 'string' },
              hospitalName: { type: 'string' },
              maxResults: { type: 'integer' }
            },
            required: ['intent', 'city', 'hospitalName', 'maxResults'],
            additionalProperties: false
          }
        }
      }
    });

    const parsed = result.output[0].content[0].json;
    return {
      intent: parsed.intent,
      city: parsed.city,
      hospitalName: parsed.hospitalName,
      maxResults: parsed.maxResults || 3,
      outOfScope: parsed.intent === 'OUT_OF_SCOPE'
    };
  } catch (err) {
    console.error('OpenAI parsing failed, falling back to naive parse:', err.message);
    return naiveParse(userText);
  }
}

app.post('/api/query', async (req, res) => {
  const userText = (req.body && req.body.text) || '';
  if (!userText.trim()) {
    return res.status(400).json({ error: 'Missing text' });
  }

  try {
    const info = await extractQueryInfo(userText);

    // Heuristic upgrade: if parser said IN_SCOPE but we have enough info,
    // route to a concrete intent so user doesn't always get the generic message.
    if (info.intent === 'IN_SCOPE') {
      if (info.city && !info.hospitalName) {
        info.intent = 'FIND_NEARBY';
      } else if (info.city && info.hospitalName) {
        info.intent = 'CONFIRM_IN_NETWORK';
      }
    }

    if (info.outOfScope || info.intent === 'OUT_OF_SCOPE') {
      return res.json({
        reply:
          "I'm sorry, I can't help with that. I am forwarding this to a human agent.",
        endConversation: true
      });
    }

    // Handle search intents
    if (info.intent === 'FIND_NEARBY') {
      if (!info.city) {
        return res.json({
          reply:
            "I can definitely help you find hospitals, but I need to know the city. In which city are you looking for hospitals?",
          endConversation: false
        });
      }
      const results = searchHospitalsAroundCity(info.city, info.maxResults || 3);
      if (!results.length) {
        return res.json({
          reply: `I could not find any hospitals in our network for ${info.city}.`,
          endConversation: false
        });
      }
      const lines = results.map(
        (h, idx) => `${idx + 1}. ${h.name}, ${h.address}, ${h.city}`
      );
      const reply =
        `Here are ${results.length} hospitals around ${info.city}: ` +
        lines.join(' ');
      return res.json({ reply, endConversation: false });
    }

    if (info.intent === 'CONFIRM_IN_NETWORK') {
      if (!info.hospitalName) {
        return res.json({
          reply:
            'I found several similar names. Can you please repeat the full hospital name and city?',
          endConversation: false
        });
      }
      if (!info.city) {
        return res.json({
          reply:
            'I have found hospitals with this name in multiple locations. In which city are you looking for this hospital?',
          endConversation: false
        });
      }
      const matches = findHospitalInCityByName(info.hospitalName, info.city);
      if (matches.length > 0) {
        return res.json({
          reply: `Yes, ${info.hospitalName} in ${info.city} is in your Loop network.`,
          endConversation: false
        });
      }
      return res.json({
        reply: `I could not find ${info.hospitalName} in ${info.city} in your Loop network.`,
        endConversation: false
      });
    }

    // Fallback: treat as in-scope but unclear
    return res.json({
      reply:
        'I am Loop AI, your hospital network assistant. You can ask me to find hospitals in a city or confirm if a specific hospital in a city is in your network.',
      endConversation: false
    });
  } catch (err) {
    console.error('Error handling /api/query:', err);
    return res.status(500).json({
      error: 'Internal server error'
    });
  }
});

// Simple health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

loadHospitals()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  })
  .catch(() => {
    console.error('Failed to start server because hospitals CSV could not be loaded.');
  });


