-- Patch Novoskill - extensions par console
-- Périmètre : neutraliser cible_segment/cible_offer pour tbl_novoskill_offer_extension_catalog.
-- À exécuter dans Supabase SQL Editor après le patch applicatif, si la base n'a pas déjà été alignée.

BEGIN;

ALTER TABLE public.tbl_novoskill_offer_extension_catalog
  ADD COLUMN IF NOT EXISTS console_code text,
  ADD COLUMN IF NOT EXISTS extension_scope text,
  ADD COLUMN IF NOT EXISTS pack_quantity integer;

ALTER TABLE public.tbl_novoskill_offer_extension_catalog
  ALTER COLUMN cible_segment_code SET DEFAULT 'console';

UPDATE public.tbl_novoskill_offer_extension_catalog
SET console_code = CASE
      WHEN COALESCE(delta_nb_clients, 0) > 0 OR COALESCE(delta_nb_sites, 0) > 0 THEN 'studio_reseau'
      WHEN COALESCE(delta_nb_acces_studio, 0) > 0 THEN 'studio'
      WHEN COALESCE(delta_nb_acces_insights, 0) > 0 THEN 'insights'
      WHEN COALESCE(delta_nb_acces_people, 0) > 0 THEN 'people'
      WHEN COALESCE(delta_nb_acces_learn, 0) > 0 THEN 'learn'
      WHEN COALESCE(delta_nb_acces_partner, 0) > 0 THEN 'partner'
      ELSE console_code
    END,
    extension_scope = CASE
      WHEN COALESCE(delta_nb_clients, 0) > 0 THEN 'clients'
      WHEN COALESCE(delta_nb_sites, 0) > 0 THEN 'sites'
      ELSE 'acces'
    END,
    pack_quantity = GREATEST(
      COALESCE(delta_nb_acces_studio, 0),
      COALESCE(delta_nb_acces_insights, 0),
      COALESCE(delta_nb_acces_people, 0),
      COALESCE(delta_nb_acces_partner, 0),
      COALESCE(delta_nb_acces_learn, 0),
      COALESCE(delta_nb_clients, 0),
      COALESCE(delta_nb_sites, 0),
      COALESCE(delta_nb_collaborateurs_couverts, 0)
    ),
    cible_segment_code = 'console',
    cible_offer_family = NULL,
    updated_at = NOW()
WHERE COALESCE(archive, FALSE) = FALSE;

COMMENT ON COLUMN public.tbl_novoskill_offer_extension_catalog.console_code IS
  'Console cible de l extension : studio, studio_reseau, insights, people, learn, partner.';
COMMENT ON COLUMN public.tbl_novoskill_offer_extension_catalog.extension_scope IS
  'Portée métier de l extension : acces, clients, sites.';
COMMENT ON COLUMN public.tbl_novoskill_offer_extension_catalog.pack_quantity IS
  'Quantité lisible du pack, dérivée du delta principal.';

COMMIT;

SELECT
  extension_code,
  extension_label,
  console_code,
  extension_scope,
  pack_quantity,
  delta_nb_acces_studio,
  delta_nb_acces_insights,
  delta_nb_acces_people,
  delta_nb_acces_learn,
  delta_nb_acces_partner,
  delta_nb_clients,
  delta_nb_sites
FROM public.tbl_novoskill_offer_extension_catalog
WHERE COALESCE(archive, FALSE) = FALSE
ORDER BY ordre_affichage, lower(extension_label), extension_code;
