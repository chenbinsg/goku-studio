"""
Middleware that records HTTP request metrics for Prometheus.
Tracks: request count, latency histogram, active requests gauge.
"""
import time
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request


class MetricsMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        from app.services.prometheus import counter_inc, histogram_observe, gauge_inc, gauge_dec

        method = request.method
        path = self._normalize_path(request.url.path)
        labels = {"method": method, "path": path}

        gauge_inc("aios_http_requests_active", labels=labels)
        start = time.perf_counter()

        try:
            response = await call_next(request)
        except Exception:
            counter_inc("aios_http_requests_total", labels={**labels, "status": "500"})
            raise
        finally:
            duration = time.perf_counter() - start
            gauge_dec("aios_http_requests_active", labels=labels)

        status = str(response.status_code)
        counter_inc("aios_http_requests_total", labels={**labels, "status": status})
        histogram_observe("aios_http_request_duration_seconds", duration, labels=labels)

        return response

    @staticmethod
    def _normalize_path(path: str) -> str:
        """Collapse UUID-like path segments to reduce cardinality."""
        parts = path.strip("/").split("/")
        normalized = []
        for p in parts:
            # Replace UUID-like segments (32+ hex chars with hyphens)
            if len(p) >= 32 and all(c in "0123456789abcdef-" for c in p.lower()):
                normalized.append(":id")
            else:
                normalized.append(p)
        return "/" + "/".join(normalized)
