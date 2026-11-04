@echo off
rem Abre o Editor GP-5 / GP-50 no Chrome. Deixe esta janela aberta enquanto usa o editor.
cd /d "%~dp0"
python iniciar.py
if errorlevel 1 pause
