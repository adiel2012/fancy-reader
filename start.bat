@echo off
setlocal
cd /d "%~dp0"
set PORT=8765
echo Iniciando Voz Alta en http://localhost:%PORT%/
echo Deja esta ventana abierta mientras uses la app. Ciérrala para detener el servidor.
where py >nul 2>&1 && ( start "" "http://localhost:%PORT%/" & py -3 -m http.server %PORT% --bind 127.0.0.1 & goto :fin )
where python >nul 2>&1 && ( start "" "http://localhost:%PORT%/" & python -m http.server %PORT% --bind 127.0.0.1 & goto :fin )
where node >nul 2>&1 && ( start "" "http://localhost:%PORT%/" & node serve.js %PORT% & goto :fin )
echo.
echo No encontre Python ni Node.js. Instala uno de los dos (por ejemplo Node.js desde nodejs.org) y vuelve a abrir este archivo.
pause
:fin
