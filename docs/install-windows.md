# Windows development setup

1. Install Node 20 or 22. Install REAPER independently from its official source if rendering is needed.
2. Run `npm ci` and `npm run check` in this repository.
3. Create a dedicated music workspace. Keep input MIDI/WAV files inside it.
4. Configure the MCP client to launch `node` with the absolute path to `dist/src/stdio.js`. Supply an absolute `REAPER_MCP_WORKSPACE` and set `REAPER_MCP_ALLOW_WRITES=true` only when edits are wanted. `REAPER_PATH` can name the REAPER executable if it is outside common installation locations.

Example client configuration (adapt placeholders for the chosen client):

```json
{
  "mcpServers": {
    "reaper": {
      "command": "node",
      "args": ["C:/path/to/reaper-mcp/dist/src/stdio.js"],
      "env": {
        "REAPER_MCP_WORKSPACE": "C:/path/to/music-workspace",
        "REAPER_MCP_ALLOW_WRITES": "true"
      }
    }
  }
}
```

See [Windows alpha usage](windows-alpha.md) for setup, launch, doctor, explicit modes, live limits and recovery. Saves create new files only. No bridge or settings are installed into your normal REAPER profile.
