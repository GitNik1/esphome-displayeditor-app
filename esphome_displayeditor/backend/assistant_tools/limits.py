"""Central limits for machine-driven access to the editor."""

MCP_PORT = 8100
MCP_MIN_TOKEN_LENGTH = 32
MCP_REQUEST_MAX_BYTES = 1024 * 1024
MCP_RESPONSE_MAX_BYTES = 512 * 1024
MCP_PROJECT_LIST_LIMIT = 100
MCP_PAGE_SIZE_LIMIT = 100
MCP_COMPLETION_LIMIT = 50
MCP_BINDING_TARGET_SCAN_LIMIT = 1000
MCP_DEVICE_SCAN_LIMIT = 1000
MCP_CURSOR_MAX_CHARACTERS = 2048
MCP_TREE_WIDGET_LIMIT = 1000
MCP_CONFIGURATION_CHUNK_CHARACTERS = 64 * 1024
MCP_CHANGESET_TTL_SECONDS = 15 * 60
MCP_APPLIED_CHANGESET_RETENTION_SECONDS = 24 * 60 * 60
MCP_ACTIVE_CHANGESET_LIMIT = 100
MCP_CHANGESET_RECORD_LIMIT_PER_IDENTITY = 200
MCP_CHANGESET_RECORD_LIMIT = 1000
MCP_CHANGESET_PAYLOAD_MAX_BYTES = 8 * 1024 * 1024
MCP_CHANGESET_STORAGE_MAX_BYTES = 64 * 1024 * 1024
MCP_ACTIVE_TOKEN_LIMIT = 100
MCP_TOKEN_RECORD_LIMIT = 500
MCP_TOKEN_STORE_MAX_BYTES = 512 * 1024
MCP_TOKEN_LAST_USED_FLUSH_SECONDS = 60
MCP_HEALTH_RESPONSE_MAX_BYTES = 4096
MCP_HEALTH_PROBE_TIMEOUT_SECONDS = 2.0
MCP_OPERATIONS_PER_CHANGESET = 50
MCP_OPERATION_TEXT_LENGTH = 4096
MCP_TOOL_ARGUMENTS_MAX_BYTES = 256 * 1024
#: Ceiling for the few tools whose one legitimate argument is an inline file
#: body (e.g. pasted YAML). This must stay well under MCP_REQUEST_MAX_BYTES
#: (the whole-request 1 MiB transport cap, enforced both by this app and by
#: the SDK's own ASGI body counter): a JSON-RPC envelope and JSON string
#: escaping both add overhead on top of the raw argument bytes, so a limit
#: any closer to 1 MiB would make the effective ceiling unpredictable.
#: Each such tool's handler still enforces its own real content limit
#: (typically settings.max_file_size) independently of this transport bound.
MCP_LARGE_TOOL_ARGUMENTS_MAX_BYTES = 768 * 1024
MCP_TOOL_RESULT_SOFT_TARGET_CHARACTERS = 32_000
MCP_TOOL_TIMEOUT_SECONDS = 30
MCP_CONCURRENT_READS_PER_IDENTITY = 4
MCP_CONCURRENT_WRITES_PER_IDENTITY = 1
#: MCP Apps bundle ceiling (plan §8.3): the ui:// HTML resource is static and
#: self-contained (no external origins), so this is checked once at server
#: construction, not per request.
MCP_APP_BUNDLE_MAX_BYTES = 512 * 1024
