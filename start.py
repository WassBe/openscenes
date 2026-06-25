"""Launcher: starts the Flask backend, which also serves the built client.

Reads ``config.ini`` for the address and port, then spawns ``main.py`` in
``core/``. The built React client in ``client/dist/`` is served by Flask on
the same origin — no separate Node process is needed at runtime. Requires
``setup.py`` to have been run first.
"""
import configparser
import os
import platform
import subprocess
import sys


SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CORE_DIR   = os.path.join(SCRIPT_DIR, "core")
CLIENT_DIR = os.path.join(SCRIPT_DIR, "client")
VENV_DIR   = os.path.join(CORE_DIR, "env")
CONFIG     = os.path.join(SCRIPT_DIR, "config.ini")
DIST_DIR   = os.path.join(CLIENT_DIR, "dist")  # Built by setup.py; served by Flask at runtime.

if platform.system() == "Windows":
    VENV_PYTHON = os.path.join(VENV_DIR, "Scripts", "python.exe")
else:
    VENV_PYTHON = os.path.join(VENV_DIR, "bin", "python")


def read_config():
    """Return the ``DEFAULT`` section of ``config.ini`` as a mapping."""
    cfg = configparser.ConfigParser()
    with open(CONFIG, 'r') as f:
        cfg.read_string('[DEFAULT]\n' + f.read())
    return cfg["DEFAULT"]


def check_ready():
    """Abort if the virtualenv or the built client is missing."""
    errors = []

    if not os.path.exists(VENV_PYTHON):
        errors.append("Virtualenv not found — run python setup.py first")

    if not os.path.exists(DIST_DIR):
        errors.append("Client not built — run python setup.py first")

    if errors:
        for error in errors:
            print(f"  - {error}")
        sys.exit(1)


def main():
    """Start the Flask backend and wait until interrupted."""
    check_ready()

    cfg    = read_config()
    c_addr = cfg.get("CORE_ADDRESS", "localhost")
    c_port = cfg.get("CORE_PORT",    "8080")

    print(f"Open    : http://{c_addr}:{c_port}")
    print("Press Ctrl+C to stop.\n")

    server = subprocess.Popen([VENV_PYTHON, "main.py"], cwd=CORE_DIR)

    try:
        server.wait()
    except KeyboardInterrupt:
        print("\nShutting down...")
    finally:
        server.terminate()
        server.wait()


if __name__ == "__main__":
    main()
