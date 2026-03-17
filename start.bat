@echo off
cd /d "%~dp0"

echo Uruchamiam TIX Terminal...
echo.

:: Start backend
echo -^> Backend (port 3001)...
start /b cmd /c "cd server && npx tsx src/index.ts"

:: Wait for server
timeout /t 3 /nobreak >nul

:: Start frontend
echo -^> Frontend (port 5173)...
start /b cmd /c "cd client && npx vite --host"

:: Wait for vite
timeout /t 4 /nobreak >nul

:: Open browser
echo.
echo -^> Otwieram przegladarke...
start http://localhost:5173

echo.
echo TIX Terminal dziala na http://localhost:5173
echo Nacisnij Ctrl+C aby zatrzymac.
echo.

:: Keep window open
pause
