import os
import requests
from html import escape

MJ_APIKEY_PUBLIC = os.getenv("MJ_APIKEY_PUBLIC")
MJ_APIKEY_PRIVATE = os.getenv("MJ_APIKEY_PRIVATE")
MAIL_ALERT_DEST = os.getenv("MAIL_ALERT_DEST")
MAIL_FROM = os.getenv("MAIL_FROM") or "no-reply@novoskill.fr"
MAIL_FROM_NAME = os.getenv("MAIL_FROM_NAME", "Novoskill")
NOVOSKILL_PUBLIC_BASE_URL = (os.getenv("NOVOSKILL_PUBLIC_BASE_URL") or "https://novoskill.jmbconsultant.fr").rstrip("/")

MAILJET_URL = "https://api.mailjet.com/v3.1/send"


def send_absent_mail(code_formation: str, titre: str, absents: list[str]):
    """
    Envoie le mail via l'API Mailjet pour la gestion des absences.
    """

    if not MJ_APIKEY_PUBLIC or not MJ_APIKEY_PRIVATE:
        print("Mailjet non configuré. Envoi annulé.")
        return

    if not MAIL_ALERT_DEST:
        print("MAIL_ALERT_DEST non défini")
        return

    sujet = f"Gestion des absences – formation {code_formation}"

    texte = (
        f"{code_formation} – {titre}\n\n"
        "Les stagiaires ci-dessous ont été déclarés absents par le consultant :\n"
        + "\n".join(absents)
        + "\n\nMerci de prendre contact avec les stagiaires et démarrer la procédure d'absence."
    )

    payload = {
        "Messages": [
            {
                "From": {"Email": MAIL_FROM, "Name": "Skillboard"},
                "To": [{"Email": MAIL_ALERT_DEST}],
                "Subject": sujet,
                "TextPart": texte,
            }
        ]
    }

    try:
        r = requests.post(
            MAILJET_URL,
            auth=(MJ_APIKEY_PUBLIC, MJ_APIKEY_PRIVATE),
            json=payload
        )

        if 200 <= r.status_code < 300:
            print("Mail envoyé via Mailjet OK")
        else:
            print("Erreur Mailjet:", r.status_code, r.text)

    except Exception as e:
        print("Erreur appel Mailjet:", e)


def send_satisfaction_stagiaire_mail(
    code_formation: str | None,
    titre_formation: str,
    prenom: str,
    nom: str,
    id_action_formation_effectif: str,
    mode: str,
    code_action_formation: str | None = None,    
):
    """
    Envoie un mail d'info pour une enquête de satisfaction stagiaire.
    mode = 'insert' ou 'update'
    """

    if not MJ_APIKEY_PUBLIC or not MJ_APIKEY_PRIVATE:
        print("Mailjet non configuré. Envoi satisfaction annulé.")
        return

    if not MAIL_ALERT_DEST:
        print("MAIL_ALERT_DEST non défini pour la satisfaction")
        return

    suffix = "nouvelle réponse" if mode == "insert" else "mise à jour"
    sujet = "Satisfaction stagiaire – "
    if code_action_formation:
        sujet += f"{code_action_formation} – "
    sujet += f"{prenom} {nom} ({suffix})"

    texte = (
        f"Une enquête de satisfaction stagiaire vient d'être {suffix}.\n\n"
        f"Stagiaire : {prenom} {nom}\n"
        f"Formation : {(code_formation + ' - ') if code_formation else ''}{titre_formation}\n"
        f"Code action de formation : {code_action_formation or 'Non renseigné'}\n"
        f"id_action_formation_effectif : {id_action_formation_effectif}\n\n"
        "Vous pouvez consulter cette action de formation dans Skillboard pour analyser cette réponse."
    )

    html = f"""
    <h3>Enquête de satisfaction stagiaire {suffix}</h3>
    <p>
      <strong>Stagiaire :</strong> {prenom} {nom}<br>
      <strong>Formation :</strong> {(code_formation + " - ") if code_formation else ""}{titre_formation}<br>
      <strong>Code action de formation :</strong> {code_action_formation or "Non renseigné"}<br>
      <strong>id_action_formation_effectif :</strong> {id_action_formation_effectif}
    </p>
    <p>
      Vous pouvez consulter cette action de formation dans Skillboard pour analyser cette réponse.
    </p>
    """

    payload = {
        "Messages": [
            {
                "From": {"Email": MAIL_FROM, "Name": "Skillboard"},
                "To": [{"Email": MAIL_ALERT_DEST}],
                "Subject": sujet,
                "TextPart": texte,
                "HTMLPart": html,
            }
        ]
    }

    try:
        r = requests.post(
            MAILJET_URL,
            auth=(MJ_APIKEY_PUBLIC, MJ_APIKEY_PRIVATE),
            json=payload
        )

        if 200 <= r.status_code < 300:
            print("Mail satisfaction stagiaire envoyé via Mailjet OK")
        else:
            print("Erreur Mailjet (satisfaction):", r.status_code, r.text)

    except Exception as e:
        print("Erreur appel Mailjet (satisfaction):", e)

def send_satisfaction_responsable_mail(
    code_formation: str | None,
    titre_formation: str,
    prenom: str,
    nom: str,
    id_action_formation_entreprise: str,
    mode: str,
    code_action_formation: str | None = None,
):
    """
    Envoie un mail d'info pour une enquête de satisfaction responsable administratif.
    mode = 'insert' ou 'update'
    """

    if not MJ_APIKEY_PUBLIC or not MJ_APIKEY_PRIVATE:
        print("Mailjet non configuré. Envoi satisfaction responsable annulé.")
        return

    if not MAIL_ALERT_DEST:
        print("MAIL_ALERT_DEST non défini pour la satisfaction responsable")
        return

    suffix = "nouvelle réponse" if mode == "insert" else "mise à jour"

    sujet = "Satisfaction responsable – "
    if code_action_formation:
        sujet += f"{code_action_formation} – "
    sujet += f"{prenom} {nom} ({suffix})"

    texte = (
        f"Une enquête de satisfaction responsable administratif vient d'être {suffix}.\n\n"
        f"Contact administratif : {prenom} {nom}\n"
        f"Formation : {(code_formation + ' - ') if code_formation else ''}{titre_formation}\n"
        f"Code action de formation : {code_action_formation or 'Non renseigné'}\n"
        f"id_action_formation_entreprise : {id_action_formation_entreprise}\n\n"
        "Vous pouvez consulter cette action de formation dans Skillboard pour analyser cette réponse."
    )

    html = f"""
    <h3>Enquête de satisfaction responsable administratif ({suffix})</h3>
    <p>
      <strong>Contact administratif :</strong> {prenom} {nom}<br>
      <strong>Formation :</strong> {(code_formation + " - ") if code_formation else ""}{titre_formation}<br>
      <strong>Code action de formation :</strong> {code_action_formation or "Non renseigné"}<br>
      <strong>id_action_formation_entreprise :</strong> {id_action_formation_entreprise}
    </p>
    <p>
      Vous pouvez consulter cette action de formation dans Skillboard pour analyser cette réponse.
    </p>
    """

    payload = {
        "Messages": [
            {
                "From": {"Email": MAIL_FROM, "Name": "Skillboard"},
                "To": [{"Email": MAIL_ALERT_DEST}],
                "Subject": sujet,
                "TextPart": texte,
                "HTMLPart": html,
            }
        ]
    }

    try:
        r = requests.post(
            MAILJET_URL,
            auth=(MJ_APIKEY_PUBLIC, MJ_APIKEY_PRIVATE),
            json=payload
        )

        if 200 <= r.status_code < 300:
            print("Mail satisfaction responsable envoyé via Mailjet OK")
        else:
            print("Erreur Mailjet (satisfaction responsable):", r.status_code, r.text)

    except Exception as e:
        print("Erreur appel Mailjet (satisfaction responsable):", e)

def send_satisfaction_consultant_mail(
    code_formation: str | None,
    titre_formation: str,
    prenom: str,
    nom: str,
    id_action_formation: str,
    mode: str,
    code_action_formation: str | None = None,
):
    """
    Envoie un mail d'info pour une enquête de satisfaction consultant.
    mode = 'insert' ou 'update'
    """

    if not MJ_APIKEY_PUBLIC or not MJ_APIKEY_PRIVATE:
        print("Mailjet non configuré. Envoi satisfaction consultant annulé.")
        return

    if not MAIL_ALERT_DEST:
        print("MAIL_ALERT_DEST non défini pour la satisfaction consultant")
        return

    suffix = "nouvelle réponse" if mode == "insert" else "mise à jour"

    sujet = "Satisfaction consultant – "
    if code_formation:
        sujet += f"{code_formation} – "
    if code_action_formation:
        sujet += f"{code_action_formation} – "
    sujet += f"{prenom} {nom} ({suffix})"

    texte = (
        f"Une enquête de satisfaction consultant vient d'être {suffix}.\n\n"
        f"Consultant : {prenom} {nom}\n"
        f"Formation : {(code_formation + ' - ') if code_formation else ''}{titre_formation}\n"
        f"Code action de formation : {code_action_formation or 'Non renseigné'}\n"
        f"id_action_formation : {id_action_formation}\n\n"
        "Vous pouvez consulter cette action de formation dans Skillboard pour analyser cette réponse."
    )

    html = f"""
    <h3>Enquête de satisfaction consultant ({suffix})</h3>
    <p>
      <strong>Consultant :</strong> {prenom} {nom}<br>
      <strong>Formation :</strong> {(code_formation + " - ") if code_formation else ""}{titre_formation}<br>
      <strong>Code action de formation :</strong> {code_action_formation or "Non renseigné"}<br>
      <strong>id_action_formation :</strong> {id_action_formation}
    </p>
    <p>
      Vous pouvez consulter cette action de formation dans Skillboard pour analyser cette réponse.
    </p>
    """

    payload = {
        "Messages": [
            {
                "From": {"Email": MAIL_FROM, "Name": "Skillboard"},
                "To": [{"Email": MAIL_ALERT_DEST}],
                "Subject": sujet,
                "TextPart": texte,
                "HTMLPart": html,
            }
        ]
    }

    try:
        r = requests.post(
            MAILJET_URL,
            auth=(MJ_APIKEY_PUBLIC, MJ_APIKEY_PRIVATE),
            json=payload
        )

        if 200 <= r.status_code < 300:
            print("Mail satisfaction consultant envoyé via Mailjet OK")
        else:
            print("Erreur Mailjet (satisfaction consultant):", r.status_code, r.text)

    except Exception as e:
        print("Erreur appel Mailjet (satisfaction consultant):", e)

def _mailjet_ready() -> bool:
    return bool(MJ_APIKEY_PUBLIC and MJ_APIKEY_PRIVATE and MAIL_FROM)


def _send_mailjet_email(
    to_email: str,
    subject: str,
    text_part: str,
    html_part: str,
) -> bool:
    if not _mailjet_ready():
        print("Mailjet non configuré. Envoi Novoskill annulé.")
        return False

    dest = (to_email or "").strip()
    if not dest:
        print("Email destinataire manquant. Envoi Novoskill annulé.")
        return False

    payload = {
        "Messages": [
            {
                "From": {"Email": MAIL_FROM, "Name": MAIL_FROM_NAME},
                "To": [{"Email": dest}],
                "Subject": subject,
                "TextPart": text_part,
                "HTMLPart": html_part,
            }
        ]
    }

    try:
        r = requests.post(
            MAILJET_URL,
            auth=(MJ_APIKEY_PUBLIC, MJ_APIKEY_PRIVATE),
            json=payload,
            timeout=20,
        )

        if 200 <= r.status_code < 300:
            print("Mail Novoskill envoyé via Mailjet OK")
            return True

        print("Erreur Mailjet (Novoskill):", r.status_code, r.text)
        return False
    except Exception as e:
        print("Erreur appel Mailjet (Novoskill):", e)
        return False


def send_novoskill_access_mail(
    to_email: str,
    collaborateur_nom: str,
    admin_name: str,
    mode: str,
    consoles: list[dict] | None = None,
    setup_link: str | None = None,
) -> bool:
    mode_norm = (mode or "").strip().lower()
    items = list(consoles or [])

    collab = (collaborateur_nom or "").strip() or "Bonjour"
    admin = (admin_name or "").strip() or "Administrateur Novoskill"
    setup_url = (setup_link or "").strip()
    safe_collab = escape(collab)
    safe_admin = escape(admin)

    if mode_norm == "first_access":
        subject = "Novoskill – Vos accès ont été activés"
        intro_text = f"Votre administrateur NOVOSKILL {admin} vient de vous accorder des droits d'accès."
        intro_html = f"Votre administrateur NOVOSKILL <strong>{safe_admin}</strong> vient de vous accorder des droits d'accès."
    elif mode_norm == "removal":
        subject = "Novoskill – Vos accès ont été retirés"
        intro_text = f"Votre administrateur NOVOSKILL {admin} vient de retirer vos accès aux consoles Novoskill."
        intro_html = f"Votre administrateur NOVOSKILL <strong>{safe_admin}</strong> vient de retirer vos accès aux consoles Novoskill."
    else:
        subject = "Novoskill – Vos accès ont été mis à jour"
        intro_text = f"Votre administrateur NOVOSKILL {admin} vient de mettre à jour vos droits d'accès."
        intro_html = f"Votre administrateur NOVOSKILL <strong>{safe_admin}</strong> vient de mettre à jour vos droits d'accès."

    if items:
        consoles_text = "\n".join(
            [
                f"- {it.get('label', 'Console')} ({it.get('role_label', 'Aucun accès')}) : {it.get('login_url', '')}"
                for it in items
            ]
        )
        consoles_html = "".join(
            [
                f"""
                <tr>
                  <td style="padding:14px 12px; border-bottom:1px solid #eef2f7; width:56px; vertical-align:top;">
                    <a href="{escape((it.get('login_url') or '').strip())}" target="_blank" style="text-decoration:none;">
                      <span style="display:inline-flex; align-items:center; justify-content:center; width:36px; height:36px; border:1px solid #dbe3ea; border-radius:10px; background:#ffffff;">
                        <img
                          src="{escape((it.get('icon_url') or '').strip())}"
                          alt="{escape((it.get('label') or '').strip())}"
                          width="24"
                          height="24"
                          style="display:block; border:0; width:24px; height:24px;"
                        />
                      </span>
                    </a>
                  </td>
                  <td style="padding:14px 12px; border-bottom:1px solid #eef2f7; vertical-align:top;">
                    <div style="font-weight:700; font-size:18px; color:#111827; line-height:1.2;">{escape((it.get('label') or '').strip())}</div>
                    <div style="font-size:13px; color:#4b5563; margin-top:4px;">Profil : {escape((it.get('role_label') or '').strip())}</div>
                    <div style="font-size:13px; margin-top:8px;">
                      <a href="{escape((it.get('login_url') or '').strip())}" target="_blank" style="color:#6d28d9; text-decoration:none; font-weight:700;">Ouvrir la connexion</a>
                    </div>
                  </td>
                </tr>
                """
                for it in items
            ]
        )
    else:
        consoles_text = "- Aucun accès actif"
        consoles_html = """
        <tr>
          <td colspan="2" style="padding:10px 8px; color:#4b5563;">
            Aucun accès actif.
          </td>
        </tr>
        """

    if setup_url:
        auth_text = (
            "Pour finaliser votre accès, cliquez sur le lien sécurisé ci-dessous pour définir votre mot de passe.\n\n"
            f"Lien d’activation : {setup_url}\n\n"
            f"Identifiant : {to_email}"
        )
        auth_html = f"""
        <div style="margin-top:18px; border:1px solid #e5e7eb; border-radius:14px; background:#f9fafb; padding:16px 18px;">
          <p style="margin:0 0 10px 0; color:#111827; font-weight:700;">
            Pour finaliser votre accès, cliquez sur le lien sécurisé ci-dessous pour définir votre mot de passe.
          </p>

          <p style="margin:0 0 12px 0;">
            <a
              href="{escape(setup_url)}"
              target="_blank"
              style="display:inline-block; background:#111827; color:#ffffff; text-decoration:none; padding:10px 16px; border-radius:10px; font-weight:700;"
            >Définir mon mot de passe</a>
          </p>

          <p style="margin:0; color:#4b5563;">
            <strong>Identifiant :</strong> {escape((to_email or '').strip())}
          </p>
        </div>
        """
    elif mode_norm == "removal":
        auth_text = "Vous ne disposez plus d’aucun accès actif aux consoles Novoskill."
        auth_html = """
        <p style="margin:16px 0 0 0; color:#4b5563;">
          Vous ne disposez plus d’aucun accès actif aux consoles Novoskill.
        </p>
        """
    else:
        auth_text = (
            "Pour vous connecter, utilisez vos identifiants habituels.\n\n"
            f"Identifiant : {to_email}"
        )
        auth_html = f"""
        <div style="margin-top:18px; border:1px solid #e5e7eb; border-radius:14px; background:#f9fafb; padding:16px 18px;">
          <p style="margin:0 0 10px 0; color:#111827; font-weight:700;">
            Pour vous connecter, utilisez vos identifiants habituels.
          </p>
          <p style="margin:0; color:#4b5563;">
            <strong>Identifiant :</strong> {escape((to_email or '').strip())}
          </p>
        </div>
        """

    text_part = (
        f"{collab},\n\n"
        f"{intro_text}\n\n"
        "Consoles actives :\n"
        f"{consoles_text}\n\n"
        f"{auth_text}\n\n"
        "Ceci est un email automatique, merci de ne pas y répondre."
    )

    html_part = f"""
    <div style="background:#f3f4f6; padding:24px; font-family:Arial, Helvetica, sans-serif; color:#111827;">
      <div style="max-width:680px; margin:0 auto; background:#ffffff; border:1px solid #e5e7eb; border-radius:16px; overflow:hidden;">

        <div style="padding:0; background:#111827;">
          <div style="padding:18px 22px; background:#111827;">
            <div style="font-size:24px; font-weight:800; color:#ffffff; letter-spacing:.2px;">NOVOSKILL</div>
            <div style="margin-top:6px; display:inline-block; background:#f3f4f6; color:#111827; border-radius:999px; padding:6px 12px; font-size:13px; font-weight:700;">
              Gestion des accès console
            </div>
          </div>
        </div>

        <div style="padding:22px;">
          <p style="margin:0 0 12px 0; font-size:16px; color:#111827;">Bonjour {safe_collab},</p>
          <p style="margin:0 0 18px 0; color:#111827; line-height:1.5;">{intro_html}</p>

          <div style="border:1px solid #e5e7eb; border-radius:14px; overflow:hidden; background:#ffffff;">
            <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="border-collapse:collapse;">
              <tbody>
                {consoles_html}
              </tbody>
            </table>
          </div>

          {auth_html}

          <p style="margin:18px 0 0 0; color:#6b7280; font-size:12px;">
            Ceci est un email automatique, merci de ne pas y répondre.
          </p>
        </div>
      </div>
    </div>
    """

    return _send_mailjet_email(
        to_email=to_email,
        subject=subject,
        text_part=text_part,
        html_part=html_part,
    )
