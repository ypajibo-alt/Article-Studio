import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';
import express, { Request, Response } from 'express';
import articlesRouter from './routes/articles.js';
import monitorRouter from './routes/monitor.js';
import gitRouter from './routes/git.js';
import pipelineRouter from './routes/pipeline.js';
import historyRouter from './routes/history.js';
import generateRouter from './routes/generate.js';
import searchRouter from './routes/search.js';
import discoverRouter from './routes/discover.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.resolve(__dirname, '..', 'frontend');

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

const pages = ['articles', 'generate', 'article', 'editor', 'pipeline', 'history', 'git', 'monitor'];
pages.forEach(page => {
  app.get(`/${page}`, (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(FRONTEND_DIR, `${page}.html`));
  });
});

app.get('/', (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(FRONTEND_DIR, 'monitor.html'));
});

app.use('/api', articlesRouter);
app.use('/api', monitorRouter);
app.use('/api', gitRouter);
app.use('/api', pipelineRouter);
app.use('/api', historyRouter);
app.use('/api', generateRouter);
app.use('/api', searchRouter);
app.use('/api', discoverRouter);

const PORT = parseInt(process.env.PORT || '3002', 10);
app.listen(PORT, () => console.log(`Article Studio running at http://localhost:${PORT}`));
