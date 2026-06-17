import { Router, Request, Response } from 'express';
import {
  readArticle, readAllArticles, writeArticle, slugify, getUniqueSlug,
  saveArticleVersion, type SavedArticle, type ArticleComment,
} from '../lib/storage.js';

const router = Router();

router.post('/articles/save', (req: Request, res: Response) => {
  const { articleTitle, articleType, output, contentId, brandScore, brandNotes,
          gscQueries, tags, heroImageUrl, secondaryImageUrls, status } = req.body;
  if (!output || !articleTitle) { res.status(400).json({ error: 'output and articleTitle required' }); return; }

  const slug = getUniqueSlug(slugify(output.headline || articleTitle));
  const now = new Date().toISOString();
  const article: SavedArticle = {
    slug, createdAt: now, updatedAt: now,
    status: status || 'draft', published: false, publishedAt: null, publishAt: null,
    articleType: articleType || 'single', articleTitle,
    tags: Array.isArray(tags) ? tags : [],
    heroImageUrl: heroImageUrl || '',
    secondaryImageUrls: Array.isArray(secondaryImageUrls) ? secondaryImageUrls : [],
    contentId: contentId || null,
    brandScore: brandScore ?? null, brandNotes: brandNotes || '',
    gscQueries: gscQueries || [],
    seo: { metaTitle: '', metaDescription: '', canonicalUrl: '' },
    output, blocks: [], comments: [],
  };
  writeArticle(article);
  res.json({ slug, article });
});

router.get('/articles', (req: Request, res: Response) => {
  const statusFilter = String(req.query.status || 'all');
  const all = readAllArticles();
  const articles = statusFilter === 'all' ? all : all.filter(a => a.status === statusFilter);
  res.json(articles.map(a => ({
    slug: a.slug, createdAt: a.createdAt, updatedAt: a.updatedAt,
    status: a.status, published: a.published || false, publishedAt: a.publishedAt || null,
    publishAt: a.publishAt || null, outOfWindowDate: a.outOfWindowDate || null,
    articleType: a.articleType, articleTitle: a.articleTitle,
    tags: a.tags, heroImageUrl: a.heroImageUrl, contentId: a.contentId, brandScore: a.brandScore,
    headline: a.output?.headline || a.articleTitle,
    subheadline: a.output?.subheadline || a.output?.angle || '',
    commentCount: (a.comments || []).length,
    unresolvedCommentCount: (a.comments || []).filter(c => !c.resolvedAt).length,
  })));
});

router.get('/articles/:slug', (req: Request, res: Response) => {
  const article = readArticle(req.params.slug);
  if (!article) { res.status(404).json({ error: 'Not found' }); return; }
  res.json(article);
});

router.put('/articles/:slug', (req: Request, res: Response) => {
  const article = readArticle(req.params.slug);
  if (!article) { res.status(404).json({ error: 'Not found' }); return; }

  // Auto-save version before significant updates
  const savingContent = req.body.output !== undefined;
  if (savingContent && article.output && Object.keys(article.output).length > 0) {
    saveArticleVersion(article.slug, article.output);
  }

  for (const key of ['status', 'tags', 'heroImageUrl', 'secondaryImageUrls', 'output', 'articleTitle', 'seo', 'publishAt', 'outOfWindowDate', 'blocks']) {
    if (req.body[key] !== undefined) (article as unknown as Record<string, unknown>)[key] = req.body[key];
  }
  article.updatedAt = new Date().toISOString();
  writeArticle(article);
  res.json({ article });
});

router.post('/articles/:slug/publish', (req: Request, res: Response) => {
  const article = readArticle(req.params.slug);
  if (!article) { res.status(404).json({ error: 'Not found' }); return; }
  const doPublish = req.body.publish !== false;
  const now = new Date().toISOString();
  article.published = doPublish;
  article.publishedAt = doPublish ? now : null;
  article.publishAt = null;
  article.status = doPublish ? 'published' : 'unpublished';
  article.updatedAt = now;
  writeArticle(article);
  res.json({ article });
});

router.get('/published', (_req: Request, res: Response) => {
  const articles = readAllArticles();
  res.json(
    articles
      .filter(a => a.published)
      .sort((a, b) => (b.publishedAt || b.createdAt).localeCompare(a.publishedAt || a.createdAt))
      .map(a => ({
        slug: a.slug, publishedAt: a.publishedAt, articleType: a.articleType,
        articleTitle: a.articleTitle, tags: a.tags, heroImageUrl: a.heroImageUrl,
        contentId: a.contentId, seo: a.seo || {}, output: a.output, blocks: a.blocks || [],
      }))
  );
});

// Comments
router.post('/articles/:slug/comments', (req: Request, res: Response) => {
  const article = readArticle(req.params.slug);
  if (!article) { res.status(404).json({ error: 'Not found' }); return; }
  const { selectedText, textBefore, comment, author } = req.body;
  if (!selectedText || !comment) { res.status(400).json({ error: 'selectedText and comment required' }); return; }

  const newComment: ArticleComment = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    author: author || 'Editor',
    selectedText, text: comment,
  };
  article.comments = [...(article.comments || []), newComment];
  article.updatedAt = new Date().toISOString();
  writeArticle(article);
  res.json({ comment: newComment });
});

router.put('/articles/:slug/comments/:commentId', (req: Request, res: Response) => {
  const article = readArticle(req.params.slug);
  if (!article) { res.status(404).json({ error: 'Not found' }); return; }
  const c = (article.comments || []).find(c => c.id === req.params.commentId);
  if (!c) { res.status(404).json({ error: 'Comment not found' }); return; }

  if (req.body.resolved === true) c.resolvedAt = new Date().toISOString();
  else if (req.body.resolved === false) delete c.resolvedAt;

  article.updatedAt = new Date().toISOString();
  writeArticle(article);
  res.json({ comment: c });
});

router.delete('/articles/:slug/comments/:commentId', (req: Request, res: Response) => {
  const article = readArticle(req.params.slug);
  if (!article) { res.status(404).json({ error: 'Not found' }); return; }
  article.comments = (article.comments || []).filter(c => c.id !== req.params.commentId);
  article.updatedAt = new Date().toISOString();
  writeArticle(article);
  res.json({ ok: true });
});

export default router;
