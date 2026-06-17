import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express, { Request, Response } from 'express';
import articlesRouter from './routes/articles.js';
import monitorRouter, { loadMonitorArticles } from './routes/monitor.js';
import generateRouter from './routes/generate.js';
import searchRouter from './routes/search.js';
import discoverRouter from './routes/discover.js';
import pipelineRouter from './routes/pipeline.js';
import exportRouter from './routes/export.js';
import settingsRouter from './routes/settings.js';
import { DEFAULT_PORT } from './lib/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.resolve(__dirname, '..', 'frontend');

const app = express();
app.use(express.json({ limit: '10mb' }));

const allowedOrigin = process.env.ALLOWED_ORIGIN || `http://localhost:${process.env.PORT || DEFAULT_PORT}`;
app.use((_req: Request, res: Response, next) => {
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (_req.method === 'OPTIONS') { res.sendStatus(200); return; }
  next();
});

app.use(express.static(FRONTEND_DIR));

const pages = ['articles', 'generate', 'article', 'editor', 'pipeline', 'settings'];
pages.forEach(page => {
  app.get(`/${page}`, (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(FRONTEND_DIR, `${page}.html`));
  });
});

app.get(['/', '/monitor'], (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  let html = fs.readFileSync(path.join(FRONTEND_DIR, 'monitor.html'), 'utf-8');
  const articles = loadMonitorArticles();
  html = html.replace('window.__ARTICLES__ = null', `window.__ARTICLES__ = ${JSON.stringify(articles)}`);
  res.send(html);
});

app.use('/api', articlesRouter);
app.use('/api', monitorRouter);
app.use('/api', generateRouter);
app.use('/api', searchRouter);
app.use('/api', discoverRouter);
app.use('/api', pipelineRouter);
app.use('/api', exportRouter);
app.use('/api', settingsRouter);

const PORT = parseInt(String(process.env.PORT || DEFAULT_PORT), 10);
app.listen(PORT, () => console.log(`Article Studio running at http://localhost:${PORT}`));
