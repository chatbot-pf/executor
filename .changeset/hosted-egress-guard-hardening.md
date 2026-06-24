---
"executor": patch
---

Hardened the hosted egress guard. Outbound requests from OAuth token exchanges,
MCP transports, and GraphQL/Google/Microsoft discovery now all route through the
guard, and the guard resolves DNS before connecting so a hostname that points at
a private or loopback address is blocked rather than only literal private IPs.
This tightens SSRF protection for hosted and cloud execution.
