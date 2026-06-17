# Product Requirements Document
## Tubi Blog — Automated Publishing System

**Author:** Growth / Blog Team  
**Status:** Draft  
**Last updated:** 2026-05-27  

---

## 1. Overview

The Tubi Blog currently requires manual intervention at every step: articles are generated, manually reviewed in Article Studio, exported as ZIP files, and uploaded by an engineer (Craig) to the production CMS. This PRD defines a fully automated publishing system that:

- Auto-publishes articles on a scheduled date
- Monitors content availability from the Tubi platform API and unpublishes or updates articles when titles expire
- Handles three article types: **Single Title**, **Listicle**, and **Coming Soon**
- Is backed by a custom-built CMS that serves the live blog

---

## 2. Goals

1. Remove all manual publishing steps — no more ZIP exports or engineer uploads
2. Ensure published articles never contain expired or unavailable Tubi titles
3. Automatically surface "Coming Soon" articles ahead of a title's availability window
4. Give editors full visibility and override capability through the Article Studio UI

---

## 3. Article Types

### 3.1 Single Title Article
A deep-dive article about one specific Tubi title (movie or series).

- Has one primary `contentId`
- Expires when that title's `availability_ends` passes or the title is removed from Tubi
- Should be unpublished automatically when the title is no longer available

### 3.2 Listicle Article
A curated list of 8–10 Tubi titles around a theme (e.g. "Best Horror Movies on Tubi").

- Has multiple `contentId` values (one per list entry)
- Degrades gracefully: if 1–2 titles expire, the article stays published with those entries removed
- Unpublished automatically if fewer than **6 valid entries** remain
- Entry removal triggers a rebuild of the article's JSON (renumbered, no gaps)

### 3.3 Coming Soon Article
An article promoting a title or collection arriving on Tubi on a specific date.

- Has a `goes_live` date (when the content becomes available on Tubi)
- Publishes as "Coming Soon" ahead of that date (configurable lead time, default: 7 days)
- Automatically transitions to a standard Single Title or Listicle article on `goes_live`
- Unpublished if the `goes_live` date passes and content never became available

---

## 4. System Architecture

### 4.1 Custom CMS
A purpose-built CMS (extending the existing Article Studio backend) that:

- Stores all articles in SQLite (already used by Article Studio)
- Exposes a public-facing API the blog frontend reads from
- Handles publish state, scheduling, and content availability metadata

### 4.2 Components

```
┌─────────────────────────────────────────────────────┐
│                    Article Studio                    │
│  (editor UI, generation pipeline, approval flow)     │
└───────────────────────┬─────────────────────────────┘
                        │ writes to
                        ▼
┌─────────────────────────────────────────────────────┐
│                   CMS Database (SQLite)              │
│  articles, content_items, publish_schedule, audit    │
└───────────┬───────────────────────┬─────────────────┘
            │                       │
            ▼                       ▼
┌───────────────────┐   ┌───────────────────────────┐
│  Scheduler / Cron │   │  Public Blog API           │
│  (publish,        │   │  GET /api/articles         │
│   unpublish,      │   │  GET /api/articles/:slug   │
│   expire check)   │   │  GET /api/articles/coming-soon│
└───────────────────┘   └───────────────────────────┘
                                    │
                                    ▼
                        ┌───────────────────────────┐
                        │   Blog Frontend (V2)       │
                        │   Reads from CMS API       │
                        └───────────────────────────┘
```

### 4.3 Availability Monitor
A scheduled job (runs daily at 6:00 AM PT) that:

1. Fetches all currently published articles
2. For each article, calls the Tubi content API:
   `GET https://content-cdn.production-public.tubi.io/api/v2/contents?content_ids={id1},{id2},...`
3. Checks each title's `availability_ends` against today's date
4. Takes action based on article type (see Section 6)
5. Logs all actions to the audit table

---

## 5. Data Model

### `articles` table (extends existing)
```sql
id                  INTEGER PRIMARY KEY
slug                TEXT UNIQUE NOT NULL
title               TEXT NOT NULL
type                TEXT NOT NULL  -- 'single' | 'listicle' | 'coming_soon'
status              TEXT NOT NULL  -- 'draft' | 'scheduled' | 'published' | 'unpublished' | 'expired'
publish_at          DATETIME       -- scheduled publish date/time
unpublish_at        DATETIME       -- optional hard unpublish date (overrides availability check)
goes_live           DATETIME       -- coming_soon only: date content arrives on Tubi
coming_soon_lead    INTEGER        -- days before goes_live to publish (default 7)
content             TEXT           -- full article JSON
created_at          DATETIME
updated_at          DATETIME
published_at        DATETIME
unpublished_at      DATETIME
unpublish_reason    TEXT           -- 'expired' | 'manual' | 'low_valid_entries' | 'content_unavailable'
```

### `content_items` table
```sql
id                  INTEGER PRIMARY KEY
article_id          INTEGER REFERENCES articles(id)
content_id          TEXT NOT NULL       -- Tubi contentId
position            INTEGER             -- order in listicle
title               TEXT
type                TEXT                -- 'movie' | 'series'
availability_starts DATETIME
availability_ends   DATETIME
last_checked        DATETIME
is_available        BOOLEAN DEFAULT 1
```

### `publish_audit` table
```sql
id                  INTEGER PRIMARY KEY
article_id          INTEGER REFERENCES articles(id)
action              TEXT    -- 'published' | 'unpublished' | 'entry_removed' | 'status_changed'
reason              TEXT
triggered_by        TEXT    -- 'scheduler' | 'editor:{email}'
created_at          DATETIME
```

---

## 6. Automated Behaviors

### 6.1 Scheduled Publishing
- Scheduler runs every 15 minutes
- Checks for articles with `status = 'scheduled'` and `publish_at <= NOW()`
- Sets `status = 'published'`, records `published_at`
- For Coming Soon articles: sets article type to `coming_soon` and publishes 7 days (configurable) before `goes_live`

### 6.2 Coming Soon → Live Transition
- On `goes_live` date, scheduler verifies content is available on Tubi
- If available: transitions article from `coming_soon` to `single` or `listicle` type, keeps published
- If not available after 48-hour grace period: unpublishes with reason `content_unavailable`

### 6.3 Expiry Monitoring (Daily Job)
For each published article:

**Single Title:**
- If `availability_ends < TODAY`: unpublish, reason = `expired`
- Notify editor via Article Studio dashboard alert

**Listicle:**
- Remove any entries where `availability_ends < TODAY`
- If remaining entries ≥ 6: rebuild article JSON (renumber entries), keep published
- If remaining entries < 6: unpublish, reason = `low_valid_entries`
- Notify editor in both cases

**Coming Soon:**
- If `goes_live` has passed and content still unavailable: unpublish, reason = `content_unavailable`

### 6.4 Minimum Notice Window
The system will flag (but not auto-unpublish) any article where a title expires within the next **14 days**, giving editors time to:
- Swap the expiring title for a replacement
- Decide to let it expire naturally

---

## 7. Editor Controls (Article Studio UI)

### 7.1 Publish Panel (in editor)
- Status badge: Draft / Scheduled / Published / Unpublished / Expired
- Scheduled publish date/time picker
- "Publish Now" button (bypasses schedule)
- "Unpublish" button with reason field
- Coming Soon: `goes_live` date picker + lead time setting

### 7.2 Content Health Dashboard (Monitor page)
- List of all published articles with their content health status
- Flags: "Expiring Soon" (title expires within 14 days), "Entry Removed" (listicle had entries auto-removed), "Needs Review"
- One-click to open affected article in editor

### 7.3 Audit Log
- Full log of all automated actions (available in Article Studio Settings or Monitor page)
- Columns: article, action, reason, triggered by, timestamp

---

## 8. Public Blog API

All endpoints are read-only. No authentication required.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/blog/articles` | Paginated list of published articles |
| GET | `/api/blog/articles/:slug` | Single article by slug |
| GET | `/api/blog/articles/type/:type` | Filter by type (single, listicle, coming_soon) |
| GET | `/api/blog/coming-soon` | All active coming soon articles |
| GET | `/api/blog/latest` | Most recently published articles (for homepage cards) |

Query params for list endpoints: `?page=1&limit=20&tag=horror`

---

## 9. Notifications

When the scheduler takes an automated action, the Article Studio dashboard should surface:

- **Banner alert** on next login: "2 articles were auto-updated overnight — review changes"
- **Per-article badge** in the articles list: "Entry removed", "Unpublished – expired", "Coming soon → live"
- **Optional email digest** (future phase): daily summary of automated actions

---

## 10. Out of Scope (v1)

- Multi-author permissions / roles
- Comment system
- A/B testing article variants
- Push notifications to subscribers
- Integration with third-party analytics beyond existing Article Studio analytics

---

## 11. Success Metrics

- Zero manually triggered publishes within 30 days of launch
- Zero articles serving expired content (measured by daily availability check pass rate)
- Editor time-to-publish reduced from ~2 hours (current manual flow) to < 5 minutes (write + schedule)

---

## 12. Open Questions for Engineer

1. **Hosting:** Where does the CMS API run? Same Express server as Article Studio (port 3002) or separate service?
2. **Frontend data source:** Does the V2 Blog frontend currently read from static JSON files or an API? This determines migration scope.
3. **Image storage:** Images are currently in ZIP exports. In the automated system, where do they live? CDN bucket? Local `/public/` path?
4. **Availability API auth:** The content API requires a token (anonymous device token). Token generation logic exists in the pipeline — does the engineer have access to this or does it need to be packaged as a shared lib?
5. **Staging environment:** Is there a staging URL for the blog where auto-publish can be tested before going to production?
