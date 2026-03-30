#!/bin/bash
set -e

echo "Running post-merge setup..."

cd backend
npm install --no-audit --no-fund 2>/dev/null || true
DATABASE_URL='file:/home/runner/workspace/data/clearorbit.db' npx prisma generate 2>/dev/null
DATABASE_URL='file:/home/runner/workspace/data/clearorbit.db' npx prisma db push --accept-data-loss 2>/dev/null || true

echo "Post-merge setup complete"
