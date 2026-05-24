"""Loads runtime configuration from ../config.ini.

Plain key=value lines, no sections. Paths are resolved relative to
the directory holding config.ini, so the process working directory
does not matter.
"""
from pathlib import Path

CONFIG_PATH = Path(__file__).resolve().parent.parent / "config.ini"


def _load(path):
    """Parse a key=value file and return its contents as a dict."""
    cfg = {}
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            k, _, v = line.partition("=")
            cfg[k.strip()] = v.strip()
    return cfg


_CFG = _load(CONFIG_PATH)
_ROOT = CONFIG_PATH.parent

DB = str((_ROOT / _CFG["DATABASE"]).resolve())
CORE_ADDRESS = _CFG["CORE_ADDRESS"]
CORE_PORT = int(_CFG["CORE_PORT"])
CORE_ORIGIN = f"http://{CORE_ADDRESS}:{CORE_PORT}"
CLIENT_ADDRESS = _CFG["CLIENT_ADDRESS"]
CLIENT_PORT = int(_CFG["CLIENT_PORT"])
CLIENT_ORIGIN = f"http://{CLIENT_ADDRESS}:{CLIENT_PORT}"
