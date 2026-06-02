@echo off
setlocal

echo.
echo ===============================================
echo  Installation audit fiabilite Insights
 echo ===============================================
echo.

if not exist "unified_api" (
  echo ERREUR : lance ce fichier depuis la racine du projet skillboard_api.
  echo On doit voir les dossiers unified_api et static au meme niveau.
  echo.
  pause
  exit /b 1
)

if not exist "static" (
  echo ERREUR : dossier static introuvable. Tu n'es pas a la racine du projet.
  echo.
  pause
  exit /b 1
)

if not exist "tools\audit_insights\test_fiabilite_insights.py" (
  echo ERREUR : le fichier tools\audit_insights\test_fiabilite_insights.py est introuvable.
  echo Dezippe le pack directement dans la racine du projet.
  echo.
  pause
  exit /b 1
)

if not exist ".gitignore" (
  echo .gitignore introuvable : creation.
  type nul > .gitignore
)

findstr /C:"_local_audit/" .gitignore >nul 2>nul
if errorlevel 1 (
  echo.>> .gitignore
  echo # Audits locaux / exports Supabase>> .gitignore
  echo _local_audit/>> .gitignore
  echo Ajout de _local_audit/ dans .gitignore
) else (
  echo _local_audit/ est deja present dans .gitignore
)

echo.
echo Installation OK.
echo.
echo Lancement du test de fiabilite avec le CSV fourni...
echo.

python "tools\audit_insights\test_fiabilite_insights.py" "_local_audit\insights\Supabase Snippet Insights fiabilite - couverture competences par poste.csv"

if errorlevel 1 (
  echo.
  echo TEST EN ECHEC. Lis les messages ci-dessus.
) else (
  echo.
  echo TEST OK.
)

echo.
pause
