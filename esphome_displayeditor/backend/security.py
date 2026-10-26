"""Ingress boundary and small in-memory API rate limiter."""

from __future__ import annotations

import threading
import time
from collections import defaultdict, deque
from dataclasses import dataclass


@dataclass(frozen=True)
class RateLimitDecision:
    allowed: bool
    retry_after: int = 0


class RateLimiter:
    """Sliding-window limits for one single-process app instance."""

    def __init__(
        self,
        read_limit: int,
        write_limit: int,
        window_seconds: int = 60,
        *,
        asset_limit: int | None = None,
    ) -> None:
        self.read_limit = read_limit
        self.write_limit = write_limit
        #: Image/font reads get their own, larger budget: a page full of
        #: images (or an animated image's frames) must not use up the
        #: budget that saving and loading depend on.
        self.asset_limit = asset_limit if asset_limit is not None else 5 * read_limit
        self.window_seconds = window_seconds
        self._requests: dict[tuple[str, str], deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def check(
        self,
        identity: str,
        *,
        write: bool,
        asset: bool = False,
        now: float | None = None,
    ) -> RateLimitDecision:
        timestamp = time.monotonic() if now is None else now
        buckets = [("asset", self.asset_limit)] if asset else [("api", self.read_limit)]
        if write:
            buckets.append(("write", self.write_limit))

        with self._lock:
            queues: list[tuple[deque[float], int]] = []
            for bucket, limit in buckets:
                queue = self._requests[(identity, bucket)]
                cutoff = timestamp - self.window_seconds
                while queue and queue[0] <= cutoff:
                    queue.popleft()
                if len(queue) >= limit:
                    retry_after = max(1, int(self.window_seconds - (timestamp - queue[0]) + 0.999))
                    return RateLimitDecision(False, retry_after)
                queues.append((queue, limit))
            for queue, _limit in queues:
                queue.append(timestamp)
        return RateLimitDecision(True)
