# Development Setup

Quick commands to spin up the full local development environment with hot reload.

## One-Command Setup

### macOS / Linux
```bash
./dev.sh
```

### Windows (PowerShell)
```powershell
.\dev.ps1
```

### Manual Setup (all platforms)
```bash
# 1. Start PostgreSQL in Docker
docker compose -f docker-compose.dev.yml up -d postgres

# 2. Wait for DB to be ready
docker compose -f docker-compose.dev.yml exec postgres pg_isready -U recharge_hub -d recharge_hub

# 3. Install dependencies
npm install

# 4. Run migrations
npx prisma migrate deploy

# 5. Start dev server with hot reload
npm run dev
```

## What This Does

- **PostgreSQL 16** runs in Docker on `localhost:5432`
- **App server** runs locally with hot reload at `http://localhost:52133` (via React Router dev)
- **Shopify CLI proxy** runs at `https://enb-gender-vbulletin-suspension.trycloudflare.com` (or your configured tunnel)
- **Worker queue** runs locally for background jobs

## Testing in Browser

Once `npm run dev` is running, open Brave (or any browser) and navigate to your Shopify dev store:

```
admin.shopify.com/store/YOUR-STORE/apps/mk-sync/app/setup
```

The setup wizard should now work smoothly end-to-end:
- ✅ Welcome step
- ✅ Connect (MetaKocka credentials)
- ✅ Warehouses & stock (no "Handling response" errors)
- ✅ Orders & payments
- ✅ Review & finish

## Stopping Everything

```bash
# Stop the dev server (Ctrl+C in terminal)

# Stop PostgreSQL
docker compose -f docker-compose.dev.yml down

# Stop and remove all data (fresh start next time)
docker compose -f docker-compose.dev.yml down --volumes
```

## Troubleshooting

**"Port 5432 already in use"**
```bash
docker compose -f docker-compose.dev.yml down --volumes
# Then try again
```

**"Connection refused"**
Wait a few more seconds for PostgreSQL to start:
```bash
docker compose -f docker-compose.dev.yml exec postgres pg_isready -U recharge_hub -d recharge_hub
```

**"Migrations failed"**
```bash
# Reset the database and re-run migrations
docker compose -f docker-compose.dev.yml down --volumes
# Then run dev.sh / dev.ps1 again
```

## Testing Session Recovery

To test the seamless session recovery fix:

1. Start setup wizard, go to the "Warehouses and stock" step
2. Fill in your warehouse mappings
3. Click Continue
4. If there's a transient auth issue, the page will silently redirect and reload
5. You should see the "Orders & payments" step loaded successfully

No error banners should appear — it should be transparent.
