@echo off
setlocal

for %%I in ("%~dp0..") do set "PLUGIN_ROOT=%%~fI"
for %%I in ("%PLUGIN_ROOT%\..\..") do set "PROJECT_ROOT=%%~fI"

set "MCP_HOME=%USERPROFILE%\.codex\playwright-mcp-package"
set "MCP_CLI=%MCP_HOME%\node_modules\@playwright\mcp\cli.js"
set "CONFIG_PATH=%PROJECT_ROOT%\codex\playwright-mcp.config.json"

if not exist "%CONFIG_PATH%" (
  echo Project Playwright MCP config is missing at "%CONFIG_PATH%".
  exit /b 1
)

if not exist "%MCP_CLI%" (
  echo Playwright MCP CLI is not installed at "%MCP_CLI%".
  echo Install it into "%MCP_HOME%" and rerun Codex.
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found in PATH.
  echo Install Node.js 22+ or add it to PATH before starting Codex.
  exit /b 1
)

pushd "%PROJECT_ROOT%" >nul
node "%MCP_CLI%" --config "%CONFIG_PATH%" %*
set "EXIT_CODE=%ERRORLEVEL%"
popd >nul

exit /b %EXIT_CODE%
