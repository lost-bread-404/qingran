"""Qingran self-host hearing: Qwen2.5-Omni-7B on Modal, OpenAI-compatible.

Why this model and Modal — see deploy/README.md.

Deploy:
  pip install modal
  modal setup
  modal deploy deploy/modal_hearing.py

The public URL looks like https://<workspace>--qingran-hearing-serve.modal.run
Set in Vercel:
  SELFHOST_BASE_URL=https://<that-host>/v1
  SELFHOST_API_KEY=<same as API_KEY below>
  SELFHOST_MODEL=qwen2.5-omni-7b
"""

import os
import subprocess

import modal

MODEL_ID = os.environ.get("QINGRAN_HEARING_MODEL", "Qwen/Qwen2.5-Omni-7B")
SERVED_NAME = os.environ.get("QINGRAN_HEARING_SERVED_NAME", "qwen2.5-omni-7b")
API_KEY = os.environ.get("QINGRAN_HEARING_API_KEY", "qingran")
GPU = os.environ.get("QINGRAN_HEARING_GPU", "L40S")
PORT = 8000
MINUTES = 60

hf_cache = modal.Volume.from_name("qingran-hearing-hf", create_if_missing=True)
vllm_cache = modal.Volume.from_name("qingran-hearing-vllm", create_if_missing=True)

image = (
    modal.Image.from_registry("nvidia/cuda:12.8.0-devel-ubuntu22.04", add_python="3.12")
    .entrypoint([])
    .uv_pip_install("vllm==0.10.2", "qwen-omni-utils")
    .env(
        {
            "HF_HUB_ENABLE_HF_TRANSFER": "1",
            "VLLM_WORKER_MULTIPROC_METHOD": "spawn",
        }
    )
)

app = modal.App("qingran-hearing")


@app.cls(
    image=image,
    gpu=GPU,
    timeout=20 * MINUTES,
    scaledown_window=90,
    min_containers=0,
    volumes={
        "/root/.cache/huggingface": hf_cache,
        "/root/.cache/vllm": vllm_cache,
    },
    secrets=[modal.Secret.from_name("huggingface-secret")]
    if os.environ.get("MODAL_HF_SECRET")
    else [],
)
class HearingEngine:
    @modal.enter()
    def start(self):
        cmd = [
            "vllm",
            "serve",
            MODEL_ID,
            "--served-model-name",
            SERVED_NAME,
            "--host",
            "0.0.0.0",
            "--port",
            str(PORT),
            "--dtype",
            "bfloat16",
            "--max-model-len",
            "8192",
            "--enforce-eager",
            "--trust-remote-code",
            "--limit-mm-per-prompt",
            "audio=1",
        ]
        env = os.environ.copy()
        env["VLLM_API_KEY"] = API_KEY
        self.proc = subprocess.Popen(cmd, env=env)
        self._wait_ready()

    def _wait_ready(self):
        import time
        import urllib.request

        deadline = time.time() + 15 * MINUTES
        while time.time() < deadline:
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{PORT}/v1/models", timeout=2)
                return
            except Exception:
                if self.proc.poll() is not None:
                    raise RuntimeError("vLLM exited before becoming ready")
                time.sleep(2)
        raise TimeoutError("vLLM did not become ready")

    @modal.exit()
    def stop(self):
        if getattr(self, "proc", None):
            self.proc.terminate()

    @modal.asgi_app()
    def serve(self):
        import fastapi
        from fastapi.responses import JSONResponse
        import httpx

        api = fastapi.FastAPI()
        client = httpx.AsyncClient(base_url=f"http://127.0.0.1:{PORT}", timeout=120.0)

        @api.get("/health")
        async def health():
            return {"ok": True, "model": SERVED_NAME}

        @api.post("/warmup")
        async def warmup():
            res = await client.get("/v1/models")
            return JSONResponse(res.json(), status_code=res.status_code)

        @api.api_route("/{path:path}", methods=["GET", "POST", "OPTIONS"])
        async def proxy(path: str, request: fastapi.Request):
            headers = dict(request.headers)
            headers.pop("host", None)
            body = await request.body()
            res = await client.request(
                request.method,
                f"/{path}",
                content=body,
                headers=headers,
                params=dict(request.query_params),
            )
            return JSONResponse(res.json(), status_code=res.status_code)

        return api
