# Third-party source and template attribution

This project is MIT-licensed. REAPER is separately installed and is not distributed here.

| Source | Revision | Used here | Licence |
|---|---|---|---|
| House MCP server template | `6e6ba1ce9e2d42fb2f3ce95f80a9964b78938fb4` | Adapted tool contracts, error boundary, stdio tests and TypeScript configuration | MIT, copyright 2026 Alexei Udall |
| lmms-mcp audio measurements | `e447956bb9437116d291ba05bb7c917f39279de4` ([source PR](https://github.com/SarutobiSasuke8/lmms-mcp/pull/81)) | Byte-preserved audio.mjs, k-weight.mjs, lra.mjs and stereo.mjs under vendor/lmms-mcp/ | MIT; complete notice in vendor/lmms-mcp/LICENSE |
| lmms-mcp composition | `d6d2c2e4a0b2bfd230f10caae257807b033ff8c1` | Byte-preserved music.mjs, composers.mjs, tools/compose.mjs, melody.mjs, motif.mjs, solo.mjs, blueprints.mjs, arranger-lint.mjs, personas.mjs, tools/balance.mjs, tools/styles.json, tools/blueprints.json and personas/*.json under vendor/lmms-mcp/ | MIT; complete notice in vendor/lmms-mcp/LICENSE |

Package dependency licences are retained by npm. No REAPER binary, paid plugin, stock sample library or community REAPER MCP code is included. Later music ports require a source path, commit and licence entry before inclusion.

The template adaptation uses the existing LMMS MCP SDK 1.x stack for Node 20/22 compatibility. It does not copy the template's HTTP authentication, release workflows or publishing scripts.
