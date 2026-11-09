# Kon Selection Guide for AI Assistants

> **Purpose:** Rapid, zero-fluff decision aid for LLMs choosing between kons, datasets, and grimoires.  
> **Rule of thumb:** If a kon exists for the domain, install it. Only fall back to custom datasets for truly unique schemas.

---

## 1. Decision Table

| User Intent                                            | Kon to Install    | Fallback (Custom Dataset)                    |
| ------------------------------------------------------ | ----------------- | -------------------------------------------- |
| "I want a blog / posts / articles / CMS"               | `kon-blog`        | `blog-posts` dataset                         |
| "I want CRM / deals / pipelines / sales"               | `kon-crm`         | `deals`, `contacts` datasets                 |
| "I want booking / reservations / rooms / calendar"     | `kon-booking`     | `bookings`, `rooms` datasets                 |
| "I want learning / courses / LMS / students / quizzes" | `kon-academy-lms` | `courses`, `lessons` datasets                |
| "I want employee directory / org chart / HR"           | `kon-directory`   | `employees`, `departments` datasets          |
| "I want game catalog / releases / platforms"           | `kon-games`       | `games`, `platforms` datasets                |
| "I want tournaments / esports / brackets / teams"      | `kon-esports`     | `tournaments`, `matches` datasets            |
| "I want document management / manuals / DMS"           | `kon-dms`         | `documents`, `categories` datasets           |
| "I want agile / sprints / issues / kanban"             | `kon-agile`       | `issues`, `sprints` datasets                 |
| "I want media library / uploads / assets"              | `kon-media`       | `media` dataset                              |
| "I want accounting / ledger / double-entry"            | `kon-conta`       | `transactions`, `accounts` datasets          |
| "I want streamer tracking / live status"               | `kon-streamers`   | `streamers` dataset                          |
| "I want custom data structure / no standard domain"    | —                 | Create dataset via `kitsuden_create_dataset` |

---

## 2. Kon Capability Matrix

| Kon               | Auth Required | Has Admin UI | Has Relations                  | Has Workflows           | Media Support     |
| ----------------- | ------------- | ------------ | ------------------------------ | ----------------------- | ----------------- |
| `kon-blog`        | Optional      | ✅           | ✅ (tags, authors)             | ✅ (publish/draft)      | ✅ (kon-media)    |
| `kon-crm`         | Yes           | ✅           | ✅ (contacts↔deals)            | ✅ (pipeline)           | ❌                |
| `kon-booking`     | Yes           | ✅           | ✅ (rooms↔bookings)            | ✅ (conflict detection) | ❌                |
| `kon-academy-lms` | Yes           | ✅           | ✅ (courses↔modules↔quizzes)   | ✅ (progress)           | ✅                |
| `kon-directory`   | Yes           | ✅           | ✅ (dept↔employee)             | ❌                      | ✅ (avatars)      |
| `kon-games`       | No            | ✅           | ✅ (games↔platforms↔tags)      | ❌                      | ✅ (kon-media)    |
| `kon-esports`     | Yes           | ✅           | ✅ (teams↔tournaments↔matches) | ✅ (brackets)           | ❌                |
| `kon-dms`         | Yes           | ✅           | ✅ (docs↔categories↔versions)  | ✅ (approval)           | ✅                |
| `kon-agile`       | Yes           | ✅           | ✅ (issues↔sprints↔epics)      | ✅ (triage)             | ❌                |
| `kon-media`       | No            | ✅           | ❌                             | ❌                      | N/A (it IS media) |
| `kon-conta`       | Yes           | ✅           | ✅ (accounts↔entries)          | ✅ (templates)          | ❌                |
| `kon-streamers`   | No            | ✅           | ✅ (streamer↔platforms)        | ✅ (live sync)          | ✅                |

---

## 3. Grimoire vs Individual Kons

A **Grimoire** is a pre-packaged ecosystem of kons + configuration for a specific vertical. Use a grimoire when the user wants a turnkey solution; install individual kons when the user wants to cherry-pick features.

### When to recommend a Grimoire

| User Need                           | Grimoire              | Included Kons                 |
| ----------------------------------- | --------------------- | ----------------------------- |
| "I want a starting point to extend" | `grimoire-default`    | none required (optional: crm) |
| "I want a corporate intranet"       | `grimoire-corporate`  | crm, dms, directory           |
| "I want a SharePoint-like portal"   | `grimoire-sharepoint` | dms (optional: directory)     |

### Grimoire advantages

1. **Pre-configured auth** — OAuth providers, default roles, and RLS policies are set up automatically.
2. **Cross-kon relations** — A grimoire guarantees compatible foreign keys and shared datasets (e.g., `kon-media` linked from blog, games, and directory).
3. **Single activation step** — start the API with `KITSUDEN_ACTIVE_GRIMOIRE=<grimoire id>` and it activates the grimoire and runs its seed.
4. **Unified admin navigation** — The admin UI shows a coherent sidebar instead of disconnected modules.

### When to recommend individual Kons

1. The user already has a backend and wants **one extra feature** (e.g., "just add a blog").
2. The user wants to **avoid bloat** (e.g., a simple landing page that only needs `kon-media`).
3. The user is **building a custom grimoire** and wants to compose their own set.

---

## 4. Dependency Chain

Some kons depend on others. Always install dependencies first.

```
kon-games, kon-blog, kon-directory, kon-academy-lms, kon-crm, kon-booking,
kon-esports, kon-agile, kon-ecommerce, kon-streamers → require kon-media
```

(Each kon's `kon.json` lists its requirements; `kon-dms` declares none.)

If the user installs a kon and you see a "missing dependency" error, install the upstream kon first, then retry.

---

## 5. Quick Decision Flowchart

```
User describes a need
│
├─ Is it a well-known domain with a kon?
│   ├─ YES → Install kon (check dependencies first)
│   │         └─ Does the user want a full turnkey vertical?
│   │            ├─ YES → Recommend a Grimoire
│   │            └─ NO  → Install individual kon
│   └─ NO  → Create custom dataset
│
└─ Does the user mention multiple unrelated domains?
      └─ YES → Recommend a Grimoire or install kons one by one
```
