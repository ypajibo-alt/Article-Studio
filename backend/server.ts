import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express, { Request, Response } from 'express';
import articlesRouter from './routes/articles.js';
import monitorRouter from './routes/monitor.js';
import generateRouter from './routes/generate.js';
import searchRouter from './routes/search.js';
import discoverRouter from './routes/discover.js';
import pipelineRouter from './routes/pipeline.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.resolve(__dirname, '..', 'frontend');
const ARTICLES_DIR = path.resolve(__dirname, '..', 'the-t-data', 'data', 'articles');

function loadMonitorArticles() {
  try {
    const files = fs.readdirSync(ARTICLES_DIR).filter(f => f.endsWith('.json'));
    return files.map(file => {
      const raw = JSON.parse(fs.readFileSync(path.join(ARTICLES_DIR, file), 'utf-8'));
      const type = String(raw.type ?? '');
      const items = type === 'listicle'
        ? (raw.items ?? []).map((item: Record<string, unknown>, idx: number) => ({
            position: item.position ?? idx + 1,
            title: String(item.title ?? ''),
            content_title: String(item.contentTitle ?? item.title ?? ''),
            tubi_link: String(item.tubiLink ?? ''),
            contentId: String(item.contentId ?? '') || null,
          }))
        : (() => {
            const hero = (raw.hero ?? {}) as Record<string, unknown>;
            const contentId = String(hero.contentId ?? '') || null;
            return contentId ? [{ position: 1, title: String(raw.title ?? ''), content_title: String(raw.title ?? ''), tubi_link: String(hero.watchLink ?? ''), contentId }] : [];
          })();
      return {
        id: String(raw.id ?? ''),
        slug: String(raw.slug ?? ''),
        articleType: type === 'listicle' ? 'listicle' : 'single',
        title: String(raw.title ?? ''),
        subtitle: String(raw.subtitle ?? ''),
        itemCount: items.length,
        items,
      };
    });
  } catch {
    return [];
  }
}

const app = express();
app.use(express.json({ limit: '10mb' }));

app.use((_req: Request, res: Response, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (_req.method === 'OPTIONS') { res.sendStatus(200); return; }
  next();
});

app.use(express.static(FRONTEND_DIR));

const pages = ['articles', 'generate', 'article', 'editor', 'pipeline'];
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

const PORT = parseInt(process.env.PORT || '3002', 10);
app.listen(PORT, () => console.log(`Article Studio running at http://localhost:${PORT}`));
