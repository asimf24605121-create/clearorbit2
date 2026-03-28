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