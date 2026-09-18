#!/bin/bash
# Development startup: spin up database and run app with hot reload

set -e

echo "🐳 Starting PostgreSQL..."
docker compose -f docker-compose.dev.yml down --volumes 2>/dev/null || true
docker compose -f docker-compose.dev.yml up -d postgres

echo "⏳ Waiting for PostgreSQL to be ready..."
docker compose -f docker-compose.dev.yml exec -T postgres pg_isready -U recharge_hub -d recharge_hub 2>/dev/null || sleep 5

echo "📦 Installing dependencies..."
npm install

echo "🔄 Running migrations..."
npx prisma migrate deploy

echo "🚀 Starting dev server (hot reload enabled)..."
npm run dev
