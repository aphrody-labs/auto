---
name: auto
description: Operate Auto billing, Factur-X e-invoicing, FEC ledger export, HR leave, workflows, and workspace search via the Auto MCP tools.
---

Use the configured `auto` MCP server (`auto mcp`) or TypeScript/Rust SDK (`@aphrody/auto` / `aphrody_auto`).

- Read invoices and quotes before editing (`list_documents`, `search_workspace`).
- Issuing a document (`issue_document`) assigns gapless sequential numbering and generates a Factur-X PDF/A-3b artifact.
- Never delete issued invoices; create a credit note instead.
- Check overdue invoices with `list_overdue_documents` and export balanced ledgers via `export_fec`.
