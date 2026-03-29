// One-off Groq connectivity test (prints status + response slice, never prints API key).
import fs from "fs";

function loadEnv(path) {
  const txt = fs.readFileSync(path, "utf8");
  const out = {};
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

const env = loadEnv(".env");
const key = env.GROQ_API_KEY;
const model = env.GROQ_MODEL || "llama3-8b-8192";

if (!key) {
  console.error("Missing GROQ_API_KEY in .env");
  process.exit(1);
}

const prompt = "Write a TikTok caption about fitness.";
const body = {
  model,
  messages: [
    {
      role: "system",
      content:
        "You are a TikTok caption generator. Output only the caption text. No markdown. No bullet points. No surrounding quotes.",
    },
    { role: "user", content: prompt },
  ],
  temperature: 0.7,
  max_tokens: 180,
};

const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(body),
});

const text = await resp.text();
console.log("status", resp.status);
console.log(text.slice(0, 800));

