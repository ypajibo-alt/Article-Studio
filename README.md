# THE T — Article Studio

An AI-assisted CMS purpose-built for *The T*. Automates metadata lookup, first-draft generation, brand voice scoring, and quality gating — while keeping editors in control of editing, approving, scheduling, and publishing.

---

## 1. Product Vision

Article Studio eliminates the blank-page problem for The T's editorial team. An editor searches for any Tubi title, triggers generation, and receives a brand-aligned draft within minutes. The system handles metadata retrieval, AI writing, programmatic quality checks, and brand scoring. The editor handles judgment.

**Two users:**
- **Content Editor** — owns the article pipeline end-to-end. Needs to generate, edit, approve, schedule, and publish without switching tools.
- **Web Engineering** — consumes Article Studio's structured output via a stable API to render the public-facing blog. Does not interact with the CMS directly.

---

## 2. Content Types

### Path A — Single Title Article
Trigger: editor searches for a specific Tubi title (e.g., "Scream"), selects it, initiates generation.

**Generation flow:**
1. Tubi metadata fetched automatically (title, year, cast, directors, tags, MPAA rating, poster art)
2. GSC data fetched in parallel and appended as soft SEO hints
3. Claude Sonnet 4.6 generates a 500–800 word draft in Tubi's brand voice
4. Programmatic quality gate validates structure, word count, and restricted language
5. GPT-5 scores brand alignment across five dimensions (≥ 3.5 avg required to pass)
6. On pass: saved as draft, editor redirected to workspace
7. On fail: retry up to 5 attempts, each with structured feedback injected into the next prompt

### Path B — Listicle
Trigger: editor selects Listicle type, populates titles via manual entry, keyword search, or a Tubi container, optionally provides a headline, initiates generation.

**Generation flow:**
1. Each title individually validated against Tubi metadata or a designated container
2. Claude generates a ranked listicle: headline, intro copy, per-entry blurbs
3. Same quality gate and GPT-5 brand check as Path A

---

## 3. Generation Pipeline (All Stages)

```
Data Fetch → [Retry Loop x5] Prompt Build → AI Generation → Quality Gate → Brand Check → Save Draft
```

### Stage 0 — Data Fetch
Before any prompt is assembled, real-world metadata is fetched.

| Input | Method |
|---|---|
| Numeric Content ID | Direct lookup via Tubi content CDN API — fast, 1 call |
| Title Name | Fuzzy search across Tubi containers (exact → includes → reverse-includes). Returns first match. |

Fields extracted and injected into prompt: `title`, `year`, `type`, `description`, `directors`, `cast` (with character names where available), `tags`, `rating`.

GSC data fetched in parallel. If found, appended as a soft SEO hint block.

**Note:** Poster images and video preview URLs are *not* fetched at generation time — available via `fetchTitleImages()` but deferred to article page render.

---

### Stage 1 — Prompt Build
Four source files assembled into a single prompt:

| File | Role |
|---|---|
| `article-system-prompt.md` | System persona — Tubi's brand personality (Exciting, Inviting, Mischievous), format rules, banned words, reference example |
| `article-user-prompt.md` | Content template — injects title metadata and retry feedback slot |
| `brand-voice-reference.md` | Brand calibration — known-good Tubi writing samples for GPT-5 scoring anchor |
| `brand-alignment-prompt.md` | Scoring rubric — five-dimension guide with calibrated 4 vs 5 examples |

---

### Stage 2 — AI Generation (Claude Sonnet 4.6)
Returns a JSON object:

```json
{
  "headline": "...",        // max 12 words, sentence case, must include title name
  "subheadline": "...",     // one-sentence hook, does not restate headline
  "introduction": "...",    // 2-3 paragraphs
  "cast": [
    { "name": "Actor Name", "bio": "..." }  // 30-50 words each, up to 4
  ],
  "pullQuote": "...",       // punchy single line, character voice
  "whyWatchIt": "...",      // 2-3 paragraphs, editorial case, no plot summary
  "moreDetails": {
    "director": "...",
    "fullCast": ["..."],
    "streamingNote": "Watch free on Tubi"
  }
}
```

If response is not valid JSON or is wrapped in markdown fences, parser strips fences and retries before failing the attempt.

---

### Stage 3 — Programmatic Quality Gate (Layer 1)
Deterministic rules checked before any AI scoring.

**Auto-fixed silently:**
| Issue | Fix |
|---|---|
| Em dashes (—) | Replaced with commas |
| Exclamation marks | Replaced with periods in body copy |

**Hard failures (trigger retry):**
| Rule | Threshold |
|---|---|
| Headline word count | Max 12 words |
| Headline casing | Sentence case only — Title Case fails |
| Introduction structure | 2–3 paragraphs required |
| Cast entries | 1–4 entries required |
| Pull quote length | Max 20 words |
| "Why Watch It" structure | 2–3 paragraphs required |
| Banned words | delve, meticulously, showcases, nuanced, multifaceted, tapestry, realm, robust, leverage, facilitate, underscore, elevate, landscape, journey, compelling, indulge, captivating, riveting, masterful, intriguing |
| Banned phrases | "in conclusion", "it's worth noting", "one can see", "whether you're" |
| Negative brand language | "stupid", "bad", "terrible", "awful" |
| Generic jargon | "binge-worthy", "must-see", "hidden gem" |

Each failure produces a human-readable string injected into the next attempt's prompt.

---

### Stage 4 — Brand Voice Scoring (GPT-5, Layer 2)
Only drafts that pass Stage 3 reach this check.

| Dimension | What it measures | 5 = Unmistakably Tubi |
|---|---|---|
| Voice | Exciting, Inviting, Mischievous? | Reads like a fellow fan, not a corporation |
| Specificity | Plot points, characters, premises — not vague praise | Sharp, concrete, plot-rooted |
| Angle | Distinct and opinionated, not just genre restatement | Clear Tubi POV that surprises |
| Energy | Pulls you in, builds curiosity | Cultural hooks, makes you want to scroll |
| Consistency | Tone holds across full article | Same voice throughout, one writer |

**Pass/fail:** overall average ≥ 3.5. On fail, the `notes` field is injected into the next retry prompt.

**Calibration rule:** "Could this appear on another streamer and feel the same?" If yes, it's a 4 at most. A 5 means unmistakably Tubi.

---

### Retry Loop
Max 5 attempts. Attempt 1 = clean prompt. Attempt 2+ = previous failure appended as a `## Retry feedback` block. After 5 fails, pipeline terminates and editor sees the last error with the specific failure reason.

In practice, most articles pass on attempt 1 or 2.

---

## 4. Editor Workspace

Two tabs:

**Workspace Tab**
- Inline-editable fields: headline, subheadline, body, pull quotes, cast bios
- Reviewer comments appear in a dedicated side panel

**Details Tab**
- Status pill (Draft / Ready to publish / Published / Unpublished)
- Schedule publish (future datetime)
- Out-of-window date + red overdue alert if a published article is past its window
- SEO fields: meta title, meta description, canonical URL
- Brand score with annotated dimension notes
- Google Search Console queries

---

## 5. Key Features

| # | Feature | Priority |
|---|---|---|
| 1 | AI Article Generation (Single) | Must Have |
| 2 | AI Listicle Generation | Must Have |
| 3 | Programmatic Quality Gate | Must Have |
| 4 | GPT-5 Brand Voice Scoring | Must Have |
| 5 | Inline Editor with Block Rendering | Must Have |
| 6 | Status Workflow (Draft → Ready → Published → Unpublished) | Must Have |
| 7 | Publish / Unpublish with Scheduled Publish | Must Have |
| 8 | Out-of-Window Date + Overdue Alert | Must Have |
| 9 | SEO Fields (meta title, meta description, canonical URL) | Must Have |
| 10 | Block Schema + Published Feed API | Must Have |
| 14 | Article Persistence (durable database) | Must Have |
| 11 | Reviewer Feedback (Inline Comments) | Nice to Have |
| 12 | Google Search Console Integration | Nice to Have |
| 13 | Listicle Title Suggestion by Keyword | Nice to Have |

---

## 6. Brand Voice — Key Rules

Tubi's personality: **Exciting, Inviting, Mischievous.**

- Write like a fellow fan, not a corporation
- Commit to opinions — no hedging
- Champion the content, never mock it. Frame weirdness as intentional
- No em dashes, no exclamation marks
- Contractions and parenthetical asides are fine
- Vary sentence length — rhythm matters
- Never hard-sell. Never over-promise

**Never use:** stupid, bad, terrible, awful (about Tubi content). Use: chaotic, ridiculous (intentionally), over-the-top.

---

## 7. Project Structure

```
Article-Studio/
├── backend/
│   ├── server.ts              # Express app, routes wired
│   ├── routes/
│   │   ├── articles.ts
│   │   ├── generate.ts        # Generation pipeline entry point
│   │   ├── pipeline.ts
│   │   ├── search.ts
│   │   ├── discover.ts
│   │   └── monitor.ts
│   ├── lib/
│   │   ├── bedrock.ts         # AWS Bedrock / Claude integration
│   │   ├── tubi.ts            # Tubi metadata API calls
│   │   ├── tubiSearch.ts      # Fuzzy title search
│   │   ├── storage.ts         # SQLite persistence
│   │   ├── quality-gate.ts    # Stage 3 programmatic rules
│   │   └── prompts.ts         # Prompt assembly (Stage 1)
│   └── prompts/
│       ├── article-system-prompt.md
│       ├── article-user-prompt.md
│       ├── brand-voice-reference.md
│       ├── brand-alignment-prompt.md
│       ├── listicle-system-prompt.md
│       ├── listicle-user-prompt.md
│       └── discover-prompt.md
├── frontend/
│   ├── monitor.html           # Homepage / article list
│   ├── articles.html
│   ├── generate.html          # Generation trigger UI
│   ├── editor.html            # Inline editor workspace
│   ├── article.html           # Article preview
│   ├── pipeline.html          # Pipeline status view
│   ├── pipeline-diagram.html
│   ├── marketing.html
│   └── legal.html
└── the-t-data/                # Static/seed data
```

---

## 8. Data Contract (Block Schema)

The published-articles API endpoint returns structured, typed article data. Each block type maps to a frontend component that the web engineer implements once and relies on to stay stable. The schema is the contract between Article Studio and the public blog.

---

## 9. Prototype

Link TBD — see `frontend/pipeline-diagram.html` for the current pipeline visualization.
