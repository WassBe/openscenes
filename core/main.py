"""Flask HTTP API for OpenScenes.

Exposes ``/api`` endpoints for chats, users, personas, characters, model
presets, and raw GGUF files. Storage is filesystem-backed under
``config.DB`` and every collection uses an ``{next_id, items}`` index file.
"""
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
import json, os, re, shutil, random, string, traceback
from datetime import datetime, timezone
import config
from girlfriend import Style, Llm, Persona, Character, Chats, buildSettings, send, substitute_placeholders


def now_iso():
    """Return the current UTC time as an ISO-8601 ``...Z`` string."""
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


ALLOWED_PIC_EXT = {'.png', '.jpg', '.jpeg', '.gif', '.webp'}
AUTHORIZED_ORIGINS = [config.CLIENT_ORIGIN, config.CORE_ORIGIN]


def save_picture(file_storage, target_dir, old_filename=None):
    """Save an uploaded picture as ``picture.<ext>`` in ``target_dir``.

    Deletes the previous file when its extension differs, and returns
    the new filename.
    """
    if not file_storage or not file_storage.filename:
        raise ValueError('No file provided')
    ext = os.path.splitext(file_storage.filename)[1].lower()
    if ext not in ALLOWED_PIC_EXT:
        raise ValueError(f'Unsupported file type: {ext}')
    new_name = f'picture{ext}'
    os.makedirs(target_dir, exist_ok=True)
    file_storage.save(os.path.join(target_dir, new_name))
    if old_filename and old_filename != new_name:
        old_path = os.path.join(target_dir, old_filename)
        if os.path.isfile(old_path):
            os.remove(old_path)
    return new_name


app = Flask(__name__)
app.json.sort_keys = False
app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024  # 50 MB cap — only pictures are uploaded now.
CORS(app, origins=AUTHORIZED_ORIGINS)

DB = config.DB


def ensure_db():
    """Create the top-level index files on first run, then run migrations.

    Bootstraps the canonical ``{next_id, items}`` index files so the API
    works on a fresh checkout and runs the legacy schema migrations.
    """
    bootstrap = [
        ('users',      'users.json'),
        ('characters', 'characters.json'),
        ('styles',     'styles.json'),
    ]
    for folder, filename in bootstrap:
        target_dir = f"{DB}/{folder}"
        target = f"{target_dir}/{filename}"
        os.makedirs(target_dir, exist_ok=True)
        if not os.path.isfile(target):
            write_index(target, [], 0)
    _migrate_models_to_styles()
    _migrate_llms_per_user()
    _migrate_models_to_llm_id()
    _migrate_chat_owns_llm()


def _migrate_models_to_llm_id():
    """Rewrite legacy model entries (``llm``: filename) to use ``llm_id``.

    Legacy state — predates per-user LLMs. Now a near-no-op kept only so
    very old installs can still upgrade through current code.
    """
    # The directory was renamed to ``database/styles/`` in a later migration —
    # this legacy migration runs FIRST when files are still at the old path
    # (and is also tolerant of the post-rename layout).
    styles_path = f"{DB}/styles/styles.json"
    legacy_path = f"{DB}/models/models.json"
    path = styles_path if os.path.isfile(styles_path) else legacy_path
    if not os.path.isfile(path):
        return
    items, items_next = read_index(path)
    if not items:
        return
    changed = False
    for m in items:
        if 'llm_id' in m:
            if 'llm' in m:
                m.pop('llm', None)
                changed = True
            continue
        m.pop('llm', None)
        m['llm_id'] = None
        changed = True
    if changed:
        write_index(path, items, items_next)


def _migrate_models_to_styles():
    """Rename legacy ``database/models/`` to ``database/styles/`` and rewrite
    chat references (``model_id`` → ``style_id``).

    "Model preset" used to clash with "LLM model" — they're called "Chat
    styles" now. Migration steps (idempotent):

    1. Move ``database/models/`` → ``database/styles/`` if the new dir
       doesn't already exist.
    2. Rename ``models.json`` inside it to ``styles.json``.
    3. For each chat across every user, copy ``model_id`` → ``style_id``
       (only when ``style_id`` is missing).
    """
    legacy_dir = f"{DB}/models"
    new_dir = f"{DB}/styles"
    if os.path.isdir(legacy_dir) and not os.path.isdir(new_dir):
        os.rename(legacy_dir, new_dir)

    legacy_index = f"{new_dir}/models.json"
    new_index = f"{new_dir}/styles.json"
    if os.path.isfile(legacy_index) and not os.path.isfile(new_index):
        os.rename(legacy_index, new_index)

    users_path = f"{DB}/users/users.json"
    if not os.path.isfile(users_path):
        return
    users, _ = read_index(users_path)
    for u in users:
        chats_path = f"{DB}/users/{norm_path(u['path'])}chats.json"
        if not os.path.isfile(chats_path):
            continue
        chats, chats_next = read_index(chats_path)
        changed = False
        for c in chats:
            if 'style_id' in c:
                continue
            c['style_id'] = c.pop('model_id', None)
            changed = True
        if changed:
            write_index(chats_path, chats, chats_next)


def _migrate_llms_per_user():
    """Move ``database/llms.json`` to per-user ``llms.json`` files.

    LLM entries used to be a single global registry. With per-user
    Connections (BYOK), each user gets their own list. Migration:

    * For every user whose ``llms.json`` does not exist, seed it from the
      legacy global file (or write an empty index when no global exists).
    * Delete the legacy global file once all users are seeded.

    Idempotent — safe to run on every startup.
    """
    users_path = f"{DB}/users/users.json"
    if not os.path.isfile(users_path):
        return
    users, _ = read_index(users_path)

    legacy_items = []
    legacy_next = 0
    if os.path.isfile(GLOBAL_LLMS_INDEX):
        legacy_items, legacy_next = read_index(GLOBAL_LLMS_INDEX)

    for u in users:
        path = _user_llms_index(u)
        if os.path.isfile(path):
            continue
        os.makedirs(os.path.dirname(path), exist_ok=True)
        write_index(path, list(legacy_items), legacy_next)

    if os.path.isfile(GLOBAL_LLMS_INDEX):
        try:
            os.remove(GLOBAL_LLMS_INDEX)
        except OSError:
            pass


def _migrate_chat_owns_llm():
    """Move LLM ownership from the model preset to the chat session.

    Steps (idempotent, safe to run on every startup):

    1. For each chat across every user, copy the *current* ``model.llm_id``
       value (looked up through ``chat.model_id``) onto the chat itself as
       ``chat.llm_id``. Chats already migrated are skipped.
    2. Drop ``llm_id`` from every model preset — the preset is a pure rules
       wrapper now.
    3. Strip credentials and resolver-side fields from every LLM entry. The
       entry collapses to ``{id, name, provider}`` plus, for OpenRouter
       entries, ``name`` is promoted from the old ``model`` value so it can
       still resolve against OpenRouter's catalogue.
    """
    # _migrate_models_to_styles has already renamed models -> styles by now.
    styles_path = f"{DB}/styles/styles.json"
    if not os.path.isfile(styles_path):
        return
    styles, styles_next = read_index(styles_path)
    styles_by_id = {s['id']: s for s in styles}

    # Step 1: chats get an ``llm_id`` of their own.
    users_path = f"{DB}/users/users.json"
    if os.path.isfile(users_path):
        users, _ = read_index(users_path)
        for u in users:
            chats_path = f"{DB}/users/{norm_path(u['path'])}chats.json"
            if not os.path.isfile(chats_path):
                continue
            chats, chats_next = read_index(chats_path)
            changed = False
            for c in chats:
                if 'llm_id' in c:
                    continue
                s_id = c.get('style_id', c.get('model_id'))
                inherited = styles_by_id.get(s_id, {}).get('llm_id') if s_id is not None else None
                c['llm_id'] = inherited
                changed = True
            if changed:
                write_index(chats_path, chats, chats_next)

    # Step 2: chat-style entries drop their ``llm_id`` entirely.
    if any('llm_id' in s for s in styles):
        for s in styles:
            s.pop('llm_id', None)
        write_index(styles_path, styles, styles_next)

    # Step 3: LLM entries collapse to ``{id, name, provider}`` — iterates
    # over each user's per-user llms.json (seeded by _migrate_llms_per_user).
    if not os.path.isfile(users_path):
        return
    users, _ = read_index(users_path)
    for u in users:
        path = _user_llms_index(u)
        if not os.path.isfile(path):
            continue
        llms, llms_next = read_index(path)
        changed = False
        for entry in llms:
            provider = entry.get('provider', 'local')
            if provider == 'openrouter':
                legacy_model = entry.pop('model', None)
                if legacy_model and entry.get('name') != legacy_model:
                    entry['name'] = legacy_model
                    changed = True
                if 'api_key' in entry:
                    entry.pop('api_key', None)
                    changed = True
            elif provider == 'agent':
                for legacy in ('address', 'api_key'):
                    if legacy in entry:
                        entry.pop(legacy, None)
                        changed = True
            elif provider == 'local':
                if 'filename' in entry:
                    entry.pop('filename', None)
                    changed = True
        if changed:
            write_index(path, llms, llms_next)


@app.before_request
def _check_origin():
    """Reject cross-origin requests whose Origin header is not whitelisted.

    Browsers send Origin on cross-site fetches, so blocking unknown values
    prevents malicious pages from driving the API through the user's browser.
    Same-origin and tool requests (no Origin) are allowed through.
    """
    origin = request.headers.get('Origin')
    if origin and origin not in AUTHORIZED_ORIGINS:
        return jsonify({'error': 'Forbidden'}), 403


def _on_rm_error(func, path, exc_info):
    """``shutil.rmtree`` error callback that clears the read-only bit and retries.

    Windows trips on read-only or locked files; one retry handles the common case.
    """
    try:
        os.chmod(path, 0o700)
        func(path)
    except Exception:
        pass


@app.errorhandler(404)
def _err_404(_):
    """Return a JSON 404 (the client expects JSON everywhere under /api)."""
    return jsonify({'error': 'Not found'}), 404


@app.errorhandler(405)
def _err_405(_):
    """Return a JSON 405."""
    return jsonify({'error': 'Method not allowed'}), 405


@app.errorhandler(Exception)
def _err_500(e):
    """Catch-all error handler that maps HTTP exceptions and logs the rest."""
    from werkzeug.exceptions import HTTPException
    if isinstance(e, HTTPException):
        return jsonify({'error': e.description}), e.code
    traceback.print_exc()
    return jsonify({'error': str(e) or 'Internal server error'}), 500


def _required(data, *keys):
    """Validate that ``data`` is a dict and contains every key in ``keys``.

    Returns ``(None, None)`` when valid or ``(missing_key, (json, 400))``
    so the caller can surface a 400 instead of a 500.
    """
    if not isinstance(data, dict):
        return 'body', (jsonify({'error': 'JSON body required'}), 400)
    for k in keys:
        if k not in data or data[k] is None:
            return k, (jsonify({'error': f'{k} required'}), 400)
    return None, None


def read_json(path):
    """Read and parse a UTF-8 JSON file."""
    with open(path, "r", encoding="utf-8") as f:
        return json.loads(f.read())


def write_json(path, data):
    """Write ``data`` as pretty-printed UTF-8 JSON."""
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=4)


def write_text(path, text):
    """Write ``text`` to ``path`` as UTF-8."""
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def random_dir(length=10):
    """Return a random lowercase-alphanumeric directory name."""
    return ''.join(random.choices(string.ascii_lowercase + string.digits, k=length))


def read_index(path):
    """Read an index file and return ``(items, next_id)``.

    Index files are shaped ``{"next_id": int, "items": [...]}``. Legacy
    list-only files are accepted and upgraded on the next write. Missing
    files are created empty so a fresh clone works without a seed step.
    """
    if not os.path.isfile(path):
        write_index(path, [], 0)
        return [], 0
    raw = read_json(path)
    if isinstance(raw, list):
        next_id = (max((i['id'] for i in raw), default=-1) + 1)
        return raw, next_id
    return raw.get('items', []), raw.get('next_id', 0)


def write_index(path, items, next_id):
    """Write an index file in the canonical ``{next_id, items}`` shape."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    write_json(path, {'next_id': next_id, 'items': items})


def find_by_id(items, id):
    """Return the first item with matching ``id`` or ``None``."""
    return next((i for i in items if i["id"] == id), None)


def norm_path(p):
    """Strip the leading ``./`` from a stored relative path."""
    return p.removeprefix("./")


def safe_slug(name, max_len=60):
    """Derive a filesystem-safe slug from a user-supplied name.

    Drops anything that is not alphanumeric, underscore, or hyphen.
    """
    slug = re.sub(r'[^a-z0-9_-]', '', name.lower().replace(' ', '_'))
    return (slug or 'item')[:max_len]


def get_user(user_id):
    """Return the user index entry for ``user_id`` or ``None``."""
    users, _ = read_index(f"{DB}/users/users.json")
    return find_by_id(users, user_id)


# ── Per-user settings ───────────────────────────────────────────────────────

USER_SETTINGS_DEFAULTS = {
    'openrouter': {'api_key': ''},
    'agent': {'address': '', 'api_key': ''},
}


def _user_settings_path(user):
    """Return the on-disk path to ``settings.json`` for a user."""
    return f"{DB}/users/{norm_path(user['path'])}settings.json"


def _read_user_settings(user):
    """Read a user's settings file, returning defaults if it does not exist.

    Always returns the full shape, with missing sections filled in. Sensitive
    fields stay in their raw form — callers must mask before sending to the
    client.
    """
    path = _user_settings_path(user)
    data = {}
    if os.path.isfile(path):
        try:
            data = read_json(path) or {}
        except Exception:
            # Corrupt settings should not brick the user — fall back to defaults.
            data = {}
    merged = {section: dict(defaults) for section, defaults in USER_SETTINGS_DEFAULTS.items()}
    for section, defaults in USER_SETTINGS_DEFAULTS.items():
        if isinstance(data.get(section), dict):
            for key, default_value in defaults.items():
                if key in data[section]:
                    merged[section][key] = data[section][key]
    return merged


def _write_user_settings(user, settings):
    """Persist ``settings`` for a user, creating parent directories as needed."""
    path = _user_settings_path(user)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    write_json(path, settings)


def _public_user_settings(settings):
    """Return a copy of ``settings`` with API keys masked for safe display."""
    out = {}
    for section, values in settings.items():
        out[section] = {}
        for key, value in values.items():
            if key == 'api_key':
                out[section]['has_api_key'] = bool(value)
                out[section]['api_key_preview'] = _mask_api_key(value)
            else:
                out[section][key] = value
    return out


@app.route('/api/users/<int:user_id>/settings', methods=['GET'])
def get_user_settings(user_id):
    """Return the user's settings (with API keys masked)."""
    try:
        user = get_user(user_id)
        if not user: return jsonify({'error': 'User not found'}), 404
        return jsonify(_public_user_settings(_read_user_settings(user)))
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/users/<int:user_id>/settings', methods=['PUT'])
def update_user_settings(user_id):
    """Update a user's settings.

    Accepts a partial payload — only the sections / fields present in the
    request are touched. API-key semantics differ by provider:

    * ``openrouter.api_key`` empty → keep existing (clearing it bricks the
      entry, so the UI never blanks it accidentally).
    * ``agent.api_key`` empty → clear (the agent often runs without auth,
      so users need a way to remove the key once set).
    """
    try:
        user = get_user(user_id)
        if not user: return jsonify({'error': 'User not found'}), 404
        data = request.get_json(silent=True) or {}
        if not isinstance(data, dict):
            return jsonify({'error': 'Body must be a JSON object'}), 400

        current = _read_user_settings(user)

        openrouter_in = data.get('openrouter')
        if isinstance(openrouter_in, dict):
            if 'api_key' in openrouter_in:
                incoming = (openrouter_in.get('api_key') or '').strip()
                if incoming:
                    current['openrouter']['api_key'] = incoming

        agent_in = data.get('agent')
        if isinstance(agent_in, dict):
            if 'address' in agent_in:
                current['agent']['address'] = (agent_in.get('address') or '').strip()
            if 'api_key' in agent_in:
                # Empty input clears the key, matching the LLM-entry edit rule
                # for the agent provider.
                current['agent']['api_key'] = (agent_in.get('api_key') or '').strip()

        _write_user_settings(user, current)
        return jsonify(_public_user_settings(current))
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ── Chats ───────────────────────────────────────────────────────────────────

@app.route('/api/chats/<int:user_id>', methods=['GET'])
def list_chats(user_id):
    """List every chat owned by ``user_id``."""
    try:
        user = get_user(user_id)
        if not user: return jsonify({'error': 'User not found'}), 404
        chats, _ = read_index(f"{DB}/users/{norm_path(user['path'])}chats.json")
        return jsonify(chats)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/chats/<int:user_id>/start', methods=['POST'])
def start_chat(user_id):
    """Return the existing chat for a character, or create one seeded with its opening line."""
    try:
        data = request.get_json() or {}
        character_id = data.get('character_id')
        persona_id = data.get('persona_id')
        if character_id is None:
            return jsonify({'error': 'character_id required'}), 400
        user = get_user(user_id)
        if not user: return jsonify({'error': 'User not found'}), 404
        chats_path = f"{DB}/users/{norm_path(user['path'])}chats.json"
        chats, chats_next = read_index(chats_path)

        existing = next((c for c in chats if c.get('character_id') == character_id), None)
        if existing:
            return jsonify(existing)

        characters, _ = read_index(f"{DB}/characters/characters.json")
        char = find_by_id(characters, character_id)
        if not char: return jsonify({'error': 'Character not found'}), 404
        char_dir = f"{DB}/characters/{norm_path(char['path'])}"
        char_data = read_json(f"{char_dir}character.json")
        opening_path = f"{char_dir}{char_data['opening']}"
        opening = ''
        if os.path.isfile(opening_path):
            with open(opening_path, 'r', encoding='utf-8') as f:
                opening = f.read().strip()

        # {user} resolves to the selected persona's name, falling back to the
        # first persona, then the account name.
        if opening:
            personas, _ = read_index(_user_personas_index(user))
            selected = find_by_id(personas, persona_id) if persona_id is not None else None
            if selected:
                user_name = selected['name']
            elif personas:
                user_name = personas[0]['name']
            else:
                user_name = user['name']
            opening = substitute_placeholders(opening, char['name'], user_name)

        history = []
        if opening:
            history.append({
                'id': 0,
                'role': 'assistant',
                'content': [opening],
                'selected_index': 0
            })

        new_chat = {
            'id': chats_next,
            'character_id': character_id,
            'style_id': None,
            'llm_id': None,
            'last_update': now_iso(),
            'history': history
        }
        chats.append(new_chat)
        write_index(chats_path, chats, chats_next + 1)
        return jsonify(new_chat), 201
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/chats/<int:user_id>/<int:chat_id>', methods=['GET'])
def get_chat_history(user_id, chat_id):
    """Return a chat with a sliced, paginated history window.

    ``before`` selects messages with id < before; ``limit`` keeps only the
    last N of those. Opening a chat also bumps ``last_update``.
    """
    try:
        before = request.args.get('before', type=int)
        limit  = request.args.get('limit',  type=int)
        user = get_user(user_id)
        if not user: return jsonify({'error': 'User not found'}), 404
        chats_path = f"{DB}/users/{norm_path(user['path'])}chats.json"
        chats, chats_next = read_index(chats_path)
        chat = find_by_id(chats, chat_id)
        if not chat: return jsonify({'error': 'Chat not found'}), 404
        chat['last_update'] = now_iso()
        write_index(chats_path, chats, chats_next)
        full = chat['history']
        visible = [m for m in full if m['id'] < before] if before is not None else full
        if limit is not None:
            sliced = visible[-limit:]
            has_more = len(sliced) < len(visible)
        else:
            sliced = visible
            has_more = False
        return jsonify({**chat, 'history': sliced, 'has_more': has_more, 'total': len(full)})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/chats/<int:user_id>/<int:chat_id>', methods=['DELETE'])
def delete_chat(user_id, chat_id):
    """Remove a chat from the user's index."""
    try:
        user = get_user(user_id)
        if not user: return jsonify({'error': 'User not found'}), 404
        path = f"{DB}/users/{norm_path(user['path'])}chats.json"
        chats, chats_next = read_index(path)
        if not any(c['id'] == chat_id for c in chats):
            return jsonify({'error': 'Chat not found'}), 404
        chats = [c for c in chats if c['id'] != chat_id]
        write_index(path, chats, chats_next)
        return jsonify({'ok': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/chats/<int:user_id>/<int:chat_id>/style', methods=['PUT'])
def set_chat_style(user_id, chat_id):
    """Set the chat style used by ``chat_id``."""
    try:
        data = request.get_json() or {}
        if 'style_id' not in data:
            return jsonify({'error': 'style_id required'}), 400
        user = get_user(user_id)
        if not user: return jsonify({'error': 'User not found'}), 404
        path = f"{DB}/users/{norm_path(user['path'])}chats.json"
        chats, chats_next = read_index(path)
        chat = find_by_id(chats, chat_id)
        if not chat: return jsonify({'error': 'Chat not found'}), 404
        chat['style_id'] = data['style_id']
        write_index(path, chats, chats_next)
        return jsonify({'ok': True, 'style_id': chat['style_id']})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/chats/<int:user_id>/<int:chat_id>/llm', methods=['PUT'])
def set_chat_llm(user_id, chat_id):
    """Set the LLM used by ``chat_id``.

    The LLM is owned by the chat session (not the model preset), so a user
    can swap providers without duplicating presets. ``llm_id=null`` clears
    the assignment.
    """
    try:
        data = request.get_json() or {}
        if 'llm_id' not in data:
            return jsonify({'error': 'llm_id required'}), 400
        new_id = data['llm_id']
        user = get_user(user_id)
        if not user: return jsonify({'error': 'User not found'}), 404
        if new_id is not None and not _llm_exists(user, new_id):
            return jsonify({'error': 'llm_id does not match any LLM'}), 400
        path = f"{DB}/users/{norm_path(user['path'])}chats.json"
        chats, chats_next = read_index(path)
        chat = find_by_id(chats, chat_id)
        if not chat: return jsonify({'error': 'Chat not found'}), 404
        chat['llm_id'] = new_id
        write_index(path, chats, chats_next)
        return jsonify({'ok': True, 'llm_id': chat['llm_id']})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/chats/<int:user_id>/<int:chat_id>', methods=['PUT'])
def update_chat_history(user_id, chat_id):
    """Replace a chat's full history with the provided list."""
    try:
        new_history = request.get_json()
        if not isinstance(new_history, list):
            return jsonify({'error': 'History must be a list'}), 400
        user = get_user(user_id)
        if not user: return jsonify({'error': 'User not found'}), 404
        path = f"{DB}/users/{norm_path(user['path'])}chats.json"
        chats, chats_next = read_index(path)
        chat = find_by_id(chats, chat_id)
        if not chat: return jsonify({'error': 'Chat not found'}), 404
        chat['history'] = new_history
        write_index(path, chats, chats_next)
        return jsonify({'ok': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/chats/<int:user_id>/<int:chat_id>/messages/<int:message_id>', methods=['PUT'])
def edit_message(user_id, chat_id, message_id):
    """Patch a message's ``content`` and/or ``selected_index``."""
    try:
        data = request.get_json()
        user = get_user(user_id)
        if not user: return jsonify({'error': 'User not found'}), 404
        path = f"{DB}/users/{norm_path(user['path'])}chats.json"
        chats, chats_next = read_index(path)
        chat = find_by_id(chats, chat_id)
        if not chat: return jsonify({'error': 'Chat not found'}), 404
        message = find_by_id(chat['history'], message_id)
        if not message: return jsonify({'error': 'Message not found'}), 404

        if 'content' in data:
            message['content'] = data['content']
        if 'selected_index' in data:
            message['selected_index'] = data['selected_index']

        write_index(path, chats, chats_next)
        return jsonify(message)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/chats/<int:user_id>/<int:chat_id>/rewind/<int:message_id>', methods=['POST'])
def rewind_chat(user_id, chat_id, message_id):
    """Truncate a chat to the inclusive position of ``message_id``."""
    try:
        limit = request.args.get('limit', type=int)
        user = get_user(user_id)
        if not user: return jsonify({'error': 'User not found'}), 404
        path = f"{DB}/users/{norm_path(user['path'])}chats.json"
        chats, chats_next = read_index(path)
        chat = find_by_id(chats, chat_id)
        if not chat: return jsonify({'error': 'Chat not found'}), 404
        if not any(m['id'] == message_id for m in chat['history']):
            return jsonify({'error': 'Message not found'}), 404
        chat['history'] = [m for m in chat['history'] if m['id'] <= message_id]
        write_index(path, chats, chats_next)
        full = chat['history']
        if limit is not None:
            sliced = full[-limit:]
            has_more = len(sliced) < len(full)
        else:
            sliced = full
            has_more = False
        return jsonify({'ok': True, 'history': sliced, 'has_more': has_more, 'total': len(full)})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/chats/<int:user_id>/<int:chat_id>/messages/<int:message_id>', methods=['DELETE'])
def delete_message(user_id, chat_id, message_id):
    """Remove a single message from a chat's history."""
    try:
        user = get_user(user_id)
        if not user: return jsonify({'error': 'User not found'}), 404
        path = f"{DB}/users/{norm_path(user['path'])}chats.json"
        chats, chats_next = read_index(path)
        chat = find_by_id(chats, chat_id)
        if not chat: return jsonify({'error': 'Chat not found'}), 404
        chat['history'] = [m for m in chat['history'] if m['id'] != message_id]
        write_index(path, chats, chats_next)
        return jsonify({'ok': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/chat/send', methods=['POST'])
def chat_send():
    """Generate an assistant reply for a chat and persist it."""
    data = request.get_json()
    missing, err = _required(data, 'style_id', 'user_id', 'persona_id', 'character_id', 'chat_id')
    if missing: return err
    try:
        user = get_user(data['user_id'])
        if not user: return jsonify({'error': 'User not found'}), 404
        # The chat owns the LLM choice; look it up before loading anything heavy.
        chats_path = f"{DB}/users/{norm_path(user['path'])}chats.json"
        chats_index, _ = read_index(chats_path)
        chat_entry = find_by_id(chats_index, data['chat_id'])
        if not chat_entry: return jsonify({'error': 'Chat not found'}), 404
        chat_llm_id = chat_entry.get('llm_id')
        if chat_llm_id is None:
            return jsonify({'error': 'No LLM selected for this chat. Pick one in the chat header.'}), 400

        style = Style();         style.setStyle(id=data['style_id'])
        llm = Llm();             llm.setLlm(_user_llms_index(user), chat_llm_id)
        persona = Persona();     persona.setPersona(userID=data['user_id'], personaID=data['persona_id'])
        character = Character(); character.setCharacter(id=data['character_id'])
        chats = Chats();         chats.setChats(data['user_id'])

        settings = buildSettings(style, persona, character)
        reply = send(
            data.get('message'),
            settings, llm, chats, data['chat_id'],
            new_attempt=data.get('new_attempt', False),
            continue_mode=data.get('continue_mode', False),
            user_settings=_read_user_settings(user),
        )
        return jsonify({'reply': reply})
    except ValueError as e:
        # Lookup / validation failures from the LLM helpers — caller error, not server bug.
        return jsonify({'error': str(e)}), 400
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


# ── Users ───────────────────────────────────────────────────────────────────

@app.route('/api/users', methods=['GET'])
def list_users():
    """List every user."""
    try:
        users, _ = read_index(f"{DB}/users/users.json")
        return jsonify(users)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/users', methods=['POST'])
def create_user():
    """Create a new user with a random storage directory."""
    try:
        data = request.get_json()
        missing, err = _required(data, 'username')
        if missing: return err
        username = data['username'].strip() if isinstance(data['username'], str) else ''
        if not username:
            return jsonify({'error': 'username required'}), 400
        users, users_next = read_index(f"{DB}/users/users.json")
        if any(u['name'].lower() == username.lower() for u in users):
            return jsonify({'error': 'Username taken'}), 400

        id = users_next
        dirname = random_dir()
        base = f"{DB}/users/{dirname}"
        os.makedirs(f"{base}/personas", exist_ok=True)
        reg_date = now_iso()
        write_json(f"{base}/user.json", {
            'id': id,
            'username': username,
            'reg_date': reg_date,
        })
        write_index(f"{base}/personas/user_personas.json", [], 0)
        write_index(f"{base}/chats.json", [], 0)
        write_index(f"{base}/llms.json", [], 0)

        entry = {'id': id, 'name': username, 'path': f'./{dirname}/', 'reg_date': reg_date}
        users.append(entry)
        write_index(f"{DB}/users/users.json", users, users_next + 1)
        return jsonify(entry), 201
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/users/<int:user_id>', methods=['DELETE'])
def delete_user(user_id):
    """Delete a user, then best-effort remove their on-disk directory."""
    try:
        users, users_next = read_index(f"{DB}/users/users.json")
        user = find_by_id(users, user_id)
        if not user: return jsonify({'error': 'User not found'}), 404

        # Drop the index entry first so the user is logically gone even if
        # Windows holds a lock on something inside the directory.
        users = [u for u in users if u['id'] != user_id]
        write_index(f"{DB}/users/users.json", users, users_next)

        user_dir = f"{DB}/users/{norm_path(user['path'])}"
        if os.path.isdir(user_dir):
            shutil.rmtree(user_dir, onerror=_on_rm_error)

        return jsonify({'ok': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/users/<int:user_id>', methods=['PUT'])
def edit_user(user_id):
    """Rename a user (keeps the on-disk directory)."""
    try:
        data = request.get_json()
        if not isinstance(data, dict):
            return jsonify({'error': 'JSON body required'}), 400
        users, users_next = read_index(f"{DB}/users/users.json")
        user = find_by_id(users, user_id)
        if not user: return jsonify({'error': 'User not found'}), 404

        if 'username' in data:
            new_name = data['username']
            if any(u['id'] != user_id and u['name'].lower() == new_name.lower() for u in users):
                return jsonify({'error': 'Username taken'}), 400
            user['name'] = new_name
            user_json_path = f"{DB}/users/{norm_path(user['path'])}user.json"
            user_json = read_json(user_json_path)
            user_json['username'] = new_name
            write_json(user_json_path, user_json)

        write_index(f"{DB}/users/users.json", users, users_next)
        return jsonify(user)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/users/<int:user_id>/picture', methods=['GET'])
def get_user_picture(user_id):
    """Stream the user's profile picture file, if any."""
    try:
        user = get_user(user_id)
        if not user: return jsonify({'error': 'User not found'}), 404
        base = f"{DB}/users/{norm_path(user['path'])}"
        user_json_path = f"{base}user.json"
        if not os.path.isfile(user_json_path):
            return jsonify({'error': 'No picture'}), 404
        user_json = read_json(user_json_path)
        picture = user_json.get('picture')
        if not picture:
            return jsonify({'error': 'No picture'}), 404
        pic_path = os.path.join(base, picture)
        if not os.path.isfile(pic_path):
            return jsonify({'error': 'Picture file missing'}), 404
        return send_from_directory(os.path.abspath(base), picture)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/users/<int:user_id>/picture', methods=['PUT'])
def upload_user_picture(user_id):
    """Upload (or replace) the user's profile picture."""
    try:
        user = get_user(user_id)
        if not user: return jsonify({'error': 'User not found'}), 404
        base = f"{DB}/users/{norm_path(user['path'])}"
        user_json_path = f"{base}user.json"
        user_json = read_json(user_json_path)
        new_name = save_picture(request.files.get('file'), base, old_filename=user_json.get('picture'))
        user_json['picture'] = new_name
        write_json(user_json_path, user_json)
        return jsonify({'ok': True, 'picture': new_name})
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/users/<int:user_id>/picture', methods=['DELETE'])
def delete_user_picture(user_id):
    """Delete the user's profile picture if present."""
    try:
        user = get_user(user_id)
        if not user: return jsonify({'error': 'User not found'}), 404
        base = f"{DB}/users/{norm_path(user['path'])}"
        user_json_path = f"{base}user.json"
        user_json = read_json(user_json_path)
        old = user_json.get('picture')
        if old:
            old_path = os.path.join(base, old)
            if os.path.isfile(old_path):
                os.remove(old_path)
        user_json.pop('picture', None)
        write_json(user_json_path, user_json)
        return jsonify({'ok': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ── Personas ────────────────────────────────────────────────────────────────

def _user_personas_dir(user):
    """Return the absolute personas directory for ``user``."""
    return f"{DB}/users/{norm_path(user['path'])}personas"


def _user_personas_index(user):
    """Return the path to the user's personas index file."""
    return f"{_user_personas_dir(user)}/user_personas.json"


@app.route('/api/users/<int:user_id>/personas', methods=['GET'])
def list_personas(user_id):
    """List every persona belonging to ``user_id``."""
    try:
        user = get_user(user_id)
        if not user: return jsonify({'error': 'User not found'}), 404
        personas, _ = read_index(_user_personas_index(user))
        return jsonify(personas)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/users/<int:user_id>/personas/<int:persona_id>', methods=['GET'])
def get_persona(user_id, persona_id):
    """Return a single persona including its markdown content."""
    try:
        user = get_user(user_id)
        if not user: return jsonify({'error': 'User not found'}), 404
        personas, _ = read_index(_user_personas_index(user))
        persona = find_by_id(personas, persona_id)
        if not persona: return jsonify({'error': 'Persona not found'}), 404
        with open(f"{_user_personas_dir(user)}/{persona['path']}", 'r', encoding='utf-8') as f:
            content = f.read()
        return jsonify({**persona, 'content': content})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/users/<int:user_id>/personas', methods=['POST'])
def create_persona(user_id):
    """Create a new persona for ``user_id`` and write its markdown file."""
    try:
        data = request.get_json()
        name = data.get('name', '').strip()
        if not name: return jsonify({'error': 'Name required'}), 400
        user = get_user(user_id)
        if not user: return jsonify({'error': 'User not found'}), 404
        personas, personas_next = read_index(_user_personas_index(user))
        if any(p['name'].lower() == name.lower() for p in personas):
            return jsonify({'error': 'Persona name already exists'}), 400

        id = personas_next
        filename = f"{safe_slug(name)}_{id}.md"
        write_text(f"{_user_personas_dir(user)}/{filename}", data.get('content', ''))

        entry = {'id': id, 'name': name, 'description': data.get('description', ''), 'path': filename}
        personas.append(entry)
        write_index(_user_personas_index(user), personas, personas_next + 1)
        return jsonify(entry), 201
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/users/<int:user_id>/personas/<int:persona_id>', methods=['PUT'])
def edit_persona(user_id, persona_id):
    """Patch a persona's name, description, and/or content."""
    try:
        data = request.get_json()
        user = get_user(user_id)
        if not user: return jsonify({'error': 'User not found'}), 404
        personas, personas_next = read_index(_user_personas_index(user))
        persona = find_by_id(personas, persona_id)
        if not persona: return jsonify({'error': 'Persona not found'}), 404

        if 'name' in data:
            new_name = data['name'].strip()
            if not new_name: return jsonify({'error': 'Name required'}), 400
            if any(p['id'] != persona_id and p['name'].lower() == new_name.lower() for p in personas):
                return jsonify({'error': 'Persona name already exists'}), 400
            persona['name'] = new_name
        if 'description' in data:
            persona['description'] = data['description']
        if 'content' in data:
            write_text(f"{_user_personas_dir(user)}/{persona['path']}", data['content'])

        write_index(_user_personas_index(user), personas, personas_next)
        return jsonify(persona)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/users/<int:user_id>/personas/<int:persona_id>', methods=['DELETE'])
def delete_persona(user_id, persona_id):
    """Delete a persona and its markdown file."""
    try:
        user = get_user(user_id)
        if not user: return jsonify({'error': 'User not found'}), 404
        personas, personas_next = read_index(_user_personas_index(user))
        persona = find_by_id(personas, persona_id)
        if not persona: return jsonify({'error': 'Persona not found'}), 404
        md_path = f"{_user_personas_dir(user)}/{persona['path']}"
        if os.path.isfile(md_path):
            os.remove(md_path)
        personas = [p for p in personas if p['id'] != persona_id]
        write_index(_user_personas_index(user), personas, personas_next)
        return jsonify({'ok': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ── Characters ──────────────────────────────────────────────────────────────

@app.route('/api/characters', methods=['GET'])
def list_characters():
    """List every character."""
    try:
        chars, _ = read_index(f"{DB}/characters/characters.json")
        return jsonify(chars)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/characters/<int:character_id>', methods=['GET'])
def get_character(character_id):
    """Return a character with persona, context, and opening text inlined."""
    try:
        chars, _ = read_index(f"{DB}/characters/characters.json")
        char = find_by_id(chars, character_id)
        if not char: return jsonify({'error': 'Character not found'}), 404
        base = f"{DB}/characters/{norm_path(char['path'])}"
        char_data = read_json(f"{base}character.json")
        def _read_optional(filename):
            path = f"{base}{filename}"
            if not os.path.isfile(path):
                return ''
            with open(path, 'r', encoding='utf-8') as f:
                return f.read()
        persona = _read_optional(char_data.get('persona', 'persona.md'))
        context = _read_optional(char_data.get('context', 'context.md'))
        opening = _read_optional(char_data.get('opening', 'opening.txt'))
        return jsonify({**char, 'persona': persona, 'context': context, 'opening': opening})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/characters', methods=['POST'])
def create_character():
    """Create a character with its persona, context, and opening files."""
    try:
        data = request.get_json()
        missing, err = _required(data, 'name')
        if missing: return err
        name = data['name'].strip() if isinstance(data['name'], str) else ''
        if not name:
            return jsonify({'error': 'name required'}), 400
        chars, chars_next = read_index(f"{DB}/characters/characters.json")
        if any(c['name'].lower() == name.lower() for c in chars):
            return jsonify({'error': 'Character already exists'}), 400

        id = chars_next
        dirname = random_dir()
        base = f"{DB}/characters/{dirname}"
        os.makedirs(base, exist_ok=True)
        write_json(f"{base}/character.json", {
            'id': id,
            'persona': 'persona.md',
            'context': 'context.md',
            'opening': 'opening.txt',
        })
        write_text(f"{base}/persona.md", data.get('persona', ''))
        write_text(f"{base}/context.md", data.get('context', ''))
        write_text(f"{base}/opening.txt", data.get('opening', ''))

        entry = {
            'id': id,
            'name': name,
            'description': data.get('description', ''),
            'path': f'./{dirname}/',
            'last_update': now_iso(),
        }
        chars.append(entry)
        write_index(f"{DB}/characters/characters.json", chars, chars_next + 1)
        return jsonify(entry), 201
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/characters/<int:character_id>', methods=['PUT'])
def edit_character(character_id):
    """Patch a character's metadata and overwrite any provided text files."""
    try:
        data = request.get_json()
        if not isinstance(data, dict):
            return jsonify({'error': 'JSON body required'}), 400
        chars, chars_next = read_index(f"{DB}/characters/characters.json")
        char = find_by_id(chars, character_id)
        if not char: return jsonify({'error': 'Character not found'}), 404

        if 'name' in data:
            if any(c['id'] != character_id and c['name'].lower() == data['name'].lower() for c in chars):
                return jsonify({'error': 'Character already exists'}), 400
            char['name'] = data['name']
        if 'description' in data:
            char['description'] = data['description']

        base = f"{DB}/characters/{norm_path(char['path'])}"
        if 'persona' in data: write_text(f"{base}persona.md", data['persona'])
        if 'context' in data: write_text(f"{base}context.md", data['context'])
        if 'opening' in data: write_text(f"{base}opening.txt", data['opening'])

        char['last_update'] = now_iso()
        write_index(f"{DB}/characters/characters.json", chars, chars_next)
        return jsonify(char)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/characters/<int:character_id>/picture', methods=['GET'])
def get_character_picture(character_id):
    """Stream the character's picture file, if any."""
    try:
        chars, _ = read_index(f"{DB}/characters/characters.json")
        char = find_by_id(chars, character_id)
        if not char: return jsonify({'error': 'Character not found'}), 404
        base = f"{DB}/characters/{norm_path(char['path'])}"
        char_json_path = f"{base}character.json"
        if not os.path.isfile(char_json_path):
            return jsonify({'error': 'No picture'}), 404
        char_data = read_json(char_json_path)
        picture = char_data.get('picture')
        if not picture:
            return jsonify({'error': 'No picture'}), 404
        pic_path = os.path.join(base, picture)
        if not os.path.isfile(pic_path):
            return jsonify({'error': 'Picture file missing'}), 404
        return send_from_directory(os.path.abspath(base), picture)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/characters/<int:character_id>/picture', methods=['PUT'])
def upload_character_picture(character_id):
    """Upload (or replace) a character's picture."""
    try:
        chars, chars_next = read_index(f"{DB}/characters/characters.json")
        char = find_by_id(chars, character_id)
        if not char: return jsonify({'error': 'Character not found'}), 404
        base = f"{DB}/characters/{norm_path(char['path'])}"
        char_data = read_json(f"{base}character.json")
        new_name = save_picture(request.files.get('file'), base, old_filename=char_data.get('picture'))
        char_data['picture'] = new_name
        write_json(f"{base}character.json", char_data)
        char['last_update'] = now_iso()
        write_index(f"{DB}/characters/characters.json", chars, chars_next)
        return jsonify({'ok': True, 'picture': new_name, 'last_update': char['last_update']})
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/characters/<int:character_id>/picture', methods=['DELETE'])
def delete_character_picture(character_id):
    """Delete a character's picture file."""
    try:
        chars, chars_next = read_index(f"{DB}/characters/characters.json")
        char = find_by_id(chars, character_id)
        if not char: return jsonify({'error': 'Character not found'}), 404
        base = f"{DB}/characters/{norm_path(char['path'])}"
        char_data = read_json(f"{base}character.json")
        old = char_data.get('picture')
        if old:
            old_path = os.path.join(base, old)
            if os.path.isfile(old_path):
                os.remove(old_path)
        char_data.pop('picture', None)
        write_json(f"{base}character.json", char_data)
        char['last_update'] = now_iso()
        write_index(f"{DB}/characters/characters.json", chars, chars_next)
        return jsonify({'ok': True, 'last_update': char['last_update']})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/characters/<int:character_id>', methods=['DELETE'])
def delete_character(character_id):
    """Delete a character, its directory, and every chat that referenced it."""
    try:
        chars, chars_next = read_index(f"{DB}/characters/characters.json")
        char = find_by_id(chars, character_id)
        if not char: return jsonify({'error': 'Character not found'}), 404
        # Drop the index entry first so the character is logically gone even
        # if Windows holds a lock on something inside the directory.
        chars = [c for c in chars if c['id'] != character_id]
        write_index(f"{DB}/characters/characters.json", chars, chars_next)
        char_dir = f"{DB}/characters/{norm_path(char['path'])}"
        if os.path.isdir(char_dir):
            shutil.rmtree(char_dir, onerror=_on_rm_error)

        # Cascade: drop every chat referencing this character across all users.
        users, _ = read_index(f"{DB}/users/users.json")
        for u in users:
            chats_path = f"{DB}/users/{norm_path(u['path'])}chats.json"
            if not os.path.isfile(chats_path):
                continue
            chats, chats_next = read_index(chats_path)
            kept = [c for c in chats if c.get('character_id') != character_id]
            if len(kept) != len(chats):
                write_index(chats_path, kept, chats_next)

        return jsonify({'ok': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ── Chat styles ─────────────────────────────────────────────────────────────

STYLES_INDEX = f"{DB}/styles/styles.json"
STYLES_DIR   = f"{DB}/styles"


@app.route('/api/styles', methods=['GET'])
def list_styles():
    """List every chat style."""
    try:
        styles, _ = read_index(STYLES_INDEX)
        return jsonify(styles)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/styles/<int:style_id>', methods=['GET'])
def get_style(style_id):
    """Return a chat style including its rules markdown."""
    try:
        styles, _ = read_index(STYLES_INDEX)
        style = find_by_id(styles, style_id)
        if not style: return jsonify({'error': 'Style not found'}), 404
        with open(f"{STYLES_DIR}/{style['path']}", 'r', encoding='utf-8') as f:
            rules = f.read()
        return jsonify({**style, 'rules': rules})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/styles/<int:style_id>', methods=['DELETE'])
def delete_style(style_id):
    """Delete a chat style and its rules file."""
    try:
        styles, styles_next = read_index(STYLES_INDEX)
        style = find_by_id(styles, style_id)
        if not style: return jsonify({'error': 'Style not found'}), 404
        md_path = f"{STYLES_DIR}/{style['path']}"
        if os.path.isfile(md_path):
            os.remove(md_path)
        styles = [s for s in styles if s['id'] != style_id]
        write_index(STYLES_INDEX, styles, styles_next)
        return jsonify({'ok': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/styles', methods=['POST'])
def create_style():
    """Create a chat style (name + description + rules markdown).

    Chat styles are pure rules wrappers — the LLM dispatched against is
    owned by the chat session, not the style.
    """
    try:
        data = request.get_json()
        missing, err = _required(data, 'name')
        if missing: return err
        name = data['name'].strip() if isinstance(data['name'], str) else ''
        if not name:
            return jsonify({'error': 'name required'}), 400
        styles, styles_next = read_index(STYLES_INDEX)
        if any(s['name'].lower() == name.lower() for s in styles):
            return jsonify({'error': 'Style already exists'}), 400

        id = styles_next
        filename = f"{safe_slug(name)}_{id}.md"
        write_text(f"{STYLES_DIR}/{filename}", data.get('rules', ''))

        entry = {
            'id': id,
            'name': name,
            'description': data.get('description', ''),
            'path': filename,
        }
        styles.append(entry)
        write_index(STYLES_INDEX, styles, styles_next + 1)
        return jsonify(entry), 201
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/styles/<int:style_id>', methods=['PUT'])
def edit_style(style_id):
    """Patch a chat style's fields and/or its rules markdown."""
    try:
        data = request.get_json()
        if not isinstance(data, dict):
            return jsonify({'error': 'JSON body required'}), 400
        styles, styles_next = read_index(STYLES_INDEX)
        style = find_by_id(styles, style_id)
        if not style: return jsonify({'error': 'Style not found'}), 404

        if 'name' in data:
            if any(s['id'] != style_id and s['name'].lower() == data['name'].lower() for s in styles):
                return jsonify({'error': 'Style already exists'}), 400
            style['name'] = data['name']
        if 'description' in data:
            style['description'] = data['description']
        if 'rules' in data:
            write_text(f"{STYLES_DIR}/{style['path']}", data['rules'])

        write_index(STYLES_INDEX, styles, styles_next)
        return jsonify(style)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/styles/<int:style_id>/duplicate', methods=['POST'])
def duplicate_style(style_id):
    """Clone a chat style (metadata + rules file) under a unique name."""
    try:
        styles, styles_next = read_index(STYLES_INDEX)
        source = find_by_id(styles, style_id)
        if not source: return jsonify({'error': 'Style not found'}), 404

        names = {s['name'].lower() for s in styles}
        base_name = source['name']
        # Try " (copy)", " (copy 2)", " (copy 3)" … until we find an unused name.
        candidate = f"{base_name} (copy)"
        i = 2
        while candidate.lower() in names:
            candidate = f"{base_name} (copy {i})"
            i += 1

        new_id = styles_next
        new_filename = f"{safe_slug(candidate)}_{new_id}.md"
        # Carry over the source rules text by reading the markdown file directly.
        src_rules = ''
        src_path = f"{STYLES_DIR}/{source['path']}"
        if os.path.isfile(src_path):
            with open(src_path, 'r', encoding='utf-8') as f:
                src_rules = f.read()
        write_text(f"{STYLES_DIR}/{new_filename}", src_rules)

        entry = {
            'id': new_id,
            'name': candidate,
            'description': source.get('description', ''),
            'path': new_filename,
        }
        styles.append(entry)
        write_index(STYLES_INDEX, styles, styles_next + 1)
        return jsonify(entry), 201
    except Exception as e:
        return jsonify({'error': str(e)}), 500


def _llm_exists(user, llm_id):
    """Return True when ``llm_id`` is a registered entry for ``user``."""
    if llm_id is None:
        return False
    path = _user_llms_index(user)
    if not os.path.isfile(path):
        return False
    llms, _ = read_index(path)
    return any(l['id'] == llm_id for l in llms)


# ── LLM weight files ────────────────────────────────────────────────────────

GLOBAL_LLMS_INDEX = f"{DB}/llms.json"  # Legacy location; only read during migration.
ALLOWED_PROVIDERS = {'openrouter', 'agent'}
API_KEY_PREVIEW_LEN = 4


def _user_llms_index(user):
    """Return the on-disk path to ``llms.json`` for a user."""
    return f"{DB}/users/{norm_path(user['path'])}llms.json"


def _mask_api_key(key):
    """Return a short preview (``…last4``) of an API key for safe display."""
    if not key:
        return ''
    tail = key[-API_KEY_PREVIEW_LEN:]
    return f"…{tail}"


def _public_llm(entry):
    """Project an LLM index entry into the shape returned by the API.

    Entries are pure labels now — ``{id, name, provider}``. Credentials
    (OpenRouter API key, Agent address + API key) live in the per-user
    settings file and are surfaced through ``/api/users/<id>/settings``.
    """
    return {
        'id': entry['id'],
        'name': entry.get('name', ''),
        'provider': entry.get('provider', 'local'),
    }


def _llm_in_use(user, llm_id):
    """Return True if any of ``user``'s chats reference ``llm_id``."""
    chats_path = f"{DB}/users/{norm_path(user['path'])}chats.json"
    if not os.path.isfile(chats_path):
        return False
    chats, _ = read_index(chats_path)
    return any(c.get('llm_id') == llm_id for c in chats)


@app.route('/api/users/<int:user_id>/llms', methods=['GET'])
def list_user_llms(user_id):
    """List the LLM labels registered by ``user_id``."""
    try:
        user = get_user(user_id)
        if not user: return jsonify({'error': 'User not found'}), 404
        path = _user_llms_index(user)
        if not os.path.isfile(path):
            return jsonify([])
        llms, _ = read_index(path)
        return jsonify([_public_llm(l) for l in llms])
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/users/<int:user_id>/llms/<int:llm_id>', methods=['GET'])
def get_user_llm(user_id, llm_id):
    """Return one of ``user_id``'s LLM entries."""
    try:
        user = get_user(user_id)
        if not user: return jsonify({'error': 'User not found'}), 404
        path = _user_llms_index(user)
        if not os.path.isfile(path):
            return jsonify({'error': 'LLM not found'}), 404
        llms, _ = read_index(path)
        entry = find_by_id(llms, llm_id)
        if not entry: return jsonify({'error': 'LLM not found'}), 404
        return jsonify(_public_llm(entry))
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/users/<int:user_id>/llms', methods=['POST'])
def create_user_llm(user_id):
    """Register a new LLM label ``{name, provider}`` for ``user_id``.

    The connection credentials live in the user's Connections settings.
    The ``name`` doubles as the resolver identifier: for OpenRouter it is
    the model id (e.g. ``anthropic/claude-3.5-sonnet``); for the Agent it
    is the LLM name registered on the agent's own ``llms.json``.
    """
    try:
        user = get_user(user_id)
        if not user: return jsonify({'error': 'User not found'}), 404
        data = request.get_json(silent=True) or {}
        provider = data.get('provider')
        name = (data.get('name') or '').strip()
        if provider not in ALLOWED_PROVIDERS:
            return jsonify({'error': f'Unsupported provider: {provider!r}'}), 400
        if not name:
            return jsonify({'error': 'name required'}), 400

        path = _user_llms_index(user)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        if not os.path.isfile(path):
            write_index(path, [], 0)
        llms, llms_next = read_index(path)
        if any(l.get('name', '').lower() == name.lower() for l in llms):
            return jsonify({'error': 'An LLM with this name already exists'}), 400

        entry = {'id': llms_next, 'name': name, 'provider': provider}
        llms.append(entry)
        write_index(path, llms, llms_next + 1)
        return jsonify(_public_llm(entry)), 201
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/users/<int:user_id>/llms/<int:llm_id>', methods=['PUT'])
def edit_user_llm(user_id, llm_id):
    """Rename one of ``user_id``'s LLM entries (only the name is editable)."""
    try:
        user = get_user(user_id)
        if not user: return jsonify({'error': 'User not found'}), 404
        path = _user_llms_index(user)
        if not os.path.isfile(path):
            return jsonify({'error': 'LLM not found'}), 404
        data = request.get_json(silent=True) or {}
        llms, llms_next = read_index(path)
        entry = find_by_id(llms, llm_id)
        if not entry: return jsonify({'error': 'LLM not found'}), 404

        if 'name' in data:
            new_name = (data.get('name') or '').strip()
            if not new_name:
                return jsonify({'error': 'name required'}), 400
            if any(l['id'] != llm_id and l.get('name', '').lower() == new_name.lower() for l in llms):
                return jsonify({'error': 'An LLM with this name already exists'}), 400
            entry['name'] = new_name

        write_index(path, llms, llms_next)
        return jsonify(_public_llm(entry))
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/users/<int:user_id>/llms/<int:llm_id>', methods=['DELETE'])
def delete_user_llm(user_id, llm_id):
    """Delete one of ``user_id``'s LLM entries.

    Rejects deletion when one of the user's chats still references the
    entry — the user must switch those chats off it first.
    """
    try:
        user = get_user(user_id)
        if not user: return jsonify({'error': 'User not found'}), 404
        path = _user_llms_index(user)
        if not os.path.isfile(path):
            return jsonify({'error': 'LLM not found'}), 404
        llms, llms_next = read_index(path)
        entry = find_by_id(llms, llm_id)
        if not entry: return jsonify({'error': 'LLM not found'}), 404
        if _llm_in_use(user, llm_id):
            return jsonify({'error': 'This LLM is used by one or more chats — switch them off it first'}), 400

        llms = [l for l in llms if l['id'] != llm_id]
        write_index(path, llms, llms_next)
        return jsonify({'ok': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


ensure_db()


if __name__ == '__main__':
    debug = os.environ.get('CHATBOT_DEBUG') == '1'
    app.run(host=config.CORE_ADDRESS, port=config.CORE_PORT, debug=debug)
