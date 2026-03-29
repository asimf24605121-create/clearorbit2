# ClearOrbit — Shared Access Management SaaS Platform

## Overview
ClearOrbit is a secure, premium Shared Access Management SaaS platform built for a Group Buy business model. It provides functionalities to manage shared platform credentials (cookies) and grant time-limited access to users. The platform includes a Chrome Extension for secure cookie injection, real-time heartbeat monitoring, and anti-abuse mechanisms. The project aims to deliver a robust, scalable, and secure solution for shared account management, focusing on real-time monitoring and strong security.

## User Preferences
I prefer detailed explanations. I want iterative development. Ask before making major changes.

## System Architecture

### Backend
- **Technology**: Node.js with Express.js.
- **Database**: Prisma ORM, using SQLite for development and MySQL for production.
- **Authentication**: JWT tokens in httpOnly cookies, with CSRF protection.
- **Real-time Communication**: Socket.io for live user count and session heartbeat monitoring.
- **Security Features**: Role-Based Access Control (RBAC), XSS sanitization, mass assignment guards, payload validation, and per-action rate limiting.
- **Core Logic**:
    - **Cookie Engine**: Handles parsing, validation, detection, and fingerprint generation for cookies.
    - **Platform Adapters**: Modular system for integrating with various platforms (e.g., Netflix, Spotify).
    - **Session Management**: Slot-based system with unique identity dedup keys, atomic slot allocation, real-time release mechanisms, heartbeat monitoring, and stale session cleanup.
    - **Account Intelligence (ALIE)**: A scoring system with exponential time decay, confidence multipliers, anomaly penalties, and streak bonuses to assess account stability. Includes features for running intelligence, auto-cleaning accounts, and detailed score breakdowns.
    - **Job Queue**: In-memory for background tasks like auto-rechecking accounts.
    - **Cache**: TTL-based in-memory cache with LRU eviction.
    - **Master Session Enforcement**: Ensures platform access is tied to the ClearOrbit website session, with mechanisms for session validation, logout-driven revocation, and stale session cleanup across backend, extension, and frontend.

### Frontend
- **Technology**: HTML5, Vanilla JavaScript, and Tailwind CSS v3.
- **Design**: Clean white/light theme with mobile responsiveness.

### Key Features
- **User & Subscription Management (Single-Page Workflow)**: Users module provides a unified single-page experience with 3 distinct action workflows — no separate Subscriptions page.
  - **Users Page** (`sec-users`): 5-column table (User, Email, Expiry, Status, Actions) with 3 action buttons per row: Open User (purple user icon), Toggle (disable/enable), Delete (super_admin only). Single entry point opens unified user workflow modal.
  - **Unified User Workflow Modal** (`userWorkflowModal`): Single tabbed modal with 3 internal pages accessed via `openUserWorkflow(userId, tab)`. Shared header with avatar, display name, username, status badge. Tab navigation (View Profile / Edit Profile / Manage Access) with `uwSwitchTab()`. Escape key and backdrop click to close via `closeUserWorkflow()`.
    - **View Profile Tab** (`uwPageView`): Read-only user details (account info, access & security, subscriptions summary, active slots). IP geolocation with flag/location/ISP via `vuLookupGeo()`. VPN/proxy detection indicator. "Manage" link to switch to access tab.
    - **Edit Profile Tab** (`uwPageEdit`): Profile-only fields (name, email, phone, expiry, country, city, gender, password). Save returns to View tab with updated data. No platform assignment.
    - **Manage Access Tab** (`uwPageAccess`): Active/expired subscriptions, add new subscription (platform + duration with custom option), inline extend (+7/+30/+N), revoke per-card. Auto-refreshes parent table.
  - **Manage Subscription Tab** (`uwPageAccess`): Renamed from "Manage Access". Compact subscription rows with small green/amber/red status dots. Platform checkboxes with "Select All", already-assigned platforms show "Active · Xd" badge and are disabled. Batch multi-platform assignment. Inline extend (+7/+30/+N), revoke per-row.
  - **IP Geolocation**: `POST /api/geo_lookup` endpoint queries 3 providers in parallel (`ipwhois.app`, `ip-api.com`, `freeipapi.com`) via `multiProviderGeoLookup()`. VPN/proxy detection (independent from hosting detection). `IpGeoCache` DB with `proxy`/`hosting` integer columns, 72h TTL. `alt_cities` when providers disagree. Frontend shows `≈` prefix and italic text for uncertain locations (VPN/hosting IPs), small "VPN" or "Hosting" badges. Graceful "Unavailable" fallback. Client-side `_geoCache` Map + `_geoLookupVersion` race guard.
  - **Backend**: `get_subscriptions` with search/sort/status/user_id filters + `days_left`/`computedStatus`. `bulk_extend_subscriptions` and `bulk_revoke_subscriptions` endpoints. IDOR fix on `get_user_subscriptions` (admin-only override).
  - **Shared Infrastructure**: Production-grade RBAC. Server-side `get_users` API with computed 6-state status model (`active`, `expiring`, `partial`, `expired`, `no_access`, `disabled`) derived from subscriptions. `computeUserStatus()` and `mapUserRow()` are the single source of truth. Server-side search, filter, sort, pagination with correct counts for computed-status filters. `create_user_with_sub` is transactional with duplicate username blocking. `toggle_user` accepts explicit action and revokes sessions on disable. `delete_user` has impact preview (`delete_user_preview`) + type-to-confirm + pending payment guard, wrapped in transaction. `revoke_subscription` endpoint replaces hard delete. `check_username` availability endpoint for real-time UI feedback. `export_users_csv` server-side endpoint. Background subscription expiry enforcement in `autoRecheckJob`. Frontend uses `_userDataCache` Map, `fetchUsersFromServer()` with debounced search and skeleton loading, `refreshUsersTable()` for lightweight post-mutation refresh. **Frontend Quality (CSS+UX)**: `badge-status` with 6 status variants + dot indicators (`badge-active/expiring/partial/expired/disabled/no-access`), `skel-row/bar/circle` shimmer skeletons, `showTableSkeleton()` 8-row shimmer on fetch, `getExpiryDisplay()` relative+absolute date display with danger/warn/ok coloring, `plat-count-chip` for platform counts, `tbl-act` icon-only action buttons with view/edit/danger/success variants and `aria-label` accessibility, `user-empty-state` with illustration for no-results/error states. Create form: password show/hide toggle (`cuTogglePassword`), "Platform Access" section with Optional pill, shorter duration presets (7d/30d/etc), `cuDaysLabel` context display, `cuAccessHint` reactive info/warn hints (`cuUpdateHint`), `cuResetFormFields` clear button with password type reset. View modal: grouped sections with `vu-section-title` (Account Details, Access & Security), `vu-info-grid` 2-column layout, `vu-sub-card` for subscriptions/slots with badge-status and tbl-act action buttons. Delete modal has type-to-confirm with impact summary.
- **Platform Management**: CRUD operations for platforms and account slots.
- **Cookie Vault**: Secure storage for cookies with validation and auto-detection.
- **Support System**: Ticketing, contact management, announcements, and notifications.
- **Reseller System**: Wallet management for resellers.
- **Chrome Extension Integration**: Secure cookie injection and real-time session heartbeat.
- **Session Reconstruction**: Full session reconstruction including cookies, localStorage, sessionStorage, and API token verification.
- **Activity Monitoring**: Active session monitoring, login attempt tracking, and force logout capabilities.
- **Account Manager Safety**: Enhanced session revocation, type-to-confirm for dangerous deletes, recheck functionalities with reasons, and improved UI for account health monitoring.
- **Platform Intelligence**: 5-state classification (healthy/degraded/unused/inactive/dead) with composite scoring, async health checks, safe deletion/disabling, and logo management. Premium detail modal with gradient header, inline logo upload (ObjectURL preview + shimmer skeleton + cache-busting), colored stat cards, `plat-slots-table` with "Verified/Failed X ago" sub-rows and "Created" column, tiered stale-data warnings (`_platStaleLevel`: >24h amber, >72h red/critical), and status-based recommendation labels (`_platRecommendation`). Registry table: debounced search (250ms), sort direction arrows (`.plat-sort-arrow`), pagination (25/page with `platChangePage`), bulk enable/disable (`bulkTogglePlatforms` with batched Promise.allSettled, 5 concurrent), DocumentFragment rendering. **Edit Platform modal** (`platEditModal`): prefilled form for Name, Domain, Login URL, Max Slots (1-50), Brand Color (#RRGGBB); dirty-state detection with disabled save until changes; inline validation; domain-change impact warnings for linked accounts; partial UI refresh via local cache update (no full reload). Backend `update_platform`: fetches old values before update, logs field-level old→new diffs in audit log, server-side validation (name required, domain/name duplicate checks, format validation), returns updated platform data, cache invalidation. **RBAC enforcement**: Delete button hidden for non-super_admin in both registry table rows and detail modal footer (via `data-rbac` + inline check). Edit button added in table rows and detail modal footer. **Bulk action impact summaries**: bulk toggle/delete show platform names, total accounts, active sessions in confirmation dialogs. **Time semantics**: `_platAbsoluteTime` now shows both local time and UTC in tooltips. CSS: `msg-modal-header/close/footer`, `plat-logo-wrap`, `plat-detail-stat`, `plat-slots-table`, `plat-action-btn` (danger/success/primary), `plat-loading-skeleton`, `plat-stale-warn` (amber/red), `plat-recommendation` (warn/danger/info/muted), `plat-page-controls/btn`, `plat-sort-arrow`, `plat-edit-*` (group/label/input/error/hint/row/warning).

### Duration Units & Access Mode System
- **Schema**: `UserSubscription` has `durationValue` (Int, nullable) and `durationUnit` (String, default "days"). Supports "minutes", "hours", "days".
- **Date format**: `endDate` stores date-only ("2024-01-15") for day-based subs, full datetime ("2024-01-15 14:30:00") for minutes/hours subs.
- **Backend helpers** (`backend/utils/helpers.js`): `computeEndDate(value, unit)`, `extendEndDate(currentEnd, value, unit)`, `isSubExpired(endDate)` (handles both formats), `getUserAccessMode(prisma, userId)` returns 'short' (only minutes/hours subs), 'regular' (has days subs), or 'none'.
- **Access mode**: Dashboard and profile routes include `access_mode` in response. Short-access users cannot edit profile (tab hidden, `switchTab` guard). Profile completion redirect removed from dashboard.
- **Admin UI**: Create User and Manage Access both have unit selector (Minutes/Hours/Days) with per-unit presets, expiry preview, and send `duration_value`/`duration_unit` to backend. Backend routes accept both old (`duration_in_days`, `duration_days`) and new params for backwards compatibility.
- **Subscription status**: `get_subscriptions` and `get_user_subscriptions` use `isSubExpired()` for accurate minute/hour expiry detection. `extend_subscription` updates `durationUnit`/`durationValue` when unit changes.
- **Frontend date parsing**: Dashboard uses `parseEndDate()` utility; profile.html uses inline parsing with space-to-T replacement. Both handle date-only and datetime formats. Remaining time shows days/hours/minutes as appropriate.

### Global Admin Dead-Platform Notification System
- **AdminNotification model** (`admin_notifications` table): Stores platform-dead alerts with `type`, `title`, `message`, `platformId`, `platformName`, `severity`, `isRead`, `dedupeKey` (e.g. `platform_dead_{id}_{date}`), `createdAt`. Indexed on `(isRead, createdAt)` and `dedupeKey`.
- **Transition detection**: `autoRecheckJob` in `server.js` detects when a `PlatformAccount` transitions from any non-DEAD `stabilityStatus` to `DEAD`. Deduped per platform per day. Creates an `AdminNotification` row and emits a `platform_dead_alert` Socket.io event to `admin_room`.
- **Auto-resolution**: When a platform recovers (all accounts leave DEAD status), `platform_dead` notifications are automatically deleted from the database and removed from the admin bell in real-time via `platform_dead_resolved` Socket.io event. Works in `autoRecheckJob`, single-account recheck, and `recheck_all`. Uses Prisma transactions for atomicity (count + delete). Skips resolution if platform also had new DEAD transitions in the same batch.
- **API routes** in `backend/routes/admin.js`:
  - `GET /api/admin/notifications` — returns up to 30 notifications + unread count (auth+admin required)
  - `POST /api/admin/notifications/mark-read` — marks one (by `id`) or all notifications as read
- **Frontend (`admin.html`)**: Bell icon in sticky header with animated red badge (unread count); sidebar badge on Platform Intelligence nav item; notification dropdown with per-item read/unread state, time-ago, click-to-navigate to Platform Intelligence; "View Dead Platforms" footer CTA; critical red-left-border toast (8s, click-dismissible, one-per-session per notification via `sessionStorage`). Zero polling — purely Socket.io push + one-time load at admin_init. `_resolveDeadNotifs()` removes notifications client-side on `platform_dead_resolved` event and shows a recovery toast.

### User Profile Location System
- **IP Geolocation**: Automatic IP location lookup on login using ip-api.com (primary, HTTPS) and ipapi.co (fallback). Results cached in `IpGeoCache` table with 72h TTL. Private IP detection for IPv4/IPv6/mapped addresses. Fields stored on User: `ipCountry`, `ipRegion`, `ipCity`, `ipIsp`, `ipTimezone`, `ipLat`, `ipLon`, `ipLookupStatus`.
- **Device GPS Location**: Browser Geolocation API integration. User grants permission, GPS coordinates sent to backend. Reverse geocoded via Nominatim (with User-Agent header). Fields stored on User: `deviceLat`, `deviceLon`, `deviceAccuracy`, `deviceAddress`, `deviceCity`, `deviceRegion`, `deviceCountry`, `deviceLocationAt`.
- **API Endpoints**:
  - `GET /api/security-location` — returns both IP and device location data with confidence levels
  - `POST /api/device-location` — saves device GPS coords with strict validation (`Number.isFinite`, range checks, accuracy bounds 0-100000)
  - `POST /api/refresh-ip-location` — re-lookups current IP with proper success/fail semantics and persists failed status
- **Profile UI**: Access & Security section in profile View tab with separate IP Location and Device Location cards. Confidence badges (high/medium/low/none), refresh buttons, skeleton loaders, tooltips.
- **Utility**: `backend/utils/geoip.js` — `lookupIP()`, `reverseGeocode()`, cache management with Date-based TTL comparison.

## External Dependencies
- **Node.js Libraries**: `express`, `@prisma/client`, `jsonwebtoken`, `bcryptjs`, `cookie-parser`, `socket.io`, `multer`, `express-rate-limit`.
- **Frontend Libraries**: Tailwind CSS v3 (CDN), intl-tel-input v18 (CDN).