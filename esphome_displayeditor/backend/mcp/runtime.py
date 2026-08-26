"""Small command-line bridge used by the container startup script.

A misconfigured optional MCP listener must never prevent the core add-on
(the Ingress-served editor) from starting. On invalid MCP configuration this
prints ``disabled`` on stdout - the same as the feature being turned off -
and reports the actual problem on stderr for the add-on log.
"""

from __future__ import annotations

import sys

from ..assistant_tools.limits import MCP_PORT
from ..settings import Settings
from .configuration import validate_mcp_settings


def main() -> None:
    settings = Settings.load()
    mode = settings.mcp_mode
    access = settings.mcp_access
    try:
        validate_mcp_settings(settings)
    except ValueError as exc:
        print(f"[error] Invalid MCP configuration, MCP stays disabled: {exc}", file=sys.stderr)
        mode = "disabled"
    print(f"{mode} {MCP_PORT} {access}")


if __name__ == "__main__":
    main()
