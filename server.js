require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const OpenAI = require('openai');
const twilio = require('twilio');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware for JSON and URL-encoded (needed for Twilio webhooks)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Twilio client
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

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

function isOutOfScope(userText) {
  const lower = userText.toLowerCase();
  // Keywords that indicate out-of-scope queries
  const outOfScopeKeywords = [
    'appointment', 'book', 'schedule', 'insurance coverage', 'claim', 'policy',
    'stock', 'price', 'weather', 'joke', 'recipe', 'sports', 'news',
    'movie', 'music', 'restaurant', 'hotel', 'flight', 'travel'
  ];
  
  // Check if query contains out-of-scope keywords and no hospital-related keywords
  const hospitalKeywords = ['hospital', 'network', 'clinic', 'medical', 'doctor', 'nursing'];
  const hasHospitalKeyword = hospitalKeywords.some(kw => lower.includes(kw));
  const hasOutOfScopeKeyword = outOfScopeKeywords.some(kw => lower.includes(kw));
  
  // If it has out-of-scope keywords but no hospital keywords, likely out of scope
  if (hasOutOfScopeKeyword && !hasHospitalKeyword) {
    return true;
  }
  
  // Very short queries that don't mention hospitals
  if (userText.trim().split(/\s+/).length < 3 && !hasHospitalKeyword) {
    return false; // Too short to determine, let OpenAI decide
  }
  
  return false;
}

function naiveParse(userText) {
  const lower = userText.toLowerCase();
  let intent = 'IN_SCOPE';
  let city = '';
  let hospitalName = '';
  let maxResults = 3;

  // Check for out-of-scope first
  if (isOutOfScope(userText)) {
    return {
      intent: 'OUT_OF_SCOPE',
      city: '',
      hospitalName: '',
      maxResults: 3,
      outOfScope: true
    };
  }

  if (lower.includes('around') || lower.includes('near') || lower.includes('nearby')) {
    intent = 'FIND_NEARBY';
  } else if (
    lower.includes('confirm') ||
    lower.includes('in my network') ||
    (lower.includes('is') && lower.includes('network'))
  ) {
    intent = 'CONFIRM_IN_NETWORK';
  }

  // Extract city - look for "in [city]" pattern
  const cityPatterns = [
    /in\s+([a-z\s]+?)(?:\s+is|\s+in\s+my\s+network|$)/i,
    /in\s+([a-z\s]+?)(?:\s+or\s+not|$)/i,
    /in\s+([a-z\s]+?)(?:\s+[?.!]|$)/i
  ];
  
  for (const pattern of cityPatterns) {
    const match = userText.match(pattern);
    if (match && match[1]) {
      city = match[1].trim().replace(/[?.!]/g, '');
      break;
    }
  }

  // Fallback: check for common city names
  if (!city) {
    const cities = ['bangalore', 'delhi', 'mumbai', 'chennai', 'kolkata', 'hyderabad', 'pune', 'noida', 'gurgaon', 'ghaziabad', 'faridabad'];
    for (const c of cities) {
      if (lower.includes(c)) {
        city = c.charAt(0).toUpperCase() + c.slice(1);
        break;
      }
    }
  }

  if (intent === 'CONFIRM_IN_NETWORK') {
    // Extract hospital name - look for patterns like:
    // "confirm [name] in [city]"
    // "can you confirm [name] in [city]"
    // "[name] in [city] is in my network"
    const patterns = [
      /(?:can\s+you\s+)?confirm\s+(.+?)\s+in\s+/i,
      /confirm\s+if\s+(.+?)\s+in\s+/i,
      /confirm\s+whether\s+(.+?)\s+in\s+/i,
      /if\s+(.+?)\s+in\s+/i,
      /(.+?)\s+in\s+[a-z\s]+?\s+(?:is\s+)?in\s+my\s+network/i
    ];

    for (const pattern of patterns) {
      const match = userText.match(pattern);
      if (match && match[1]) {
        hospitalName = match[1].trim();
        // Remove trailing words that might be part of the query structure
        hospitalName = hospitalName.replace(/\s+(is|are|was|were|in|the|a|an)\s*$/i, '').trim();
        if (hospitalName && hospitalName.length > 2) {
          break;
        }
      }
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

    const result = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
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
          strict: true,
          schema: {
            type: 'object',
            properties: {
              intent: { 
                type: 'string',
                enum: ['FIND_NEARBY', 'CONFIRM_IN_NETWORK', 'OUT_OF_SCOPE']
              },
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

    const parsed = JSON.parse(result.choices[0].message.content);
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

// Shared query handler function (used by both web and Twilio)
async function handleQuery(userText, isFirstMessage = false) {
  if (!userText || !userText.trim()) {
    return {
      reply: 'I am Loop AI, your hospital network assistant. How can I help you today?',
      endConversation: false
    };
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
      return {
        reply: "I'm sorry, I can't help with that. I am forwarding this to a human agent.",
        endConversation: true
      };
    }

    // Handle search intents
    if (info.intent === 'FIND_NEARBY') {
      if (!info.city) {
        return {
          reply: "I can definitely help you find hospitals, but I need to know the city. In which city are you looking for hospitals?",
          endConversation: false
        };
      }
      const results = searchHospitalsAroundCity(info.city, info.maxResults || 3);
      if (!results.length) {
        return {
          reply: `I could not find any hospitals in our network for ${info.city}.`,
          endConversation: false
        };
      }
      const lines = results.map(
        (h, idx) => `${idx + 1}. ${h.name}, ${h.address}, ${h.city}`
      );
      const reply =
        `Here are ${results.length} hospitals around ${info.city}: ` +
        lines.join(' ');
      return { reply, endConversation: false };
    }

    if (info.intent === 'CONFIRM_IN_NETWORK') {
      if (!info.hospitalName) {
        return {
          reply: 'I found several similar names. Can you please repeat the full hospital name and city?',
          endConversation: false
        };
      }
      if (!info.city) {
        return {
          reply: 'I have found hospitals with this name in multiple locations. In which city are you looking for this hospital?',
          endConversation: false
        };
      }
      const matches = findHospitalInCityByName(info.hospitalName, info.city);
      if (matches.length > 0) {
        return {
          reply: `Yes, ${info.hospitalName} in ${info.city} is in your Loop network.`,
          endConversation: false
        };
      }
      return {
        reply: `I could not find ${info.hospitalName} in ${info.city} in your Loop network.`,
        endConversation: false
      };
    }

    // Fallback: treat as in-scope but unclear
    const intro = isFirstMessage 
      ? 'Hi, I am Loop AI, your hospital network assistant. '
      : '';
    return {
      reply: intro + 'I can help you find hospitals in a city or confirm if a specific hospital in a city is in your network.',
      endConversation: false
    };
  } catch (err) {
    console.error('Error handling query:', err);
    return {
      reply: 'Sorry, something went wrong while processing your request.',
      endConversation: false
    };
  }
}

// Web API endpoint (existing)
app.post('/api/query', async (req, res) => {
  const userText = (req.body && req.body.text) || '';
  if (!userText.trim()) {
    return res.status(400).json({ error: 'Missing text' });
  }

  const result = await handleQuery(userText, !req.body.introduced);
  return res.json(result);
});

// Twilio Voice Webhook - Initial call handler
app.post('/twilio/voice', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  
  // Introduction
  twiml.say(
    'Hi, I am Loop AI, your hospital network assistant. I can help you find hospitals in a city or confirm if a specific hospital is in your network.',
    { voice: 'alice', language: 'en-IN' }
  );
  
  // Gather speech input
  const gather = twiml.gather({
    input: 'speech',
    language: 'en-IN',
    speechTimeout: 'auto',
    action: '/twilio/voice/response',
    method: 'POST',
    numDigits: 0
  });
  
  gather.say('Please ask your question.', { voice: 'alice', language: 'en-IN' });
  
  // Fallback if no input
  twiml.say('I did not receive your question. Please call again.', { voice: 'alice', language: 'en-IN' });
  twiml.hangup();
  
  res.type('text/xml');
  res.send(twiml.toString());
});

// Twilio Voice Webhook - Handle user response
app.post('/twilio/voice/response', async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const userSpeech = req.body.SpeechResult || '';
  const callSid = req.body.CallSid;
  
  // Store conversation state (simple in-memory for demo, use Redis/DB in production)
  if (!global.twilioSessions) {
    global.twilioSessions = {};
  }
  const isFirstMessage = !global.twilioSessions[callSid];
  global.twilioSessions[callSid] = true;
  
  if (!userSpeech || !userSpeech.trim()) {
    twiml.say('I did not understand. Please ask your question again.', { voice: 'alice', language: 'en-IN' });
    const gather = twiml.gather({
      input: 'speech',
      language: 'en-IN',
      speechTimeout: 'auto',
      action: '/twilio/voice/response',
      method: 'POST'
    });
    twiml.hangup();
    res.type('text/xml');
    return res.send(twiml.toString());
  }
  
  // Process the query
  const result = await handleQuery(userSpeech, isFirstMessage);
  
  // Speak the response
  twiml.say(result.reply, { voice: 'alice', language: 'en-IN' });
  
  // If conversation should end (out of scope), hang up
  if (result.endConversation) {
    twiml.hangup();
  } else {
    // Continue conversation - gather next input
    const gather = twiml.gather({
      input: 'speech',
      language: 'en-IN',
      speechTimeout: 'auto',
      action: '/twilio/voice/response',
      method: 'POST'
    });
    gather.say('You can ask another question, or say goodbye to end the call.', { voice: 'alice', language: 'en-IN' });
    
    // Timeout fallback
    twiml.say('Thank you for calling Loop AI. Goodbye.', { voice: 'alice', language: 'en-IN' });
    twiml.hangup();
  }
  
  res.type('text/xml');
  res.send(twiml.toString());
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


