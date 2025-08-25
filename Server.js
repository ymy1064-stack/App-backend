// server.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import crypto from 'crypto';
import fetch from 'node-fetch'; // node-fetch v3 (ESM)

// --------- CONFIG (set via environment) ----------
const PORT = process.env.PORT || 8080;
const ORIGIN = process.env.CORS_ORIGIN || '*';

// Put your API keys into environment variables (Render / .env)
// If missing, the server will still run and return safe fallback text.
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';          // optional
const OPENAI_LEARN_KEY = process.env.OPENAI_LEARN_KEY || '';    // optional (can be same)
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';         // optional
const GEMINI_LEARN_KEY = process.env.GEMINI_LEARN_KEY || '';     // optional

const DAILY_LIMIT_SEO = Number(process.env.DAILY_LIMIT_SEO || 3);
const DAILY_LIMIT_LEARN = Number(process.env.DAILY_LIMIT_LEARN || 3);

// --------- APP ----------
const app = express();
app.use(cors({ origin: ORIGIN }));
app.use(express.json({ limit: '1mb' }));
app.use(morgan('tiny'));

// --------- Simple in-memory storage & counters (demo)
// For production use Redis / RDS / persistent DB.
const seoCache = new Map();    // key -> { data, provider, at }
const learnCache = new Map();
const dailyCounters = new Map(); // date -> Map(userKey -> { seo, learn })

const sha1 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');
const today = () => new Date().toISOString().slice(0, 10);

// create a user key from x-user header if present, else IP+UA
function getUserKey(req) {
  const headerUser = (req.headers['x-user'] || '').toString().trim();
  if (headerUser) return sha1('user:' + headerUser);
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '0.0.0.0';
  const ua = (req.headers['user-agent'] || '').slice(0, 200);
  return sha1(`${ip}|${ua}`);
}

function getDayMap(dateKey) {
  if (!dailyCounters.has(dateKey)) dailyCounters.set(dateKey, new Map());
  return dailyCounters.get(dateKey);
}

function getCounts(dateKey, userKey) {
  const dayMap = getDayMap(dateKey);
  if (!dayMap.has(userKey)) dayMap.set(userKey, { seo: 0, learn: 0 });
  return dayMap.get(userKey);
}

// increment and check remaining
function remainings(dateKey, userKey) {
  const c = getCounts(dateKey, userKey);
  return {
    seo: Math.max(0, DAILY_LIMIT_SEO - (c.seo || 0)),
    learn: Math.max(0, DAILY_LIMIT_LEARN - (c.learn || 0)),
  };
}
function incCount(dateKey, userKey, type) {
  const c = getCounts(dateKey, userKey);
  c[type] = (c[type] || 0) + 1;
}

// --------- Lightweight AI callers with graceful fallback ---------
async function callOpenAI(prompt, apiKey = OPENAI_API_KEY) {
  if (!apiKey) return { ok: false, reason: 'no_openai_key' };
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini', // might change per availability; you can change in env if needed
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.6,
        max_tokens: 800,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      console.warn('OpenAI non-ok:', res.status, text);
      return { ok: false, reason: 'openai_error', status: res.status, text };
    }
    const j = await res.json();
    const content = j.choices?.[0]?.message?.content || (j.choices?.[0]?.text) || '';
    return { ok: true, provider: 'openai', text: content };
  } catch (e) {
    console.warn('OpenAI call failed', e.message || e);
    return { ok: false, reason: 'openai_exception', error: String(e) };
  }
}

async function callGemini(prompt, apiKey = GEMINI_API_KEY) {
  // Note: Google Generative API endpoints and request shape might differ.
  // We'll attempt a simple REST call pattern — if key missing or fails, fallback gracefully.
  if (!apiKey) return { ok: false, reason: 'no_gemini_key' };
  try {
    // Example endpoint: this may require adjustment depending on your Google setup.
    const url = `https://generativelanguage.googleapis.com/v1beta/models/text-bison-001:generateText?key=${apiKey}`;
    const body = { prompt: { text: prompt }, // simple form
                   temperature: 0.6, maxOutputTokens: 512 };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const t = await res.text();
      console.warn('Gemini non-ok', res.status, t);
      return { ok: false, reason: 'gemini_error', status: res.status, text: t };
    }
    const j = await res.json();
    // The shape differs by API; try to extract text safely
    const text =
      (j?.candidates?.[0]?.content?.text) ||
      (j?.outputText) ||
      (typeof j === 'string' ? j : JSON.stringify(j));
    return { ok: true, provider: 'gemini', text: text };
  } catch (e) {
    console.warn('Gemini call failed', e.message || e);
    return { ok: false, reason: 'gemini_exception', error: String(e) };
  }
}

// unified SEO AI call: try Gemini then OpenAI, else return failure
async function aiSeo(prompt) {
  if (GEMINI_API_KEY) {
    const g = await callGemini(prompt, GEMINI_API_KEY);
    if (g.ok) return g;
  }
  if (OPENAI_API_KEY) {
    const o = await callOpenAI(prompt, OPENAI_API_KEY);
    if (o.ok) return o;
  }
  return { ok: false, reason: 'no_providers_ok' };
}

// unified Learn AI call: try Gemini_LEARN then OPENAI_LEARN
async function aiLearn(prompt) {
  if (GEMINI_LEARN_KEY) {
    const g = await callGemini(prompt, GEMINI_LEARN_KEY);
    if (g.ok) return g;
  }
  if (OPENAI_LEARN_KEY) {
    const o = await callOpenAI(prompt, OPENAI_LEARN_KEY);
    if (o.ok) return o;
  }
  return { ok: false, reason: 'no_providers_ok' };
}

// --------- Prompt builders (concise & safe) ----------
function buildSeoPrompt({ topic = '', script = '', language = 'en', shorts = false }) {
  const langLabel = language === 'hi' ? 'Hindi' : language === 'hinglish' ? 'Hinglish' : 'English';
  return `
You are a concise YouTube SEO assistant. Language: ${langLabel}.
Output ONLY JSON with keys: title (<=100 chars), description (3-6 lines), tags (array of strings).
Video type: ${shorts ? 'Shorts' : 'Long form'}.
Topic: ${topic || 'General'}.
Script excerpt: ${String(script).slice(0, 1000)}.

Constraints:
- Title: clickable but honest.
- Description: 3 bullet lines + CTA.
- Tags: 10-25 relevant tags.

Return compact JSON only.
`.trim();
}

function buildLearnPrompt({ question = '', language = 'en', section = 'seo-basics' }) {
  const langLabel = language === 'hi' ? 'Hindi' : 'English';
  return `
You are a clear SEO teacher. Language: ${langLabel}.
Section: ${section}.
User question: ${String(question).slice(0, 800)}.

Give a short answer (4-8 sentences) and 3 practical tips. Keep it simple.
Return plain text (no JSON).
`.trim();
}

// --------- Routes ----------

// Health
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString(), note: 'Working demo backend' });
});

// Quota status
app.get('/api/quota', (req, res) => {
  const userKey = getUserKey(req);
  const d = today();
  const r = remainings(d, userKey);
  res.json({ ok: true, date: d, remaining: r });
});

/**
 * POST /api/seo/generate
 * body: { topic, script, language, shorts }
 * header optional: x-user (string) to identify a specific user
 */
app.post('/api/seo/generate', async (req, res) => {
  try {
    const userKey = getUserKey(req);
    const d = today();
    const rem = remainings(d, userKey);
    if (rem.seo <= 0) {
      return res.status(429).json({ ok: false, error: `Daily SEO limit reached (${DAILY_LIMIT_SEO})` });
    }

    const { topic = '', script = '', language = 'en', shorts = false } = req.body || {};
    const cacheKey = sha1(JSON.stringify({ topic, script, language, shorts }));

    // Serve cache if present (cache does not consume quota)
    if (seoCache.has(cacheKey)) {
      const item = seoCache.get(cacheKey);
      return res.json({ ok: true, cached: true, provider: item.provider || 'cache', data: item.data });
    }

    // Build prompt and call AI
    const prompt = buildSeoPrompt({ topic, script, language, shorts });
    const ai = await aiSeo(prompt);

    if (!ai.ok) {
      // fallback sample output (safe)
      incCount(d, userKey, 'seo'); // still count attempt to avoid abuse
      const fallback = {
        title: `Quick tips: ${topic || 'Grow on YouTube'}`,
        description: `Quick guide for ${topic || 'YouTube'}:\n• Use clear title with 1 main keyword\n• Keep thumbnail 2–4 bold words\n• Add 10+ relevant tags\nCTA: Subscribe for more.`,
        tags: ['youtube', 'seo', 'tips', 'growth']
      };
      return res.status(503).json({ ok: false, error: 'AI unavailable', fallback });
    }

    // Try to parse JSON from ai.text (AI asked to return JSON)
    let parsed = null;
    try {
      const jsonMatch = ai.text.match(/\{[\s\S]*\}/);
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(ai.text);
    } catch (e) {
      // If parse fails, attempt a best-effort extraction:
      parsed = {
        title: String(ai.text).slice(0, 100),
        description: String(ai.text).slice(0, 400),
        tags: []
      };
    }

    // Save to cache and increment quota
    seoCache.set(cacheKey, { provider: ai.provider || 'ai', data: parsed, at: Date.now() });
    incCount(d, userKey, 'seo');

    return res.json({ ok: true, cached: false, provider: ai.provider || 'ai', data: parsed });
  } catch (err) {
    console.error('seo/generate error', err);
    return res.status(500).json({ ok: false, error: 'server error' });
  }
});

/**
 * POST /api/learn/ask
 * body: { question, language, section }
 */
app.post('/api/learn/ask', async (req, res) => {
  try {
    const userKey = getUserKey(req);
    const d = today();
    const rem = remainings(d, userKey);
    if (rem.learn <= 0) {
      return res.status(429).json({ ok: false, error: `Daily Learn limit reached (${DAILY_LIMIT_LEARN})` });
    }

    const { question = '', language = 'en', section = 'seo-basics' } = req.body || {};
    const cacheKey = sha1(JSON.stringify({ question, language, section }));

    if (learnCache.has(cacheKey)) {
      const item = learnCache.get(cacheKey);
      return res.json({ ok: true, cached: true, provider: item.provider || 'cache', answer: item.answer });
    }

    const prompt = buildLearnPrompt({ question, language, section });
    const ai = await aiLearn(prompt);

    if (!ai.ok) {
      // fallback: simple manual lesson snippet
      incCount(d, userKey, 'learn');
      const fallbackAnswer = `Manual SEO tip:\n- Title: keep main keyword early\n- Thumbnail: contrast + big text\n- Description: 3 lines + CTA\n(Full AI unavailable)`;
      return res.status(503).json({ ok: false, error: 'AI unavailable', fallback: { answer: fallbackAnswer } });
    }

    const answer = String(ai.text || '').trim();
    learnCache.set(cacheKey, { provider: ai.provider || 'ai', answer, at: Date.now() });
    incCount(d, userKey, 'learn');
    return res.json({ ok: true, cached: false, provider: ai.provider || 'ai', answer });
  } catch (err) {
    console.error('learn/ask error', err);
    return res.status(500).json({ ok: false, error: 'server error' });
  }
});

// 404
app.use((req, res) => res.status(404).json({ ok: false, error: 'not found' }));

// Start server
app.listen(PORT, () => {
  console.log(`✅ Backend running on port ${PORT}`);
});
