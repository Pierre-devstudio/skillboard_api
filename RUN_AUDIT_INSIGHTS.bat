@echo off
setlocal

echo.
echo ===============================================
echo  Test fiabilite Insights
 echo ===============================================
echo.

if not exist "tools\audit_insights\test_fiabilite_insights.py" (
  echo ERREUR : test_fiabilite_insights.py introuvable.
  echo Lance d'abord INSTALL_AUDIT_INSIGHTS.bat depuis la racine du projet.
  echo.
  pause
  exit /b 1
)

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
