"""LLM dispatch: prompt assembly, provider routing, and chat history.

Resolves a chat's target LLM to either the OpenRouter HTTP API or the
standalone OpenScenes Agent, assembles the system prompt from the
model/character/persona/context, and records replies into the chat
history. Local llama-cpp inference lives in the agent now — this module
only speaks HTTP.
"""
import json
import os
import re

import requests

import config

DB = config.DB
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
OPENROUTER_TIMEOUT = 120

AGENT_COMPLETE_PATH = "/v1/complete"
# Cold-loading a large GGUF without mmap can take a minute or more on top
# of generation time, so the cap is set well above the usual 2-minute one.
AGENT_TIMEOUT = 300

_OPENROUTER_STATUS_HINTS = {
    400: "OpenRouter rejected the request as malformed — the model name may be wrong, or the prompt may exceed its context window.",
    401: "OpenRouter rejected the API key. Open the LLM in Manage → LLMs and paste a fresh key from openrouter.ai/keys.",
    402: "Your OpenRouter account is out of credits. Top it up at openrouter.ai/credits, then retry.",
    403: "OpenRouter refused this request — the model may not be available on your plan, blocked in your region, or flagged by content moderation.",
    404: "OpenRouter does not recognise this model identifier. Check the spelling against openrouter.ai/models (e.g. \"anthropic/claude-3.5-sonnet\").",
    408: "OpenRouter timed out before the model replied. Try again, or pick a faster model.",
    413: "The request is too large for this model — shorten the chat history or pick a model with a larger context window.",
    429: "OpenRouter is rate-limiting this key. Wait a few seconds and retry, or upgrade your plan.",
    500: "OpenRouter had an internal error. Retry in a moment.",
    502: "OpenRouter's upstream provider is unreachable. Retry, or pick a different model.",
    503: "OpenRouter (or the upstream provider) is temporarily unavailable. Retry in a moment.",
    504: "OpenRouter's upstream provider timed out. Retry, or pick a different model.",
}


def _scrub_secret(text, secret):
    """Remove an API key from a string so it never appears in surfaced errors."""
    if not text or not secret:
        return text
    return text.replace(secret, "***")


def _format_openrouter_error(status_code, body_text, api_key):
    """Build a friendly error string for a non-200 OpenRouter response.

    Extracts the API's ``error.message`` when present, maps the status code
    to a human hint, and scrubs the API key out of whatever we end up with.
    """
    api_message = ''
    try:
        body = json.loads(body_text) if body_text else {}
        err = body.get('error', {}) if isinstance(body, dict) else {}
        if isinstance(err, dict):
            api_message = err.get('message') or ''
        elif isinstance(err, str):
            api_message = err
    except (ValueError, TypeError):
        # Some gateways return plain text rather than JSON on errors.
        api_message = (body_text or '')[:300]

    hint = _OPENROUTER_STATUS_HINTS.get(status_code)
    if hint and api_message:
        message = f"{hint} (OpenRouter: {api_message.strip()})"
    elif hint:
        message = hint
    elif api_message:
        message = f"OpenRouter error ({status_code}): {api_message.strip()}"
    else:
        message = f"OpenRouter returned HTTP {status_code} with no detail."

    return _scrub_secret(message, api_key)


def call_openrouter(messages, api_key, model_name, max_tokens=1024, temperature=0.8, top_p=0.95):
    """Send a chat completion request to OpenRouter and return the reply text.

    The endpoint is OpenAI-compatible, so the ``messages`` payload matches the
    shape llama-cpp's ``create_chat_completion`` accepts. Errors are re-raised
    as ``ValueError`` so the Flask layer surfaces them as 400s rather than
    500s; status codes are mapped to actionable hints (bad key, wrong model,
    out of credits, rate-limited, …) and the API key is scrubbed from any
    text that bubbles up.
    """
    if not api_key:
        raise ValueError("OpenRouter API key missing for this LLM. Add it in Manage → LLMs.")
    if not model_name:
        raise ValueError("OpenRouter model name missing for this LLM. Set it in Manage → LLMs.")

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": model_name,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "top_p": top_p,
    }
    try:
        response = requests.post(OPENROUTER_URL, headers=headers, json=payload, timeout=OPENROUTER_TIMEOUT)
    except requests.Timeout:
        raise ValueError("OpenRouter did not respond within 2 minutes. The model may be overloaded — retry, or pick a faster one.")
    except requests.ConnectionError:
        raise ValueError("Could not reach OpenRouter. Check your internet connection and try again.")
    except requests.RequestException as e:
        raise ValueError(_scrub_secret(f"OpenRouter request failed: {e}", api_key))

    if response.status_code != 200:
        raise ValueError(_format_openrouter_error(response.status_code, response.text, api_key))

    # A 200 response can still hide an ``error`` object when the upstream
    # provider failed mid-stream — OpenRouter forwards that shape verbatim.
    try:
        data = response.json()
    except ValueError:
        raise ValueError("OpenRouter returned a response that was not valid JSON.")

    if isinstance(data, dict) and data.get('error'):
        err = data['error']
        api_message = err.get('message') if isinstance(err, dict) else str(err)
        code = err.get('code') if isinstance(err, dict) else None
        hint = _OPENROUTER_STATUS_HINTS.get(code) if isinstance(code, int) else None
        message = f"{hint} (OpenRouter: {api_message})" if hint and api_message else (api_message or "OpenRouter reported an error with no detail.")
        raise ValueError(_scrub_secret(message, api_key))

    try:
        return data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        raise ValueError("OpenRouter returned an unexpected response shape (no choices).")


_AGENT_STATUS_HINTS = {
    400: "The agent rejected the request — usually the LLM name is not registered there. Open the agent's llm/ folder and confirm the GGUF + llms.json entry exist.",
    401: "The agent rejected the API key. Update it in Settings → Agent.",
    404: "The agent does not expose this route. Make sure the agent is up to date.",
    500: "The agent crashed during generation. Check its terminal for the underlying llama-cpp error.",
    502: "Could not reach the agent's upstream — the agent process may be restarting.",
    503: "The agent is temporarily unavailable. Retry in a moment.",
    504: "The agent timed out before the model replied. Try again or pick a faster model.",
}


def _normalise_agent_url(address):
    """Return a fully-qualified URL for the agent's ``/v1/complete`` endpoint.

    Accepts bare ``host:port``, ``http://host:port``, or a value that already
    includes a path. Trailing slashes are stripped.
    """
    if not address:
        return None
    addr = address.strip().rstrip("/")
    if not addr:
        return None
    if "://" not in addr:
        addr = f"http://{addr}"
    if addr.endswith(AGENT_COMPLETE_PATH):
        return addr
    return f"{addr}{AGENT_COMPLETE_PATH}"


def call_agent(messages, address, api_key, name, max_tokens=1024, temperature=0.8, top_p=0.95):
    """Send a chat completion request to the standalone agent and return the reply.

    The agent's wire contract is a strict subset of OpenRouter's — name + messages
    in, ``{"content": ...}`` out — and errors come back as ``{"error": ...}`` at
    every status code. Errors are re-raised as ``ValueError`` so the Flask layer
    surfaces them as 400s. The agent API key, when present, is scrubbed from any
    text that bubbles up.
    """
    url = _normalise_agent_url(address)
    if not url:
        raise ValueError("No Agent address configured. Add it in Settings → Agent.")
    if not name:
        raise ValueError("Agent LLM name missing. Set it in Manage → LLMs.")

    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    payload = {
        "name": name,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "top_p": top_p,
    }
    try:
        response = requests.post(url, headers=headers, json=payload, timeout=AGENT_TIMEOUT)
    except requests.Timeout:
        raise ValueError("Agent did not respond within 5 minutes. The model may be too large for its host, or generation stalled.")
    except requests.ConnectionError:
        raise ValueError(f"OpenScenes Agent at {address} is not responding. Start it, or check the address in Settings → Agent.")
    except requests.RequestException as e:
        raise ValueError(_scrub_secret(f"Agent request failed: {e}", api_key))

    body_text = response.text or ""
    try:
        data = response.json() if body_text else {}
    except ValueError:
        data = {}

    if response.status_code != 200:
        api_message = data.get("error") if isinstance(data, dict) else ""
        hint = _AGENT_STATUS_HINTS.get(response.status_code)
        if hint and api_message:
            message = f"{hint} (agent: {api_message})"
        elif hint:
            message = hint
        elif api_message:
            message = f"Agent error ({response.status_code}): {api_message}"
        else:
            message = f"Agent returned HTTP {response.status_code} with no detail."
        raise ValueError(_scrub_secret(message, api_key))

    if not isinstance(data, dict) or "content" not in data:
        raise ValueError("Agent returned an unexpected response shape (no content).")

    return data["content"]


_PLACEHOLDER_RE = re.compile(r'\{(character|user)\}', re.IGNORECASE)


def substitute_placeholders(text, character_name, user_name):
    """Replace ``{character}`` and ``{user}`` (case-insensitive) in author text."""
    if not text:
        return text
    def repl(m):
        key = m.group(1).lower()
        if key == 'character':
            return character_name
        if key == 'user':
            return user_name
        return m.group(0)
    return _PLACEHOLDER_RE.sub(repl, text)


def _load_index(path):
    """Read an index file and return ``(items, next_id)``.

    Index files are stored as ``{"next_id": int, "items": [...]}``. Legacy
    list-only files are still accepted on read.
    """
    with open(path, "r", encoding="utf-8") as f:
        raw = json.loads(f.read())
    if isinstance(raw, list):
        return raw, (max((i["id"] for i in raw), default=-1) + 1)
    return raw.get("items", []), raw.get("next_id", 0)


def _save_index(path, items, next_id):
    """Write an index file in the canonical ``{next_id, items}`` shape."""
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"next_id": next_id, "items": items}, f, ensure_ascii=False, indent=4)


def get_llm_entry(llms_path, llm_id):
    """Return the LLM index entry for ``llm_id`` or raise ``ValueError``.

    ``llms_path`` is the per-user ``llms.json`` file; LLM registries live
    next to each user's chats now.
    """
    if llm_id is None:
        raise ValueError("No LLM selected for this chat.")
    if not os.path.isfile(llms_path):
        raise ValueError("LLMs index missing — restart the server to bootstrap it.")
    llms, _ = _load_index(llms_path)
    entry = next((l for l in llms if l["id"] == llm_id), None)
    if entry is None:
        raise ValueError(f"LLM {llm_id} not found.")
    return entry


class Style:
    """Chat style (name + rules markdown).

    A chat style is a pure rules wrapper — the LLM it dispatches against
    is owned by the chat session, not the style. Use the ``Llm`` helper
    alongside this one to load the chat's LLM.
    """

    def __init__(self):
        self.style_info = None
        self.style = None

    def setStyle(self, id):
        """Load the style entry and its rules markdown by id."""
        styles, _ = _load_index(f"{DB}/styles/styles.json")
        entry = next((s for s in styles if s["id"] == id), None)
        if entry is None:
            raise ValueError(f"Style {id} not found.")
        self.style_info = entry
        with open(f"{DB}/styles/{entry['path']}", "r", encoding="utf-8") as f:
            self.style = f.read()


class Llm:
    """Wrapper around a registered LLM entry (id, name, provider)."""

    def __init__(self):
        self.llm_info = None

    def setLlm(self, llms_path, id):
        """Load the LLM index entry for ``id`` from ``llms_path``."""
        self.llm_info = get_llm_entry(llms_path, id)


class Persona:
    """User-side persona (the role the user plays in the scene)."""

    def __init__(self):
        self.persona_info = None
        self.persona = None

    def setPersona(self, userID, personaID):
        """Load a persona's metadata and markdown content for the given user."""
        users, _ = _load_index(f"{DB}/users/users.json")
        user = next((u for u in users if u["id"] == userID), None)
        if user is None:
            raise ValueError(f"User {userID} not found.")

        user_path = user["path"].removeprefix("./")

        personas, _ = _load_index(f"{DB}/users/{user_path}personas/user_personas.json")
        persona = next((p for p in personas if p["id"] == personaID), None)
        if persona is None:
            raise ValueError(f"Persona {personaID} not found.")

        self.persona_info = persona
        with open(f"{DB}/users/{user_path}personas/{persona['path']}", "r", encoding="utf-8") as f:
            self.persona = f.read()


class Character:
    """Character preset (persona markdown, scene context, opening line)."""

    def __init__(self):
        self.character_info = None
        self.character = None
        self.context = None

    def setCharacter(self, id):
        """Load a character entry, its persona markdown, and its scene context."""
        characters, _ = _load_index(f"{DB}/characters/characters.json")
        entry = next((c for c in characters if c["id"] == id), None)
        if entry is None:
            raise ValueError(f"Character {id} not found.")

        char_path = entry["path"].removeprefix("./")
        char_dir = f"{DB}/characters/{char_path}"

        with open(f"{char_dir}character.json", "r", encoding="utf-8") as f:
            char_data = json.loads(f.read())

        # Merge index entry (has name) with character.json (has file refs).
        self.character_info = {**char_data, **entry}

        with open(f"{char_dir}{char_data['persona']}", "r", encoding="utf-8") as f:
            self.character = f.read()

        with open(f"{char_dir}{char_data['context']}", "r", encoding="utf-8") as f:
            self.context = f.read()


class Chats:
    """Per-user chat store backed by ``chats.json``."""

    def __init__(self):
        self.chats = None
        self.chats_path = None
        self.chats_next_id = 0

    def setChats(self, userID):
        """Locate and load the user's chats index into memory."""
        users, _ = _load_index(f"{DB}/users/users.json")
        user = next((u for u in users if u["id"] == userID), None)
        if user is None:
            raise ValueError(f"User {userID} not found.")

        user_path = user["path"].removeprefix("./")
        self.chats_path = f"{DB}/users/{user_path}chats.json"

        self.chats, self.chats_next_id = _load_index(self.chats_path)

    def getHistory(self, chatID):
        """Return the message history for ``chatID``, or ``None`` if missing.

        The file is re-read on each call so concurrent edits made through
        the API are reflected here.
        """
        self.chats, self.chats_next_id = _load_index(self.chats_path)
        for chat in self.chats:
            if chat["id"] == chatID:
                return chat["history"]
        return None

    def flattenHistory(self, history):
        """Collapse multi-variant assistant messages to plain ``{role, content}``."""
        flat = []
        for message in history:
            if isinstance(message["content"], list):
                flat.append({
                    "role": message["role"],
                    "content": message["content"][message["selected_index"]]
                })
            else:
                flat.append({"role": message["role"], "content": message["content"]})
        return flat

    def saveHistory(self, chatID, history):
        """Persist ``history`` for ``chatID`` back to disk."""
        for chat in self.chats:
            if chat["id"] == chatID:
                chat["history"] = history
                break
        _save_index(self.chats_path, self.chats, self.chats_next_id)

    def getMessageId(self, history):
        """Return the next message id (monotonic per chat)."""
        return (history[-1]["id"] + 1) if history else 0


def buildSettings(style, persona, character):
    """Assemble the system prompt from style rules, persona, character, context."""
    char_name = character.character_info["name"]
    user_name = persona.persona_info["name"]

    rules = substitute_placeholders(style.style, char_name, user_name)
    character_info = substitute_placeholders(character.character, char_name, user_name)
    persona_info = substitute_placeholders(persona.persona, char_name, user_name)
    context = substitute_placeholders(character.context, char_name, user_name)

    return f"""{rules}

Here is more information about {char_name}:
{character_info}

Here is who you are talking to ({user_name}):
{persona_info}

Here is the context of the scene:
{context}
"""


def _complete(llm_info, messages, user_settings=None):
    """Dispatch a chat-completion request to the right provider and return text.

    ``user_settings`` carries the BYOK credentials for external providers and
    the agent endpoint. When present, its values take precedence over the
    legacy fields stored on the LLM entry; the fallback exists only until the
    schema migration in task #6 strips those legacy fields entirely.
    """
    user_settings = user_settings or {}
    provider = llm_info.get("provider")
    if provider == "openrouter":
        openrouter_cfg = user_settings.get("openrouter") or {}
        api_key = openrouter_cfg.get("api_key") or llm_info.get("api_key")
        # After the v2 migration the entry's ``name`` is the OpenRouter model
        # identifier — the legacy ``model`` field is only consulted as a
        # fallback for entries that pre-date the migration.
        model_name = llm_info.get("name") or llm_info.get("model")
        return call_openrouter(
            messages=messages,
            api_key=api_key,
            model_name=model_name,
        )
    if provider == "agent":
        agent_cfg = user_settings.get("agent") or {}
        address = agent_cfg.get("address") or llm_info.get("address")
        # An explicitly empty user setting clears the key; only fall back to
        # the LLM-entry value when the user has never touched the field.
        api_key = agent_cfg["api_key"] if "api_key" in agent_cfg else llm_info.get("api_key")
        return call_agent(
            messages=messages,
            address=address,
            api_key=api_key,
            name=llm_info.get("name"),
        )
    raise ValueError(f"Unknown LLM provider: {provider}")


def send(message, settings, llm, chats, chatID, new_attempt=False, continue_mode=False, user_settings=None):
    """Run one completion and append the result to the chat history.

    ``new_attempt`` regenerates the last assistant reply as an extra variant.
    ``continue_mode`` extends the last reply with an empty user turn instead
    of submitting ``message``. ``user_settings`` carries per-user BYOK
    credentials and is forwarded to ``_complete``.
    """
    raw_history = chats.getHistory(chatID)
    if raw_history is None:
        raise ValueError(f"Chat {chatID} not found.")
    if new_attempt and not raw_history:
        raise ValueError("Cannot retry an empty chat.")

    if new_attempt:
        messages = [{"role": "system", "content": settings}] + chats.flattenHistory(raw_history)[:-1]
    elif continue_mode:
        messages = [{"role": "system", "content": settings}] + chats.flattenHistory(raw_history) + [{"role": "user", "content": ""}]
    else:
        messages = [{"role": "system", "content": settings}] + chats.flattenHistory(raw_history) + [{"role": "user", "content": message}]

    reply = _complete(llm.llm_info, messages, user_settings=user_settings)

    if new_attempt:
        raw_history[-1]["content"].append(reply)
    elif continue_mode:
        raw_history.append({"id": chats.getMessageId(raw_history), "role": "assistant", "selected_index": 0, "content": [reply]})
    else:
        raw_history.append({"id": chats.getMessageId(raw_history), "role": "user", "content": message})
        raw_history.append({"id": chats.getMessageId(raw_history), "role": "assistant", "selected_index": 0, "content": [reply]})

    chats.saveHistory(chatID, raw_history)

    return reply
