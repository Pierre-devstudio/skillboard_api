# Export des sources Novoskill

Le script `export_novoskill_sources.ps1` exporte :

- tous les fichiers suivis par Git ;
- tous les fichiers Python ;
- les fichiers HTML, CSS, JavaScript, SQL, JSON, Markdown, TXT, SVG et de configuration ;
- les fichiers de règles, droits et cadrage suivis dans le dépôt ;
- les assets suivis nécessaires au fonctionnement du projet ;
- en option, les fichiers source non suivis.

Il exclut :

- `.git` ;
- environnements virtuels ;
- caches ;
- logs ;
- patches ;
- archives ;
- bases locales ;
- fichiers `.env` et fichiers de secrets connus.

## Utilisation PowerShell

Depuis la racine du projet :

```powershell
.\tools\export_novoskill_sources.ps1 -IncludeUntrackedSources
```

L'archive est créée sur le Bureau.

## Utilisation depuis Visual Studio Code

1. Copier `tasks.json` dans `.vscode\tasks.json`.
2. Ouvrir `Terminal > Exécuter la tâche`.
3. Choisir `Novoskill : exporter toutes les sources`.

Chaque ZIP contient `_MANIFESTE_EXPORT_NOVOSKILL.txt`, avec le nombre total de fichiers et le nombre de fichiers Python.
