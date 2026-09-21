"""Serve the REAL Foundry receiver around a deterministic fixture driver.

Honest label: this runs the actual adapter_core.AdapterServer, its HTTP handler,
NativeAdmission (durable FIFO admission, exact replay) and NativeTaskStore from
a local a2a-cli-adapter checkout, over loopback HTTP, with state in a temporary
directory. The DRIVER is a fixture: no model and no CLI is invoked, and this is
NOT a named teammate's native turn.

It only reads the adapter checkout. Bytecode writes are disabled so nothing is
created inside that tree, and all inherited team lineage is cleared first, the
same way the adapter's own fixtures do.

usage: real_adapter_seat.py <adapter_root> <state_dir> <record_file> [token]
"""
import sys

sys.dont_write_bytecode = True

import json
import os
import threading
import time
from http.server import ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace

adapter_root = Path(sys.argv[1]).resolve()
state_dir = Path(sys.argv[2]).resolve()
record_file = Path(sys.argv[3]).resolve()
token = sys.argv[4] if len(sys.argv) > 4 else ""
hold_file = Path(str(record_file) + ".hold")

for key in list(os.environ):
    upper = key.upper()
    if upper.startswith(("TEAM_A2A_", "A2A_TEAM_", "HERMES_A2A_")) or upper in {"A2A_ROSTER", "A2A_STATE_DIR"}:
        del os.environ[key]
os.environ.update({"A2A_STATE_DIR": str(state_dir), "A2A_HOST": "127.0.0.1", "A2A_TOKEN": token})
sys.path.insert(0, str(adapter_root))

from adapter_core import AdapterServer  # noqa: E402  (the real receiver)

_lock = threading.Lock()
_calls = 0
LINEAGE = ("TEAM_A2A_ROOT_ID", "TEAM_A2A_ROOT_CONTEXT", "TEAM_A2A_PARENT_CALL_ID",
           "TEAM_A2A_OUTCOME_OWNER", "TEAM_A2A_AUTHORITY", "TEAM_A2A_ORIGIN_ROUTE", "TEAM_A2A_ROOT_TASK")


def invoke(prompt, session, cwd, timeout, env=None, cancel_event=None, on_process=None, on_session=None):
    """Deterministic stand-in for a native CLI turn. Records exactly what the
    receiver handed to the driver, resumes the session it was given, and ends
    when the test removes the hold file (if one exists)."""
    global _calls
    with _lock:
        _calls += 1
        number = _calls
    session_id = session or f"fixture-native-session-{number}"
    if on_session:
        on_session(session_id)
    record = {
        "call": number, "prompt": prompt, "session_in": session or "", "session": session_id,
        "timeout": timeout, "lineage_env": sorted(k for k in LINEAGE if (env or {}).get(k)),
        "seat_env": (env or {}).get("TEAM_A2A_SEAT", ""),
    }
    with _lock:
        with open(record_file, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, ensure_ascii=False) + "\n")
    deadline = time.monotonic() + 30
    while hold_file.exists() and time.monotonic() < deadline:
        if cancel_event is not None and cancel_event.is_set():
            break
        time.sleep(0.02)
    return f"REAL-RECEIVER-FIXTURE-REPLY call {number}: a private reply nobody is assigned to read", session_id


driver = SimpleNamespace(
    AGENT={"slug": "fixture", "name": "Deterministic fixture driver", "port": 0,
           "description": "No model invoked; not a teammate", "skills": []},
    invoke=invoke,
)
server = AdapterServer(driver)
httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.make_handler())
server.port = httpd.server_address[1]
server.public_url = f"http://127.0.0.1:{server.port}"
server.admission.start()
print(json.dumps({"ready": True, "url": server.public_url, "state_dir": str(state_dir)}), flush=True)
try:
    httpd.serve_forever()
finally:
    server.admission.stop()
    httpd.server_close()
