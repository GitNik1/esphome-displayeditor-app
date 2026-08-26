"""In-app AI help panel (plan M8/D3).

A minimal, opt-in assistant built into the editor itself, calling the
Anthropic API directly. It reuses ``AssistantToolService`` - the same
service MCP calls - for every read and proposal, so an in-app request and an
external MCP client produce identical semantic operations. It never shares
MCP's transport, tokens, or scopes: access is gated by the app's own
``administrator``-only ``assistant.ask`` capability and a separate
``assistant_mode``/``assistant_api_key`` setting.

Security posture (see the project's MCP security review for the full
reasoning): the tool set exposed to the model is a small, fixed subset (no
apply, no build/install, no arbitrary YAML import/export, no cross-project
listing) and every project- or configuration-scoped tool is hard-bound to
the one project/configuration chosen when the request was made - the model
is never given a parameter to choose a different one, so a prompt injection
that tries to redirect a tool call at another project/configuration has
nothing to redirect: the parameter does not exist in the schema, and the
handler substitutes the bound name regardless of what the model sends.
"""
