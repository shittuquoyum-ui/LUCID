"""
The Lucid server on Modal: one small, always-on container running the
bundled Node server (dist/server.mjs).

Before the first deploy:
  1. npm run build:server        builds dist/server.mjs
  2. In the Modal dashboard, a secret named "lucid-keys" with
     MODEL_API_KEY and BASETEN_API_KEY (optional: LUCID_DAILY_CAP,
     LUCID_ENABLED=false to pause the server).

Deploy (or: npm run deploy, which builds first):
  modal deploy deploy/modal_app.py
"""

import subprocess
from pathlib import Path

import modal

ROOT = Path(__file__).resolve().parent.parent
PORT = 8000

image = (
    modal.Image.from_registry("node:22-slim", add_python="3.12")
    # The prover's broker (deploy/prove_sandbox.py) talks to its sandboxes over
    # TLS; node:22-slim has no CA certificates, so without these it retries
    # forever (certificate verify failed).
    .apt_install("ca-certificates")
    .env({
        "PORT": str(PORT),
        "HOST": "0.0.0.0",
        "NODE_ENV": "production",
        "LUCID_PYTHON": "python",
        "LUCID_SANDBOX_BROKER": "/app/deploy/prove_sandbox.py",
    })
    # Only these files go to Modal: the bundled server, the prompts and the
    # sandbox broker. Nothing else from the repository, and never .env.
    .add_local_file(str(ROOT / "dist" / "server.mjs"), "/app/dist/server.mjs")
    .add_local_dir(str(ROOT / "src" / "prompts"), "/app/prompts")
    .add_local_file(str(ROOT / "deploy" / "prove_sandbox.py"), "/app/deploy/prove_sandbox.py")
)

app = modal.App("lucid", image=image)


@app.function(
    secrets=[modal.Secret.from_name("lucid-keys")],
    # Exactly one container: the daily limits live in its memory, so a second
    # copy would double them. One always-on container also means no cold starts.
    min_containers=1,
    max_containers=1,
    # A lesson mostly waits on the model APIs, so one small container runs
    # many at once (tested: 10 in parallel). 0.25 core and 512 MiB leave room
    # for ten 2 MB requests; billed per second whether busy or idle.
    cpu=0.25,
    memory=512,
    timeout=600,
)
# Up to 50 requests at the same time in the one container.
@modal.concurrent(max_inputs=50)
@modal.web_server(PORT, startup_timeout=30)
def server():
    _start_broker_and(["node", "/app/dist/server.mjs"])


BROKER_PORT = 8001


def _start_broker_and(command, extra_env=None):
    """
    The prover's sandbox broker runs in a thread of this function's own
    process, where the Modal client is known to work (tested with
    check_sandbox). Started as a child process here it hung without a word;
    that was before the image had CA certificates, so the cause is not
    certain. Node reaches it on 127.0.0.1 with a token made fresh for this
    container.
    """
    import os
    import secrets
    import sys
    import threading

    sys.path.insert(0, "/app/deploy")
    import prove_sandbox

    token = secrets.token_hex(24)
    threading.Thread(target=prove_sandbox.serve, args=(BROKER_PORT, token), daemon=True).start()
    env = {**os.environ, "LUCID_SANDBOX_URL": f"http://127.0.0.1:{BROKER_PORT}", "LUCID_SANDBOX_TOKEN": token, **(extra_env or {})}
    return subprocess.Popen(command, env=env)


@app.function(
    image=image.add_local_file(str(ROOT / "dist" / "prove-fixtures.mjs"), "/app/dist/prove-fixtures.mjs").add_local_dir(
        str(ROOT / "test" / "fixtures" / "prover-app"), "/app/fixtures/prover-app"
    ),
    secrets=[modal.Secret.from_name("lucid-keys")],
    timeout=600,
)
def prove_fixtures(letters: str = ""):
    """
    modal run deploy/modal_app.py::prove_fixtures [--letters "a c"]
    The prover's integration test, run on Modal the way the server runs a
    proof: same image, the broker in this process, sandboxes in us-east.
    """
    p = _start_broker_and(
        ["node", "/app/dist/prove-fixtures.mjs", *letters.split()],
        {"LUCID_PROVER_FIXTURES": "/app/fixtures/prover-app"},
    )
    p.wait()


@app.function(
    image=image.add_local_file(str(ROOT / "dist" / "eval.mjs"), "/app/dist/eval.mjs").add_local_dir(
        str(ROOT / "test" / "fixtures"), "/app/fixtures"
    ),
    secrets=[modal.Secret.from_name("lucid-keys")],
    cpu=1.0,
    timeout=1800,
)
def run_eval(arguments: str = "") -> str:
    """
    npm run eval:modal [-- --only a,b]
    The red-team evaluation, run on Modal the way the server runs a proof.
    Returns the report and the results; the npm script saves them to samples/eval.
    """
    import json

    out = "/tmp/lucid-eval"
    p = _start_broker_and(
        ["node", "/app/dist/eval.mjs", "--out", out, "--where", "On Modal, in the server's image", *arguments.split()],
        {"LUCID_PROVER_FIXTURES": "/app/fixtures/prover-app", "LUCID_EVAL_FIXTURES": "/app/fixtures"},
    )
    p.wait()
    return json.dumps({name: Path(out, name).read_text(encoding="utf-8") for name in ("eval-report.md", "eval-results.json")})


@app.function(timeout=300)
def check_sandbox():
    """
    modal run deploy/modal_app.py::check_sandbox
    Starts the broker the way the server does, inside this image, and runs
    one query in a fresh sandbox through it: proves the server can make them.
    """
    import json
    import sys
    import threading
    import time
    import urllib.request

    sys.path.insert(0, "/app/deploy")
    import prove_sandbox

    token = "check"
    threading.Thread(target=prove_sandbox.serve, args=(BROKER_PORT, token), daemon=True).start()
    time.sleep(0.5)

    def ask(msg):
        request = urllib.request.Request(
            f"http://127.0.0.1:{BROKER_PORT}/",
            data=json.dumps(msg).encode(),
            headers={"authorization": f"Bearer {token}", "content-type": "application/json"},
        )
        return json.loads(urllib.request.urlopen(request, timeout=120).read())

    started = time.time()
    session = ask({"op": "start"})
    print("start:", session, flush=True)
    print("psql:", ask({"op": "psql", "session": session.get("session"), "db": "postgres", "user": "postgres", "sql": "select 'sandbox ok';"}))
    print("stop:", ask({"op": "stop", "session": session.get("session")}))
    print(f"took {time.time() - started:.1f}s")
