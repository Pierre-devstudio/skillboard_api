/* =============================================================
   AUDIT FIABILITÉ CALCULS INSIGHTS / NOVOSKILL
   Objectif : extraire les données nécessaires pour tester la cohérence
   poste -> compétences requises -> collaborateurs -> évaluations -> statut de couverture.

   À modifier avant exécution :
   - id_ent : identifiant de l'entreprise auditée
   - id_service : NULL pour toute l'entreprise, ou id_service pour un service ciblé
   - criticite_min : seuil utilisé dans Analyse / Dashboard
   ============================================================= */

WITH params AS (
    SELECT
        'A_REMPLACER_ID_ENT'::text AS id_ent,
        NULL::text AS id_service,
        70::int AS criticite_min,
        6::int AS mois_fiabilite
),
services_scope AS (
    SELECT o.id_service, o.nom_service
    FROM public.tbl_entreprise_organigramme o
    JOIN params p ON p.id_ent = o.id_ent
    WHERE COALESCE(o.archive, FALSE) = FALSE
      AND (p.id_service IS NULL OR o.id_service = p.id_service)
),
postes_scope AS (
    SELECT
        fp.id_poste,
        fp.id_ent,
        fp.id_service,
        COALESCE(ss.nom_service, 'Non lié') AS nom_service,
        fp.codif_poste,
        fp.codif_client,
        fp.intitule_poste,
        COALESCE(prh.nb_titulaires_cible, 1)::int AS nb_titulaires_cible,
        COALESCE(prh.criticite_poste, 2)::int AS criticite_poste,
        COALESCE(prh.statut_poste, 'actif') AS statut_poste
    FROM public.tbl_fiche_poste fp
    JOIN params p ON p.id_ent = fp.id_ent
    LEFT JOIN services_scope ss ON ss.id_service = fp.id_service
    LEFT JOIN public.tbl_fiche_poste_param_rh prh ON prh.id_poste = fp.id_poste
    WHERE COALESCE(fp.archive, FALSE) = FALSE
      AND COALESCE(fp.masque, FALSE) = FALSE
      AND (p.id_service IS NULL OR fp.id_service = p.id_service)
),
competences_requises AS (
    SELECT DISTINCT
        ps.id_poste,
        ps.nom_service,
        ps.codif_poste,
        ps.codif_client,
        ps.intitule_poste,
        ps.nb_titulaires_cible,
        ps.criticite_poste,
        ps.statut_poste,
        c.id_comp,
        c.code AS code_competence,
        c.intitule AS intitule_competence,
        c.domaine AS id_domaine_competence,
        d.titre AS domaine_titre,
        COALESCE(fpc.niveau_requis, '') AS niveau_requis,
        CASE upper(trim(COALESCE(fpc.niveau_requis, '')))
            WHEN 'A' THEN 1
            WHEN 'B' THEN 2
            WHEN 'C' THEN 3
            ELSE 0
        END AS rang_requis,
        COALESCE(fpc.poids_criticite, 0)::int AS poids_criticite,
        (COALESCE(fpc.poids_criticite, 0)::int >= (SELECT criticite_min FROM params)) AS dans_seuil_criticite,
        COALESCE(fpc.masque, FALSE) AS competence_poste_masquee,
        COALESCE(c.masque, FALSE) AS competence_masquee,
        COALESCE(c.etat, '') AS etat_competence
    FROM postes_scope ps
    JOIN public.tbl_fiche_poste_competence fpc ON fpc.id_poste = ps.id_poste
    JOIN public.tbl_competence c ON (c.id_comp = fpc.id_competence OR c.code = fpc.id_competence)
    LEFT JOIN public.tbl_domaine_competence d ON d.id_domaine_competence = c.domaine
    WHERE COALESCE(fpc.masque, FALSE) = FALSE
      AND COALESCE(c.masque, FALSE) = FALSE
      AND COALESCE(c.etat, '') = 'active'
),
titulaires AS (
    SELECT
        e.id_effectif,
        e.id_poste_actuel AS id_poste,
        e.id_service,
        e.nom_effectif,
        e.prenom_effectif,
        e.date_sortie_prevue,
        COALESCE(e.havedatefin, FALSE) AS havedatefin,
        COALESCE(e.statut_actif, TRUE) AS statut_actif,
        COALESCE(e.archive, FALSE) AS effectif_archive
    FROM public.tbl_effectif_client e
    JOIN postes_scope ps ON ps.id_poste = e.id_poste_actuel
    WHERE COALESCE(e.archive, FALSE) = FALSE
),
evaluations AS (
    SELECT
        ec.id_effectif_competence,
        ec.id_effectif_client AS id_effectif,
        ec.id_comp,
        ec.niveau_actuel,
        CASE lower(trim(COALESCE(ec.niveau_actuel, '')))
            WHEN 'a' THEN 1
            WHEN 'initial' THEN 1
            WHEN 'b' THEN 2
            WHEN 'avance' THEN 2
            WHEN 'avancé' THEN 2
            WHEN 'avancee' THEN 2
            WHEN 'avancée' THEN 2
            WHEN 'c' THEN 3
            WHEN 'expert' THEN 3
            ELSE 0
        END AS rang_actuel,
        ec.date_derniere_eval,
        ec.id_dernier_audit,
        a.id_audit_competence,
        a.resultat_eval,
        a.date_audit,
        COALESCE(ec.actif, TRUE) AS competence_effectif_active,
        COALESCE(ec.archive, FALSE) AS competence_effectif_archive,
        CASE
            WHEN a.id_audit_competence IS NOT NULL AND a.resultat_eval IS NOT NULL THEN TRUE
            WHEN ec.date_derniere_eval IS NOT NULL THEN TRUE
            ELSE FALSE
        END AS est_evaluee,
        GREATEST(
            COALESCE(ec.date_derniere_eval, DATE '1900-01-01'),
            COALESCE(a.date_audit, DATE '1900-01-01')
        ) AS date_reference_evaluation
    FROM public.tbl_effectif_client_competence ec
    LEFT JOIN public.tbl_effectif_client_audit_competence a
      ON a.id_audit_competence = ec.id_dernier_audit
     AND a.id_effectif_competence = ec.id_effectif_competence
    WHERE COALESCE(ec.actif, TRUE) = TRUE
      AND COALESCE(ec.archive, FALSE) = FALSE
),
indispos_en_cours AS (
    SELECT
        b.id_effectif,
        COUNT(*)::int AS nb_indispos_en_cours,
        MIN(b.date_debut) AS premiere_indispo_debut,
        MAX(b.date_fin) AS derniere_indispo_fin
    FROM public.tbl_effectif_client_break b
    WHERE COALESCE(b.archive, FALSE) = FALSE
      AND b.date_debut <= CURRENT_DATE
      AND b.date_fin >= CURRENT_DATE
    GROUP BY b.id_effectif
),
actions_poste AS (
    SELECT
        t.id_poste,
        COUNT(DISTINCT af.id_action_formation)::int AS nb_formations_planifiees,
        COUNT(DISTINCT ei.id_entretien)::int AS nb_entretiens_prepares
    FROM titulaires t
    LEFT JOIN public.tbl_action_formation_effectif afe
      ON afe.id_effectif = t.id_effectif
     AND COALESCE(afe.archive, FALSE) = FALSE
    LEFT JOIN public.tbl_action_formation af
      ON af.id_action_formation = afe.id_action_formation
     AND COALESCE(af.archive, FALSE) = FALSE
     AND COALESCE(af.etat_action, '') NOT IN ('annulée', 'annulee', 'annulé', 'annule')
     AND (af.date_fin_formation IS NULL OR af.date_fin_formation >= CURRENT_DATE)
    LEFT JOIN public.tbl_entretien_individuel ei
      ON ei.id_effectif_client = t.id_effectif
     AND COALESCE(ei.archive, FALSE) = FALSE
     AND lower(COALESCE(ei.statut, '')) IN ('à réaliser', 'a réaliser', 'en cours', 'en-cours', 'à signer 1/2', 'a signer 1/2')
    GROUP BY t.id_poste
)
SELECT
    cr.nom_service,
    cr.codif_client,
    cr.codif_poste,
    cr.intitule_poste,
    cr.id_poste,
    cr.statut_poste,
    cr.criticite_poste,
    cr.nb_titulaires_cible,
    COUNT(t.id_effectif) OVER (PARTITION BY cr.id_poste) AS nb_titulaires_reels,

    cr.code_competence,
    cr.intitule_competence,
    cr.id_comp,
    cr.domaine_titre,
    cr.niveau_requis,
    cr.rang_requis,
    cr.poids_criticite,
    cr.dans_seuil_criticite,

    t.id_effectif,
    t.prenom_effectif,
    t.nom_effectif,
    t.statut_actif,
    t.date_sortie_prevue,
    t.havedatefin,
    COALESCE(i.nb_indispos_en_cours, 0) AS nb_indispos_en_cours,

    ev.id_effectif_competence,
    ev.niveau_actuel,
    ev.rang_actuel,
    ev.est_evaluee,
    ev.date_derniere_eval,
    ev.date_audit,
    ev.resultat_eval,
    ev.date_reference_evaluation,
    (ev.date_reference_evaluation >= CURRENT_DATE - ((SELECT mois_fiabilite FROM params) || ' months')::interval) AS evaluation_fraiche_6m,

    CASE
        WHEN t.id_effectif IS NULL THEN 'AUCUN_TITULAIRE'
        WHEN ev.id_effectif_competence IS NULL THEN 'COMPETENCE_ABSENTE'
        WHEN COALESCE(ev.est_evaluee, FALSE) = FALSE THEN 'PRESENTE_NON_EVALUEE'
        WHEN ev.rang_actuel < cr.rang_requis THEN 'EVALUEE_NIVEAU_INSUFFISANT'
        WHEN ev.rang_actuel >= cr.rang_requis THEN 'VALIDEE_NIVEAU_REQUIS'
        ELSE 'INDETERMINE'
    END AS statut_couverture_calcul,

    CASE
        WHEN t.id_effectif IS NULL THEN 100
        WHEN ev.id_effectif_competence IS NULL THEN 100
        WHEN COALESCE(ev.est_evaluee, FALSE) = FALSE THEN 85
        WHEN ev.rang_actuel < cr.rang_requis THEN 70
        WHEN ev.rang_actuel >= cr.rang_requis THEN 0
        ELSE 50
    END AS score_risque_ligne_reference,

    COALESCE(ap.nb_formations_planifiees, 0) AS nb_formations_planifiees_poste,
    COALESCE(ap.nb_entretiens_prepares, 0) AS nb_entretiens_prepares_poste
FROM competences_requises cr
LEFT JOIN titulaires t ON t.id_poste = cr.id_poste
LEFT JOIN evaluations ev ON ev.id_effectif = t.id_effectif AND ev.id_comp = cr.id_comp
LEFT JOIN indispos_en_cours i ON i.id_effectif = t.id_effectif
LEFT JOIN actions_poste ap ON ap.id_poste = cr.id_poste
ORDER BY
    cr.nom_service,
    COALESCE(cr.codif_client, cr.codif_poste),
    cr.poids_criticite DESC,
    cr.code_competence,
    t.nom_effectif,
    t.prenom_effectif;
