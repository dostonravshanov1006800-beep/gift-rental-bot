"""ECDSA P-256 подпись пейлоадов витрин. Совместимо с WebCrypto в мини-аппе:
подпись отдаётся в формате P-1363 (raw r||s), base64url."""
import base64
import hashlib

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature


def load_private(pem_text: str) -> ec.EllipticCurvePrivateKey:
    return serialization.load_pem_private_key(pem_text.encode(), password=None)


def sign_payload(priv: ec.EllipticCurvePrivateKey, payload: str) -> str:
    der = priv.sign(payload.encode("utf-8"), ec.ECDSA(hashes.SHA256()))
    r, s = decode_dss_signature(der)
    raw = r.to_bytes(32, "big") + s.to_bytes(32, "big")
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def hash_payload(payload: str) -> str:
    digest = hashlib.sha256(payload.encode("utf-8")).digest()
    return base64.urlsafe_b64encode(digest).decode().rstrip("=")
