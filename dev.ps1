# Development startup: spin up database and run app with hot reload

Write-Host "🐳 Starting PostgreSQL..."
docker compose -f docker-compose.dev.yml down --volumes 2>$null
docker compose -f docker-compose.dev.yml up -d postgres

Write-Host "⏳ Waiting for PostgreSQL to be ready..."
$retries = 0
while ($retries -lt 30) {
  try {
    docker compose -f docker-compose.dev.yml exec -T postgres pg_isready -U recharge_hub -d recharge_hub 2>$null
    if ($?) { break }
  } catch {}
  $retries++
  Start-Sleep -Seconds 1
}

Write-Host "📦 Installing dependencies..."
npm install

Write-Host "🔄 Running migrations..."
npx prisma migrate deploy

Write-Host "🚀 Starting dev server (hot reload enabled)..."
npm run dev
