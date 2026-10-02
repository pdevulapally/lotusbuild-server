"""Initialises Firebase Admin from an explicit service-account file."""

from __future__ import annotations

import json
from typing import Any

import firebase_admin
from firebase_admin import auth, credentials, firestore
from google.cloud.firestore import AsyncClient

from lotusbuild.errors import EnvironmentError


def initialise_firebase(config: Any) -> dict[str, Any]:
    try:
        raw = open(config.FIREBASE_SERVICE_ACCOUNT_FILE, encoding="utf8").read()
    except OSError as cause:
        raise EnvironmentError([
            "FIREBASE_SERVICE_ACCOUNT_FILE cannot be read; check the configured path and permissions.",
        ]) from cause
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as cause:
        raise EnvironmentError(["FIREBASE_SERVICE_ACCOUNT_FILE is not valid JSON."]) from cause
    if not isinstance(parsed, dict):
        raise EnvironmentError(["FIREBASE_SERVICE_ACCOUNT_FILE is not a JSON object."])
    missing = [field for field in ("project_id", "client_email", "private_key") if not isinstance(parsed.get(field), str) or parsed[field] == ""]
    if missing:
        raise EnvironmentError([f'FIREBASE_SERVICE_ACCOUNT_FILE is missing "{field}".' for field in missing])
    if parsed["project_id"] != config.FIREBASE_PROJECT_ID:
        raise EnvironmentError(["FIREBASE_SERVICE_ACCOUNT_FILE project_id does not match FIREBASE_PROJECT_ID."])
    credential = credentials.Certificate({
        "type": "service_account",
        "project_id": parsed["project_id"],
        "client_email": parsed["client_email"],
        "private_key": parsed["private_key"],
        "token_uri": parsed.get("token_uri", "https://oauth2.googleapis.com/token"),
    })
    google_credentials = credential.get_credential()
    app = firebase_admin.initialize_app(credential, {"projectId": parsed["project_id"], "storageBucket": config.FIREBASE_STORAGE_BUCKET})
    client = AsyncClient(project=parsed["project_id"], credentials=google_credentials)
    return {
        "app": app,
        "auth": auth,
        "firestore": client,
        "sync_firestore": firestore.client(app),
        "credentials": google_credentials,
        "project_id": parsed["project_id"],
    }
