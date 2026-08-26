# ESPHome Display Editor for Claude Desktop

This MCPB package connects Claude Desktop to an ESPHome Display Editor instance
that is reachable from the local computer. It translates Claude's stdio MCP
transport to the editor's authenticated Streamable HTTP endpoint; the editor
continues to enforce token scopes, revisions, change sets, limits, and audit
logging.

## Install

1. Enable the editor's LAN MCP listener and publish port `8100/tcp` only to the
   required local network.
2. Create a scoped, expiring client token under **System → AI client access**.
3. Build the package with `python scripts/build_mcpb.py` from the add-on source
   directory, or download the `claude-desktop-mcpb` artifact from a successful
   CI run. Verify the package against the accompanying `.mcpb.sha256` file
   before installing it.
4. Open the generated `.mcpb` file with Claude Desktop or drag it onto the
   Claude Desktop Settings window.
5. Enter the endpoint URL, such as
   `http://homeassistant.local:8100/mcp`, and the one-time client token.

The token is provided to the local bridge as a sensitive environment value. It
is never placed in the package, command arguments, stdout, or diagnostics.

## Scope and trust boundary

The bridge only forwards MCP JSON-RPC messages to the configured endpoint. It
does not bypass the editor's read-only/project-write mode or token scopes. Use
`http` only on a trusted LAN; use `https` whenever the endpoint crosses an
untrusted network. Do not expose the raw MCP listener to the public internet.

Claude Desktop's remote custom connectors are a separate cloud-to-server
integration and still require public HTTPS plus OAuth. This package runs on the
same computer as Claude Desktop and can therefore reach a private LAN endpoint.
