# Security policy

Retake runs hooks (HTTP, SQL, shell, in-page JavaScript) against your product, keeps signed-in browser sessions on
your computer, serves the Studio and an MCP server on 127.0.0.1, and lets an AI agent drive all of that. Security
reports are taken seriously.

## Reporting a vulnerability

**Please do not open a public issue.** Report it privately through GitHub:
[Security › Report a vulnerability](../../security/advisories/new).

Include what is affected (the desktop app, the `retake` command, the Studio, the MCP server), the version, how to
reproduce it, and what an attacker could do with it. You will get an answer within a week. Once a fix is released,
the advisory is published with credit to you, unless you prefer otherwise.

## Supported versions

Fixes go into the latest release. The desktop app updates itself.

## Scope

In scope, for example:

- a hook, a seed step or code from an agent-writable file running without the user's approval;
- reading a signed-in session, a secret or the MCP token from outside the user's account;
- a page, a scenario, a comment or a component's text making an agent or the Studio act on it as an instruction;
- reaching the Studio or the MCP server without its token, or from another origin;
- an update installed without a valid signature.

Out of scope: attacks that need full control of the user's machine, and a product the user films on purpose.
How Retake protects each of these is in [Security model](docs/guide/security.md).
