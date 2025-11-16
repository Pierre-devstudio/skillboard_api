import os
import requests

MJ_APIKEY_PUBLIC = os.getenv("MJ_APIKEY_PUBLIC")
MJ_APIKEY_PRIVATE = os.getenv("MJ_APIKEY_PRIVATE")
MAIL_ALERT_DEST = os.getenv("MAIL_ALERT_DEST")
MAIL_FROM = os.getenv("MAIL_FROM", MAIL_ALERT_DEST)

MAILJET_URL = "https://api.mailjet.com/v3.1/send"


def send_absent_mail(code_formation: str, titre: str, absents: list[str]):
    """
    Envoie le mail via l'API Mailjet.
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

        if r.status_code >= 200 and r.status_code < 300:
            print("Mail envoyé via Mailjet OK")
        else:
            print("Erreur Mailjet:", r.status_code, r.text)

    except Exception as e:
        print("Erreur appel Mailjet:", e)
