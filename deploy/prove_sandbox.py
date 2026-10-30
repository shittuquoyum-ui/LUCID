"""
The prover's sandbox broker: it makes and drives the Modal Sandboxes the
Node prover (src/prover/sandbox.ts) attacks. Two ways to reach it:

  - stdio (local runs): started as a child process for one proof, JSON lines
    on stdin and stdout.
  - HTTP (on Modal): serve() runs in a thread of the server function itself,
    on 127.0.0.1 only, behind a token the Node server is given at start. A
    child process there gets no Modal credentials; the function's own process
    has them.

Messages:
  {"op": "start"}                                       -> {"session": id}, Postgres running
  {"op": "psql", "session": id, "db", "user", "options", "sql", "tuplesOnly", "timeout"}
  {"op": "stop", "session": id}                         -> sandbox destroyed

The sandbox: postgres:16, no network at all, 1 CPU, 1 GiB, destroyed after
the proof and in any case after SANDBOX_TIMEOUT seconds. Postgres listens on
a Unix socket only. SQL never runs anywhere but inside it.

Inside, the sandbox's own main process is a small bash loop: it starts
Postgres, then reads one request per line on stdin and answers one line on
stdout (fields in base64). It talks over the sandbox's stdio, which works
from inside a Modal container; Sandbox.exec there hung.
"""

import base64
import json
import re
import sys
import threading
import time
import uuid

import modal

SANDBOX_TIMEOUT = 120  # hard ceiling; the prover itself stops at about 90 s
IMAGE = "postgres:16-bookworm"
PG_BIN = "/usr/lib/postgresql/16/bin"

LOOP = f"""
set -u
mkdir -p /tmp/pg && chown postgres /tmp/pg
if ! gosu postgres {PG_BIN}/initdb -D /tmp/pg --auth=trust -U postgres >/dev/null 2>&1 \\
  || ! gosu postgres {PG_BIN}/pg_ctl -D /tmp/pg -l /tmp/pg.log -w -o "-c listen_addresses='' -c unix_socket_directories=/tmp -c max_connections=20" start >/dev/null 2>&1; then
  echo FAILED; exit 1
fi
echo READY
while IFS=' ' read -r id user db secs tuples opts sql; do
  o=$(printf '%s' "$opts" | base64 -d)
  t=""; [ "$tuples" = 1 ] && t="-t"
  out=$(printf '%s' "$sql" | base64 -d | PGOPTIONS="$o" timeout "$secs" psql -X -q -h /tmp -U "$user" -d "$db" -A -F "$(printf '\\t')" -P footer=off $t 2>&1; echo "EXIT:$?")
  code=${{out##*EXIT:}}
  out=${{out%EXIT:*}}
  printf '%s %s %s\\n' "$id" "$code" "$(printf '%s' "$out" | base64 -w0)"
done
"""

NAME = re.compile(r"^[a-z_]+$")


def b64(s):
    return base64.b64encode(s.encode()).decode() or "-"


class Session:
    def __init__(self):
        app = modal.App.lookup("lucid-prover", create_if_missing=True)
        self.sandbox = modal.Sandbox.create(
            "bash", "-c", LOOP,
            app=app,
            image=modal.Image.from_registry(IMAGE),
            block_network=True,
            cpu=1.0,
            memory=1024,
            timeout=SANDBOX_TIMEOUT,
        )
        self.lock = threading.Lock()
        self.chunks = iter(self.sandbox.stdout)
        self.buffer = ""
        first = self.line()
        if first != "READY":
            self.sandbox.terminate()
            raise RuntimeError(f"postgres did not start ({first})")

    def line(self):
        while "\n" not in self.buffer:
            chunk = next(self.chunks, None)
            if chunk is None:
                raise RuntimeError("the sandbox stopped")
            self.buffer += chunk
        line, self.buffer = self.buffer.split("\n", 1)
        return line.strip()

    def psql(self, msg):
        user, db = msg["user"], msg["db"]
        if not NAME.match(user) or not NAME.match(db):
            raise RuntimeError("bad user or database name")
        with self.lock:
            rid = uuid.uuid4().hex[:8]
            secs = max(1, min(int(msg.get("timeout", 30)), 90))
            self.sandbox.stdin.write(f"{rid} {user} {db} {secs} {1 if msg.get('tuplesOnly') else 0} {b64(msg.get('options', '') or ' ')} {b64(msg['sql'])}\n")
            self.sandbox.stdin.drain()
            while True:
                parts = self.line().split(" ")
                if parts[0] == rid:
                    break
            out = base64.b64decode(parts[2]).decode(errors="replace") if len(parts) > 2 else ""
            return {"code": int(parts[1]), "stdout": out[-200_000:]}

    def stop(self):
        try:
            self.sandbox.terminate()
        except Exception:
            pass


_sessions = {}
_lock = threading.Lock()


def handle(msg):
    """One message in, one reply out. Every failure becomes a reply."""
    started = time.time()
    try:
        op = msg.get("op")
        if op == "start":
            session = uuid.uuid4().hex
            s = Session()
            with _lock:
                _sessions[session] = s
            reply = {"session": session}
        elif op == "psql":
            s = _sessions.get(msg.get("session"))
            if s is None:
                raise RuntimeError("no such sandbox")
            reply = s.psql(msg)
        elif op == "stop":
            with _lock:
                s = _sessions.pop(msg.get("session"), None)
            if s:
                s.stop()
            reply = {"stopped": True}
        else:
            raise RuntimeError(f"unknown op {op}")
        return {"ok": True, "ms": int((time.time() - started) * 1000), **reply}
    except Exception as err:
        return {"ok": False, "error": f"{type(err).__name__}: {err}"[:1000]}


def serve(port, token):
    """The HTTP broker for the server on Modal: 127.0.0.1 only, token required."""
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            if self.headers.get("authorization") != f"Bearer {token}":
                self.send_response(401)
                self.end_headers()
                return
            body = self.rfile.read(int(self.headers.get("content-length", "0")))
            out = json.dumps(handle(json.loads(body))).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(out)))
            self.end_headers()
            self.wfile.write(out)

        def log_message(self, *args):  # no request logs: they would hold nothing useful
            pass

    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()


def main():
    """stdio mode: one proof; its sandboxes are destroyed when input ends."""
    try:
        for line in sys.stdin:
            if line.strip():
                sys.stdout.write(json.dumps(handle(json.loads(line))) + "\n")
                sys.stdout.flush()
    finally:
        for s in list(_sessions.values()):
            s.stop()


if __name__ == "__main__":
    main()
