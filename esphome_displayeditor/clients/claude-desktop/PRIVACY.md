# MCPB bridge privacy notice

The ESPHome Display Editor MCPB bridge runs locally as a child process of the
MCP client. It sends MCP requests and the configured bearer token only to the
server URL entered by the user. Depending on the requested tools and resources,
those messages can contain ESPHome configuration text, project structure,
widget properties, bindings, validation results, and proposed changes.

The bridge has no analytics, advertising, telemetry, or third-party service
integration. It does not persist MCP messages or the bearer token. Claude
Desktop manages the sensitive token setting; the bridge receives it through
its process environment for the lifetime of the connection. The configured
ESPHome Display Editor server applies its own storage, audit, access-control,
and retention behavior.

Users control the data destination by choosing the MCP server URL. A plain
`http` URL should only be used on a trusted local network. Remove or revoke the
client token in the editor's System page when access is no longer required.
