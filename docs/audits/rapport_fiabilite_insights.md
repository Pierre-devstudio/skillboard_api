# Diagnostic fiabilitÃ© Insights â€“ couverture / fragilitÃ© compÃ©tences
## Base testÃ©e
- Fichiers de dÃ©veloppement : `skillboard_api.zip` fourni dans le dernier message.
- DonnÃ©es Supabase : export CSV `Supabase Snippet Insights fiabilitÃ© _ couverture compÃ©tences par poste.csv`.
- Seuil testÃ© : criticitÃ© `>= 70`, identique au dÃ©faut actuel de la page Analyse.
- Lignes export : **131**.
- Couples poste/compÃ©tence dans le seuil : **31**.
- CompÃ©tences critiques analysÃ©es : **25**.

## ProblÃ¨mes confirmÃ©s dans le code actuel
1. La table **CompÃ©tences critiques** calcule son indice depuis des porteurs dÃ©clarÃ©s, alors que le modal dÃ©tail mÃ©lange cette lecture avec des Ã©tats RH recalculÃ©s ailleurs. RÃ©sultat : indice table â‰  indice modal.
2. Le KPI `comp_critiques_fragiles` du rÃ©sumÃ© est reconstruit depuis les compteurs des postes, donc il compte des occurrences poste/compÃ©tence, pas des compÃ©tences uniques. RÃ©sultat : KPI â‰  table.
3. Une Ã©valuation peut Ãªtre considÃ©rÃ©e exploitable si `date_derniere_eval` existe seule. Le test impose une Ã©valuation exploitable : rÃ©sultat dâ€™audit prÃ©sent + date/audit rattachÃ©.
4. Les causes racines du modal compÃ©tence sont produites depuis une source diffÃ©rente de lâ€™indice affichÃ©. RÃ©sultat : parfois un score avec aucune cause, parfois des causes sans cohÃ©rence avec le score.
5. Le front indique encore â€œporteurs nominauxâ€ alors que la lecture fiable doit afficher des porteurs validÃ©s. Oui, mÃªme les libellÃ©s peuvent mentir, quelle pÃ©riode formidable.

## Doctrine corrigÃ©e
| Situation | Ã‰tat RH | Risque ligne |
|---|---:|---:|
| AUCUN_TITULAIRE | Aucun Titulaire | 100 |
| COUVERTURE_ABSENTE | Couverture Absente | 100 |
| COUVERTURE_NON_CONFIRMEE | Couverture Non Confirmee | 85 |
| NIVEAU_INSUFFISANT | Niveau Insuffisant | 70 |
| DEPENDANCE | Dependance | 60 |
| COUVERTURE_VALIDEE | Couverture Validee | 0 |

RÃ¨gle centrale : **une compÃ©tence dÃ©clarÃ©e mais non Ã©valuÃ©e ne couvre pas un poste**.

## RÃ©sultat des scÃ©narios sur les donnÃ©es fournies
| Ã‰tat                     |   Nombre |
|:-------------------------|---------:|
| DEPENDANCE               |       16 |
| NIVEAU_INSUFFISANT       |       10 |
| COUVERTURE_NON_CONFIRMEE |        3 |
| COUVERTURE_ABSENTE       |        1 |
| COUVERTURE_VALIDEE       |        1 |

## SynthÃ¨se par poste dans le seuil
| codif_poste   | intitule_poste                                      |   nb_comp |   indice_moyen |   indice_max |   absente |   non_confirmee |   insuffisante |   dependance |   validee |
|:--------------|:----------------------------------------------------|----------:|---------------:|-------------:|----------:|----------------:|---------------:|-------------:|----------:|
| PT0001        | Technico-commercial - SpÃ©cialitÃ© stores et pergolas |         3 |             52 |           85 |         0 |               1 |              1 |            0 |         1 |
| PT0002        | Administration des ventes / Accueil                 |         5 |             68 |           70 |         0 |               0 |              4 |            1 |         0 |
| PT0003        | Gestionnaire Planning                               |         7 |             67 |          100 |         1 |               0 |              1 |            5 |         0 |
| PT0004        | Assistant(e) commercial(e) / Accueil                |         8 |             67 |           85 |         0 |               1 |              3 |            4 |         0 |
| PT0005        | Gestionnaire administratif(ve) SAV & DÃ©pannage      |         6 |             64 |           85 |         0 |               1 |              0 |            5 |         0 |
| PT0006        | Technicien(ne) SAV & DÃ©pannage                      |         2 |             65 |           70 |         0 |               0 |              1 |            1 |         0 |

## Top compÃ©tences fragiles attendues
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

## ContrÃ´les automatiques du test
- Aucune compÃ©tence non Ã©valuÃ©e ne peut Ãªtre validÃ©e.
- Aucune compÃ©tence insuffisante ne peut avoir un risque 0.
- Indice table compÃ©tence = indice modal compÃ©tence.
- Indice > 0 implique au moins une cause racine.
- Indice = 0 implique aucune cause de fragilitÃ©.

## Correctif produit
Le patch ajoute une source unique `_fetch_competence_fragility_records()` utilisÃ©e par la table, les KPI et le modal compÃ©tence. Le front nâ€™a plus Ã  recalculer la vÃ©ritÃ© mÃ©tier, il affiche ce que le backend qualifie.
