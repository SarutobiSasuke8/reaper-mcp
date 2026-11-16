# Third-party source and template attribution

This project is MIT-licensed. REAPER is separately installed and is not distributed here.

| Source | Revision | Used here | Licence |
|---|---|---|---|
| House MCP server template | `6e6ba1ce9e2d42fb2f3ce95f80a9964b78938fb4` | Adapted tool contracts, error boundary, stdio tests and TypeScript configuration | MIT, copyright 2026 Alexei Udall |
| lmms-mcp `audio.mjs` | `364799c23f7c271d5b0de352935d759230c5ec39` (last modifying commit in source checkout `0ec0d6480d1a36e8ee820de566c6e0d61a14a5ec`) | Byte-preserved `vendor/lmms-mcp/audio.mjs` | MIT; complete notice in `vendor/lmms-mcp/LICENSE` |

Package dependency licences are retained by npm. No REAPER binary, paid plugin, stock sample library or community REAPER MCP code is included. Later music ports require a source path, commit and licence entry before inclusion.

The template adaptation uses the existing LMMS MCP SDK 1.x stack for Node 20/22 compatibility. It does not copy the template's HTTP authentication, release workflows or publishing scripts.
