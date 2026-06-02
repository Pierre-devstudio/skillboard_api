# Diagnostic fiabilité Insights – couverture / fragilité compétences
## Base testée
- Fichiers de développement : `skillboard_api.zip` fourni dans le dernier message.
- Données Supabase : export CSV `Supabase Snippet Insights fiabilité _ couverture compétences par poste.csv`.
- Seuil testé : criticité `>= 70`, identique au défaut actuel de la page Analyse.
- Lignes export : **131**.
- Couples poste/compétence dans le seuil : **31**.
- Compétences critiques analysées : **25**.

## Problèmes confirmés dans le code actuel
1. La table **Compétences critiques** calcule son indice depuis des porteurs déclarés, alors que le modal détail mélange cette lecture avec des états RH recalculés ailleurs. Résultat : indice table ≠ indice modal.
2. Le KPI `comp_critiques_fragiles` du résumé est reconstruit depuis les compteurs des postes, donc il compte des occurrences poste/compétence, pas des compétences uniques. Résultat : KPI ≠ table.
3. Une évaluation peut être considérée exploitable si `date_derniere_eval` existe seule. Le test impose une évaluation exploitable : résultat d’audit présent + date/audit rattaché.
4. Les causes racines du modal compétence sont produites depuis une source différente de l’indice affiché. Résultat : parfois un score avec aucune cause, parfois des causes sans cohérence avec le score.
5. Le front indique encore “porteurs nominaux” alors que la lecture fiable doit afficher des porteurs validés. Oui, même les libellés peuvent mentir, quelle période formidable.

## Doctrine corrigée
| Situation | État RH | Risque ligne |
|---|---:|---:|
| AUCUN_TITULAIRE | Aucun Titulaire | 100 |
| COUVERTURE_ABSENTE | Couverture Absente | 100 |
| COUVERTURE_NON_CONFIRMEE | Couverture Non Confirmee | 85 |
| NIVEAU_INSUFFISANT | Niveau Insuffisant | 70 |
| DEPENDANCE | Dependance | 60 |
| COUVERTURE_VALIDEE | Couverture Validee | 0 |

Règle centrale : **une compétence déclarée mais non évaluée ne couvre pas un poste**.

## Résultat des scénarios sur les données fournies
| État                     |   Nombre |
|:-------------------------|---------:|
| DEPENDANCE               |       16 |
| NIVEAU_INSUFFISANT       |       10 |
| COUVERTURE_NON_CONFIRMEE |        3 |
| COUVERTURE_ABSENTE       |        1 |
| COUVERTURE_VALIDEE       |        1 |

## Synthèse par poste dans le seuil
| codif_poste   | intitule_poste                                      |   nb_comp |   indice_moyen |   indice_max |   absente |   non_confirmee |   insuffisante |   dependance |   validee |
|:--------------|:----------------------------------------------------|----------:|---------------:|-------------:|----------:|----------------:|---------------:|-------------:|----------:|
| PT0001        | Technico-commercial - Spécialité stores et pergolas |         3 |             52 |           85 |         0 |               1 |              1 |            0 |         1 |
| PT0002        | Administration des ventes / Accueil                 |         5 |             68 |           70 |         0 |               0 |              4 |            1 |         0 |
| PT0003        | Gestionnaire Planning                               |         7 |             67 |          100 |         1 |               0 |              1 |            5 |         0 |
| PT0004        | Assistant(e) commercial(e) / Accueil                |         8 |             67 |           85 |         0 |               1 |              3 |            4 |         0 |
| PT0005        | Gestionnaire administratif(ve) SAV & Dépannage      |         6 |             64 |           85 |         0 |               1 |              0 |            5 |         0 |
| PT0006        | Technicien(ne) SAV & Dépannage                      |         2 |             65 |           70 |         0 |               0 |              1 |            1 |         0 |

## Top compétences fragiles attendues
| code_competence   |   nb_postes |   indice_table |   absente |   non_confirmee |   insuffisante |   dependance |   validee |
|:------------------|------------:|---------------:|----------:|----------------:|---------------:|-------------:|----------:|
| CO00083           |           1 |            100 |         1 |               0 |              0 |            0 |         0 |
| CO00059           |           1 |             85 |         0 |               1 |              0 |            0 |         0 |
| CO00085           |           1 |             85 |         0 |               1 |              0 |            0 |         0 |
| CO00086           |           1 |             85 |         0 |               1 |              0 |            0 |         0 |
| CO00024           |           1 |             70 |         0 |               0 |              1 |            0 |         0 |
| CO00025           |           1 |             70 |         0 |               0 |              1 |            0 |         0 |
| CO00048           |           1 |             70 |         0 |               0 |              1 |            0 |         0 |
| CO00049           |           1 |             70 |         0 |               0 |              1 |            0 |         0 |
| CO00055           |           1 |             70 |         0 |               0 |              1 |            0 |         0 |
| CO00057           |           1 |             70 |         0 |               0 |              1 |            0 |         0 |
| CO00023           |           2 |             66 |         0 |               0 |              1 |            1 |         0 |
| CO00047           |           2 |             65 |         0 |               0 |              1 |            1 |         0 |
| CO00052           |           2 |             65 |         0 |               0 |              1 |            1 |         0 |
| CO00063           |           2 |             65 |         0 |               0 |              1 |            1 |         0 |
| CO00022           |           2 |             60 |         0 |               0 |              0 |            2 |         0 |
| CO00053           |           2 |             60 |         0 |               0 |              0 |            2 |         0 |
| CO00021           |           1 |             60 |         0 |               0 |              0 |            1 |         0 |
| CO00042           |           1 |             60 |         0 |               0 |              0 |            1 |         0 |
| CO00051           |           1 |             60 |         0 |               0 |              0 |            1 |         0 |
| CO00054           |           1 |             60 |         0 |               0 |              0 |            1 |         0 |
| CO00056           |           1 |             60 |         0 |               0 |              0 |            1 |         0 |
| CO00058           |           1 |             60 |         0 |               0 |              0 |            1 |         0 |
| CO00060           |           1 |             60 |         0 |               0 |              0 |            1 |         0 |
| CO00064           |           1 |             60 |         0 |               0 |              0 |            1 |         0 |
| CO00020           |           1 |              0 |         0 |               0 |              0 |            0 |         1 |

## Contrôles automatiques du test
- Aucune compétence non évaluée ne peut être validée.
- Aucune compétence insuffisante ne peut avoir un risque 0.
- Indice table compétence = indice modal compétence.
- Indice > 0 implique au moins une cause racine.
- Indice = 0 implique aucune cause de fragilité.

## Correctif produit
Le patch ajoute une source unique `_fetch_competence_fragility_records()` utilisée par la table, les KPI et le modal compétence. Le front n’a plus à recalculer la vérité métier, il affiche ce que le backend qualifie.
