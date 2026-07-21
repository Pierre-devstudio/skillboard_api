BEGIN;

CREATE TABLE IF NOT EXISTS public.tbl_people_entretien_preparation (
  id_preparation text PRIMARY KEY,
  id_entretien text NOT NULL,
  id_effectif_client text NOT NULL,
  statut_preparation text NOT NULL DEFAULT 'brouillon',
  bilan_periode text,
  reussites text,
  difficultes text,
  changements_poste text,
  sujets_a_aborder text,
  souhaits_evolution text,
  souhaits_mobilite text,
  besoins_formation text,
  accompagnement_souhaite text,
  elements_partageables text,
  notes_privees text,
  date_transmission timestamp without time zone,
  archive boolean NOT NULL DEFAULT false,
  created_at timestamp without time zone NOT NULL DEFAULT now(),
  updated_at timestamp without time zone NOT NULL DEFAULT now(),
  CONSTRAINT fk_people_preparation_entretien
    FOREIGN KEY (id_entretien)
    REFERENCES public.tbl_entretien_individuel(id_entretien)
    ON UPDATE NO ACTION
    ON DELETE RESTRICT,
  CONSTRAINT fk_people_preparation_effectif
    FOREIGN KEY (id_effectif_client)
    REFERENCES public.tbl_effectif_client(id_effectif)
    ON UPDATE NO ACTION
    ON DELETE RESTRICT,
  CONSTRAINT ck_people_preparation_statut
    CHECK (statut_preparation IN ('brouillon', 'terminee', 'transmise')),
  CONSTRAINT uq_people_preparation_entretien_effectif
    UNIQUE (id_entretien, id_effectif_client)
);

CREATE INDEX IF NOT EXISTS idx_people_preparation_effectif
  ON public.tbl_people_entretien_preparation (id_effectif_client, archive, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_people_preparation_entretien
  ON public.tbl_people_entretien_preparation (id_entretien, archive);

COMMENT ON TABLE public.tbl_people_entretien_preparation IS
  'Préparation individuelle People liée à un entretien officiel. Les notes_privees ne sont jamais exposées aux API employeur.';

COMMENT ON COLUMN public.tbl_people_entretien_preparation.notes_privees IS
  'Notes visibles exclusivement par le collaborateur dans People.';

CREATE TABLE IF NOT EXISTS public.tbl_people_entretien_auto_evaluation (
  id_auto_evaluation text PRIMARY KEY,
  id_preparation text NOT NULL,
  id_entretien text NOT NULL,
  id_effectif_client text NOT NULL,
  id_comp text NOT NULL,
  niveau_auto_evalue text,
  commentaire_partageable text,
  besoin_accompagnement boolean NOT NULL DEFAULT false,
  statut text NOT NULL DEFAULT 'brouillon',
  date_transmission timestamp without time zone,
  archive boolean NOT NULL DEFAULT false,
  created_at timestamp without time zone NOT NULL DEFAULT now(),
  updated_at timestamp without time zone NOT NULL DEFAULT now(),
  CONSTRAINT fk_people_auto_eval_preparation
    FOREIGN KEY (id_preparation)
    REFERENCES public.tbl_people_entretien_preparation(id_preparation)
    ON UPDATE NO ACTION
    ON DELETE RESTRICT,
  CONSTRAINT fk_people_auto_eval_entretien
    FOREIGN KEY (id_entretien)
    REFERENCES public.tbl_entretien_individuel(id_entretien)
    ON UPDATE NO ACTION
    ON DELETE RESTRICT,
  CONSTRAINT fk_people_auto_eval_effectif
    FOREIGN KEY (id_effectif_client)
    REFERENCES public.tbl_effectif_client(id_effectif)
    ON UPDATE NO ACTION
    ON DELETE RESTRICT,
  CONSTRAINT fk_people_auto_eval_competence
    FOREIGN KEY (id_comp)
    REFERENCES public.tbl_competence(id_comp)
    ON UPDATE NO ACTION
    ON DELETE RESTRICT,
  CONSTRAINT ck_people_auto_eval_niveau
    CHECK (niveau_auto_evalue IS NULL OR niveau_auto_evalue IN ('', 'A', 'B', 'C', 'D')),
  CONSTRAINT ck_people_auto_eval_statut
    CHECK (statut IN ('brouillon', 'transmise')),
  CONSTRAINT uq_people_auto_eval_entretien_competence
    UNIQUE (id_entretien, id_effectif_client, id_comp)
);

CREATE INDEX IF NOT EXISTS idx_people_auto_eval_preparation
  ON public.tbl_people_entretien_auto_evaluation (id_preparation, archive);

CREATE INDEX IF NOT EXISTS idx_people_auto_eval_effectif
  ON public.tbl_people_entretien_auto_evaluation (id_effectif_client, archive, updated_at DESC);

COMMENT ON TABLE public.tbl_people_entretien_auto_evaluation IS
  'Auto-évaluations déclarées par le collaborateur dans People, distinctes des audits manager.';

COMMIT;
