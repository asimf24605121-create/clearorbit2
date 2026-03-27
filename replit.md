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

## External Dependencies
- **Node.js Libraries**: `express`, `@prisma/client`, `jsonwebtoken`, `bcryptjs`, `cookie-parser`, `socket.io`, `multer`, `express-rate-limit`.
- **Frontend Libraries**: Tailwind CSS v3 (CDN), intl-tel-input v18 (CDN).