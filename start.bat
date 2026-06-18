@echo off
REM Copy .env.example to .env and fill in your DEEPSEEK_API_KEY before running.
REM set DEEPSEEK_API_KEY=sk-your-key-here
cd /d "%~dp0"
bun run src/index.ts %*
