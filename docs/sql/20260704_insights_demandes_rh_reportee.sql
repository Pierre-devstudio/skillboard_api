-- ======================================================
-- Novoskill Insights - Demandes RH : statut reportée
-- Date : 2026-07-04
-- Objet : ajoute le statut reportee pour les demandes qualifiées mais non prioritaires
-- ======================================================

ALTER TABLE public.tbl_insights_demande_rh
  DROP CONSTRAINT IF EXISTS chk_insights_demande_rh_statut;

ALTER TABLE public.tbl_insights_demande_rh
  ADD CONSTRAINT chk_insights_demande_rh_statut
  CHECK (statut IN ('a_qualifier', 'a_valider', 'validee', 'reportee', 'transmise_studio', 'prise_en_charge', 'action_creee', 'refusee', 'classee'));
