INSTALLATION AUDIT FIABILITE INSIGHTS
=====================================

1) Dezippe le contenu de ce pack directement dans la racine de ton projet skillboard_api.
   Tu dois obtenir :

   skillboard_api\
   - INSTALL_AUDIT_INSIGHTS.bat
   - RUN_AUDIT_INSIGHTS.bat
   - tools\audit_insights\test_fiabilite_insights.py
   - docs\audits\rapport_fiabilite_insights.md
   - _local_audit\insights\...

2) Double-clique sur :

   INSTALL_AUDIT_INSIGHTS.bat

   Ce script :
   - verifie que tu es bien a la racine du projet ;
   - ajoute _local_audit/ dans .gitignore ;
   - lance le test de fiabilite sur le CSV fourni.

3) Pour relancer le test plus tard :

   RUN_AUDIT_INSIGHTS.bat

4) Important Git :

   A COMMIT :
   - tools/audit_insights/test_fiabilite_insights.py
   - docs/audits/rapport_fiabilite_insights.md
   - docs/audits/audit_fiabilite_calculs_insights.sql
   - .gitignore si le script l'a modifie

   A NE PAS COMMIT :
   - _local_audit/

   _local_audit contient les exports Supabase et les resultats d'audit locaux.
