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
    .env({"PORT": str(PORT), "HOST": "0.0.0.0", "NODE_ENV": "production"})
    # Only these files go to Modal: the bundled server and the prompts.
    # Nothing else from the repository, and never .env.
    .add_local_file(str(ROOT / "dist" / "server.mjs"), "/app/dist/server.mjs")
    .add_local_dir(str(ROOT / "src" / "prompts"), "/app/prompts")
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
    subprocess.Popen(["node", "/app/dist/server.mjs"])
