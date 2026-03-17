#!/bin/bash
cd "$(dirname "$0")"

export PATH="$HOME/.local/node/bin:$PATH"

# Kill previous instances
lsof -ti:3001 | xargs kill 2>/dev/null
lsof -ti:5173 | xargs kill 2>/dev/null

echo "🚀 Uruchamiam TIX Terminal..."
echo ""

# Start backend
echo "→ Backend (port 3001)..."
cd server
npx tsx src/index.ts &
SERVER_PID=$!
cd ..

# Wait for server to be ready
sleep 2

# Start frontend
echo "→ Frontend (port 5173)..."
cd client
npx vite --host &
CLIENT_PID=$!
cd ..

# Wait for vite to be ready
sleep 3

# Open browser
echo ""
echo "→ Otwieram przeglądarkę..."
open http://localhost:5173

echo ""
echo "✅ TIX Terminal działa na http://localhost:5173"
echo "   Naciśnij Ctrl+C aby zatrzymać."
echo ""

# Wait for Ctrl+C
trap "kill $SERVER_PID $CLIENT_PID 2>/dev/null; echo ''; echo 'Zatrzymano.'; exit 0" INT
wait
