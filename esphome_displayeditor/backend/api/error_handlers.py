"""Turn exceptions into the API's ``{"error", "message", "details"}`` shape."""

from __future__ import annotations

import logging
import secrets

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from ..builder.adapter import BuilderAdapterError
from ..errors import ApiError

_LOGGER = logging.getLogger(__name__)

#: Kept from pydantic's validation errors. "input" is left out on purpose:
#: echoing the request back can repeat an API key or a whole YAML file in a
#: response or a log, and "ctx" may hold objects JSON cannot encode.
_VALIDATION_KEYS = ("type", "loc", "msg")


def install_error_handlers(application: FastAPI) -> None:
    @application.exception_handler(ApiError)
    async def api_error_handler(_request: Request, exc: ApiError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code,
            content={"error": exc.error, "message": exc.message, "details": exc.details},
        )

    @application.exception_handler(BuilderAdapterError)
    async def builder_error_handler(
        _request: Request, exc: BuilderAdapterError
    ) -> JSONResponse:
        return JSONResponse(
            status_code=504 if exc.code == "builder_timeout" else 503,
            content={"error": exc.code, "message": exc.message, "details": {}},
        )

    @application.exception_handler(RequestValidationError)
    async def validation_error_handler(
        _request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        errors = [
            {key: error[key] for key in _VALIDATION_KEYS if key in error}
            for error in exc.errors()
        ]
        return JSONResponse(
            status_code=422,
            content={
                "error": "invalid_request",
                "message": "The request body or parameters are invalid.",
                "details": {"errors": errors},
            },
        )

    @application.exception_handler(Exception)
    async def unexpected_error_handler(request: Request, _exc: Exception) -> JSONResponse:
        # Anything not mapped above used to end as a plain-text 500 the
        # frontend could only show as "HTTP 500". The server still logs the
        # traceback; the reference ties that log entry to the message shown.
        reference = secrets.token_hex(4)
        _LOGGER.error("Unexpected error %s on %s %s", reference, request.method, request.url.path)
        return JSONResponse(
            status_code=500,
            content={
                "error": "internal_error",
                "message": "An unexpected error occurred.",
                "details": {"reference": reference},
            },
        )
