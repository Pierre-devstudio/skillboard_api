-- ======================================================
-- Novoskill Insights - Calendrier RH intelligent
-- Date : 2026-07-01
-- Objet : événements calendrier + suggestions planifiables
-- ======================================================

CREATE TABLE IF NOT EXISTS public.tbl_calendrier_rh (
  id_evenement TEXT PRIMARY KEY,
  id_ent TEXT NOT NULL,
  id_manager TEXT,
  id_utilisateur TEXT,
  id_effectif TEXT,
  type_evenement TEXT NOT NULL DEFAULT 'evenement_rh',
  titre TEXT NOT NULL,
  date_debut TIMESTAMP WITHOUT TIME ZONE NOT NULL,
  date_fin TIMESTAMP WITHOUT TIME ZONE,
  statut TEXT NOT NULL DEFAULT 'planifie',
  source TEXT NOT NULL DEFAULT 'manuel',
  id_suggestion_origine TEXT,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  notification_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  archive BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_calendrier_rh_id_ent
  ON public.tbl_calendrier_rh (id_ent);

CREATE INDEX IF NOT EXISTS idx_calendrier_rh_manager
  ON public.tbl_calendrier_rh (id_manager);

CREATE INDEX IF NOT EXISTS idx_calendrier_rh_effectif
  ON public.tbl_calendrier_rh (id_effectif);

CREATE INDEX IF NOT EXISTS idx_calendrier_rh_date_debut
  ON public.tbl_calendrier_rh (date_debut);

CREATE INDEX IF NOT EXISTS idx_calendrier_rh_statut
  ON public.tbl_calendrier_rh (statut);

CREATE INDEX IF NOT EXISTS idx_calendrier_rh_type
  ON public.tbl_calendrier_rh (type_evenement);

CREATE INDEX IF NOT EXISTS idx_calendrier_rh_archive
  ON public.tbl_calendrier_rh (archive);

CREATE INDEX IF NOT EXISTS idx_calendrier_rh_suggestion_origine
  ON public.tbl_calendrier_rh (id_suggestion_origine);

CREATE TABLE IF NOT EXISTS public.tbl_calendrier_suggestion_rh (
  id_suggestion TEXT PRIMARY KEY,
  id_ent TEXT NOT NULL,
  id_manager TEXT,
  id_effectif TEXT,
  type_suggestion TEXT NOT NULL,
  titre TEXT NOT NULL,
  date_echeance DATE,
  priorite TEXT NOT NULL DEFAULT 'normale',
  source TEXT NOT NULL DEFAULT 'moteur',
  statut TEXT NOT NULL DEFAULT 'proposee',
  id_evenement TEXT,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  notification_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  archive BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_calendrier_suggestion_id_ent
  ON public.tbl_calendrier_suggestion_rh (id_ent);

CREATE INDEX IF NOT EXISTS idx_calendrier_suggestion_manager
  ON public.tbl_calendrier_suggestion_rh (id_manager);

CREATE INDEX IF NOT EXISTS idx_calendrier_suggestion_effectif
  ON public.tbl_calendrier_suggestion_rh (id_effectif);

CREATE INDEX IF NOT EXISTS idx_calendrier_suggestion_date
  ON public.tbl_calendrier_suggestion_rh (date_echeance);

CREATE INDEX IF NOT EXISTS idx_calendrier_suggestion_statut
  ON public.tbl_calendrier_suggestion_rh (statut);

CREATE INDEX IF NOT EXISTS idx_calendrier_suggestion_priorite
  ON public.tbl_calendrier_suggestion_rh (priorite);

CREATE INDEX IF NOT EXISTS idx_calendrier_suggestion_type
  ON public.tbl_calendrier_suggestion_rh (type_suggestion);

CREATE INDEX IF NOT EXISTS idx_calendrier_suggestion_archive
  ON public.tbl_calendrier_suggestion_rh (archive);

CREATE INDEX IF NOT EXISTS idx_calendrier_suggestion_evenement
  ON public.tbl_calendrier_suggestion_rh (id_evenement);
