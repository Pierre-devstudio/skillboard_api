import os
import requests

MJ_APIKEY_PUBLIC = os.getenv("MJ_APIKEY_PUBLIC")
MJ_APIKEY_PRIVATE = os.getenv("MJ_APIKEY_PRIVATE")
MAIL_ALERT_DEST = os.getenv("MAIL_ALERT_DEST")
MAIL_FROM = os.getenv("MAIL_FROM", MAIL_ALERT_DEST)

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
