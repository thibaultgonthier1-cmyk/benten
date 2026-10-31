@echo off
REM Lance l'apercu vivant de l'app mobile, au format telephone, sur le PC.
REM La bibliotheque affichee est la vraie : elle vient du serveur local de Benten.
set ELECTRON_RUN_AS_NODE=
start "" "%~dp0..\node_modules\electron\dist\electron.exe" "%~dp0"
