"""Score the same kick/bass session with TwelveTake 1.11.0 on a disposable REAPER profile."""
import asyncio
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import wave

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


def window_rms(file, windows):
    levels = []
    with wave.open(str(file)) as source:
        rate, channels, width = source.getframerate(), source.getnchannels(), source.getsampwidth()
        assert source.getnframes() == 8 * rate and channels == 2 and width in (2, 3, 4)
        for start, end in windows:
            source.setpos(round(rate * start))
            raw = source.readframes(round(rate * (end - start)))
            step = width * channels
            samples = (int.from_bytes(raw[i:i+width], "little", signed=True) / (1 << (8*width-1))
                       for i in range(0, len(raw), step))
            levels.append(10 * math.log10(sum(s*s for s in samples) / (len(raw)//step)))
    return levels


async def compare(report_path, server):
    report = json.loads(report_path.read_text())
    fixture = report_path.parent
    root = Path(tempfile.mkdtemp(prefix="reference-sidechain-"))
    for name in ["routing.rpp", "bass.wav", "kick.wav"]:
        shutil.copyfile(fixture/name, root/name)
    profile = root/"profile"
    profile.mkdir()
    ini = profile/"reaper.ini"
    ini.write_text("[REAPER]\nrenderclosewhendone=1\n[audioconfig]\nmode=4\ndummy_srate=44100\ndummy_blocksize=1024\n")
    exe = os.environ.get("REAPER_PATH", "C:/Program Files/REAPER (x64)/reaper.exe")
    mailbox = profile/"Scripts/mcp_bridge_data"
    started = time.monotonic()
    proc = subprocess.Popen([exe, "-newinst", "-nosplash", "-cfgfile", str(ini),
                             str(root/"routing.rpp"), str(server/"reaper_mcp_bridge.lua")],
                            creationflags=subprocess.CREATE_NO_WINDOW)
    calls = []
    try:
        while not mailbox.is_dir():
            if proc.poll() is not None or time.monotonic()-started > 180:
                raise RuntimeError("Reference bridge did not start in its isolated profile")
            await asyncio.sleep(0.5)
        params = StdioServerParameters(command=sys.executable, args=[str(server/"reaper_mcp_server.py")],
                                       env={**os.environ, "REAPER_BRIDGE_DIR": str(mailbox)})
        async with stdio_client(params) as streams, ClientSession(*streams) as session:
            await session.initialize()

            async def call(name, **args):
                before = time.monotonic()
                response = await asyncio.wait_for(session.call_tool(name, args), timeout=180)
                result = json.loads(response.content[0].text)
                calls.append({"tool": name, "elapsedMs": round((time.monotonic()-before)*1000)})
                if response.isError or not result.get("ok"):
                    raise RuntimeError(f"{name}: {result}")

            await call("get_project_name")
            await call("track_fx_add_by_name", track_index=1, fx_name="ReaComp")
            await call("setup_sidechain_compression", trigger_track=0, target_track=1, compressor_fx_index=0)
            await call("track_fx_set_param", track_index=1, fx_index=0, param_index=0, value=0.2)
            await call("track_fx_set_param", track_index=1, fx_index=0, param_index=1, value=1)
            await call("save_project")
            await call("set_track_solo", track_index=1, solo=True)
            await call("render_project", output_path=str(root/"peer-bass.wav"), start_time=0, end_time=8,
                       skip_postprocessing=True)
        baseline = window_rms(fixture/report["baseline"], report["windows"])
        peer = window_rms(root/"peer-bass.wav", report["windows"])
        deltas = [round(p-b, 3) for p,b in zip(peer,baseline)]
        verdict = all(abs(x-y) < 0.2 for x,y in zip(deltas,report["deltas"]))
        proof = {"reference": "TwelveTake 1.11.0", "windows": report["windows"], "referenceDeltasDb": deltas,
                 "localDeltasDb": report["deltas"], "matchedWithinPointTwoDb": verdict,
                 "referenceCalls": calls, "referenceElapsedMs": round((time.monotonic()-started)*1000)}
        (fixture/"peer-check.json").write_text(json.dumps(proof, indent=2))
        print(json.dumps(proof))
        if not verdict:
            raise AssertionError("Sidechain results differ; inspect both sets of window measurements")
    finally:
        if proc.poll() is None:
            proc.terminate()
            proc.wait(timeout=15)


if __name__ == "__main__":
    asyncio.run(compare(Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve()))
