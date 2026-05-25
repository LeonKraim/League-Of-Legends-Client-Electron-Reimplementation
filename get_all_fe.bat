@echo off
cd /d "%~dp0"
echo ========================================
echo   League FE Asset Dumper
echo ========================================
echo.
echo This script extracts all frontend (FE)
echo JavaScript and CSS files from the installed
echo League of Legends WAD archive files.
echo.
echo Output: fe_raw\{pluginName}\
echo.
echo Options:
echo   --quick     Extract only main JS/CSS files (fast)
echo   --manifest  Only generate WAD file manifests
echo   default     Extract main files + generate manifests
echo.
echo These files are NEVER committed to git
echo (fe_raw/ is in .gitignore). Use them for
echo local inspection when creating patches.
echo ========================================
echo.

node scripts\dump-fe.js %*

echo.
pause
