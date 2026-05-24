"""One-shot installer: Python venv for the backend, then the client build.

Creates ``core/env``, installs the backend requirements, then runs
``npm install`` and ``npm run build`` in ``client/``. Inference now lives
in the standalone agent (sibling ``agent/`` directory); its install steps
are documented in ``agent/README.md`` and are not handled here.
"""
import os
import platform
import shutil
import subprocess
import sys


SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CORE_DIR   = os.path.join(SCRIPT_DIR, "core")
CLIENT_DIR = os.path.join(SCRIPT_DIR, "client")
VENV_DIR   = os.path.join(CORE_DIR, "env")

if platform.system() == "Windows":
    VENV_PYTHON = os.path.join(VENV_DIR, "Scripts", "python.exe")
    VENV_PIP    = os.path.join(VENV_DIR, "Scripts", "pip.exe")
else:
    VENV_PYTHON = os.path.join(VENV_DIR, "bin", "python")
    VENV_PIP    = os.path.join(VENV_DIR, "bin", "pip")


def run(cmd, cwd=None, shell=False):
    """Run ``cmd`` and exit with the same code on failure."""
    display = cmd if isinstance(cmd, str) else ' '.join(str(c) for c in cmd)
    print(f"  > {display}")
    result = subprocess.run(cmd, cwd=cwd, shell=shell)
    if result.returncode != 0:
        print(f"Error: command failed.")
        sys.exit(1)


def find_python(preferred=("3.12", "3.11", "3.10")):
    """Return a Python interpreter path matching one of the preferred versions.

    Tries the Windows ``py`` launcher and then plain ``pythonX.Y`` commands.
    Falls back to the current interpreter if nothing else is found.
    """
    for version in preferred:
        if platform.system() == "Windows" and shutil.which("py"):
            result = subprocess.run(
                ["py", f"-{version}", "-c", "import sys; print(sys.executable)"],
                capture_output=True, text=True
            )
            if result.returncode == 0 and result.stdout.strip():
                return result.stdout.strip()
        candidate = shutil.which(f"python{version}")
        if candidate:
            return candidate
    return sys.executable


def check_prerequisites():
    """Abort if Python, Node, or npm are missing or too old."""
    errors = []

    if sys.version_info < (3, 10):
        errors.append(f"Python 3.10+ required (found {platform.python_version()})")

    if shutil.which("node") is None:
        errors.append("Node.js is not installed or not in PATH")

    if shutil.which("npm") is None:
        errors.append("npm is not installed or not in PATH")

    if errors:
        print("Missing prerequisites:")
        for error in errors:
            print(f"  - {error}")
        sys.exit(1)


def main():
    """Drive the full setup sequence."""
    print("Checking prerequisites...")
    check_prerequisites()
    print("  OK\n")

    print("Selecting Python interpreter...")
    venv_python_src = VENV_PYTHON if os.path.exists(VENV_DIR) else find_python()
    if os.path.exists(VENV_DIR):
        print(f"  Reusing existing venv at {VENV_DIR}")
    result = subprocess.run(
        [venv_python_src, "-c", "import sys; print(sys.version_info.major, sys.version_info.minor)"],
        capture_output=True, text=True
    )
    venv_major, venv_minor = map(int, result.stdout.split())
    print(f"  Python {venv_major}.{venv_minor} ({venv_python_src})")

    print("\nCreating virtualenv...")
    if not os.path.exists(VENV_DIR):
        run([venv_python_src, "-m", "venv", VENV_DIR])
    else:
        print("  Already exists, skipping.")

    print("\nUpgrading pip...")
    run([VENV_PYTHON, "-m", "pip", "install", "--upgrade", "pip"])

    print("\nInstalling Python dependencies...")
    run([VENV_PIP, "install", "-r", os.path.join(CORE_DIR, "requirements.txt")])

    print("\nInstalling Node dependencies...")
    run("npm install", cwd=CLIENT_DIR, shell=True)

    print("\nBuilding client...")
    run("npm run build", cwd=CLIENT_DIR, shell=True)

    print("\nSetup complete. Run python start.py to launch OpenScenes.")
    print("To run a local LLM, also set up the standalone agent — see ../agent/README.md.")


if __name__ == "__main__":
    main()
