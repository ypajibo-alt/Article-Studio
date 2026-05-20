import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'studio.db');

let _db: Database.Database | null = null;

function db(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
    _db.exec(`
      CREATE TABLE IF NOT EXISTS articles (
        slug TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        published INTEGER NOT NULL DEFAULT 0,
        published_at TEXT,
        publish_at TEXT,
        out_of_window_date TEXT,
        article_type TEXT NOT NULL DEFAULT 'single',
        article_title TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        hero_image_url TEXT NOT NULL DEFAULT '',
        secondary_image_urls TEXT NOT NULL DEFAULT '[]',
        content_id TEXT,
        brand_score REAL,
        brand_notes TEXT NOT NULL DEFAULT '',
        gsc_queries TEXT NOT NULL DEFAULT '[]',
        seo TEXT NOT NULL DEFAULT '{}',
        output TEXT NOT NULL DEFAULT '{}',
        blocks TEXT NOT NULL DEFAULT '[]',
        comments TEXT NOT NULL DEFAULT '[]'
      );

      CREATE TABLE IF NOT EXISTS article_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL,
        saved_at TEXT NOT NULL,
        label TEXT,
        output TEXT NOT NULL,
        FOREIGN KEY (slug) REFERENCES articles(slug) ON DELETE CASCADE
      );
    `);
  }
  return _db;
}

export interface ArticleComment {
  id: string;
  text: string;
  selectedText?: string;
  blockType?: string;
  createdAt: string;
  resolvedAt?: string;
  author?: string;
}

export interface SavedArticle {
  slug: string;
  createdAt: string;
  updatedAt: string;
  status: string;
  published: boolean;
  publishedAt: string | null;
  publishAt: string | null;
  outOfWindowDate?: string | null;
  articleType: string;
  articleTitle: string;
  tags: string[];
  heroImageUrl: string;
  secondaryImageUrls: string[];
  contentId: string | null;
  brandScore: number | null;
  brandNotes: string;
  gscQueries: unknown[];
  seo: { metaTitle: string; metaDescription: string; canonicalUrl: string };
  output: Record<string, unknown>;
  blocks: unknown[];
  comments: ArticleComment[];
}

export interface ArticleVersion {
  id: number;
  slug: string;
  savedAt: string;
  label: string | null;
  output: Record<string, unknown>;
}

function rowToArticle(row: Record<string, unknown>): SavedArticle {
  return {
    slug: row.slug as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    status: row.status as string,
    published: Boolean(row.published),
    publishedAt: (row.published_at as string) ?? null,
    publishAt: (row.publish_at as string) ?? null,
    outOfWindowDate: (row.out_of_window_date as string) ?? null,
    articleType: row.article_type as string,
    articleTitle: row.article_title as string,
    tags: JSON.parse(row.tags as string),
    heroImageUrl: row.hero_image_url as string,
    secondaryImageUrls: JSON.parse(row.secondary_image_urls as string),
    contentId: (row.content_id as string) ?? null,
    brandScore: (row.brand_score as number) ?? null,
    brandNotes: row.brand_notes as string,
    gscQueries: JSON.parse(row.gsc_queries as string),
    seo: JSON.parse(row.seo as string),
    output: JSON.parse(row.output as string),
    blocks: JSON.parse(row.blocks as string),
    comments: JSON.parse(row.comments as string),
  };
}

export function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}

export function getUniqueSlug(base: string): string {
  const d = db();
  let slug = base;
  let i = 2;
  while (d.prepare('SELECT 1 FROM articles WHERE slug = ?').get(slug)) {
    slug = `${base}-${i++}`;
  }
  return slug;
}

export function readAllArticles(): SavedArticle[] {
  return (db().prepare('SELECT * FROM articles ORDER BY updated_at DESC').all() as Record<string, unknown>[]).map(rowToArticle);
}

export function readArticle(slug: string): SavedArticle | null {
  const row = db().prepare('SELECT * FROM articles WHERE slug = ?').get(slug) as Record<string, unknown> | undefined;
  return row ? rowToArticle(row) : null;
}

export function writeArticle(article: SavedArticle): void {
  db().prepare(`
    INSERT INTO articles (
      slug, created_at, updated_at, status, published, published_at, publish_at, out_of_window_date,
      article_type, article_title, tags, hero_image_url, secondary_image_urls, content_id,
      brand_score, brand_notes, gsc_queries, seo, output, blocks, comments
    ) VALUES (
      @slug, @createdAt, @updatedAt, @status, @published, @publishedAt, @publishAt, @outOfWindowDate,
      @articleType, @articleTitle, @tags, @heroImageUrl, @secondaryImageUrls, @contentId,
      @brandScore, @brandNotes, @gscQueries, @seo, @output, @blocks, @comments
    ) ON CONFLICT(slug) DO UPDATE SET
      updated_at = excluded.updated_at, status = excluded.status, published = excluded.published,
      published_at = excluded.published_at, publish_at = excluded.publish_at,
      out_of_window_date = excluded.out_of_window_date, article_title = excluded.article_title,
      tags = excluded.tags, hero_image_url = excluded.hero_image_url,
      secondary_image_urls = excluded.secondary_image_urls, content_id = excluded.content_id,
      brand_score = excluded.brand_score, brand_notes = excluded.brand_notes,
      gsc_queries = excluded.gsc_queries, seo = excluded.seo, output = excluded.output,
      blocks = excluded.blocks, comments = excluded.comments
  `).run({
    ...article,
    published: article.published ? 1 : 0,
    tags: JSON.stringify(article.tags),
    secondaryImageUrls: JSON.stringify(article.secondaryImageUrls),
    gscQueries: JSON.stringify(article.gscQueries),
    seo: JSON.stringify(article.seo),
    output: JSON.stringify(article.output),
    blocks: JSON.stringify(article.blocks),
    comments: JSON.stringify(article.comments),
    outOfWindowDate: article.outOfWindowDate ?? null,
  });
}

export function saveArticleVersion(slug: string, output: Record<string, unknown>, label?: string): number {
  const result = db().prepare(
    'INSERT INTO article_versions (slug, saved_at, label, output) VALUES (?, ?, ?, ?)'
  ).run(slug, new Date().toISOString(), label ?? null, JSON.stringify(output));
  return result.lastInsertRowid as number;
}

export function getArticleVersions(slug: string): ArticleVersion[] {
  return (db().prepare('SELECT * FROM article_versions WHERE slug = ? ORDER BY saved_at DESC').all(slug) as Record<string, unknown>[]).map(row => ({
    id: row.id as number,
    slug: row.slug as string,
    savedAt: row.saved_at as string,
    label: (row.label as string) ?? null,
    output: JSON.parse(row.output as string),
  }));
}

export function getArticleVersion(id: number): ArticleVersion | null {
  const row = db().prepare('SELECT * FROM article_versions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: row.id as number,
    slug: row.slug as string,
    savedAt: row.saved_at as string,
    label: (row.label as string) ?? null,
    output: JSON.parse(row.output as string),
  };
}
