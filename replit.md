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
- **User & Subscription Management**: Comprehensive user, subscription, and payment management with RBAC.
- **Platform Management**: CRUD operations for platforms and account slots.
- **Cookie Vault**: Secure storage for cookies with validation and auto-detection.
- **Support System**: Ticketing, contact management, announcements, and notifications.
- **Reseller System**: Wallet management for resellers.
- **Chrome Extension Integration**: Secure cookie injection and real-time session heartbeat.
- **Session Reconstruction**: Full session reconstruction including cookies, localStorage, sessionStorage, and API token verification.
- **Activity Monitoring**: Active session monitoring, login attempt tracking, and force logout capabilities.
- **Account Manager Safety**: Enhanced session revocation, type-to-confirm for dangerous deletes, recheck functionalities with reasons, and improved UI for account health monitoring.
- **Platform Intelligence**: Provides a 5-state classification for platforms (healthy, degraded, unused, inactive, dead) based on a composite score, with features for async health checks, safe deletion/disabling, and logo management. Premium redesigned detail modal with gradient header, inline logo upload (shimmer skeleton + cache-busting), colored stat cards, `plat-slots-table` with "Failed X ago" sub-rows, stale-data warnings (>24h), and `plat-action-btn` variants (danger/success/primary). CSS classes: `msg-modal-header`, `msg-modal-close`, `msg-modal-footer`, `plat-logo-wrap`, `plat-detail-stat`, `plat-slots-table`, `plat-action-btn`, `plat-loading-skeleton`. Dead code `_platLogoHtml` removed.

## External Dependencies
- **Node.js Libraries**: `express`, `@prisma/client`, `jsonwebtoken`, `bcryptjs`, `cookie-parser`, `socket.io`, `multer`, `express-rate-limit`.
- **Frontend Libraries**: Tailwind CSS v3 (CDN), intl-tel-input v18 (CDN).