"""
Shared rate limiter instance.
Defined here to avoid circular imports between main.py and routers.

Rate limits are per IP by default.  Override via environment variables:
  RATE_LIMIT_LOGIN        — login attempts          (default: 10/minute)
  RATE_LIMIT_REGISTER     — registration attempts   (default: 5/minute)
  RATE_LIMIT_SEND_MESSAGE — conversation messages   (default: 60/minute)
  RATE_LIMIT_CREATE_TASK  — task creation via API   (default: 30/minute)
  RATE_LIMIT_UPLOAD       — file uploads            (default: 20/minute)
  RATE_LIMIT_PASSWORD_OPS — password/MFA operations (default: 5/minute)
"""
import os
from slowapi import Limiter
from slowapi.util import get_remote_address

_LOGIN_RATE_LIMIT        = os.environ.get("RATE_LIMIT_LOGIN",        "10/minute")
_REGISTER_RATE_LIMIT     = os.environ.get("RATE_LIMIT_REGISTER",     "5/minute")
_SEND_MESSAGE_RATE_LIMIT = os.environ.get("RATE_LIMIT_SEND_MESSAGE", "60/minute")
_CREATE_TASK_RATE_LIMIT  = os.environ.get("RATE_LIMIT_CREATE_TASK",  "30/minute")
_UPLOAD_RATE_LIMIT       = os.environ.get("RATE_LIMIT_UPLOAD",       "20/minute")
_PASSWORD_OPS_RATE_LIMIT = os.environ.get("RATE_LIMIT_PASSWORD_OPS", "5/minute")

limiter = Limiter(key_func=get_remote_address)
