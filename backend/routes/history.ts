import { Router, Request, Response } from 'express';
import {
  readAllArticles, readArticle, saveArticleVersion,
  getArticleVersions, getArticleVersion, writeArticle,
} from '../lib/storage.js';

const router = Router();

// GET /api/history — list all articles (for the history page article selector)
router.get('/history', async (_req: Request, res: Response) => {
  const articles = readAllArticles();
  res.json(articles.map(a => ({
    slug: a.slug,
    articleTitle: a.articleTitle,
    updatedAt: a.updatedAt,
    status: a.status,
    articleType: a.articleType,
  })));
});

// GET /api/history/:slug — list versions for an article
router.get('/history/:slug', async (req: Request, res: Response) => {
  const article = readArticle(req.params.slug);
  if (!article) { res.status(404).json({ error: 'Article not found' }); return; }
  const versions = getArticleVersions(req.params.slug);
  res.json({ article: { slug: article.slug, articleTitle: article.articleTitle }, versions });
});

// POST /api/history/:slug/save — snapshot current output as a version
router.post('/history/:slug/save', async (req: Request, res: Response) => {
  const { label } = req.body as { label?: string };
  const article = readArticle(req.params.slug);
  if (!article) { res.status(404).json({ error: 'Article not found' }); return; }
  const id = saveArticleVersion(req.params.slug, article.output, label);
  res.json({ id });
});

// GET /api/history/:slug/version/:id — get a specific version
router.get('/history/:slug/version/:id', async (req: Request, res: Response) => {
  const version = getArticleVersion(Number(req.params.id));
  if (!version || version.slug !== req.params.slug) { res.status(404).json({ error: 'Version not found' }); return; }
  res.json(version);
});

// POST /api/history/:slug/restore/:id — restore a version as current output
router.post('/history/:slug/restore/:id', async (req: Request, res: Response) => {
  const article = readArticle(req.params.slug);
  if (!article) { res.status(404).json({ error: 'Article not found' }); return; }
  const version = getArticleVersion(Number(req.params.id));
  if (!version || version.slug !== req.params.slug) { res.status(404).json({ error: 'Version not found' }); return; }

  // Save current as a version before restoring
  saveArticleVersion(req.params.slug, article.output, 'Before restore');

  article.output = version.output;
  article.updatedAt = new Date().toISOString();
  writeArticle(article);
  res.json({ success: true });
});

export default router;
