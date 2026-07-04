import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const OLLAMA_URL = 'http://localhost:11434/api';
const EMBED_MODEL = 'nomic-embed-text';
const CHAT_MODEL = 'gemma3:270m';
const PORT = 3001;
const WWW_ROOT = path.dirname(fileURLToPath(import.meta.url));

const PG_CONFIG = {
  host: 'localhost',
  port: 5432,
  user: 'myuser',
  password: 'mypassword',
  database: 'mydatabase'
};

const SYSTEM_PROMPT = `You are Attic Shield AI, a helpful assistant for Attic Shield — a licensed attic insulation, rodent proofing, and crawl space company. You will be given relevant context from the company's knowledge base to answer the user's question.

IMPORTANT RULES:
- Be friendly, professional, and concise (keep responses under 4 sentences)
- If asked about pricing, say "We offer free estimates! Call (858) 402-0066 to schedule yours."
- If asked about availability, say "We're available Mon-Fri 7am-5pm and Sun 9am-2pm."
- Always offer to schedule a free inspection
- Never make up pricing or technical details not found in the context
- If you don't know something, just say so and offer to connect them with a specialist`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

async function ollamaChat(messages) {
  const res = await fetch(`${OLLAMA_URL}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: CHAT_MODEL, messages, stream: false })
  });
  if (!res.ok) throw new Error(`Ollama error: ${res.status}`);
  const data = await res.json();
  return data.message?.content || '';
}

async function embed(text) {
  const res = await fetch(`${OLLAMA_URL}/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, prompt: text })
  });
  const data = await res.json();
  return data.embedding;
}

async function searchDocs(query, limit = 3) {
  const queryVec = await embed(query);
  const client = new pg.Client(PG_CONFIG);
  await client.connect();
  const result = await client.query(
    `SELECT title, content, category,
            1 - (embedding <=> $1::vector) AS similarity
     FROM attic_docs
     ORDER BY embedding <=> $1::vector
     LIMIT $2`,
    [`[${queryVec.join(',')}]`, limit]
  );
  await client.end();
  return result.rows;
}

async function serveStatic(req, res) {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index-atticshield.html';

  const filePath = path.join(WWW_ROOT, urlPath);

  if (!filePath.startsWith(WWW_ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    const data = await fs.promises.readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  } catch (err) {
    if (err.code === 'ENOENT') {
      res.writeHead(404);
      res.end('Not found');
    } else {
      res.writeHead(500);
      res.end('Server error');
    }
  }
}

const srv = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { message, history = [] } = JSON.parse(body);
        if (!message) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'message is required' }));
          return;
        }

        const relevantDocs = await searchDocs(message);
        const context = relevantDocs
          .map(d => `[${d.category}] ${d.title}\n${d.content}`)
          .join('\n\n');

        const messages = [
          { role: 'system', content: SYSTEM_PROMPT },
          ...(context ? [{ role: 'system', content: `Relevant context:\n${context}` }] : []),
          ...history,
          { role: 'user', content: message }
        ];

        const reply = await ollamaChat(messages);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ reply }));
      } catch (err) {
        console.error('Chat server error:', err);
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (req.method === 'GET') {
    serveStatic(req, res);
    return;
  }

  res.writeHead(405);
  res.end(JSON.stringify({ error: 'Method not allowed' }));
});

srv.listen(PORT, () => {
  console.log(`Attic Shield RAG Chat Server running on http://localhost:${PORT}`);
  console.log(`Embeddings: ${EMBED_MODEL} | Chat: ${CHAT_MODEL}`);
  console.log(`Serving static files from: ${WWW_ROOT}`);
});
