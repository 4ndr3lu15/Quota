"""Read-only keyring lookups (libsecret): Quota's own OpenRouter keys, and the one MINITRON keeps.

The app never stores keys: they are added in the extension's settings or in MINITRON.
"""
import gi

gi.require_version("Secret", "1")

from gi.repository import Secret  # noqa: E402

_STR = Secret.SchemaAttributeType.STRING
SCHEMAS = {
    # the extension's (src/lib/secrets.js): one per (account id, kind = api | management)
    "quota": Secret.Schema.new("org.gnome.shell.extensions.quota.ApiKey", Secret.SchemaFlags.NONE,
                               {"account": _STR, "kind": _STR}),
    # MINITRON's (Minitron/minitron/secrets.py), which keeps Atelier's name
    "minitron": Secret.Schema.new("io.github._4ndr3lu15.Atelier.ApiKey", Secret.SchemaFlags.NONE,
                                  {"provider": _STR}),
    # Antigravity CLI's go-keyring schema (service="gemini", username="antigravity-oauth-token")
    "agy": Secret.Schema.new("org.freedesktop.Secret.Generic", Secret.SchemaFlags.NONE,
                             {"service": _STR, "username": _STR}),
}


def lookup(schema: str, attributes: dict) -> str | None:
    """Blocking: call it from a worker thread. None when there is no such key or no keyring."""
    try:
        return Secret.password_lookup_sync(SCHEMAS[schema], attributes, None)
    except Exception:  # noqa: BLE001  a locked or missing keyring reads as "no key"
        return None
