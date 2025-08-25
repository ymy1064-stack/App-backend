import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(express.json());

// ✅ CORS सेट करें (Render variable से origin allow होगा)
// अगर कोई origin सेट नहीं है तो "*" (सभी allow)
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || "*",
  })
);

// ✅ Daily Limits (Environment Variables से)
const DAILY_LIMIT_SEO = process.env.DAILY_LIMIT_SEO || 3;
const DAILY_LIMIT_LEARN = process.env.DAILY_LIMIT_LEARN || 3;

// memory में user usage count (Production में DB चाहिए)
let usageCount = {};

// Middleware to check limits
function checkLimit(type, req, res, next) {
  const ip = req.ip;
  if (!usageCount[ip]) usageCount[ip] = { seo: 0, learn: 0 };

  if (type === "seo" && usageCount[ip].seo >= DAILY_LIMIT_SEO) {
    return res.status(429).json({ error: "SEO API limit reached today" });
  }
  if (type === "learn" && usageCount[ip].learn >= DAILY_LIMIT_LEARN) {
    return res.status(429).json({ error: "Learning API limit reached today" });
  }

  next();
}

// -------------------- Gemini API (Title, Description, Tags) --------------------
app.post("/api/seo/generate", (req, res, next) => checkLimit("seo", req, res, next), async (req, res) => {
  try {
    const { prompt } = req.body;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateText?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
        }),
      }
    );

    const data = await response.json();

    // ✅ Count increase
    const ip = req.ip;
    usageCount[ip].seo++;

    res.json(data);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Gemini API error" });
  }
});

// -------------------- OpenAI API (SEO Learning / Thumbnail Help) --------------------
app.post("/api/seo/learn", (req, res, next) => checkLimit("learn", req, res, next), async (req, res) => {
  try {
    const { question } = req.body;

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-3.5-turbo",
        messages: [{ role: "user", content: question }],
      }),
    });

    const data = await response.json();

    // ✅ Count increase
    const ip = req.ip;
    usageCount[ip].learn++;

    res.json(data);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "OpenAI API error" });
  }
});

// -------------------- Server --------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
