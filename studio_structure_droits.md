# Studio â€“ Structure des droits (admin / editor / user)

## 1) Objectif et pÃ©rimÃ¨tre
Cette note dÃ©crit la structure de droits **effectivement mise en place** dans Skillboard Studio.

- Les droits servent Ã  **filtrer lâ€™UI (menu)** et Ã  **sÃ©curiser lâ€™API (403)**.
- Le rÃ´le est **un droit dâ€™accÃ¨s**, pas une donnÃ©e RH : il est portÃ© par **tbl_studio_user_access**.
- Principe : **masquer â‰  sÃ©curiser**. La sÃ©curitÃ© est appliquÃ©e cÃ´tÃ© API.

---

## 2) Source de vÃ©ritÃ©
### Table
**`public.tbl_studio_user_access`**
- `email` (clÃ© logique utilisateur)
- `id_owner` (pÃ©rimÃ¨tre / tenant Studio)
- `archive` (filtre implicite : `COALESCE(archive,FALSE)=FALSE`)
- `role_code` (droit)

### Valeurs autorisÃ©es
`role_code` âˆˆ **`admin`**, **`editor`**, **`user`**
- ContrÃ´le en base via contrainte `CHECK`.
- Normalisation : `lower(trim(role_code))`.
- Valeurs inconnues â†’ forcÃ©es Ã  `user`.

### LibellÃ©s affichÃ©s (UI)
- `admin` â†’ **Administrateur**
- `editor` â†’ **Ã‰diteur**
- `user` â†’ **Utilisateur**

### Rangs (comparaison)
- `admin` = 3
- `editor` = 2
- `user` = 1

---

## 3) RÃ©cupÃ©ration du rÃ´le cÃ´tÃ© API
### Endpoints impactÃ©s
- **`GET /studio/me/scope`** : renvoie `owners[]` enrichi avec `role_code` + `role_label`.
- **`GET /studio/context/{id_owner}`** : renvoie aussi `role_code` + `role_label` (utile dashboard/topbar).
- **`GET /studio/data/{id_owner}`** : renvoie `organisation` + `contact` ; le `contact.role` est dÃ©rivÃ© de `role_code`.

### Super-admin
Si `is_super_admin` est vrai, le rÃ´le est traitÃ© comme **admin**.

---

## 4) Gating UI (menu)
### Principe
Le menu porte un attribut `data-min-role` sur chaque entrÃ©e.

- `user` : visible pour tout le monde
- `editor` : visible pour `editor` + `admin`
- `admin` : visible uniquement pour `admin`

### MÃ©canisme
- Le front lit **`/studio/me/scope`** au chargement.
- `window.__studioRoleCode` est dÃ©fini Ã  partir de `owners[0].role_code` (ou de lâ€™owner courant si `?id=` est prÃ©sent).
- `applyMenuGating(roleCode)` masque/affiche `.menu-item[data-min-role]`.
- Nettoyage UX : les sÃ©parateurs `.menu-sep` sont masquÃ©s si inutiles (pas de sÃ©parateur isolÃ© ou doublonnÃ©).

### Menu Studio (V1)
- **Dashboard** (min: user)
- **Vos donnÃ©es** (min: user)

Administration (admin only)
- **Votre organisation** (admin)
- **Vos collaborateurs** (admin)
- **Droits dâ€™accÃ¨s** (admin)
- **Vos partenaires** (admin)

Catalogues
- **Catalogue fiches de poste** (editor)
- **Catalogue compÃ©tences** (editor)
- **Catalogue formation (option)** (admin)

Clients
- **Vos clients** (editor)
- **Pilotage clients** (editor)

Support
- **Vos factures** (admin)
- **Vos documents** (admin)
- **Proposer une Ã©volution** (user)

### Pages non dÃ©veloppÃ©es
Les vues non implÃ©mentÃ©es pointent vers un placeholder commun :
- `menu_studio/studio_coming_soon.html`
- `menu_studio/studio_coming_soon.js` (titre auto = menu actif)

---

## 5) SÃ©curitÃ© API (vraie rÃ¨gle)
### Helper commun (backend)
Dans `studio_portal_common.py` :
- `studio_fetch_role_code(cur, email, id_owner, is_super_admin)`
- `studio_role_rank(role_code)`
- `studio_require_min_role(cur, u, id_owner, min_role)` â†’ lÃ¨ve **HTTP 403** si droits insuffisants

### RÃ¨gles appliquÃ©es
- **Modification entreprise : admin only**
  - `POST /studio/data/entreprise/{id_owner}` â†’ vÃ©rifie `studio_require_min_role(..., "admin")`
  - RÃ©sultat attendu sinon : **403 AccÃ¨s refusÃ© (droits insuffisants)**

- **Modification contact : autorisÃ©e (user+)**
  - `POST /studio/data/contact/{id_owner}` â†’ autorisÃ©e pour `user/editor/admin`
  - Le champ â€œRÃ´leâ€ nâ€™est **pas modifiable** ici (lecture seule).

- **Lecture data : autorisÃ©e (user+)**
  - `GET /studio/data/{id_owner}` â†’ lecture autorisÃ©e si accÃ¨s owner OK.

---

## 6) UX â€œVos donnÃ©esâ€ (rÃ´le et Ã©dition)
### RÃ´le
- AffichÃ© dans le champ **RÃ´le** (input disabled).
- Valeur issue de `tbl_studio_user_access.role_code` via `GET /studio/data/{id_owner}` â†’ `contact.role`.
- **Non modifiable** depuis cette page (gestion future prÃ©vue ailleurs cÃ´tÃ© admin).

### Entreprise (Ã©dition)
- CÃ´tÃ© API : admin only (403 sinon).
- CÃ´tÃ© UI : si `window.__studioRoleCode != 'admin'` :
  - bouton **Modifier les informations** entreprise masquÃ©
  - boutons save/cancel entreprise masquÃ©s
  - inputs entreprise restent disabled

### Confirmations
- Les confirmations â€œvertesâ€ de succÃ¨s ont Ã©tÃ© supprimÃ©es.
- Les erreurs sont conservÃ©es (message rouge) pour visibilitÃ© des Ã©checs.

---

## 7) Ce que cette structure garantit
- Un cabinet peut donner Ã  ses consultants un rÃ´le **Ã‰diteur** pour produire (catalogues/clients) sans exposer :
  - organisation interne
  - droits dâ€™accÃ¨s
  - factures/documents
- Un utilisateur standard ne voit que le nÃ©cessaire.
- Lâ€™API est protÃ©gÃ©e : lâ€™UI ne suffit jamais.

---

## 8) Points prÃ©vus (non implÃ©mentÃ©s Ã  ce stade)
- Mode **Cabinet vs Entreprise (Lite)** (filtrage de menus â€œVos clients / Pilotage clientsâ€ en fonction dâ€™un champ owner).
- Page â€œDroits dâ€™accÃ¨sâ€ (admin) permettant de modifier `role_code` et les accÃ¨s Studio/Insights/People.

