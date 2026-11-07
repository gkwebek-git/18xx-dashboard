@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 18xx TV - helyi
if "%~1"=="" (node tv-local.mjs) else (node tv-local.mjs %1)
pause
