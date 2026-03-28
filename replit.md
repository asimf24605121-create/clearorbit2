# ClearOrbit — Shared Access Management SaaS Platform

## Overview
ClearOrbit is a secure, premium Shared Access Management SaaS platform designed for a Group Buy business model. It manages shared platform credentials (cookies) and grants time-limited access to users. The platform includes a Chrome Extension for secure cookie injection, heartbeat monitoring, and anti-abuse mechanisms. The project aims to provide a robust, scalable solution for shared account management with strong security and real-time monitoring capabilities.

## User Preferences
I prefer detailed explanations. I want iterative development. Ask before making major changes.

## System Architecture

### Backend
- **Technology**: Node.js with Express.js.
- **Database**: Prisma ORM, using SQLite for development and MySQL for production.
- **Authentication**: JWT tokens stored in httpOnly cookies, CSRF tokens for protection.
- **Real-time Communication**: Socket.io for live user count and session heartbeat monitoring.
- **Security Features**: Role-Based Access Control (RBAC), XSS sanitization, mass assignment guards, payload validation, and per-action rate limiting.
- **Core Logic**:
    - **Cookie Engine**: Handles parsing, validation, detection, and fingerprint generation for cookies, classifying session completeness.
    - **Platform Adapters**: A modular system allowing integration with various platforms (e.g., Netflix, Spotify, ChatGPT) for session management.
    - **Session Management**: Session-based slot system with unique identity dedup keys, atomic slot allocation, and real-time release mechanisms. Features include heartbeat monitoring, stale session cleanup, and robust logout-driven platform revocation.
    - **Account Intelligence**: Scoring system with exponential time decay, confidence multipliers, anomaly penalties, and streak bonuses to assess account stability.
    - **Job Queue**: In-memory job queue for background tasks like auto-rechecking accounts.
    - **Cache**: TTL-based in-memory cache with LRU eviction.

### Frontend
- **Technology**: HTML5, Vanilla JavaScript, and Tailwind CSS v3.
- **Design**: Clean white/light theme inspired by modern SaaS platforms like Stripe and Notion.
- **Responsiveness**: Mobile-responsive design implemented with `responsive.css`.

### Key Features
- **User Management**: Comprehensive user and subscription management with RBAC.
- **Platform Management**: CRUD operations for platforms and associated account slots.
- **Cookie Vault**: Secure storage for cookies with validation, parsing, and auto-detection across numerous platforms.
- **Subscription & Payments**: Integrated system for managing user subscriptions and payments.
- **Support System**: Ticketing, contact management, announcements, and notifications.
- **Reseller System**: Functionality for resellers with wallet management.
- **Chrome Extension Integration**: Facilitates secure cookie injection and real-time session heartbeat.
- **Session Reconstruction**: Full session reconstruction capability including cookies, localStorage, sessionStorage, and API token verification.
- **Activity Monitoring**: Active session monitoring, login attempt tracking, and force logout capabilities.

### Account Manager Safety Features
- **Session Revocation on Delete**: All delete actions (single, bulk, by-platform) now release active sessions from the in-memory session store, mark DB sessions inactive with reason codes, and emit `platform_access_revoked` WebSocket events to affected users before deleting records.
- **Session Revocation on Cookie Replace**: When cookies are replaced (including vault cascade to linked accounts), all active sessions across affected accounts are revoked, ensuring users get fresh cookies on next access.
- **Type-to-Confirm for Dangerous Deletes**: `delete_by_platform` requires typing the platform name when active sessions exist, preventing accidental mass revocation.
- **Recheck All with Platform Filter**: Backend `recheck_all` respects `platform_id` filter and returns structured `{ results: { total, updated, statuses } }` response with per-status counts (VALID, WEAK, EXPIRED, DEAD, MISSING).
- **Recheck Reason Field**: Single cookie recheck returns a human-readable `reason` explaining the cookie status.
- **Health Bar**: Uses true 0-100 intelligence score (not the old broken `(score+100)/2` formula).
- **Search & Status Filter**: Account Manager toolbar includes a text search (by slot/platform name) and a status dropdown filter (VALID/EXPIRED/DEAD/WEAK).
- **Last Checked Timestamp**: Account cards display "Last checked: X ago" when available.
- **Cached Edit Modal**: `openEditAccountModal` uses the cached `ALL_ACCOUNT_SLOTS` array instead of re-fetching all accounts from the API.

### Master Session Enforcement System
Platform access is fully dependent on the ClearOrbit website session. Key mechanisms:

**Backend**
- `GET /api/session/validate` — Lightweight endpoint the extension polls every 60 seconds; returns `{ valid: true }` or 401 if session is dead.
- `POST /api/logout` — On logout: invalidates user session, releases all active platform slots, emits `platform_access_revoked` WebSocket event to the user's socket room.
- Stale session cleanup runs every 10 seconds: platform sessions expire after 30 seconds without a heartbeat; user sessions expire after 30 minutes of inactivity.

**Extension (Desktop + Mises Browser)**
- `background.js` — Heartbeat alarm fires every 60 seconds and calls `validateWebsiteSession()`, which hits `/api/session/validate`. If the session is dead (401/non-ok), all injected cookies are immediately purged and all platform tabs are reloaded (showing the platform's login screen).
- `platformGuard.js` — Runs inside platform tabs (Netflix, Spotify, etc.) and polls `check_website_session` (via `background.js`) every 30 seconds. If session is invalid, shows a full-screen "Session Ended" overlay instantly.
- WebSocket `platform_access_revoked` event flows: server → dashboard WebSocket → `window.postMessage` → `content.js` → `background.js` → `FORCE_BROWSER_LOGOUT` (cookie purge + tab reload). This path fires instantly on explicit logout.

**Dashboard (Frontend)**
- `dashboardHeartbeat()` calls `/api/heartbeat` every 30 seconds. On 2 consecutive 401s, it stops all heartbeat intervals, posts `CLEAR_ALL_COOKIES` to the extension, clears sessionStorage, and redirects to login.
- `platform_access_revoked` WebSocket handler clears all `ACTIVE_SESSIONS`, stops all heartbeat timers, and tells the extension to `FORCE_BROWSER_LOGOUT`.

**Mobile (No Extension)**
- `js/session-enforcer.js` — Polls `/api/check_session` every 25 seconds on the dashboard page. On 2 consecutive failures (401), shows a full-page "Session Expired" overlay and redirects to login after 3 seconds.
- Platform session stale timeout (30 seconds): without the extension sending heartbeats, any platform slots expire on the backend within 30 seconds of the website logout. For mobile browsers with Mises Browser extension support, the same desktop flow applies.

## External Dependencies
- **Node.js Libraries**: `express`, `@prisma/client`, `jsonwebtoken`, `bcryptjs`, `cookie-parser`, `socket.io`, `multer`, `express-rate-limit`.
- **Frontend Libraries**: Tailwind CSS v3 (CDN), intl-tel-input v18 (CDN).

### Slot Card Event System (admin.html)
- **Delegated events**: Single `click` listener on `accountSlotsContainer` routes `button[data-action]` clicks (check/edit/replace/delete) to handlers via `_getSlotData(slotId)` from `ALL_ACCOUNT_SLOTS`.
- **Button selectors**: All toolbar/bulk buttons use stable IDs (`btnRecheckAll`, `btnBulkVerify`, `btnBulkRecheck`, `btnBulkDelete`). Platform delete buttons use `data-platform-del` attribute.
- **Mutex system**: `_slotBusy` Set guards concurrent operations per key (`ck-{id}`, `del-{id}`, `bd`, `bv`, `br`, `rca`, `dap-{platformId}`, `be`, `ext-{id}`).
- **Dead code**: Extend menu functions (`toggleExtendMenu`, `toggleBulkExtendMenu`, `bulkExtendSlots`) exist in JS but have no corresponding DOM elements — the feature was never fully built into the UI.
- **Credentials**: All fetch calls use `credentials:'include'` (never `same-origin`).

### Account Intelligence (ALIE) System
- **Dashboard API**: `GET /api/account_intelligence?action=dashboard` — cached (15s TTL via `intelligenceCache`), returns summary, platform_stats, deteriorating, needs_action, queue_status, recent_events
- **Run Intelligence**: `POST action=run_intelligence` — queued via `intelligenceQueue` background job (concurrency:1), prevents concurrent runs, returns `job_id` for progress polling
- **Job Status Polling**: `POST action=job_status` — polls background job progress (0-100%), frontend uses `setInterval(2000)` to update live status
- **Auto Clean Preview**: `POST action=auto_clean_preview` — dry-run mode showing impact (accounts/sessions/platforms affected) before destructive action
- **Auto Clean Execute**: `POST action=auto_clean` — disables dead/expired/degraded accounts (isActive=1 only), frees active sessions, saves snapshot for undo
- **Undo Clean**: `POST action=undo_clean` — restores accounts to pre-clean state (5-minute window), live countdown in UI
- **Score Breakdown**: `GET action=score_breakdown&account_id=X` — full component-level decomposition (success_rate, recency, cookie_quality, expiry, login_status, base) with modifiers (confidence, anomaly, streak, recovery)
- **Event Filtering**: `GET action=events&event_type=X&platform_id=X&page=N&limit=N` — paginated event query with type/platform filters
- **Trend Analysis**: Dashboard includes 7-day score deltas per account and platform, trend direction (improving/declining/flat), platform utilization rates
- **Priority Scoring**: Needs-action items ranked by priority = severity_weight + (active_sessions × 10) + recency_penalty
- **Batched Intelligence**: `run_intelligence` uses BATCH_SIZE=20 with `$transaction` for scalable writes
- **Score Formula**: Success Rate (35%) + Recency (20%) + Cookie Quality (15%) + Expiry (15%) + Login Status (10%) + Base (5%), with confidence multiplier, anomaly penalty, streak bonus, recovery bonus
- **Score Bands**: Stable (70+), Risky (40-69), Dead (<40)
- **Frontend Sections**: 7 summary cards, Platform Health table (with trend arrows + utilization), Needs Action panel (priority-sorted, session-aware), Deteriorating panel (with 7d trends), Recent Events timeline (with filters + pagination + type labels), Score Breakdown modal, Undo Clean banner, Score Legend
- **Auto Clean Modal**: `msg-modal-overlay` pattern with ESC dismiss, preview-before-execute safety
- **Score Breakdown Modal**: `#scoreBreakdownModal` — click any score/account to see full breakdown with progress bars; ESC dismissible
- **Incremental Refresh**: Intelligence operations reload only `loadIntelligenceDashboard()`, not full `_refreshAll()`
- **Event Dismiss**: `POST action=dismiss_event` (single) / `dismiss_events_bulk` (array up to 100) — soft-hides events from dashboard while preserving audit history via `dismissed` column (Int, default 0)
- **Events Since**: `GET action=events_since&since_id=X` — lightweight incremental fetch for new events only (up to 50, ordered by id ASC)
- **Live Timestamps**: `_alieTimestampInterval` (60s) updates all `.alie-ts[data-ts]` elements with fresh relative times; absolute time shown on hover via title attribute
- **Live Event Poller**: `_alieEventPollInterval` (30s) fetches new events via `events_since`, prepends to list, caps at 30 rows; auto-stops when leaving accounts section
- **Event Row UX**: Severity left-border (red=DEAD, amber=RISKY), hover-reveal dismiss button, absolute time tooltip, new-event pulse dot indicator, "Clear all" bulk dismiss with confirmation
- **WebSocket Optimization**: `intelligence_updated` / `intelligence_run_complete` now trigger `loadIntelligenceDashboard()` instead of `_refreshAll()`

### Platform Intelligence System
- **Status Model**: 5-state classification: `healthy` (score≥75), `degraded` (40-74), `unused` (0 active accounts), `inactive` (admin disabled), `dead` (score<40, all failing)
- **Score Formula**: Success Rate (35%) + Account Health Ratio (35%) + Avg Intelligence Score (30%); 0 active accounts = score 0 (not 100)
- **Dashboard API**: `GET /api/platform_health` — cached 15s via `platformCache`, returns `platforms[]`, `summary{}`, `queue_status{}`
- **Platform Detail**: `GET /api/platform_health?action=detail&platform_id=X` — drilldown with account slots table, session counts, subscriber counts
- **Delete Impact**: `GET /api/platform_health?action=delete_impact&platform_id=X` — preview of cascade impact before deletion
- **Async Health Check**: `POST /api/platform_health` `{action:"run_health_check"}` — background job via `platformHealthQueue`, batched writes (BATCH_SIZE=20), returns `job_id` for polling
- **Job Polling**: `GET /api/platform_health?action=job_status&job_id=X` — 2s poll interval with progress percentage
- **Safe Delete**: Backend rejects delete for platforms with active sessions/subscriptions unless `force=true`; frontend shows impact preview then force confirmation
- **Safe Disable**: `POST /api/toggle_platform` — terminates active sessions atomically in transaction; confirmation dialog warns about session termination
- **Cache Invalidation**: All mutations (toggle/delete/health check) invalidate `platform:dashboard` cache key and account caches
- **Logo Upload**: `POST /api/upload_logo` — multer file upload (JPG/PNG/WebP/SVG, 2MB limit), auto-cleanup of old files in `uploads/`, cache busting; `POST /api/remove_logo` — removes file and clears DB entry; both log to `activityLog` and invalidate dashboard cache
- **Frontend**: 6 summary cards, clickable platform cards with status reason + last-checked timestamps (relative with absolute tooltip), registry table with sortable columns (Platform/Health/Accounts/Sessions), health check polling with progress indicator
- **Detail Modal**: Gradient header with logo upload overlay (camera icon on hover, file input trigger), health score + status badge + reason, 4 colored metric cards, account slots table with Last Activity column, footer with toggle/delete/upload/remove-logo buttons
- **Timestamp Formatting**: `_platTimeAgo(ts)` consolidated from `_alieTimeAgo` pattern (Yesterday, explicit dates for old values); `_platAbsoluteTime(ts)` for `title` tooltips showing full date; all platform timestamps use these consistently
- **Status Badges**: Color-coded with icons — green ● Healthy, amber ▲ Degraded, gray ○ Unused, purple ⏸ Inactive, red ✕ Dead