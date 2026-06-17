# PRD — The T: End-to-End Article Automation
**Status:** Draft | **Updated:** 2026-05-28

---

## Overview
Fully automated pipeline that takes an article brief and produces a published, SEO-ready blog page with no manual steps beyond initial approval. Covers single title articles, listicles, and coming soon articles.

---

## Trigger
- **Manual** — editor enters a brief or content ID in Article Studio and clicks Run
- **Scheduled** — articles pre-queued against Tubi's Long Range Planning Calendar, auto-triggered ahead of each initiative
- **Availability-based** — system detects new cash-licensed titles and triggers generation automatically if no article exists

---

## Title Selection Requirements

**Data fetched per title (Tubi Content API):**
- Title, year, type, description, cast, director, runtime
- Genre tags, availability window (starts/ends)
- Trailer URL or preview URL
- Images: posterarts, landscape_images, hero_images, backgrounds

**Checks before generation:**
- **Disambiguation** — confirm correct contentId when multiple titles share the same name. Surface warning in UI, require editor to confirm before proceeding
- **Not_For_Featured blocklist** — titles tagged in CMSUI must never appear. Synced daily from CMSUI
- **Pre-promotion holds** — titles under contractual restriction excluded until hold date passes. Manually maintained by editor after consulting Acquisitions
- **Licensed windowing priority** — cash-licensed titles (short window) ranked above evergreen revshare content
- **Genre accuracy** — title tags must match article theme. Mismatches rejected and replaced
- **Title ordering** — first 2–3 titles must be most recognized. Order by: licensed urgency → marketing priority → public awareness

---

## Generation Requirements

**Models:**
- Article writing → Claude Sonnet 4.6 (Bedrock)
- Brand alignment check → GPT-4o
- SEO meta description → GPT-4o-mini
- Listicle query planning → GPT-4o-mini

**Single title output:**
- Headline (max 12 words, sentence case, must include title name)
- Subheadline (one sentence, does not restate headline)
- Introduction (2–3 paragraphs)
- Cast section (up to 4 members, 30–50 words each)
- Pull quote
- Why Watch (2–3 paragraphs, no plot summary, no spoilers)
- More Details (director, full cast, "Watch free on Tubi")

**Listicle output:**
- Headline, subheadline, intro
- 8–10 entries (50–100 words each, one opinion per entry)
- Optional outro

**Tone rules (enforced in prompt + brand check):**
- No em dashes, no exclamation marks
- No banned words (delve, meticulously, showcases, nuanced, etc.)
- Never dismissive of classic or beloved titles
- Champion the content — never mock it
- Commit to opinions, no hedging

**Quality gate (must pass before CMS write):**
- Brand alignment score ≥ 0.80
- Headline rules pass (length, case, title name present)
- No banned words
- Disambiguation confirmed
- Blocklist clear
- On fail: regenerate with feedback, max 2 retries. If still failing, save as draft and alert editor

---

## CMS Field Mapping

| Field | Source |
|---|---|
| `title` | Generated headline |
| `subtitle` | Generated subheadline |
| `slug` | Auto-generated from headline, kebab-case |
| `categoryTag` | Editor-confirmed |
| `metaDescription` | GPT-4o-mini SEO pass |
| `datePosted` | Scheduled publish date |
| `author` | Editor input (default: "The T Editorial Team") |
| `hero.watchLink` | `tubitv.com/movies/{contentId}` or `/series/{contentId}` |
| `hero.contentId` | Content API |
| `hero.fallback` | `hero_images[0]` |
| `intro` | Generated |
| `cast` | Generated |
| `quote` | Generated |
| `whyWatch` | Generated |
| `images.hero` | `hero_images[0]` |
| `images.thumbnail` | `landscape_images[0]` |
| `images.og` | `landscape_images[0]` |
| `gallery` | `backgrounds[]` — scene stills, up to 4 |
| `thumbnail` (card) | `landscape_images[0]` — never portrait |
| `eyebrow` (card) | Editor-confirmed |
| `keepReading` | Auto: 3 articles from same categoryTag |

---

## Lifecycle Requirements

**Daily monitor (6 AM PT):**
- Check availability_ends for all published articles against today

**Single title:** unpublish if title expired

**Listicle:**
- Remove expired entries
- If ≥ 6 entries remain: rebuild + keep published
- If < 6 entries remain: unpublish

**Coming Soon:**
- On goes_live date: verify content is available, transition to single/listicle
- If not available after 48hr: unpublish

**14-day warning:** flag expiring titles in dashboard without auto-unpublishing

---

## Editor Controls (Article Studio)

- Run pipeline from brief or content ID
- Disambiguation confirmation prompt
- Publish panel: status badge, schedule picker, Publish Now, Unpublish
- Monitor dashboard: health flags per article (Expiring Soon, Entry Removed, Blocklist Hit, Needs Review)
- Settings: blocklist management, pre-promotion holds, prompt editor with versioning, audit log

---

## Open Questions

1. Can CMSUI Not_For_Featured tags be pulled via API or is it a manual export?
2. Is license type (cash vs revshare) available in any internal API?
3. What is the CMS write endpoint and auth method?
4. Is there a staging environment for the blog?
5. Is there a system of record for pre-promotion holds or is it fully manual?
6. Is the Weekly Watchlist container accessible via API for ordering signals?
