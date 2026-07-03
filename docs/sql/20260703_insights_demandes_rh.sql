-- ======================================================
-- Novoskill Insights - Demandes RH
-- Date : 2026-07-03
-- Objet : table pivot des demandes issues des analyses, simulations,
--         managers, salariés et entretiens avant suivi dans Plan d'actions
-- ======================================================

CREATE TABLE IF NOT EXISTS public.tbl_insights_demande_rh (
  id_demande_rh TEXT PRIMARY KEY,
  id_ent TEXT NOT NULL,
  id_owner_destinataire TEXT,
  id_demandeur TEXT,
  id_effectif_concerne TEXT,
  nom_effectif TEXT,
  prenom_effectif TEXT,
  id_poste TEXT,
  code_poste TEXT,
  intitule_poste TEXT,
  id_service TEXT,
  nom_service TEXT,
  id_comp TEXT,
  code_competence TEXT,
  intitule_competence TEXT,
  origine TEXT NOT NULL DEFAULT 'manager',
  source_type TEXT NOT NULL DEFAULT 'manager',
  source_ref TEXT,
  type_demande TEXT NOT NULL DEFAULT 'autre',
  objet TEXT NOT NULL,
  description TEXT,
  statut TEXT NOT NULL DEFAULT 'a_qualifier',
  priorite TEXT NOT NULL DEFAULT 'normale',
  niveau_attendu TEXT,
  niveau_actuel TEXT,
  ecart_niveau INTEGER,
  criticite INTEGER,
  indice_fragilite INTEGER,
  score_anticipation INTEGER,
  delai_souhaite TEXT,
  echeance_souhaitee DATE,
  modalites_souhaitees JSONB NOT NULL DEFAULT '[]'::jsonb,
  commentaire_manager TEXT,
  commentaire_salarie TEXT,
  payload_signal JSONB NOT NULL DEFAULT '{}'::jsonb,
  id_besoin_formation TEXT,
  archive BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_insights_demande_rh_origine
    CHECK (origine IN ('analyse', 'simulation', 'manager', 'salarie', 'entretien')),
  CONSTRAINT chk_insights_demande_rh_type
    CHECK (type_demande IN ('formation', 'transmission', 'renfort', 'recrutement', 'mobilite', 'tutorat', 'entretien', 'documentation', 'organisation', 'autre')),
  CONSTRAINT chk_insights_demande_rh_statut
    CHECK (statut IN ('a_qualifier', 'a_valider', 'validee', 'transmise_studio', 'prise_en_charge', 'action_creee', 'refusee', 'classee')),
  CONSTRAINT chk_insights_demande_rh_priorite
    CHECK (priorite IN ('basse', 'normale', 'haute', 'critique'))
);

CREATE INDEX IF NOT EXISTS idx_insights_demande_rh_ent
  ON public.tbl_insights_demande_rh (id_ent);

CREATE INDEX IF NOT EXISTS idx_insights_demande_rh_service
  ON public.tbl_insights_demande_rh (id_service);

CREATE INDEX IF NOT EXISTS idx_insights_demande_rh_effectif
  ON public.tbl_insights_demande_rh (id_effectif_concerne);

CREATE INDEX IF NOT EXISTS idx_insights_demande_rh_poste
  ON public.tbl_insights_demande_rh (id_poste);

CREATE INDEX IF NOT EXISTS idx_insights_demande_rh_comp
  ON public.tbl_insights_demande_rh (id_comp);

CREATE INDEX IF NOT EXISTS idx_insights_demande_rh_origine
  ON public.tbl_insights_demande_rh (origine);

CREATE INDEX IF NOT EXISTS idx_insights_demande_rh_type
  ON public.tbl_insights_demande_rh (type_demande);

CREATE INDEX IF NOT EXISTS idx_insights_demande_rh_statut
  ON public.tbl_insights_demande_rh (statut);

CREATE INDEX IF NOT EXISTS idx_insights_demande_rh_priorite
  ON public.tbl_insights_demande_rh (priorite);

CREATE INDEX IF NOT EXISTS idx_insights_demande_rh_archive
  ON public.tbl_insights_demande_rh (archive);

CREATE INDEX IF NOT EXISTS idx_insights_demande_rh_source
  ON public.tbl_insights_demande_rh (source_type, source_ref);

CREATE INDEX IF NOT EXISTS idx_insights_demande_rh_besoin_formation
  ON public.tbl_insights_demande_rh (id_besoin_formation);
