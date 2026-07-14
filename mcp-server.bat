@echo off
cd /d "%~dp0"
set COORDINATOR_DB=.coordinator/coordinator.db
npx tsx src/mcp/server.ts
