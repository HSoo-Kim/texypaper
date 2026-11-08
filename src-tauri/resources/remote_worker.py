#!/usr/bin/env python3
"""TexyPaper protocol v1 POSIX worker (Python 3.9+, standard library only).

Stdio is exclusively framed protocol traffic. Saves are optimistic hash checks,
not a filesystem compare-and-swap against unrelated writers. Transaction journals
are durable recovery material; no project-controlled setting grants build trust.

Wire: TEXYPAPER/1 LF, then u32be JSON length, JSON, u32be raw length, raw.
Text strips only the encoding BOM; revision and source/comment byte offsets
always refer to physical bytes including BOM and CRLF. Large logical text uses
read_range chunks and save_text_begin/chunk/commit/abort. Escaped proposal JSON
uses args_begin/chunk/execute/abort (8 MiB staged maximum, 1 MiB wire frames).
Builds reply synchronously; queued builds are observed through build_status.
"""
import concurrent.futures
import collections
import contextlib
import datetime
import base64
import binascii
import hashlib
import json
import math
import os
import pathlib
import queue
import re
import shutil
import signal
import stat
import struct
import subprocess
import sys
import threading
import time
import uuid

HEADER_LIMIT = 65536
PAYLOAD_LIMIT = 1048576
TEXT_LIMIT = 4 * PAYLOAD_LIMIT
PAPER_SUFFIXES = {'.tex', '.ltx', '.bib', '.cls', '.sty', '.bst', '.bbx', '.cbx'}
STATE_NAME = '.texypaper'
LEGACY_STATE_NAME = '.paperdock'  # One-time migration and private-state read protection only.
PRIVATE_STATE_NAMES = {STATE_NAME, LEGACY_STATE_NAME}
# Deny legacy private variables too; this is secret protection, not an env alias.
PRIVATE_ENV_PREFIXES = ('TEXYPAPER_', 'PAPERDOCK_')
EXCLUDED = {'.git', *PRIVATE_STATE_NAMES, 'node_modules', '.venv', 'venv', '__pycache__'}
HEX = re.compile(r'^[a-f0-9]{64}$')
IDENT = re.compile(r'^[A-Za-z0-9_-]{1,100}$')


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00', 'Z')


def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def file_hash(path, cancel=None, deadline=None):
    h = hashlib.sha256()
    with open(path, 'rb') as stream:
        for chunk in iter(lambda: stream.read(65536), b''):
            require(cancel is None or not cancel.is_set(), 'CANCELED', 'Operation canceled while hashing')
            require(deadline is None or time.monotonic() < deadline, 'BUILD_TIMEOUT', 'Build deadline exceeded while hashing')
            h.update(chunk)
    return h.hexdigest()
def binary_bytes(data):
    if data.startswith((b'\xff\xfe', b'\xfe\xff')):
        return False
    return (b'\x00' in data
            or data.startswith((b'%PDF-', b'\x89PNG\r\n\x1a\n', b'\xff\xd8\xff',
                                b'PK\x03\x04', b'PK\x05\x06', b'PK\x07\x08', b'\x7fELF'))
            or sum(b < 32 and b not in (9, 10, 12, 13) for b in data) * 100 > len(data))



class Failure(Exception):
    def __init__(self, code, message, path=None, details=None, retryable=False):
        super().__init__(message)
        self.value = dict(code=code, message=message, retryable=retryable)
        if path is not None:
            self.value['path'] = path
        if details is not None:
            self.value['details'] = details


def require(condition, code, message, **kw):
    if not condition:
        raise Failure(code, message, **kw)


def integer(value, default=0, maximum=None):
    if value is None:
        value = default
    require(isinstance(value, int) and not isinstance(value, bool) and value >= 0,
            'INVALID_ARGUMENT', 'Expected a nonnegative integer')
    require(maximum is None or value <= maximum, 'INVALID_ARGUMENT', 'Integer exceeds limit')
    return value


def token(value=None):
    value = value or uuid.uuid4().hex
    require(isinstance(value, str) and IDENT.fullmatch(value), 'INVALID_ARGUMENT', 'Invalid operation identifier')
    return value


def fsync_dir(path):
    fd = os.open(str(path), os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic(path, data, mode=None):
    temporary = path.with_name('.texypaper-' + uuid.uuid4().hex)
    created = False
    try:
        with open(temporary, 'xb') as stream:
            created = True
            os.chmod(temporary, mode if mode is not None else 0o600)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        fsync_dir(path.parent)
    finally:
        if created:
            with contextlib.suppress(FileNotFoundError):
                temporary.unlink()


def load_json(path, default=None):
    if not path.exists():
        return default
    require(path.stat().st_size <= TEXT_LIMIT, 'INVALID_DATA', 'JSON file exceeds limit')
    try:
        with open(path, 'r', encoding='utf-8') as stream:
            return json.load(stream)
    except (ValueError, UnicodeError) as exc:
        raise Failure('INVALID_DATA', 'Invalid JSON: ' + str(exc))


def migrate_metadata(root):
    """Move the private store once; the old application must already be closed.

    Preflight precedes the rename. A durable marker and idempotent atomic JSON
    rewrites resume interruption before recovery. This cannot lock an old client.
    User documents, comments, settings and opaque recovery bytes are never edited.
    """
    legacy, current = root / LEGACY_STATE_NAME, root / STATE_NAME
    old_exists, new_exists = os.path.lexists(legacy), os.path.lexists(current)
    require(not (old_exists and new_exists), 'METADATA_MIGRATION_CONFLICT',
            'Both private metadata directories exist; close the old app and resolve the conflict without merging',
            path=str(root))
    store = legacy if old_exists else current
    if not old_exists and not new_exists:
        return
    require(not store.is_symlink() and store.is_dir(), 'METADATA_MIGRATION_UNSAFE',
            'Private metadata must be a direct directory', path=str(store))
    marker = store / '.texypaper-migration'
    if os.path.lexists(marker):
        require(not marker.is_symlink() and marker.is_file(), 'METADATA_MIGRATION_UNSAFE',
                'Migration marker must be a direct regular file', path=str(marker))
        require(marker.stat().st_size == 2 and marker.read_bytes() == b'1\n',
                'METADATA_MIGRATION_INVALID', 'Unrecognized migration marker', path=str(marker))
    if not old_exists and not marker.exists():
        return
    candidates = []

    def walk_error(exc):
        raise Failure('METADATA_MIGRATION_UNSAFE', 'Cannot inspect private metadata safely',
                      path=exc.filename)

    # Never follow links or interpret arbitrary JSON, credentials or backups.
    for directory, dirs, files in os.walk(store, followlinks=False, onerror=walk_error):
        for name in dirs + files:
            entry = pathlib.Path(directory) / name
            info = entry.lstat()
            require(stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode),
                    'METADATA_MIGRATION_UNSAFE', 'Private metadata contains a link or special file', path=str(entry))
            require(store in entry.resolve(strict=True).parents, 'METADATA_MIGRATION_UNSAFE',
                    'Private metadata escapes its directory', path=str(entry))
        for name in files:
            relative = (pathlib.Path(directory) / name).relative_to(store)
            parts = relative.parts
            journal = len(parts) == 3 and parts[0] == 'transactions' and name == 'journal.json'
            build = (parts in (('build', 'status.json'), ('build', 'latest.json'))
                     or len(parts) == 3 and parts[0] == 'build' and name == 'latest.json'
                     or len(parts) == 5 and parts[0] == 'build'
                     and parts[2] in ('pending', 'published') and name == 'manifest.json')
            if journal or build:
                candidates.append((relative, journal))

    def invalid(condition, message):
        require(condition, 'METADATA_MIGRATION_INVALID', message)

    def private_path(value):
        if not isinstance(value, str) or not value.startswith((LEGACY_STATE_NAME + '/', STATE_NAME + '/')):
            return value
        parts = value.split('/')
        invalid(all(p not in ('', '.', '..') for p in parts)
                and '\\' not in value and ':' not in value and '\x00' not in value,
                'Metadata contains an unsafe private path')
        return STATE_NAME + value[len(LEGACY_STATE_NAME):] if parts[0] == LEGACY_STATE_NAME else value

    def fields(value, names):
        invalid(isinstance(value, dict), 'Expected a metadata object')
        for name in names:
            if name in value:
                value[name] = private_path(value[name])

    def path_list(value, name):
        if name in value:
            invalid(isinstance(value[name], list), 'Expected a metadata path list')
            value[name] = [private_path(path) for path in value[name]]

    def manifest(value):
        fields(value, ('pdfPath', 'syncPath'))
        if 'sources' in value:
            invalid(isinstance(value['sources'], list), 'Expected build source records')
            for source in value['sources']:
                fields(source, ('snapshotPath',))
        # Recorder/SyncTeX bytes can embed old paths; preserve them, rebuild mapping.
        value['mappingReady'] = False
        value['mappingReason'] = 'Private metadata migrated; rebuild to refresh SyncTeX paths'

    def journal_fingerprint(records):
        if not isinstance(records, list) or not all(
                isinstance(r, dict) and all(k in r for k in ('path', 'action', 'beforeSha256', 'afterSha256'))
                for r in records):
            return None
        return digest(compact([dict(path=r['path'], baseSha256=r['beforeSha256'],
                                    action=r['action'], resultSha256=r['afterSha256']) for r in records]))

    updates = []
    for relative, journal in sorted(candidates):
        path = store / relative
        try:
            value = load_json(path)
        except Failure as exc:
            raise Failure('METADATA_MIGRATION_INVALID', 'Cannot migrate metadata JSON', path=str(path),
                          details=exc.value)
        invalid(isinstance(value, dict), 'Expected a metadata JSON object')
        before = compact(value)
        if journal:
            original_fingerprint = journal_fingerprint(value.get('files'))
            fields(value, ('path', 'source', 'destination'))
            invalid(not (isinstance(value.get('source'), str)
                         and value.get('source') == value.get('destination')),
                    'Move transaction contains ambiguous private path collisions')
            path_list(value, 'affectedPaths')
            path_list(value, 'affected')
            for name, names in (('files', ('path',)), ('records', ('path', 'backup', 'stage'))):
                if name in value:
                    invalid(isinstance(value[name], list), 'Expected transaction file records')
                    paths = []
                    for record in value[name]:
                        fields(record, names)
                        paths.append(record.get('path'))
                    invalid(all(isinstance(p, str) for p in paths) and len(paths) == len(set(paths)),
                            'Transaction contains ambiguous private path collisions')
            # Auto-reanchored comments are not in the original fingerprint. Only
            # recompute when the complete original record list matches exactly.
            if original_fingerprint is not None and value.get('fingerprint') == original_fingerprint:
                value['fingerprint'] = journal_fingerprint(value.get('files'))
            if isinstance(value.get('result'), dict):
                result = value['result']
                fields(result, ('path', 'newPath'))
                path_list(result, 'paths')
                for name in ('revisions', 'changed'):
                    if name in result:
                        invalid(isinstance(result[name], list), 'Expected transaction revisions')
                        for revision in result[name]:
                            invalid(isinstance(revision, dict), 'Expected a transaction revision')
                            if isinstance(revision.get('file'), dict):
                                fields(revision['file'], ('path',))
                            fields(revision, ('path',))
        elif relative.parts in (('build', 'status.json'), ('build', 'latest.json')):
            if value.get('manifest') is not None:
                manifest(value['manifest'])
        else:
            manifest(value)
        after = compact(value)
        if after != before:
            updates.append((relative, after, stat.S_IMODE(path.stat().st_mode)))

    if old_exists:
        require(not os.path.lexists(current), 'METADATA_MIGRATION_CONFLICT',
                'New private metadata appeared during migration; no data was merged')
        if not marker.exists():
            atomic(marker, b'1\n')
        os.rename(legacy, current)
        fsync_dir(root)
    for relative, data, mode in updates:
        atomic(current / relative, data, mode)
    (current / marker.name).unlink()
    fsync_dir(current)


class Worker:
    def __init__(self):
        self.root = None
        self.root_identity = None
        self.workspace_id = None
        self.epoch = 0
        self.mutations = threading.RLock()
        self.output_lock = threading.Lock()
        self.requests_lock = threading.Lock()
        self.requests = {}
        self.stopping = threading.Event()
        self.build_cancel = threading.Event()
        self.build_lock = threading.Lock()
        self.build_queue_lock = threading.Lock()
        self.pending_build = None
        self.active_build_args = None
        self.queued_thread = None
        self.process_lock = threading.Lock()
        self.processes = set()
        self.uploads = {}
        self.searches = {}
        self.search_lock = threading.Lock()
        self.generation = 0
        self.build_state = dict(status='idle', diagnostics=[], logTail='')
        self.main_tex = None
        self.registration_open = True
        # Only the native approval authority sends these internal protocol operations.
        self.command_lock = threading.RLock()
        self.commands = {}
        self.command_active = None

    def frame(self, header, payload=b''):
        encoded = compact(header)
        require(len(payload) <= PAYLOAD_LIMIT, 'PROTOCOL_LIMIT', 'Response payload exceeds 1 MiB')
        require(len(encoded) <= HEADER_LIMIT, 'PROTOCOL_LIMIT', 'Response header exceeds 64 KiB')
        with self.output_lock:
            sys.stdout.buffer.write(struct.pack('!I', len(encoded)))
            sys.stdout.buffer.write(encoded)
            sys.stdout.buffer.write(struct.pack('!I', len(payload)))
            sys.stdout.buffer.write(payload)
            sys.stdout.buffer.flush()

    def reply(self, request, result=None, payload=b'', error=None):
        response = dict(v=1, id=request.get('id'), ok=error is None)
        if error is not None:
            response['error'] = error
            if len(compact(response)) > HEADER_LIMIT:
                payload = compact(error)
                response['error'] = {k: error[k] for k in ('code', 'message', 'retryable') if k in error}
                response['error']['errorInPayload'] = True
        else:
            response['result'] = result
            if len(compact(response)) > HEADER_LIMIT:
                require(not payload, 'PROTOCOL_LIMIT', 'Response header exceeds limit')
                payload = compact(result)
                response['result'] = dict(resultInPayload=True)
        if len(payload) > PAYLOAD_LIMIT:
            response = dict(v=1, id=request.get('id'), ok=False,
                            error=dict(code='PROTOCOL_LIMIT', message='Response exceeds bounded payload; request a smaller page', retryable=False))
            payload = b''
        self.frame(response, payload)

    def check_root(self):
        require(self.root is not None, 'WORKSPACE_CLOSED', 'Open a workspace first')
        try:
            info = self.root.stat()
            valid = self.root.resolve(strict=True) == self.root and (info.st_dev, info.st_ino) == self.root_identity
        except OSError:
            valid = False
        require(valid, 'WORKSPACE_ROOT_CHANGED', 'Workspace canonical root changed')

    def path(self, relative, internal=False, missing=False):
        self.check_root()
        require(isinstance(relative, str) and '\x00' not in relative and '\\' not in relative,
                'INVALID_PATH', 'Expected a normalized relative POSIX path')
        require(not relative.startswith('/') and ':' not in relative,
                'INVALID_PATH', 'Absolute, drive and alternate-stream paths are forbidden', path=relative)
        parts = relative.split('/') if relative else []
        require(all(p not in ('', '.', '..') for p in parts), 'INVALID_PATH', 'Invalid path component', path=relative)
        require(internal or not parts or parts[0].casefold() not in PRIVATE_STATE_NAMES, 'PATH_RESERVED', 'Application state is not a source file', path=relative)
        candidate = self.root.joinpath(*parts)
        resolved = candidate.resolve(strict=not missing)
        require(resolved == self.root or self.root in resolved.parents,
                'PATH_OUTSIDE_ROOT', 'Canonical path escapes workspace', path=relative)
        if missing:
            parent = candidate.parent
            require(parent.exists() and parent.is_dir(), 'NOT_FOUND', 'Parent directory does not exist', path=relative)
            resolved_parent = parent.resolve(strict=True)
            require(resolved_parent == self.root or self.root in resolved_parent.parents,
                    'PATH_OUTSIDE_ROOT', 'Parent escapes workspace', path=relative)
        return candidate

    def state_path(self, relative, directory=False):
        self.check_root()
        parts = (STATE_NAME + '/' + relative).strip('/').split('/')
        current = self.root
        for part in parts if directory else parts[:-1]:
            current = current / part
            if not current.exists():
                current.mkdir(mode=0o700)
            require(not current.is_symlink() and current.is_dir(), 'PATH_OUTSIDE_ROOT', 'Application state directory must not be a symlink')
        return self.path('/'.join(parts), internal=True, missing=not directory)

    def relative(self, path):
        resolved = pathlib.Path(path).resolve(strict=True)
        require(resolved == self.root or self.root in resolved.parents, 'PATH_OUTSIDE_ROOT', 'Path escapes workspace')
        return resolved.relative_to(self.root).as_posix()

    def revision(self, path, data=None):
        info = path.stat()
        return dict(sha256=digest(data) if data is not None else file_hash(path),
                    byteLength=info.st_size, modifiedNs=str(info.st_mtime_ns))
    def agent_path(self, relative, allow_new=False, write=False):
        path = self.path(relative, internal=True, missing=allow_new)
        canonical = path.resolve(strict=not allow_new).relative_to(self.root).as_posix()
        parts = [p.casefold() for p in pathlib.PurePosixPath(canonical).parts]
        name = parts[-1] if parts else ''
        denied_dirs = {'.git', '.ssh', '.aws', '.azure', '.gnupg', 'credentials'}
        denied_names = {'auth.json', 'credentials.json', '.credentials.json', 'id_rsa', 'id_ed25519', 'id_ecdsa'}
        private_state = any(p in PRIVATE_STATE_NAMES for p in parts)
        require(not any(p in denied_dirs or p.startswith('.env') for p in parts)
                and name not in denied_names and pathlib.PurePosixPath(name).suffix not in {'.pem', '.key', '.p12', '.pfx'}
                and not private_state,
                'READ_DENIED', 'Agent access to private credentials or application state is forbidden', path=relative)
        if write:
            require(not private_state and pathlib.PurePosixPath(canonical).suffix.lower() in PAPER_SUFFIXES,
                    'WRITE_NOT_ALLOWED', 'Canonical proposal target is not a writable TeX file', path=relative)
        return path

    def canonical_path(self, args, cancel, payload):
        path = self.path(args.get('path'), internal=True, missing=bool(args.get('allowNew')))
        return dict(path=path.resolve(strict=not args.get('allowNew')).relative_to(self.root).as_posix()), b''


    def changed(self):
        self.generation += 1
        if self.build_state.get('manifest'):
            self.build_state['stale'] = True
        with self.build_queue_lock:
            if self.active_build_args is not None and not self.build_cancel.is_set():
                self.pending_build = dict(self.active_build_args)

    def canceled(self, cancel):
        require(not cancel.is_set() and not self.stopping.is_set(), 'CANCELED', 'Operation canceled')

    def hello(self, args, cancel, payload):
        return dict(protocolVersion=1, protocol=1, os=sys.platform, python=sys.version.split()[0],
                    home=str(pathlib.Path.home()), tools={name: shutil.which(name) for name in
                    ('latexmk', 'pdflatex', 'xelatex', 'lualatex', 'synctex')},
                    limits=dict(header=HEADER_LIMIT, payload=PAYLOAD_LIMIT, inFlight=8)), b''

    def open_root(self, args, cancel, payload):
        with self.mutations:
            raw = args.get('root')
            require(isinstance(raw, str) and os.path.isabs(raw) and '\x00' not in raw,
                    'INVALID_PATH', 'Root must be an absolute host path')
            root = pathlib.Path(raw).expanduser().resolve(strict=True)
            require(root.is_dir(), 'NOT_DIRECTORY', 'Workspace root is not a directory')
            if self.root is not None:
                self.check_root()
                require(self.registration_open and root == self.root and integer(args.get('epoch'), 1) == self.epoch,
                        'WORKSPACE_ALREADY_OPEN', 'Only the initial canonical identity registration is permitted')
                self.workspace_id = token(args.get('workspaceId'))
                self.registration_open = False
                return dict(id=self.workspace_id, workspaceId=self.workspace_id, root=str(root), epoch=self.epoch), b''
            migrate_metadata(root)
            self.root = root
            info = root.stat()
            self.root_identity = (info.st_dev, info.st_ino)
            self.workspace_id = token(args.get('workspaceId'))
            self.epoch = integer(args.get('epoch'), 1)
            self.state_path('transactions', directory=True)
            ignore = self.state_path('.gitignore')
            if not ignore.exists():
                atomic(ignore, b'build/\ntransactions/\ntrash/\nrecovery/\nindex/\nuploads/\nagent*/\n', 0o644)
            self.recover_transactions()
            saved = load_json(self.state_path('build/status.json'))
            if isinstance(saved, dict):
                self.build_state = saved
                if self.build_state.get('status') in ('running', 'queued'):
                    self.build_state['status'] = 'interrupted'
            project, _ = self.project_read({}, cancel, b'')
            self.main_tex = project.get('rootTex')
            return dict(id=self.workspace_id, workspaceId=self.workspace_id, root=str(root), epoch=self.epoch), b''

    def list_dir(self, args, cancel, payload):
        relative = args.get('path', '')
        path = self.agent_path(relative) if args.get('_agentPolicy') else self.path(relative)
        require(path.is_dir(), 'NOT_DIRECTORY', 'Not a directory', path=relative)
        offset = integer(args.get('offset'))
        limit = integer(args.get('limit'), 256, 256)
        entries = []
        evidence = []
        with os.scandir(path) as listing:
            for item in listing:
                self.canceled(cancel)
                if len(entries) >= 20000:
                    raise Failure('DIRECTORY_LIMIT', 'Directory exceeds 20,000 entries; use a narrower project root')
                child = relative + '/' + item.name if relative else item.name
                if args.get('_agentPolicy'):
                    try:
                        self.agent_path(child)
                    except (OSError, Failure):
                        continue
                symlink = item.is_symlink()
                directory = item.is_dir(follow_symlinks=False)
                kind = 'symlink' if symlink else 'directory' if directory else 'file'
                if not symlink and not directory and pathlib.Path(item.name).suffix.lower() in PAPER_SUFFIXES:
                    evidence.append(item.name)
                entries.append(dict(path=child, name=item.name, kind=kind,
                                    byteLength=None if directory else item.stat(follow_symlinks=False).st_size,
                                    paper='unknown' if directory else 'none', main=child == self.main_tex, evidence=[]))
        entries.sort(key=lambda item: (item['kind'] != 'directory', [int(p) if p.isdigit() else p.casefold() for p in re.split(r'(\d+)', item['name'])]))
        for entry in entries[offset:offset + limit]:
            if entry['kind'] == 'directory':
                mark = self.paper_mark(entry['path'])
                entry.update(paper=mark.get('paper', 'unknown'), evidence=mark.get('evidence', []))
        return dict(entries=entries[offset:offset + limit], total=len(entries), nextOffset=offset + limit if offset + limit < len(entries) else None,
                    paper='direct' if evidence else self.paper_mark(relative).get('paper', 'unknown'), evidence=evidence,
                    modifiedNs=str(path.stat().st_mtime_ns)), b''

    def stat_many(self, args, cancel, payload):
        paths = args.get('paths', [])
        require(isinstance(paths, list) and len(paths) <= 256, 'INVALID_ARGUMENT', 'At most 256 paths per stat request')
        results = []
        for relative in paths:
            self.canceled(cancel)
            try:
                path = self.agent_path(relative) if args.get('_agentPolicy') else self.path(relative)
                info = path.lstat()
                kind = 'symlink' if stat.S_ISLNK(info.st_mode) else 'directory' if stat.S_ISDIR(info.st_mode) else 'file'
                revision = self.revision(path) if kind == 'file' and path.is_file() else None
                results.append(dict(path=relative, kind=kind, byteLength=info.st_size,
                                    modifiedNs=str(info.st_mtime_ns), revision=revision))
            except FileNotFoundError:
                results.append(dict(path=relative, kind='file', byteLength=0, modifiedNs='0', revision=None,
                                    error=dict(code='NOT_FOUND', message='Path does not exist', retryable=False)))
            except Failure as exc:
                results.append(dict(path=relative, kind='file', byteLength=0, modifiedNs='0', revision=None, error=exc.value))
            except OSError as exc:
                results.append(dict(path=relative, kind='file', byteLength=0, modifiedNs='0', revision=None,
                                    error=dict(code='PERMISSION_DENIED' if isinstance(exc, PermissionError) else 'IO_ERROR',
                                               message=str(exc), retryable=False)))
        return dict(entries=results), b''


    def read_range(self, args, cancel, payload):
        relative = args.get('path')
        path = self.agent_path(relative) if args.get('_agentPolicy') else self.path(relative, internal=True)
        require(path.is_file(), 'NOT_FILE', 'Expected a file')
        offset = integer(args.get('offset', args.get('begin')))
        length = integer(args.get('length'), 65536, PAYLOAD_LIMIT)
        if 'end' in args:
            end = integer(args['end'])
            require(end >= offset and end - offset <= PAYLOAD_LIMIT, 'INVALID_RANGE', 'Invalid byte range')
            length = end - offset
        with open(path, 'rb') as stream:
            size = os.fstat(stream.fileno()).st_size
            require(offset <= size, 'INVALID_RANGE', 'Range starts beyond end of file')
            stream.seek(offset)
            data = stream.read(length)
        return dict(path=relative, offset=offset, byteLength=len(data), totalLength=size, eof=offset + len(data) >= size), data

    def read_text(self, args, cancel, payload):
        relative = args.get('path')
        path = self.agent_path(relative) if args.get('_agentPolicy') else self.path(relative)
        require(path.is_file(), 'NOT_FILE', 'Expected a source file')
        size = path.stat().st_size
        truncated = size > TEXT_LIMIT and not args.get('allowLargeFile')
        import codecs
        decoder = codecs.getincrementaldecoder('utf-8-sig')('strict')
        h = hashlib.sha256()
        crlf = lf = bare_cr = 0
        previous_cr = False
        prefix = b''
        unsupported = False
        controls = 0
        total_read = 0
        with open(path, 'rb') as stream:
            info = os.fstat(stream.fileno())
            while True:
                self.canceled(cancel)
                chunk = stream.read(65536)
                if not chunk:
                    break
                if len(prefix) < PAYLOAD_LIMIT:
                    prefix += chunk[:PAYLOAD_LIMIT - len(prefix)]
                legacy_utf16 = prefix.startswith((b'\xff\xfe', b'\xfe\xff'))
                if not legacy_utf16:
                    require(not prefix.startswith((b'%PDF-', b'\x89PNG\r\n\x1a\n', b'\xff\xd8\xff',
                                                   b'PK\x03\x04', b'PK\x05\x06', b'PK\x07\x08', b'\x7fELF'))
                            and b'\x00' not in chunk,
                            'BINARY_FILE', 'This file is binary; use metadata, preview or export', path=relative)
                total_read += len(chunk)
                controls += sum(b < 32 and b not in (9, 10, 12, 13) for b in chunk)
                h.update(chunk)
                if not unsupported:
                    try:
                        decoder.decode(chunk)
                    except UnicodeError:
                        unsupported = True
                if previous_cr and chunk.startswith(b'\n'):
                    crlf += 1
                    bare_cr -= 1
                crlf += chunk.count(b'\r\n')
                lf += chunk.count(b'\n')
                bare_cr += chunk.count(b'\r') - chunk.count(b'\r\n')
                previous_cr = chunk.endswith(b'\r')
            if not unsupported:
                try:
                    decoder.decode(b'', final=True)
                except UnicodeError:
                    unsupported = True
            after = os.fstat(stream.fileno())
        require(prefix.startswith((b'\xff\xfe', b'\xfe\xff')) or controls * 100 <= total_read,
                'BINARY_FILE', 'This file contains binary control data; use metadata or export', path=relative)
        require((info.st_size, info.st_mtime_ns, info.st_ctime_ns) == (after.st_size, after.st_mtime_ns, after.st_ctime_ns),
                'FILE_CONFLICT', 'Source changed while reading; retry', path=relative, retryable=True)
        bom = prefix.startswith(b'\xef\xbb\xbf')
        newline = 'mixed' if bare_cr or (crlf and lf != crlf) else 'crlf' if crlf else 'lf'
        metadata = dict(file=dict(workspaceId=self.workspace_id, path=relative),
                        revision=dict(sha256=h.hexdigest(), byteLength=info.st_size, modifiedNs=str(info.st_mtime_ns)),
                        encoding='unsupported' if unsupported else 'utf8Bom' if bom else 'utf8', newline=newline,
                        readOnly=truncated or unsupported, textInPayload=True, textOffset=3 if bom else 0,
                        textByteLength=info.st_size - (3 if bom else 0),
                        chunkedText=info.st_size > PAYLOAD_LIMIT and not truncated and not unsupported,
                        truncated=truncated or (unsupported and info.st_size > PAYLOAD_LIMIT), largeFile=size > TEXT_LIMIT)
        raw = prefix[3:] if bom else prefix
        if unsupported:
            metadata['warning'] = dict(code='ENCODING_UNSUPPORTED',
                                       message='Display is lossy; create a converted copy explicitly to edit')
            raw = raw.decode('utf-8', errors='replace').encode('utf-8')[:PAYLOAD_LIMIT]
            raw = raw.decode('utf-8', errors='ignore').encode('utf-8')
        elif truncated:
            try:
                raw.decode('utf-8')
            except UnicodeDecodeError as exc:
                require(exc.end == len(raw), 'ENCODING_UNSUPPORTED', 'Invalid UTF-8 source')
                raw = raw[:exc.start]
        return metadata, raw


    def text_bytes(self, text, original=b'', encoding=None, newline=None):
        require(isinstance(text, str), 'INVALID_ARGUMENT', 'Text must be a string')
        require(not binary_bytes(original), 'BINARY_FILE', 'Cannot save over a binary file; create a converted copy explicitly')
        try:
            old = original.decode('utf-8-sig')
        except UnicodeError:
            raise Failure('ENCODING_UNSUPPORTED', 'Cannot overwrite a non-UTF-8 file')
        crlf = old.count('\r\n')
        remaining = old.replace('\r\n', '')
        lf = remaining.count('\n')
        cr = remaining.count('\r')
        if crlf and not lf and not cr:
            text = text.replace('\r\n', '\n').replace('\n', '\r\n')
        elif lf and not crlf and not cr:
            text = text.replace('\r\n', '\n')
        elif cr and not crlf and not lf:
            text = text.replace('\r\n', '\n').replace('\n', '\r')
        elif sum(bool(n) for n in (crlf, lf, cr)) > 1:
            old_lines = old.splitlines(keepends=True)
            new_lines = text.splitlines(keepends=True)
            import difflib
            for block in difflib.SequenceMatcher(a=[x.rstrip('\r\n') for x in old_lines],
                                                b=[x.rstrip('\r\n') for x in new_lines]).get_matching_blocks():
                for j in range(block.size):
                    before = old_lines[block.a + j]
                    after = new_lines[block.b + j]
                    if after.endswith(('\n', '\r')) and before.endswith(('\n', '\r')):
                        ending = '\r\n' if before.endswith('\r\n') else before[-1]
                        new_lines[block.b + j] = after.rstrip('\r\n') + ending
            text = ''.join(new_lines)
        elif not original and newline == 'crlf':
            text = text.replace('\r\n', '\n').replace('\n', '\r\n')
        bom = original.startswith(b'\xef\xbb\xbf') or (not original and encoding == 'utf8Bom')
        return (b'\xef\xbb\xbf' if bom else b'') + text.encode('utf-8')


    def transaction_dir(self, transaction_id):
        return self.state_path('transactions/' + token(transaction_id), directory=True)

    def journal(self, directory, value):
        atomic(directory / 'journal.json', compact(value))

    def apply_files(self, transaction_id, changes, summary='', update_comments=True):
        directory = self.transaction_dir(transaction_id)
        previous = load_json(directory / 'journal.json')
        fingerprint = digest(compact([dict(path=c['path'], baseSha256=c.get('baseSha256'), action=c['action'], resultSha256=digest(c['data']) if c['data'] is not None else None) for c in changes]))
        if previous:
            require(previous.get('fingerprint') == fingerprint, 'TRANSACTION_ID_REUSED', 'Transaction ID was already used for different edits')
            require(previous.get('status') == 'committed', 'TRANSACTION_UNRESOLVED', 'Existing transaction needs recovery', details=previous)
            return previous['result']
        changes = list(changes)
        if update_comments and not any(c['path'] == '.texypaper/comments.json' for c in changes):
            comment_change = self.reanchor_changes(changes)
            if comment_change:
                changes.append(comment_change)
        records = []
        for index, change in enumerate(changes):
            path = self.path(change['path'], internal=change.get('internal', False), missing=change['action'] == 'create')
            require(not path.is_symlink(), 'INVALID_PATH', 'Mutations require a direct file, not a symlink', path=change['path'])
            exists = path.exists()
            require(change['action'] != 'create' or not exists, 'FILE_CONFLICT', 'Create destination already exists', path=change['path'])
            require(change['action'] == 'create' or path.is_file(), 'NOT_FILE', 'Expected an existing file', path=change['path'])
            before = path.read_bytes() if exists else None
            base = digest(before) if before is not None else None
            require(change.get('baseSha256') == base, 'FILE_CONFLICT', 'File changed since it was read', path=change['path'],
                    details=dict(revision=self.revision(path, before)) if exists else dict(exists=False))
            mode = stat.S_IMODE(path.stat().st_mode) if exists else 0o644
            record = dict(path=change['path'], action=change['action'], beforeSha256=base,
                          afterSha256=digest(change['data']) if change['data'] is not None else None,
                          afterByteLength=len(change['data']) if change['data'] is not None else 0,
                          beforeFile=str(index) + '.before' if exists else None,
                          afterFile=str(index) + '.after' if change['data'] is not None else None,
                          mode=mode, internal=change.get('internal', False))
            if exists:
                atomic(directory / record['beforeFile'], before)
            if change['data'] is not None:
                atomic(directory / record['afterFile'], change['data'])
            records.append(record)
        journal = dict(version=1, transactionId=transaction_id, fingerprint=fingerprint, summary=summary,
                       status='prepared', createdAt=now(), files=records, applied=[])
        self.journal(directory, journal)
        try:
            for index, record in enumerate(records):
                path = self.path(record['path'], internal=record['internal'], missing=record['action'] == 'create')
                current = file_hash(path) if path.exists() else None
                require(current == record['beforeSha256'], 'FILE_CONFLICT', 'File changed immediately before replacement', path=record['path'])
                journal['status'] = 'applying'
                journal['nextIndex'] = index
                self.journal(directory, journal)
                if record['afterFile'] is None:
                    path.unlink()
                    fsync_dir(path.parent)
                else:
                    atomic(path, (directory / record['afterFile']).read_bytes(), record['mode'])
                journal['applied'].append(index)
                self.journal(directory, journal)
        except BaseException:
            self.rollback(directory, journal)
            raise
        revisions = []
        for record in records:
            modified_ns = '0'
            try:
                modified_ns = str(self.path(record['path'], internal=record['internal']).stat().st_mtime_ns)
            except (OSError, Failure):
                pass
            revision = None if record['afterSha256'] is None else dict(
                sha256=record['afterSha256'], byteLength=record['afterByteLength'], modifiedNs=modified_ns)
            revisions.append(dict(path=record['path'], revision=revision))
        result = dict(transactionId=transaction_id, status='committed', paths=[r['path'] for r in records], revisions=revisions)
        journal.update(status='committed', finishedAt=now(), result=result)
        journal.pop('nextIndex', None)
        self.journal(directory, journal)
        if any(not r['internal'] for r in records):
            self.changed()
        self.prune_transactions()
        return result
    def prune_transactions(self):
        successful = []
        root = self.state_path('transactions', directory=True)
        with os.scandir(root) as listing:
            for item in listing:
                if not item.is_dir(follow_symlinks=False) or not IDENT.fullmatch(item.name):
                    continue
                directory = self.state_path('transactions/' + item.name, directory=True)
                journal = load_json(directory / 'journal.json')
                if journal and journal.get('status') == 'committed' and journal.get('files'):
                    successful.append((journal.get('finishedAt', ''), directory))
        successful.sort(key=lambda item: item[0], reverse=True)
        for _, directory in successful[100:]:
            shutil.rmtree(directory)


    def rollback(self, directory, journal):
        partial = []
        applied = set(journal.get('applied', []))
        if 'nextIndex' in journal:
            applied.add(journal['nextIndex'])
        for index in sorted(applied, reverse=True):
            record = journal['files'][index]
            try:
                path = self.path(record['path'], internal=record.get('internal', False), missing=True)
                current = file_hash(path) if path.exists() else None
                if current == record['beforeSha256']:
                    continue
                if current != record['afterSha256']:
                    partial.append(record['path'])
                    continue
                if record['beforeFile'] is None:
                    path.unlink()
                    fsync_dir(path.parent)
                else:
                    before = (directory / record['beforeFile']).read_bytes()
                    require(digest(before) == record['beforeSha256'], 'JOURNAL_CORRUPT', 'Recovery backup hash does not match')
                    atomic(path, before, record['mode'])
            except (OSError, Failure):
                partial.append(record['path'])
        journal.update(status='partial' if partial else 'rolled_back', affectedPaths=partial)
        self.journal(directory, journal)
        if partial:
            raise Failure('TRANSACTION_PARTIAL', 'Rollback refused to overwrite later external changes', details=dict(transactionId=journal['transactionId'], paths=partial))

    def recover_transactions(self):
        root = self.state_path('transactions', directory=True)
        with os.scandir(root) as listing:
            for item in listing:
                if not item.is_dir(follow_symlinks=False) or not IDENT.fullmatch(item.name):
                    continue
                directory = self.state_path('transactions/' + item.name, directory=True)
                journal = load_json(directory / 'journal.json')
                if journal and journal.get('status') in ('prepared', 'applying'):
                    with contextlib.suppress(Failure):
                        self.rollback(directory, journal)
                elif journal and journal.get('status') == 'move_prepared':
                    try:
                        source = self.path(journal['source'], internal=True, missing=True)
                        destination = self.path(journal['destination'], internal=True, missing=True)
                        if source.exists() and not destination.exists():
                            journal['status'] = 'rolled_back'
                        elif not source.exists() and destination.exists() and self.tree_signature(destination) == journal['signature']:
                            journal.update(status='committed', finishedAt=now(),
                                           result=dict(transactionId=journal['transactionId'], status='committed',
                                                       path=journal['source'], newPath=journal['destination']))
                        else:
                            journal.update(status='partial', affectedPaths=[journal['source'], journal['destination']])
                    except (OSError, Failure):
                        journal.update(status='partial', affectedPaths=[journal['source'], journal['destination']])
                    self.journal(directory, journal)
                elif journal and journal.get('status') == 'directory_prepared':
                    try:
                        path = self.path(journal['path'], missing=True)
                        if not path.exists():
                            journal['status'] = 'rolled_back'
                        elif path.is_dir() and self.tree_signature(path) == journal['signature']:
                            journal.update(status='committed', finishedAt=now(),
                                           result=dict(transactionId=journal['transactionId'], status='committed',
                                                       path=journal['path'], kind='directory'))
                        else:
                            journal.update(status='partial', affectedPaths=[journal['path']])
                    except (OSError, Failure):
                        journal.update(status='partial', affectedPaths=[journal['path']])
                    self.journal(directory, journal)

    def save_text(self, args, cancel, payload):
        with self.mutations:
            self.canceled(cancel)
            relative = args.get('path')
            path = self.path(relative)
            require(path.is_file(), 'NOT_FILE', 'Expected a source file')
            require(path.stat().st_size <= TEXT_LIMIT or args.get('allowLargeFile') is True,
                    'LARGE_FILE_CONSENT_REQUIRED', 'Explicit consent is required for edits above 4 MiB')
            before = path.read_bytes()
            text = args.get('text')
            if text is None:
                text = payload.decode('utf-8')
            data = self.text_bytes(text, before, args.get('encoding'), args.get('newline'))
            result = self.apply_files(token(args.get('transactionId')), [dict(path=relative, baseSha256=args.get('expectedSha256', args.get('baseSha256')), action='modify', data=data)])
            result['revision'] = next(r['revision'] for r in result['revisions'] if r['path'] == relative)
            return result, b''
    def save_text_begin(self, args, cancel, payload):
        with self.mutations:
            self.canceled(cancel)
            self.path(args.get('path'))
            require(len(self.uploads) < 2, 'UPLOAD_BUSY', 'At most two source uploads may be staged', retryable=True)
            total = integer(args.get('totalLength'))
            require(total <= TEXT_LIMIT or args.get('allowLargeFile') is True, 'LARGE_FILE_CONSENT_REQUIRED', 'Explicit consent is required for edits above 4 MiB')
            upload_id = uuid.uuid4().hex
            path = self.state_path('uploads/' + upload_id + '.utf8')
            with open(path, 'xb'):
                pass
            os.chmod(path, 0o600)
            self.uploads[upload_id] = dict(kind='text', args=dict(args), path=path, total=total, received=0)
            return dict(uploadId=upload_id), b''

    def save_text_chunk(self, args, cancel, payload):
        with self.mutations:
            self.canceled(cancel)
            upload = self.uploads.get(token(args.get('uploadId')))
            require(upload is not None, 'UPLOAD_NOT_FOUND', 'Unknown source upload')
            require(upload['kind'] == 'text', 'UPLOAD_KIND', 'This is not a source-text upload')
            offset = integer(args.get('offset'))
            require(offset == upload['received'] and offset + len(payload) <= upload['total'], 'INVALID_RANGE', 'Source upload chunks must be sequential and bounded')
            with open(upload['path'], 'ab') as stream:
                stream.write(payload)
            upload['received'] += len(payload)
            return dict(received=upload['received']), b''

    def save_text_commit(self, args, cancel, payload):
        with self.mutations:
            upload_id = token(args.get('uploadId'))
            upload = self.uploads.get(upload_id)
            require(upload is not None and upload['received'] == upload['total'], 'UPLOAD_INCOMPLETE', 'Source upload is not complete')
            require(upload['kind'] == 'text', 'UPLOAD_KIND', 'This is not a source-text upload')
            data = upload['path'].read_bytes()
            save_args = dict(upload['args'], text=data.decode('utf-8'))
            try:
                return self.save_text(save_args, cancel, b'')
            finally:
                self.uploads.pop(upload_id, None)
                upload['path'].unlink()

    def save_text_abort(self, args, cancel, payload):
        with self.mutations:
            ident = token(args.get('uploadId'))
            upload = self.uploads.get(ident)
            require(upload is None or upload['kind'] in ('text', 'args'), 'UPLOAD_KIND', 'Not a source or argument upload')
            self.uploads.pop(ident, None)
            if upload:
                with contextlib.suppress(FileNotFoundError):
                    upload['path'].unlink()
            return dict(aborted=upload is not None), b''

    def asset_cleanup(self, upload):
        with contextlib.suppress(FileNotFoundError):
            os.unlink(upload['temp'], dir_fd=upload['directory'])
        os.close(upload['directory'])

    def asset_import_begin(self, args, cancel, payload):
        with self.mutations:
            self.canceled(cancel)
            self.check_root()
            for ident, upload in list(self.uploads.items()):
                if upload['kind'] == 'asset' and time.monotonic() - upload['touched'] >= 300:
                    self.uploads.pop(ident)
                    self.asset_cleanup(upload)
            relative = args.get('path')
            require(isinstance(relative, str) and relative and not relative.startswith('/') and '\\' not in relative
                    and ':' not in relative and '\x00' not in relative, 'INVALID_PATH', 'Expected a relative asset path')
            parts = relative.split('/')
            for part in parts:
                stem = part.split('.')[0].upper()
                require(part not in ('', '.', '..') and part.casefold() not in {'.git', *PRIVATE_STATE_NAMES}
                        and not part.endswith((' ', '.')) and not any(ord(c) < 32 or c in '<>"|?*' for c in part)
                        and stem not in ('CON', 'PRN', 'AUX', 'NUL')
                        and re.fullmatch(r'(COM|LPT)[0-9]', stem) is None,
                        'INVALID_PATH', 'Reserved or invalid asset path')
            require(pathlib.PurePosixPath(relative).suffix.lower() in {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.eps', '.svg'},
                    'ASSET_EXTENSION', 'Unsupported image or figure extension')
            require('byteLength' in args, 'INVALID_ARGUMENT', 'byteLength required')
            total = integer(args.get('byteLength'))
            require(total <= 20 * PAYLOAD_LIMIT, 'ASSET_TOO_LARGE', 'Assets must be at most 20 MiB')
            expected = args.get('sha256')
            require(isinstance(expected, str) and HEX.fullmatch(expected), 'INVALID_ARGUMENT', 'Lowercase SHA-256 required')
            require(len(self.uploads) < 2,
                    'UPLOAD_BUSY', 'At most two asset uploads may be staged', retryable=True)
            directory = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            temp = None
            try:
                info = os.fstat(directory)
                require((info.st_dev, info.st_ino) == self.root_identity, 'WORKSPACE_ROOT_CHANGED', 'Workspace root changed')
                # Directory descriptors and O_NOFOLLOW prevent both symlink escapes and parent-swap races.
                for part in parts[:-1]:
                    with contextlib.suppress(FileExistsError):
                        os.mkdir(part, dir_fd=directory)
                    child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
                    os.close(directory)
                    directory = child
                try:
                    os.stat(parts[-1], dir_fd=directory, follow_symlinks=False)
                except FileNotFoundError:
                    pass
                else:
                    raise Failure('ALREADY_EXISTS', 'Asset destination already exists')
                ident = uuid.uuid4().hex
                temp = '.texypaper-asset-' + ident + '.tmp'
                descriptor = os.open(temp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600, dir_fd=directory)
                os.close(descriptor)
                self.uploads[ident] = dict(kind='asset', directory=directory, temp=temp, path=self.root / relative,
                                          relative=relative, name=parts[-1], total=total, received=0, index=0,
                                          sha256=expected, touched=time.monotonic())
                return dict(uploadId=ident), b''
            except BaseException:
                if temp:
                    with contextlib.suppress(FileNotFoundError):
                        os.unlink(temp, dir_fd=directory)
                os.close(directory)
                raise

    def asset_import_chunk(self, args, cancel, payload):
        with self.mutations:
            ident = token(args.get('uploadId'))
            upload = self.uploads.get(ident)
            require(upload is not None and upload['kind'] == 'asset', 'UPLOAD_NOT_FOUND', 'Unknown asset upload')
            try:
                self.canceled(cancel)
                require(time.monotonic() - upload['touched'] < 300, 'UPLOAD_NOT_FOUND', 'Asset upload expired')
                if 'data' in args:
                    encoded = args['data']
                    require(isinstance(encoded, str) and len(encoded) <= 256 * 1024, 'UPLOAD_CHUNK_LIMIT', 'Asset chunk exceeds 192 KiB')
                    try:
                        payload = base64.b64decode(encoded, validate=True)
                    except (ValueError, binascii.Error):
                        raise Failure('INVALID_ARGUMENT', 'Invalid base64 asset chunk')
                require('index' in args, 'INVALID_ARGUMENT', 'index required')
                require(integer(args.get('index')) == upload['index'] and 0 < len(payload) <= 192 * 1024
                        and upload['received'] + len(payload) <= upload['total'],
                        'UPLOAD_SEQUENCE', 'Asset chunks must be sequential and bounded')
                descriptor = os.open(upload['temp'], os.O_WRONLY | os.O_APPEND | os.O_NOFOLLOW, dir_fd=upload['directory'])
                with os.fdopen(descriptor, 'ab') as stream:
                    stream.write(payload)
                upload['received'] += len(payload)
                upload['index'] += 1
                upload['touched'] = time.monotonic()
                return dict(received=upload['received']), b''
            except BaseException:
                self.uploads.pop(ident)
                self.asset_cleanup(upload)
                raise

    def asset_import_commit(self, args, cancel, payload):
        with self.mutations:
            ident = token(args.get('uploadId'))
            upload = self.uploads.get(ident)
            require(upload is not None and upload['kind'] == 'asset', 'UPLOAD_NOT_FOUND', 'Unknown asset upload')
            self.uploads.pop(ident)
            try:
                self.canceled(cancel)
                require(time.monotonic() - upload['touched'] < 300, 'UPLOAD_NOT_FOUND', 'Asset upload expired')
                require(upload['received'] == upload['total'], 'UPLOAD_INCOMPLETE', 'Asset upload is incomplete')
                descriptor = os.open(upload['temp'], os.O_RDONLY | os.O_NOFOLLOW, dir_fd=upload['directory'])
                h = hashlib.sha256()
                with os.fdopen(descriptor, 'rb') as stream:
                    require(os.fstat(stream.fileno()).st_size == upload['total'], 'UPLOAD_INCOMPLETE', 'Asset byte length does not match')
                    for chunk in iter(lambda: stream.read(65536), b''):
                        h.update(chunk)
                    os.fsync(stream.fileno())
                require(h.hexdigest() == upload['sha256'], 'ASSET_HASH_MISMATCH', 'Asset SHA-256 does not match')
                try:
                    # Atomic no-replace publication: rename() would overwrite a competing writer on POSIX.
                    os.link(upload['temp'], upload['name'], src_dir_fd=upload['directory'],
                            dst_dir_fd=upload['directory'], follow_symlinks=False)
                except FileExistsError:
                    raise Failure('ALREADY_EXISTS', 'Asset destination already exists')
                os.fsync(upload['directory'])
                self.generation += 1
                return dict(path=upload['relative'], byteLength=upload['total'], sha256=upload['sha256']), b''
            finally:
                self.asset_cleanup(upload)

    def asset_import_abort(self, args, cancel, payload):
        with self.mutations:
            ident = token(args.get('uploadId'))
            upload = self.uploads.get(ident)
            if upload is not None and upload['kind'] == 'asset':
                self.uploads.pop(ident)
                self.asset_cleanup(upload)
                return dict(aborted=True), b''
            return dict(aborted=False), b''

    def args_begin(self, args, cancel, payload):
        with self.mutations:
            self.canceled(cancel)
            op = args.get('op')
            require(op in ('apply_proposal', 'comments_update'), 'UNKNOWN_OPERATION', 'Multipart arguments support proposals and comments only')
            total = integer(args.get('totalLength'), maximum=8 * PAYLOAD_LIMIT)
            require(len(self.uploads) < 2, 'UPLOAD_BUSY', 'At most two uploads may be staged', retryable=True)
            upload_id = uuid.uuid4().hex
            path = self.state_path('uploads/' + upload_id + '.json')
            with open(path, 'xb'):
                pass
            os.chmod(path, 0o600)
            self.uploads[upload_id] = dict(kind='args', op=op, path=path, total=total, received=0)
            return dict(uploadId=upload_id), b''

    def args_chunk(self, args, cancel, payload):
        with self.mutations:
            self.canceled(cancel)
            upload = self.uploads.get(token(args.get('uploadId')))
            require(upload is not None and upload['kind'] == 'args', 'UPLOAD_NOT_FOUND', 'Unknown argument upload')
            offset = integer(args.get('offset'))
            require(offset == upload['received'] and offset + len(payload) <= upload['total'],
                    'INVALID_RANGE', 'Argument upload chunks must be sequential and bounded')
            with open(upload['path'], 'ab') as stream:
                stream.write(payload)
            upload['received'] += len(payload)
            return dict(received=upload['received']), b''

    def args_execute(self, args, cancel, payload):
        with self.mutations:
            self.canceled(cancel)
            upload_id = token(args.get('uploadId'))
            upload = self.uploads.get(upload_id)
            require(upload is not None and upload['kind'] == 'args' and upload['received'] == upload['total'],
                    'UPLOAD_INCOMPLETE', 'Argument upload is not complete')
            try:
                decoded = json.loads(upload['path'].read_bytes().decode('utf-8'))
                require(isinstance(decoded, dict), 'INVALID_ARGUMENT', 'Uploaded arguments must be an object')
                return getattr(self, upload['op'])(decoded, cancel, b'')
            finally:
                self.uploads.pop(upload_id, None)
                with contextlib.suppress(FileNotFoundError):
                    upload['path'].unlink()

    def args_abort(self, args, cancel, payload):
        return self.save_text_abort(args, cancel, payload)



    def apply_proposal(self, args, cancel, payload):
        files = args.get('files')
        require(isinstance(files, list) and 0 < len(files) <= 16, 'INVALID_ARGUMENT', 'Proposal requires 1–16 files')
        require(isinstance(args.get('summary', ''), str) and len(args.get('summary', '').encode('utf-8')) <= 8192,
                'INVALID_ARGUMENT', 'Proposal summary exceeds 8 KiB')
        require(len({f.get('path') for f in files}) == len(files), 'INVALID_ARGUMENT', 'Duplicate proposal path')
        with self.mutations:
            changes = []
            total = 0
            for item in files:
                self.canceled(cancel)
                relative = item.get('path')
                require(isinstance(relative, str), 'INVALID_ARGUMENT', 'Proposal path must be a string')
                action = item.get('action')
                require(action in ('edit', 'create'), 'INVALID_ARGUMENT', 'Proposal action must be edit or create')
                agent = args.get('_agentPolicy') is True
                if agent:
                    require(pathlib.PurePosixPath(relative).suffix.lower() in PAPER_SUFFIXES,
                            'WRITE_NOT_ALLOWED', 'Proposals may change only TeX/bibliography/style files')
                    path = self.agent_path(relative, allow_new=action == 'create', write=True)
                else:
                    path = self.path(relative, missing=action == 'create')
                    parts = pathlib.PurePosixPath(relative).parts + path.resolve(strict=path.exists()).relative_to(self.root).parts
                    require(not any(part.casefold() in {'.git', *PRIVATE_STATE_NAMES} for part in parts),
                            'PATH_RESERVED', 'Private metadata is not replaceable source', path=relative)
                    require(action != 'edit' or path.stat().st_size <= TEXT_LIMIT,
                            'LARGE_FILE', 'Project replacement cannot edit files over 4 MiB', path=relative)
                original = path.read_bytes() if path.exists() else b''
                content = item.get('content')
                require(isinstance(content, str), 'INVALID_ARGUMENT', 'Proposal content must be a string')
                if agent:
                    data = self.text_bytes(content, original)
                else:
                    require(not binary_bytes(original), 'BINARY_FILE', 'Binary files cannot be overwritten', path=relative)
                    try:
                        original.decode('utf-8-sig')
                    except UnicodeError:
                        raise Failure('ENCODING_UNSUPPORTED', 'Non-UTF-8 source cannot be overwritten', path=relative)
                    data = (b'\xef\xbb\xbf' if original.startswith(b'\xef\xbb\xbf') else b'') + content.encode('utf-8')
                total += len(data)
                maximum = PAYLOAD_LIMIT if agent else 8 * PAYLOAD_LIMIT
                require(total <= maximum, 'PROPOSAL_LIMIT', 'Proposal changed text exceeds bounded upload limit')
                changes.append(dict(path=relative, baseSha256=item.get('baseSha256'), action=action, data=data))
            result = self.apply_files(token(args.get('transactionId')), changes, args.get('summary', ''))
            return dict(transactionId=result['transactionId'], status=result['status'], changed=result['revisions']), b''

    def transaction_status(self, args, cancel, payload):
        transaction_id = token(args.get('transactionId'))
        path = self.state_path('transactions/' + transaction_id + '/journal.json') if (self.root / STATE_NAME / 'transactions' / transaction_id).is_dir() else None
        journal = load_json(path) if path else None
        if journal is None:
            return dict(transactionId=transaction_id, status='unknown', affectedPaths=[], files=[]), b''
        statuses = {'prepared': 'staged', 'applying': 'applying', 'committed': 'committed',
                    'rolled_back': 'rolledBack', 'partial': 'partial', 'move_prepared': 'applying', 'directory_prepared': 'staged'}
        status = 'undone' if journal.get('undoneBy') or journal.get('restoredBy') else statuses.get(journal.get('status'), 'partial')
        files = []
        for record in journal.get('files', []):
            self.canceled(cancel)
            known = True
            try:
                current_path = self.path(record['path'], internal=record.get('internal', False), missing=True)
                current = file_hash(current_path) if current_path.is_file() else None
                known = not current_path.exists() or current_path.is_file()
            except (OSError, Failure):
                current = None
                known = False
            files.append(dict(path=record['path'], beforeSha256=record['beforeSha256'],
                              resultSha256=record['afterSha256'], currentSha256=current,
                              matchesResult=known and current == record['afterSha256'], matchesOriginal=known and current == record['beforeSha256']))
        affected = journal.get('affectedPaths', [f['path'] for f in files])
        if not affected and not files:
            affected = [journal['path']] if 'path' in journal else [p for p in (journal.get('source'), journal.get('destination')) if p]
        return dict(transactionId=transaction_id, status=status, affectedPaths=affected, files=files), b''


    def undo_transaction(self, args, cancel, payload):
        with self.mutations:
            directory = self.transaction_dir(args.get('transactionId'))
            original = load_json(directory / 'journal.json')
            require(original and original['status'] == 'committed', 'TRANSACTION_NOT_UNDOABLE', 'Transaction is not committed')
            require(not original.get('undoneBy'), 'TRANSACTION_NOT_UNDOABLE', 'Transaction was already undone')
            if original.get('kind') in ('rename', 'trash', 'restore'):
                return self.restore(dict(transactionId=original['transactionId'],
                                         restoreTransactionId=args.get('undoTransactionId')), cancel, b'')
            if original.get('kind') == 'create_directory':
                path = self.path(original['path'])
                require(path.is_dir() and self.tree_signature(path) == original['signature'],
                        'FILE_CONFLICT', 'Created directory was changed after this transaction')
                result, _ = self.trash(dict(path=original['path'], transactionId=args.get('undoTransactionId')), cancel, b'')
                original['undoneBy'] = result['transactionId']
                self.journal(directory, original)
                return result, b''
            changes = []
            for record in original['files']:
                data = (directory / record['beforeFile']).read_bytes() if record['beforeFile'] else None
                require(data is None or digest(data) == record['beforeSha256'], 'JOURNAL_CORRUPT', 'Undo backup hash does not match')
                changes.append(dict(path=record['path'], baseSha256=record['afterSha256'], action='delete' if data is None else 'create' if record['afterSha256'] is None else 'modify', data=data, internal=record.get('internal', False)))
            result = self.apply_files(token(args.get('undoTransactionId')), changes, 'Undo ' + original['transactionId'])
            original['undoneBy'] = result['transactionId']
            self.journal(directory, original)
            return dict(transactionId=original['transactionId'], undoTransactionId=result['transactionId'],
                        status='undone', changed=result['revisions']), b''

    def create(self, args, cancel, payload):
        with self.mutations:
            relative = args.get('path')
            path = self.path(relative, missing=True)
            require(not path.exists() and not path.is_symlink(), 'FILE_CONFLICT', 'Destination already exists')
            if args.get('kind') == 'directory':
                transaction_id = token(args.get('transactionId'))
                directory = self.transaction_dir(transaction_id)
                require(not (directory / 'journal.json').exists(), 'TRANSACTION_ID_REUSED', 'Directory transaction already exists')
                journal = dict(version=1, transactionId=transaction_id, kind='create_directory', path=relative,
                               status='directory_prepared', signature=digest(b''), createdAt=now())
                self.journal(directory, journal)
                path.mkdir()
                fsync_dir(path.parent)
                result = dict(transactionId=transaction_id, status='committed', path=relative, kind='directory')
                journal.update(status='committed', result=result, finishedAt=now())
                self.journal(directory, journal)
                self.changed()
                self.invalidate_index()
                return result, b''
            text = args.get('text', args.get('content', ''))
            return self.apply_files(token(args.get('transactionId')), [dict(path=relative, baseSha256=None, action='create', data=self.text_bytes(text))]), b''

    def tree_signature(self, path):
        h = hashlib.sha256()
        if path.is_symlink():
            raise Failure('INVALID_PATH', 'Cannot mutate a symlink')
        if path.is_file():
            return file_hash(path)
        for current, dirs, files in os.walk(path, followlinks=False):
            dirs.sort()
            files.sort()
            for name in dirs + files:
                child = pathlib.Path(current) / name
                require(not child.is_symlink(), 'INVALID_PATH', 'Directory mutation contains a symlink')
                h.update(compact([child.relative_to(path).as_posix(), 'directory' if child.is_dir() else 'file',
                                  None if child.is_dir() else file_hash(child)]) + b'\n')
        return h.hexdigest()

    def move(self, source, destination, transaction_id, kind):
        directory = self.transaction_dir(transaction_id)
        previous = load_json(directory / 'journal.json')
        source_rel = source.relative_to(self.root).as_posix()
        dest_rel = destination.relative_to(self.root).as_posix()
        if previous:
            require(previous.get('source') == source_rel and previous.get('destination') == dest_rel and previous.get('status') == 'committed', 'TRANSACTION_ID_REUSED', 'Move transaction already exists')
            return previous['result']
        require(not destination.exists() and not destination.is_symlink(), 'FILE_CONFLICT', 'Move destination already exists')
        signature = self.tree_signature(source)
        journal = dict(version=1, transactionId=transaction_id, kind=kind, source=source_rel,
                       destination=dest_rel, signature=signature, status='move_prepared', createdAt=now())
        self.journal(directory, journal)
        moved = False
        try:
            require(self.tree_signature(source) == signature, 'FILE_CONFLICT', 'Move source changed before replacement')
            require(not destination.exists() and not destination.is_symlink(), 'FILE_CONFLICT', 'Move destination appeared')
            os.rename(source, destination)
            moved = True
            fsync_dir(source.parent)
            fsync_dir(destination.parent)
            result = dict(transactionId=transaction_id, status='committed', path=source_rel, newPath=dest_rel)
            journal.update(status='committed', result=result, finishedAt=now())
            self.journal(directory, journal)
        except BaseException:
            partial = False
            if moved:
                try:
                    require(not source.exists() and not source.is_symlink() and self.tree_signature(destination) == signature,
                            'FILE_CONFLICT', 'Cannot roll back a move over subsequent edits')
                    os.rename(destination, source)
                    fsync_dir(source.parent)
                    fsync_dir(destination.parent)
                except (OSError, Failure):
                    partial = True
            journal.update(status='partial' if partial else 'rolled_back',
                           affectedPaths=[source_rel, dest_rel] if partial else [])
            self.journal(directory, journal)
            if partial:
                raise Failure('TRANSACTION_PARTIAL', 'Move rollback preserved later external changes',
                              details=dict(transactionId=transaction_id, paths=[source_rel, dest_rel]))
            raise
        self.changed()
        return result

    def rename(self, args, cancel, payload):
        with self.mutations:
            source = self.path(args.get('path'))
            require(source != self.root, 'INVALID_PATH', 'Cannot rename workspace root')
            destination = self.path(args.get('to', args.get('newPath')), missing=True)
            result = self.move(source, destination, token(args.get('transactionId')), 'rename')
            self.invalidate_index()
            return result, b''

    def trash(self, args, cancel, payload):
        with self.mutations:
            source = self.path(args.get('path'))
            require(source != self.root, 'INVALID_PATH', 'Cannot trash workspace root')
            transaction_id = token(args.get('transactionId'))
            trash_dir = self.state_path('trash/' + transaction_id, directory=True)
            result = self.move(source, trash_dir / source.name, transaction_id, 'trash')
            self.invalidate_index()
            return result, b''

    def restore(self, args, cancel, payload):
        with self.mutations:
            directory = self.transaction_dir(args.get('transactionId'))
            journal = load_json(directory / 'journal.json')
            require(journal and journal.get('kind') in ('trash', 'rename', 'restore') and journal.get('status') == 'committed', 'TRANSACTION_NOT_UNDOABLE', 'No completed move to restore')
            source = self.path(journal['destination'], internal=True)
            destination = self.path(journal['source'], internal=journal['source'].startswith(STATE_NAME + '/'), missing=True)
            require(self.tree_signature(source) == journal['signature'], 'FILE_CONFLICT', 'Moved content was changed')
            result = self.move(source, destination, token(args.get('restoreTransactionId')), 'restore')
            journal['restoredBy'] = result['transactionId']
            self.journal(directory, journal)
            self.invalidate_index()
            return result, b''

    def paper_mark(self, relative):
        key = digest(relative.encode('utf-8'))
        return load_json(self.state_path('index/marks/' + key + '.json'), {})

    def save_paper_mark(self, relative, mark):
        key = digest(relative.encode('utf-8'))
        atomic(self.state_path('index/marks/' + key + '.json'), compact(mark))

    def invalidate_index(self):
        marks = self.state_path('index/marks', directory=True)
        shutil.rmtree(marks)
        marks.mkdir(mode=0o700)
        atomic(self.state_path('index/frontier.jsonl'), compact('') + b'\n')
        atomic(self.state_path('index/scan.json'),
               compact(dict(version=1, frontierOffset=0, frontierLength=1, current=None,
                            offset=0, complete=False, visited=0, totalScanned=0)))


    def scan_step(self, args, cancel, payload):
        with self.mutations:
            scan_path = self.state_path('index/scan.json')
            frontier = self.state_path('index/frontier.jsonl')
            state = load_json(scan_path)
            if state is None or args.get('reset') or 'frontierOffset' not in state:
                self.invalidate_index()
                state = load_json(scan_path)
            marks = {}
            def get_mark(relative):
                if relative not in marks:
                    marks[relative] = self.paper_mark(relative)
                return marks[relative]
            def save_marks():
                for relative, mark in marks.items():
                    self.save_paper_mark(relative, mark)
            def positive_ancestors(relative):
                ancestor = pathlib.PurePosixPath(relative)
                while str(ancestor) != '.':
                    ancestor = ancestor.parent
                    key = '' if str(ancestor) == '.' else ancestor.as_posix()
                    if get_mark(key).get('paper') != 'direct':
                        marks[key] = dict(paper='descendant', evidence=[])
            budget = integer(args.get('budget'), 256, 256)
            if args.get('continue'):
                state['visited'] = 0
            initial = state['totalScanned']
            result = []
            with open(frontier, 'r+b') as pending:
                def check_cancel():
                    if cancel.is_set() or self.stopping.is_set():
                        pending.flush()
                        os.fsync(pending.fileno())
                        atomic(scan_path, compact(state))
                        save_marks()
                        self.canceled(cancel)
                while budget and len(result) < 256 and state['visited'] < 20000:
                    check_cancel()
                    if state['current'] is None:
                        pending.seek(state['frontierOffset'])
                        line = pending.readline(65537)
                        require(len(line) <= 65536, 'INVALID_DATA', 'Invalid persistent scan frontier')
                        if not line:
                            state['complete'] = True
                            break
                        state['frontierOffset'] = pending.tell()
                        state['frontierLength'] = max(0, state['frontierLength'] - 1)
                        state.update(current=json.loads(line), offset=0, evidence=[])
                    relative = state['current']
                    try:
                        path = self.path(relative)
                        require(not path.is_symlink(), 'INVALID_PATH', 'Scans do not traverse symlinks')
                        exhausted = True
                        with os.scandir(path) as listing:
                            for index, item in enumerate(listing):
                                if index < state['offset']:
                                    continue
                                if not budget or state['visited'] >= 20000:
                                    exhausted = False
                                    break
                                check_cancel()
                                state['offset'] = index + 1
                                state['visited'] += 1
                                state['totalScanned'] += 1
                                budget -= 1
                                child = relative + '/' + item.name if relative else item.name
                                if item.is_symlink():
                                    continue
                                if item.is_dir(follow_symlinks=False) and item.name not in EXCLUDED:
                                    pending.seek(0, os.SEEK_END)
                                    pending.write(compact(child) + b'\n')
                                    state['frontierLength'] += 1
                                elif item.is_file(follow_symlinks=False) and pathlib.Path(item.name).suffix.lower() in PAPER_SUFFIXES:
                                    if len(state['evidence']) < 256:
                                        state['evidence'].append(item.name)
                        if exhausted:
                            evidence = state['evidence']
                            mark = dict(paper='direct' if evidence else 'descendant' if get_mark(relative).get('paper') == 'descendant' else 'none', evidence=evidence)
                            marks[relative] = mark
                            result.append(dict(path=relative, **mark))
                            if evidence:
                                positive_ancestors(relative)
                            state['current'] = None
                    except FileNotFoundError:
                        state['current'] = None
                    pending.flush()
                os.fsync(pending.fileno())
            if state['current'] is None and state['frontierOffset'] >= frontier.stat().st_size:
                state['complete'] = True
            atomic(scan_path, compact(state))
            if state['current'] is not None and state.get('evidence'):
                relative = state['current']
                marks[relative] = dict(paper='direct', evidence=state['evidence'])
                positive_ancestors(relative)
                if len(result) < 256:
                    result.append(dict(path=relative, **marks[relative]))
            save_marks()
            return dict(entries=result, scanned=state['totalScanned'] - initial, totalScanned=state['totalScanned'],
                        complete=state['complete'], paused=state['visited'] >= 20000 and not state['complete'],
                        visited=state['visited'], frontierLength=state['frontierLength'] + int(state['current'] is not None),
                        exclusions=sorted(EXCLUDED)), b''


    def search_text(self, args, cancel, payload):
        query = args.get('query')
        require(isinstance(query, str) and 0 < len(query.encode('utf-8')) <= 4096,
                'INVALID_ARGUMENT', 'Search requires a bounded nonempty literal query')
        root_relative = args.get('path', '')
        agent = args.get('_agentPolicy') is True
        root = self.agent_path(root_relative) if agent else self.path(root_relative)
        require(not root.is_symlink(), 'INVALID_PATH', 'Search does not recursively traverse symlinks')
        case_sensitive = args.get('caseSensitive', False)
        require(isinstance(case_sensitive, bool), 'INVALID_ARGUMENT', 'caseSensitive must be boolean')
        matcher = re.compile(re.escape(query), 0 if case_sensitive else re.IGNORECASE)
        needle = query if case_sensitive else query.casefold()
        limit = integer(args.get('limit'), 100, 256)
        require(limit > 0, 'INVALID_ARGUMENT', 'Search limit must be positive')
        identity = (str(self.root), self.workspace_id, self.epoch, root_relative, query, case_sensitive, agent)
        with self.search_lock:
            cursor = args.get('cursor')
            if cursor is not None:
                require(isinstance(cursor, str) and IDENT.fullmatch(cursor),
                        'CURSOR_INVALID', 'Invalid search cursor')
                state = self.searches.get(cursor)
                require(state is not None and state['identity'] == identity,
                        'CURSOR_INVALID', 'Search cursor belongs to a different query or workspace')
            else:
                cursor = uuid.uuid4().hex
                state = dict(identity=identity, pending=collections.deque([(root_relative, 0)]))
            results, visited, rendered = [], 0, 0
            start = time.monotonic()
            pending = state['pending']
            while pending:
                self.canceled(cancel)
                if visited >= 20000 or time.monotonic() - start > 0.5:
                    break
                relative, skip = pending.popleft()
                visited += 1
                if any(part.casefold() in {'.git', *PRIVATE_STATE_NAMES}
                       for part in pathlib.PurePosixPath(relative).parts):
                    continue
                try:
                    path = self.agent_path(relative) if agent else self.path(relative)
                    if path.is_symlink():
                        continue
                    if path.is_dir():
                        pending.extend((self.relative(child), 0) for child in sorted(path.iterdir())
                                       if child.name.casefold() not in EXCLUDED and not child.is_symlink())
                        continue
                    if not path.is_file() or path.stat().st_size > TEXT_LIMIT:
                        continue
                    data = path.read_bytes()
                    if binary_bytes(data):
                        continue
                    text = data.decode('utf-8-sig')
                except (Failure, UnicodeError, OSError):
                    continue
                for index, line in enumerate(text.splitlines()):
                    if index < skip:
                        continue
                    position = (line if case_sensitive else line.casefold()).find(needle) if agent else (
                        match.start() if (match := matcher.search(line)) else -1)
                    if position >= 0:
                        excerpt = line[:2000]
                        rendered += len(excerpt.encode('utf-8'))
                        results.append(dict(path=relative, line=index + 1, line1=index + 1,
                                            column=position + 1, text=excerpt))
                    if len(results) >= limit or rendered >= 65536 or time.monotonic() - start > 0.5:
                        pending.appendleft((relative, index + 1))
                        break
                if len(results) >= limit or rendered >= 65536:
                    break
            more = bool(pending)
            if more:
                if cursor not in self.searches and len(self.searches) >= 32:
                    self.searches.pop(next(iter(self.searches)))
                self.searches[cursor] = state
            else:
                self.searches.pop(cursor, None)
            return dict(matches=results, nextCursor=cursor if more else None,
                        truncated=more, incomplete=more, visited=visited), b''

    def validate_threads(self, threads):
        require(isinstance(threads, list) and len(threads) <= 10000, 'INVALID_COMMENTS', 'Invalid comment threads')
        identifiers = set()
        for thread in threads:
            require(isinstance(thread, dict) and isinstance(thread.get('id'), str) and thread['id'] not in identifiers,
                    'INVALID_COMMENTS', 'Comment IDs must be unique strings')
            identifiers.add(thread['id'])
            require(thread.get('status') in ('open', 'resolved', 'orphaned'), 'INVALID_COMMENTS', 'Invalid comment status')
            source = thread.get('source')
            require(source is None or isinstance(source, dict), 'INVALID_COMMENTS', 'Source anchor must be an object')
            if source:
                try:
                    self.path(source.get('path'), missing=True)
                except Failure as exc:
                    if exc.value['code'] != 'NOT_FOUND':
                        raise
                begin = integer(source.get('startByte'))
                end = integer(source.get('endByte'))
                require(end >= begin and isinstance(source.get('baseSha256'), str) and HEX.fullmatch(source['baseSha256']) and all(isinstance(source.get(k), str) for k in ('quote', 'before', 'after')),
                        'INVALID_COMMENTS', 'Invalid source anchor')
            pdf = thread.get('pdf')
            require(pdf is None or isinstance(pdf, dict), 'INVALID_COMMENTS', 'PDF anchor must be an object')
            if pdf:
                require(isinstance(pdf.get('buildId'), str) and isinstance(pdf.get('pdfSha256'), str) and HEX.fullmatch(pdf['pdfSha256']) and integer(pdf.get('page')) >= 1,
                        'INVALID_COMMENTS', 'Invalid PDF anchor')
                rects = pdf.get('rects')
                require(isinstance(rects, list) and len(rects) <= 4096 and all(isinstance(r, list) and len(r) == 4 and all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in r) for r in rects), 'INVALID_COMMENTS', 'Invalid PDF rectangles')
            require(source or pdf, 'INVALID_COMMENTS', 'Comment requires a source or PDF anchor')
            messages = thread.get('messages')
            require(isinstance(messages, list) and all(isinstance(m, dict) and isinstance(m.get('id'), str) and m.get('author') == 'me' and all(isinstance(m.get(k), str) for k in ('text', 'createdAt', 'updatedAt')) for m in messages), 'INVALID_COMMENTS', 'Invalid comment messages')
        require(len(compact(threads)) <= PAYLOAD_LIMIT - 1024, 'COMMENTS_LIMIT', 'Comments exceed 1 MiB')

    def comment_data(self):
        path = self.state_path('comments.json')
        require(not path.exists() or path.stat().st_size <= PAYLOAD_LIMIT, 'COMMENTS_LIMIT', 'Comments file exceeds 1 MiB')
        raw = path.read_bytes() if path.exists() else None
        if raw is None:
            return dict(version=1, revision='', threads=[]), None
        try:
            value = json.loads(raw.decode('utf-8'))
        except (UnicodeError, ValueError):
            raise Failure('INVALID_COMMENTS', 'Comments file is not valid UTF-8 JSON')
        require(isinstance(value, dict) and value.get('version') == 1 and isinstance(value.get('revision'), str),
                'INVALID_COMMENTS', 'Unknown comments schema')
        self.validate_threads(value.get('threads'))
        value['revision'] = digest(raw)
        return value, raw

    def comments_read(self, args, cancel, payload):
        with self.mutations:
            value, raw = self.comment_data()
            changed = self.reanchor_value(value, {})
            if changed:
                value['revision'] = uuid.uuid4().hex
                self.apply_files(token(), [dict(path='.texypaper/comments.json', baseSha256=digest(raw) if raw else None,
                                               action='modify' if raw else 'create', data=compact(value), internal=True)], 'Reanchor comments', update_comments=False)
                value['revision'] = digest(compact(value))
            return value, b''

    def comments_update(self, args, cancel, payload):
        with self.mutations:
            current, raw = self.comment_data()
            require(args.get('expectedRevision', args.get('revision')) == current['revision'], 'FILE_CONFLICT', 'Comments were changed outside this operation', details=dict(revision=current['revision']))
            threads = args.get('threads')
            self.validate_threads(threads)
            value = dict(version=1, revision=uuid.uuid4().hex, threads=threads)
            result = self.apply_files(token(args.get('transactionId')), [dict(path='.texypaper/comments.json', baseSha256=digest(raw) if raw else None,
                        action='modify' if raw else 'create', data=compact(value), internal=True)], 'Update comments', update_comments=False)
            value['revision'] = digest(compact(value))
            return dict(**value, transactionId=result['transactionId']), b''

    def reanchor_value(self, value, originals, replacements=None):
        changed = False
        for thread in value['threads']:
            source = thread.get('source')
            if not source:
                continue
            try:
                if replacements is not None and source['path'] in replacements:
                    data = replacements[source['path']]
                    if data is None:
                        raise FileNotFoundError(source['path'])
                else:
                    path = self.path(source['path'])
                    require(path.stat().st_size <= TEXT_LIMIT, 'FILE_TOO_LARGE', 'Anchor file exceeds limit')
                    data = path.read_bytes()
            except (OSError, Failure):
                if thread['status'] != 'orphaned':
                    thread['status'] = 'orphaned'
                    changed = True
                continue
            sha = digest(data)
            if sha == source['baseSha256']:
                begin, end = source['startByte'], source['endByte']
                quote = source['quote'].encode('utf-8')
                if not (0 <= begin <= end <= len(data) and data[begin:end] == quote):
                    if thread['status'] != 'orphaned':
                        thread['status'] = 'orphaned'
                        changed = True
                continue
            found = None
            original = originals.get(source['path'])
            if original is not None and digest(original) == source['baseSha256']:
                begin, end = source['startByte'], source['endByte']
                prefix = 0
                maximum = min(len(original), len(data))
                while prefix < maximum and original[prefix] == data[prefix]:
                    prefix += 1
                suffix = 0
                while suffix < maximum - prefix and original[-1 - suffix] == data[-1 - suffix]:
                    suffix += 1
                if end <= prefix:
                    found = (begin, end)
                elif begin >= len(original) - suffix:
                    shift = len(data) - len(original)
                    found = (begin + shift, end + shift)
            if found is None:
                quote = source['quote'].encode('utf-8')
                before = source['before'].encode('utf-8')
                after = source['after'].encode('utf-8')
                pattern = before + quote + after
                if pattern:
                    first = data.find(pattern)
                    if first >= 0 and data.find(pattern, first + 1) < 0:
                        found = (first + len(before), first + len(before) + len(quote))
            if found:
                source.update(startByte=found[0], endByte=found[1], baseSha256=sha)
            else:
                thread['status'] = 'orphaned'
            changed = True
        return changed

    def reanchor_changes(self, changes):
        source_changes = [c for c in changes if not c.get('internal')]
        if not source_changes:
            return None
        value, raw = self.comment_data()
        if raw is None:
            return None
        originals = {}
        for change in source_changes:
            path = self.path(change['path'], missing=change['action'] == 'create')
            if path.is_file():
                originals[change['path']] = path.read_bytes()
        replacements = {c['path']: c['data'] for c in source_changes}
        if self.reanchor_value(value, originals, replacements):
            value['revision'] = uuid.uuid4().hex
            return dict(path='.texypaper/comments.json', baseSha256=digest(raw), action='modify',
                        data=compact(value), internal=True)
        return None


    def project_read(self, args, cancel, payload):
        value = load_json(self.state_path('project.json'), dict(version=1, rootTex=None, engine='pdflatex', profile='basic', autoBuild=True))
        require(isinstance(value, dict) and value.get('version') == 1, 'INVALID_PROJECT', 'Unknown project settings version')
        require(value.get('engine') in ('pdflatex', 'xelatex', 'lualatex') and value.get('profile') in ('basic', 'project')
                and isinstance(value.get('autoBuild'), bool)
                and (value.get('rootTex') is None or isinstance(value.get('rootTex'), str)),
                'INVALID_PROJECT', 'Invalid project settings')
        return {k: value.get(k) for k in ('version', 'rootTex', 'engine', 'profile', 'autoBuild')}, b''

    def project_update(self, args, cancel, payload):
        with self.mutations:
            value = args.get('settings', args.get('project', args))
            root = value.get('rootTex')
            if root:
                require(self.path(root).is_file() and pathlib.PurePosixPath(root).suffix.lower() in ('.tex', '.ltx'), 'INVALID_ROOT_TEX', 'Root document must be an in-root TeX file')
            require(value.get('engine') in ('pdflatex', 'xelatex', 'lualatex') and value.get('profile') in ('basic', 'project') and isinstance(value.get('autoBuild'), bool), 'INVALID_PROJECT', 'Invalid project settings')
            clean = dict(version=1, rootTex=root, engine=value['engine'], profile=value['profile'], autoBuild=value['autoBuild'])
            path = self.state_path('project.json')
            raw = path.read_bytes() if path.exists() else None
            self.apply_files(token(args.get('transactionId')), [dict(path='.texypaper/project.json', baseSha256=digest(raw) if raw else None, action='modify' if raw else 'create', data=compact(clean), internal=True)], 'Update project settings', update_comments=False)
            self.main_tex = root
            return clean, b''

    def kill_process(self, process):
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            process.wait()
            return
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            process.poll()
            try:
                os.killpg(process.pid, 0)
            except ProcessLookupError:
                process.wait()
                return
            time.sleep(0.05)
        with contextlib.suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGKILL)
        process.wait()


    def run_process(self, argv, cwd, cancel, deadline, log_limit=262144):
        process = subprocess.Popen(argv, cwd=str(cwd), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.STDOUT, start_new_session=True)
        with self.process_lock:
            self.processes.add(process)
        chunks = queue.Queue(maxsize=8)
        done = threading.Event()
        def drain():
            try:
                while True:
                    chunk = process.stdout.read(8192)
                    if not chunk:
                        break
                    while not done.is_set():
                        try:
                            chunks.put(chunk, timeout=0.1)
                            break
                        except queue.Full:
                            pass
            finally:
                process.stdout.close()
        reader = threading.Thread(target=drain, daemon=True)
        reader.start()
        tail = bytearray()
        reason = None
        try:
            while process.poll() is None or reader.is_alive() or not chunks.empty():
                if cancel.is_set() or self.stopping.is_set():
                    reason = 'CANCELED'
                    self.kill_process(process)
                elif time.monotonic() >= deadline:
                    reason = 'BUILD_TIMEOUT'
                    self.kill_process(process)
                try:
                    tail.extend(chunks.get(timeout=0.05))
                    if len(tail) > log_limit:
                        del tail[:-log_limit]
                    if argv[0] == 'latexmk':
                        self.build_state['logTail'] = tail.decode('utf-8', errors='replace')
                except queue.Empty:
                    pass
            code = process.wait()
            text = tail.decode('utf-8', errors='replace')
            if reason:
                raise Failure(reason, 'Process canceled' if reason == 'CANCELED' else 'Process deadline exceeded', details=dict(logTail=text))
            return code, text
        finally:
            done.set()
            if process.poll() is None:
                self.kill_process(process)
            reader.join(timeout=2)
            with self.process_lock:
                self.processes.discard(process)

    def fls_inputs(self, fls, cwd):
        require(fls.stat().st_size <= 16 * PAYLOAD_LIMIT, 'BUILD_ARTIFACT_LIMIT', 'Recorder file exceeds 16 MiB')
        found = set()
        base = cwd
        with open(fls, 'r', encoding='utf-8', errors='replace') as stream:
            for line in stream:
                line = line.rstrip('\r\n')
                if line.startswith('PWD '):
                    candidate = pathlib.Path(line[4:])
                    if candidate.is_absolute():
                        base = candidate
                if not line.startswith('INPUT '):
                    continue
                candidate = pathlib.Path(line[6:])
                if not candidate.is_absolute():
                    candidate = base / candidate
                try:
                    relative = self.relative(candidate)
                    if pathlib.PurePosixPath(relative).parts[0].casefold() not in PRIVATE_STATE_NAMES and candidate.is_file():
                        found.add(relative)
                except (OSError, Failure):
                    pass
                require(len(found) <= 20000, 'BUILD_INPUT_LIMIT', 'Build uses more than 20,000 project inputs')
        return found

    def snapshot_inputs(self, inputs, directory, cancel, deadline):
        records = []
        hashes = {}
        for relative in sorted(inputs):
            path = self.path(relative)
            target = directory / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            h = hashlib.sha256()
            with open(path, 'rb') as source, open(target, 'xb') as dest:
                for chunk in iter(lambda: source.read(65536), b''):
                    self.canceled(cancel)
                    require(not self.build_cancel.is_set(), 'CANCELED', 'Build canceled while snapshotting inputs')
                    require(time.monotonic() < deadline, 'BUILD_TIMEOUT', 'Build deadline exceeded while snapshotting inputs')
                    h.update(chunk)
                    dest.write(chunk)
                dest.flush()
                os.fsync(dest.fileno())
            hashes[relative] = h.hexdigest()
            records.append(dict(path=relative, sha256=h.hexdigest(), snapshotPath=target.relative_to(self.root).as_posix()))
        return records, hashes


    def diagnostics(self, text, cwd, root_tex):
        # Match native parsing: only project locations are clickable; external TeX/package
        # inputs remain inferred errors, not guesses at a line in the root document.
        def driver_summary(message):
            message = message.strip()
            return (message.startswith('Latexmk: Errors, so I did not complete making targets')
                    or message.startswith('Collected error summary')
                    or 'command failed with exit code' in message
                    or ": Command for '" in message and 'gave return code' in message
                    or message.startswith(('bibtex ', 'biber '))
                    and (': Bibtex errors:' in message or ': Biber errors:' in message))

        def driver_path(path, message):
            path = path.replace('\\', '/').lower()
            name = path.rsplit('/', 1)[-1]
            # External texmf-dist/tex/.../*.lua files can be genuine package inputs.
            return (name in ('runscript.tlu', 'latexmk', 'latexmk.pl')
                    or name.endswith(('.tlu', '.lua', '.pl'))
                    and ('command failed with exit code' in message
                         or ('/texlive/' in path or '/texmf-dist/' in path)
                         and ('/bin/' in path or '/scripts/' in path)))

        results, seen = [], set()
        previous = warning = fallback = None

        def append(diagnostic, raw_path=None):
            nonlocal fallback
            noise = (driver_summary(diagnostic['message']) if raw_path is None
                     else driver_path(raw_path, diagnostic['message']))
            if diagnostic['path'] is None and noise:
                if fallback is None and diagnostic['severity'] == 'error':
                    fallback = diagnostic
                return
            diagnostic['message'] = diagnostic['message'][:1500]
            key = compact(diagnostic)
            if key not in seen:
                seen.add(key)
                results.append(diagnostic)

        def inferred(message, severity, number=None):
            return dict(path=None, line=number, message=message, severity=severity, inferred=True)

        for line in text.splitlines():
            match = re.match(r'^(.*):([0-9]+):\s?(.*)$', line)
            location = re.search(r'l\.([0-9]+)\s?(.*)', line)
            if match:
                raw_path, number, message = match.groups()
                try:
                    path = pathlib.Path(raw_path)
                    if not path.is_absolute():
                        path = cwd / path
                    relative = self.relative(path)
                except (OSError, Failure):
                    relative = None
                append(dict(path=relative, line=int(number), line1=int(number), message=message,
                            severity='warning' if 'Warning' in message else 'error',
                            inferred=relative is None), raw_path)
            elif location:
                if previous is not None:
                    append(inferred(previous + ' ' + location.group(2), 'error', int(location.group(1))))
                    previous = None
            elif (driver_summary(line) or 'ERROR -' in line
                    or line.startswith(("I couldn't open database file ", "I couldn't open style file ", 'I found no '))):
                append(inferred(line.strip(), 'error'))
            elif line.startswith('! '):
                previous = line[2:]
            elif ('Warning:' in line or line.startswith(('Warning--', 'Overfull ', 'Underfull ')) or 'WARN -' in line):
                if warning is not None:
                    append(inferred(warning, 'warning'))
                warning = line
            elif warning is not None:
                if line.startswith(('(', ' ')):
                    if len(warning) + len(line) < 8192:
                        warning += ' ' + line.strip()
                else:
                    append(inferred(warning, 'warning'))
                    warning = None
        if previous is not None:
            append(inferred(previous, 'error'))
        if warning is not None:
            append(inferred(warning, 'warning'))
        if fallback is not None and not any(row['severity'] == 'error' for row in results):
            results.append(inferred('LaTeX build failed: ' + fallback['message'].strip(), 'error'))
        return results

    def select_artifacts(self, work, cwd, root_tex):
        candidates = []
        for fls in work.glob('*.fls'):
            pdf = fls.with_suffix('.pdf')
            syncs = [p for p in (fls.with_suffix('.synctex.gz'), fls.with_suffix('.synctex')) if p.is_file()]
            if pdf.is_file() and syncs:
                inputs = self.fls_inputs(fls, cwd)
                if root_tex in inputs:
                    candidates.append((fls.stat().st_mtime_ns, fls, pdf, syncs[0], inputs))
        require(bool(candidates), 'BUILD_ARTIFACT_MISSING', 'No matching PDF, SyncTeX and recorder artifacts were produced')
        candidates.sort(key=lambda item: item[0], reverse=True)
        if len(candidates) > 1:
            require(candidates[0][0] != candidates[1][0], 'BUILD_ARTIFACT_AMBIGUOUS', 'Multiple job artifacts cannot be identified safely')
        return candidates[0][1:]

    def build_start(self, args, cancel, payload):
        with self.build_queue_lock:
            if not self.build_lock.acquire(blocking=False):
                self.pending_build = dict(args)
                return dict(self.build_state, status='queued'), b''
            self.active_build_args = dict(args)
            self.build_cancel.clear()
        build_id = uuid.uuid4().hex
        started = now()
        old_manifest = self.build_state.get('manifest')
        self.build_state = dict(status='running', buildId=build_id, diagnostics=[], logTail='', manifest=old_manifest)
        staging = None
        try:
            root_tex = args.get('rootTex')
            source = self.path(root_tex)
            require(source.is_file() and source.suffix.lower() in ('.tex', '.ltx'), 'INVALID_ROOT_TEX', 'Build root must be a TeX file')
            require('\n' not in source.name and '\r' not in source.name, 'INVALID_ROOT_TEX', 'Unsafe root filename')
            self.main_tex = root_tex
            engine = args.get('engine', 'pdflatex')
            profile = args.get('profile', 'basic')
            require(engine in ('pdflatex', 'xelatex', 'lualatex') and profile in ('basic', 'project'), 'INVALID_ARGUMENT', 'Invalid build engine/profile')
            require(profile != 'project' or args.get('projectTrusted') is True, 'PROJECT_TRUST_REQUIRED', 'Project mode can execute commands; explicit app-owned trust is required')
            require(shutil.which('latexmk') is not None, 'TOOL_MISSING', 'latexmk is not installed on the compilation host')
            require(shutil.which(engine) is not None, 'TOOL_MISSING', engine + ' is not installed on the compilation host')
            timeout = args.get('timeoutSeconds', 120)
            require(isinstance(timeout, (int, float)) and not isinstance(timeout, bool) and math.isfinite(timeout) and 1 <= timeout <= 3600, 'INVALID_ARGUMENT', 'Build timeout must be 1–3600 seconds')
            deadline = time.monotonic() + timeout
            class CombinedCancel:
                def is_set(inner):
                    return cancel.is_set() or self.build_cancel.is_set() or self.stopping.is_set()
            combined_cancel = CombinedCancel()
            cwd = source.parent
            root_id = digest(root_tex.encode('utf-8'))[:24]
            base = self.state_path('build/' + root_id, directory=True)
            work = self.state_path('build/' + root_id + '/work', directory=True)
            staging = self.state_path('build/' + root_id + '/pending/' + build_id, directory=True)
            previous = load_json(base / 'inputs.json', {})
            latest = load_json(base / 'latest.json')
            previous_paths = previous.get('paths', []) if isinstance(previous, dict) else previous
            previous_hashes = previous.get('hashes', {}) if isinstance(previous, dict) else {}
            require(isinstance(previous_paths, list) and len(previous_paths) <= 20000, 'INVALID_DATA', 'Invalid recorded build inputs')
            inputs = {root_tex}
            for relative in previous_paths:
                try:
                    if self.path(relative, missing=True).is_file():
                        inputs.add(relative)
                except Failure as exc:
                    if exc.value['code'] != 'NOT_FOUND':
                        raise
            mapping_ready = False
            log_tail = ''
            diagnostics = []
            records = []
            artifact_tuple = None
            for attempt in range(3):
                self.canceled(cancel)
                require(not self.build_cancel.is_set(), 'CANCELED', 'Build canceled')
                snapshot_dir = staging / ('sources-' + str(attempt))
                snapshot_dir.mkdir()
                with self.mutations:
                    generation = self.generation
                    records, hashes = self.snapshot_inputs(inputs, snapshot_dir, cancel, deadline)
                if attempt == 0 and latest and hashes == previous_hashes and latest.get('engine') == engine and latest.get('profile') == profile:
                    self.build_state['diagnostics'] = load_json(self.path(latest['pdfPath'], internal=True).parent / 'diagnostics.json', [])
                argv = ['latexmk']
                if profile == 'basic':
                    argv.append('-norc')
                argv.append({'pdflatex': '-pdf', 'xelatex': '-pdfxe', 'lualatex': '-pdflua'}[engine])
                if profile == 'basic':
                    argv.append('-' + engine + '=' + engine + ' -no-shell-escape %O %S')
                argv.extend(['-synctex=1', '-interaction=nonstopmode', '-file-line-error', '-recorder', '-outdir=' + str(work)])
                if attempt or hashes != previous_hashes or not latest or not latest.get('mappingReady') or latest.get('engine') != engine or latest.get('profile') != profile:
                    argv.append('-g')
                argv.append('./' + source.name)
                code, output = self.run_process(argv, cwd, combined_cancel, deadline)
                log_tail = (log_tail + output).encode('utf-8')[-262144:].decode('utf-8', errors='replace')
                diagnostics = self.diagnostics(output, cwd, root_tex)
                self.build_state.update(logTail=log_tail, diagnostics=diagnostics)
                require(code == 0, 'BUILD_FAILED', 'latexmk exited with status ' + str(code), details=dict(exitCode=code, diagnostics=diagnostics, logTail=log_tail))
                artifact_tuple = self.select_artifacts(work, cwd, root_tex)
                fls, pdf, sync, actual = artifact_tuple
                log_file = fls.with_suffix('.log')
                if log_file.exists():
                    with open(log_file, 'rb') as stream:
                        stream.seek(max(0, log_file.stat().st_size - 262144))
                        diagnostics = self.diagnostics(output + '\n' + stream.read().decode('utf-8', errors='replace'), cwd, root_tex)
                stable = actual.issubset(inputs) and generation == self.generation
                for relative, sha in hashes.items():
                    try:
                        if file_hash(self.path(relative), combined_cancel, deadline) != sha:
                            stable = False
                    except OSError:
                        stable = False
                    except Failure as exc:
                        if exc.value['code'] in ('CANCELED', 'BUILD_TIMEOUT'):
                            raise
                        stable = False
                if stable:
                    mapping_ready = True
                    if (latest and latest.get('mappingReady') and hashes == previous_hashes and latest.get('engine') == engine
                            and latest.get('profile') == profile and file_hash(pdf, combined_cancel, deadline) == latest['pdfSha256']
                            and file_hash(sync, combined_cancel, deadline) == latest['syncSha256']):
                        retained = self.find_manifest(latest['buildId'])
                        old_diagnostics = load_json(self.path(retained['pdfPath'], internal=True).parent / 'diagnostics.json', diagnostics)
                        self.build_state = dict(status='published', manifest=retained, diagnostics=old_diagnostics,
                                                logTail=log_tail, stale=False)
                        return self.build_state.copy(), b''
                    break
                inputs |= actual
            self.canceled(cancel)
            require(not self.build_cancel.is_set(), 'CANCELED', 'Build canceled before publication')
            fls, pdf, sync, actual = artifact_tuple
            with open(pdf, 'rb') as stream:
                require(stream.read(5) == b'%PDF-', 'BUILD_ARTIFACT_INVALID', 'Produced artifact is not a PDF')
            job_name = pdf.stem
            for artifact in (pdf, sync, fls):
                require(not artifact.is_symlink() and artifact.resolve().parent == work.resolve(), 'BUILD_ARTIFACT_INVALID', 'Artifact must be a direct owned work file')
                with open(artifact, 'rb') as src, open(staging / artifact.name, 'xb') as dest:
                    for chunk in iter(lambda: src.read(65536), b''):
                        require(not combined_cancel.is_set(), 'CANCELED', 'Build canceled while publishing artifacts')
                        require(time.monotonic() < deadline, 'BUILD_TIMEOUT', 'Build deadline exceeded while publishing artifacts')
                        dest.write(chunk)
                    dest.flush()
                    os.fsync(dest.fileno())
            for older_snapshot in staging.glob('sources-*'):
                if older_snapshot != snapshot_dir and older_snapshot.is_dir() and not older_snapshot.is_symlink():
                    shutil.rmtree(older_snapshot)
            if generation != self.generation:
                mapping_ready = False
            for relative, sha in hashes.items():
                try:
                    if file_hash(self.path(relative), combined_cancel, deadline) != sha:
                        mapping_ready = False
                except OSError:
                    mapping_ready = False
                except Failure as exc:
                    if exc.value['code'] in ('CANCELED', 'BUILD_TIMEOUT'):
                        raise
                    mapping_ready = False
            published_parent = self.state_path('build/' + root_id + '/published', directory=True)
            published = published_parent / build_id
            for record in records:
                record['snapshotPath'] = record['snapshotPath'].replace('/pending/' + build_id + '/', '/published/' + build_id + '/', 1)
            manifest = dict(version=1, buildId=build_id, workspaceId=self.workspace_id, rootTex=root_tex,
                            engine=engine, cwd=cwd.relative_to(self.root).as_posix() if cwd != self.root else '',
                            jobName=job_name, startedAt=started, finishedAt=now(), pdfSha256=file_hash(staging / pdf.name, combined_cancel, deadline),
                            syncSha256=file_hash(staging / sync.name, combined_cancel, deadline), sources=records, mappingReady=mapping_ready,
                            pdfPath=(published / pdf.name).relative_to(self.root).as_posix(),
                            syncPath=(published / sync.name).relative_to(self.root).as_posix(), pdfLength=pdf.stat().st_size,
                            profile=profile, inputHashes=hashes)
            if not mapping_ready:
                manifest['mappingReason'] = 'Inputs changed or new dependencies appeared during stabilization'
            with self.mutations:
                self.canceled(cancel)
                require(not self.build_cancel.is_set(), 'CANCELED', 'Build canceled before publication')
                if generation != self.generation:
                    manifest['mappingReady'] = False
                    manifest['mappingReason'] = 'An app-owned mutation occurred before publication'
                atomic(staging / 'diagnostics.json', compact(diagnostics))
                atomic(staging / 'manifest.json', compact(manifest))
                os.rename(staging, published)
                fsync_dir(published_parent)
                atomic(base / 'inputs.json', compact(dict(paths=sorted(actual | {root_tex}), hashes=hashes)))
                atomic(base / 'latest.json', compact(manifest))
                self.build_state = dict(status='published', manifest=manifest, diagnostics=diagnostics,
                                        logTail=log_tail, stale=generation != self.generation)
            generations = sorted((p for p in published_parent.iterdir() if p.is_dir() and not p.is_symlink()), key=lambda p: p.stat().st_mtime_ns, reverse=True)
            for obsolete in generations[2:]:
                shutil.rmtree(obsolete)
            return self.build_state.copy(), b''
        except Failure as exc:
            self.build_state.update(status='canceled' if exc.value['code'] == 'CANCELED' else 'timeout' if exc.value['code'] == 'BUILD_TIMEOUT' else 'failed',
                                    error={k: v for k, v in exc.value.items() if k != 'details'})
            if exc.value.get('details', {}).get('logTail'):
                self.build_state['logTail'] = exc.value['details']['logTail']
            raise
        except Exception as exc:
            self.build_state.update(status='failed', error=dict(code='IO_ERROR', message=str(exc), retryable=False))
            raise
        finally:
            try:
                atomic(self.state_path('build/status.json'), compact(self.build_state))
                if staging is not None and staging.exists() and not staging.is_symlink():
                    shutil.rmtree(staging)
            finally:
                with self.build_queue_lock:
                    self.active_build_args = None
                    self.build_lock.release()
                    pending = self.pending_build
                    self.pending_build = None
                if pending and not self.stopping.is_set() and not self.build_cancel.is_set():
                    def run_pending():
                        try:
                            self.build_start(pending, threading.Event(), b'')
                        except Exception as exc:
                            print('TexyPaper queued build: ' + str(exc), file=sys.stderr, flush=True)
                    thread = threading.Thread(target=run_pending, name='texypaper-queued-build', daemon=True)
                    self.queued_thread = thread
                    thread.start()

    def build_cancel_op(self, args, cancel, payload):
        with self.build_queue_lock:
            self.pending_build = None
            self.build_cancel.set()
        return dict(status='canceling' if self.build_lock.locked() else 'idle'), b''

    def build_status(self, args, cancel, payload):
        state = self.build_state.copy()
        manifest = state.get('manifest')
        if manifest:
            manifest = dict(manifest)
            state['manifest'] = manifest
            stale = False
            hashes = manifest.get('inputHashes', {s['path']: s['sha256'] for s in manifest.get('sources', [])})
            for relative, sha in hashes.items():
                self.canceled(cancel)
                try:
                    if file_hash(self.path(relative), cancel) != sha:
                        stale = True
                        break
                except OSError:
                    stale = True
                    break
                except Failure as exc:
                    if exc.value['code'] == 'CANCELED':
                        raise
                    stale = True
                    break
            state['stale'] = stale
            if stale:
                manifest['mappingReady'] = False
                manifest['mappingReason'] = 'Current sources differ from this published generation'
        return state, b''

    def find_manifest(self, build_id):
        build_id = token(build_id)
        base = self.state_path('build', directory=True)
        for item in base.iterdir():
            if item.is_dir() and not item.is_symlink():
                relative = 'build/' + item.name + '/published/' + build_id + '/manifest.json'
                candidate = item / 'published' / build_id / 'manifest.json'
                if candidate.is_file():
                    return load_json(self.state_path(relative))
        raise Failure('BUILD_NOT_FOUND', 'Immutable build generation is unavailable')

    def artifact_manifest(self, args, cancel, payload):
        return self.find_manifest(args.get('buildId')), b''
    def build_validate(self, args, cancel, payload):
        with self.mutations:
            manifest = self.find_manifest(args.get('buildId'))
            changed = set()
            hashes = manifest.get('inputHashes', {s['path']: s['sha256'] for s in manifest.get('sources', [])})
            checks = [(relative, relative, sha, False) for relative, sha in hashes.items()]
            checks.extend((s['path'], s['snapshotPath'], s['sha256'], True) for s in manifest.get('sources', []))
            checks.extend((manifest[key], manifest[key], manifest[sha], True)
                          for key, sha in (('pdfPath', 'pdfSha256'), ('syncPath', 'syncSha256')))
            for affected, relative, expected, internal in checks:
                self.canceled(cancel)
                try:
                    path = self.path(relative, internal=internal)
                    if not path.is_file() or file_hash(path, cancel) != expected:
                        changed.add(affected)
                except OSError:
                    changed.add(affected)
                except Failure as exc:
                    if exc.value['code'] in ('CANCELED', 'WORKSPACE_ROOT_CHANGED'):
                        raise
                    changed.add(affected)
            return dict(valid=bool(manifest.get('mappingReady')) and not changed,
                        changedPaths=sorted(changed)), b''


    def synctex(self, args, cancel, inverse):
        manifest = self.find_manifest(args.get('buildId'))
        require(manifest.get('mappingReady') is True, 'PDF_STALE',
                'Build mapping is unavailable; rebuild before using SyncTeX')
        require(shutil.which('synctex') is not None, 'TOOL_MISSING', 'SyncTeX is not installed on the compilation host')
        pdf = self.path(manifest['pdfPath'], internal=True)
        sync = self.path(manifest['syncPath'], internal=True)
        require(file_hash(pdf) == manifest['pdfSha256'] and file_hash(sync) == manifest['syncSha256'], 'PDF_STALE', 'Published artifacts were modified')
        cwd = self.path(manifest['cwd'])
        if inverse:
            page = integer(args.get('page', args.get('page1')))
            x, y = args.get('x', args.get('xPt')), args.get('y', args.get('yPt'))
            require(page >= 1 and all(isinstance(v, (int, float)) and math.isfinite(v) for v in (x, y)), 'INVALID_ARGUMENT', 'Invalid SyncTeX PDF coordinates')
            argv = ['synctex', 'edit', '-o', '{}:{}:{}:{}'.format(page, x, y, pdf)]
        else:
            relative = args.get('path', args.get('file'))
            if isinstance(relative, dict):
                relative = relative.get('path')
            source = self.path(relative)
            require(any(s['path'] == relative for s in manifest['sources']), 'SYNC_NO_MATCH', 'Source does not belong to this build snapshot')
            line = integer(args.get('line', args.get('line1')))
            column = integer(args.get('column', args.get('column1')), 0)
            require(line >= 1, 'INVALID_ARGUMENT', 'SyncTeX lines are 1-based')
            argv = ['synctex', 'view', '-i', '{}:{}:{}'.format(line, column, source), '-o', str(pdf)]
        code, output = self.run_process(argv, cwd, cancel, time.monotonic() + 15, 60000)
        require(code == 0, 'SYNC_FAILED', 'SyncTeX command failed', details=dict(output=output))
        active = False
        records = []
        record = None
        for line in output.replace('\r\n', '\n').splitlines():
            if line.strip() == 'SyncTeX result begin':
                active = True
                continue
            if line.strip() == 'SyncTeX result end':
                active = False
                continue
            if not active or ':' not in line:
                continue
            key, value = line.split(':', 1)
            if key == 'Output':
                if record:
                    records.append(record)
                record = {}
            if record is not None:
                record[key] = value.strip()
        if record:
            records.append(record)
        valid = False
        for candidate in records:
            try:
                if inverse:
                    valid = bool(candidate.get('Input')) and int(candidate.get('Line', '0')) >= 1
                else:
                    valid = int(candidate.get('Page', '0')) >= 1 and all(
                        math.isfinite(float(candidate[k])) for k in ('h', 'v', 'W', 'H'))
            except (KeyError, ValueError, OverflowError):
                valid = False
            if valid:
                break
        require(valid, 'SYNC_NO_MATCH', 'SyncTeX returned no valid matching records')
        return dict(output=output), b''

    def command_snapshot(self, record):
        result = {key: record[key] for key in ('id', 'status', 'exitCode', 'truncated')}
        result['stdout'] = bytes(record['stdout']).decode('utf-8', errors='replace')
        result['stderr'] = bytes(record['stderr']).decode('utf-8', errors='replace')
        if record.get('error'):
            result['error'] = dict(record['error'])
        return result

    def command_start(self, args, cancel, payload):
        command_id = token(args.get('id'))
        argv = args.get('argv')
        require(isinstance(argv, list) and 1 <= len(argv) <= 128
                and all(isinstance(arg, str) and '\x00' not in arg and len(arg.encode('utf-8')) <= 4096 for arg in argv)
                and sum(len(arg.encode('utf-8')) for arg in argv) <= 8192 and bool(argv[0]) and not argv[0].startswith('-'),
                'COMMAND_INVALID', 'argv must contain 1..128 bounded exact arguments')
        timeout = integer(args.get('timeoutSeconds'), 120, 1200)
        require(timeout >= 1, 'COMMAND_INVALID', 'Command timeout must be 1..1200 seconds')
        cwd = self.path(args.get('cwd', ''), internal=True).resolve(strict=True)
        require(cwd.is_dir(), 'COMMAND_INVALID', 'Command cwd must be a directory')
        require('\\' not in argv[0] and ':' not in argv[0] and not argv[0].startswith('/'),
                'COMMAND_INVALID', 'Executable must be a PATH name or workspace-relative path')
        if '/' in argv[0]:
            relative = argv[0][2:] if argv[0].startswith('./') else argv[0]
            require(relative and all(part not in ('', '.', '..') for part in relative.split('/')),
                    'COMMAND_INVALID', 'Invalid executable path')
            executable = (cwd / relative).resolve(strict=True)
            require(executable == self.root or self.root in executable.parents,
                    'PATH_OUTSIDE_ROOT', 'Executable escapes workspace')
            argv = [str(executable)] + argv[1:]
        environment = {key: value for key, value in os.environ.items()
                       if not key.upper().startswith(PRIVATE_ENV_PREFIXES)
                       and key.upper() not in {'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY',
                                               'OPENAI_ACCESS_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CODEX_API_KEY',
                                               'AZURE_OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'}}
        with self.command_lock:
            require(not self.stopping.is_set(), 'WORKSPACE_CLOSED', 'Worker is closing')
            if command_id in self.commands:
                return self.command_snapshot(self.commands[command_id]), b''
            require(self.command_active is None, 'COMMAND_BUSY', 'Only one approved command may run')
            # Spawn and registration are atomic with shutdown/cancellation.
            with self.process_lock:
                require(not self.stopping.is_set(), 'WORKSPACE_CLOSED', 'Worker is closing')
                process = subprocess.Popen(argv, cwd=str(cwd), env=environment, stdin=subprocess.DEVNULL,
                                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
                self.processes.add(process)
            record = dict(id=command_id, status='running', stdout=bytearray(), stderr=bytearray(),
                          exitCode=None, truncated=False, cancel=threading.Event(), done=threading.Event())
            self.commands[command_id] = record
            self.command_active = command_id
            for old in list(self.commands):
                if len(self.commands) <= 21:
                    break
                if self.commands[old]['done'].is_set():
                    del self.commands[old]
            try:
                threading.Thread(target=self.command_run, args=(record, process, timeout),
                                 name='texypaper-command', daemon=True).start()
            except BaseException:
                self.kill_process(process)
                with self.process_lock:
                    self.processes.discard(process)
                record.update(status='failed', error=dict(code='COMMAND_INTERRUPTED', message='Command supervisor could not start'))
                record['done'].set()
                self.command_active = None
                raise
            return self.command_snapshot(record), b''

    def command_run(self, record, process, timeout):
        readers = []
        def drain(stream, channel):
            try:
                while True:
                    chunk = os.read(stream.fileno(), 8192)
                    if not chunk:
                        break
                    with self.command_lock:
                        record[channel].extend(chunk)
                        if len(record[channel]) > 16384:
                            del record[channel][:-16384]
                            record['truncated'] = True
            except OSError as exc:
                with self.command_lock:
                    record['error'] = dict(code='COMMAND_OUTPUT', message=str(exc)[:2048])
            finally:
                stream.close()
        try:
            for stream, channel in ((process.stdout, 'stdout'), (process.stderr, 'stderr')):
                reader = threading.Thread(target=drain, args=(stream, channel), daemon=True)
                reader.start()
                readers.append(reader)
            deadline = time.monotonic() + timeout
            status = None
            while True:
                if record['cancel'].is_set() or self.stopping.is_set():
                    status = 'cancelled'
                    break
                if process.poll() is not None:
                    break
                if time.monotonic() >= deadline:
                    status = 'timeout'
                    break
                time.sleep(0.025)
            # Also stops children left behind by a launcher that has already exited.
            self.kill_process(process)
            for reader in readers:
                reader.join()
            with self.command_lock:
                record['exitCode'] = process.returncode
                record['status'] = status or ('completed' if process.returncode == 0 and not record.get('error') else 'failed')
                if status == 'timeout':
                    record['error'] = dict(code='COMMAND_TIMEOUT', message='Approved command time limit exceeded; owned process group stopped')
        except BaseException as exc:
            self.kill_process(process)
            for reader in readers:
                reader.join()
            with self.command_lock:
                record.update(status='failed', exitCode=process.returncode,
                              error=dict(code='COMMAND_INTERRUPTED', message=str(exc)[:2048]))
        finally:
            with self.process_lock:
                self.processes.discard(process)
            with self.command_lock:
                self.command_active = None
                self.changed()
                record['done'].set()

    def command_status(self, args, cancel, payload):
        with self.command_lock:
            record = self.commands.get(token(args.get('id')))
            require(record is not None, 'COMMAND_STALE', 'Command belongs to another epoch or has expired')
            return self.command_snapshot(record), b''

    def command_cancel(self, args, cancel, payload):
        with self.command_lock:
            record = self.commands.get(token(args.get('id')))
            require(record is not None, 'COMMAND_STALE', 'Command belongs to another epoch or has expired')
            record['cancel'].set()
        # Never report cancelled while the owned process group is still alive.
        record['done'].wait()
        with self.command_lock:
            return self.command_snapshot(record), b''

    def dispatch(self, request, cancel, payload):
        require(request.get('v') == 1, 'PROTOCOL_VERSION', 'Only protocol v1 is supported')
        op = request.get('op')
        args = request.get('args', {})
        require(isinstance(args, dict), 'INVALID_ARGUMENT', 'Arguments must be an object')
        if request.get('argsInPayload'):
            args = json.loads(payload.decode('utf-8'))
            payload = b''
            require(isinstance(args, dict), 'INVALID_ARGUMENT', 'Payload arguments must be an object')
        if op == 'open_root':
            args = dict(args)
            args.setdefault('workspaceId', request.get('workspaceId'))
            args.setdefault('epoch', request.get('epoch'))
        if op not in ('hello', 'open_root') and (self.root is not None or op not in ('ping', 'close')):
            self.check_root()
            require(request.get('workspaceId') == self.workspace_id and request.get('epoch') == self.epoch,
                    'STALE_WORKSPACE', 'Request belongs to a different workspace or epoch')
            if op not in ('ping', 'close'):
                self.registration_open = False
        if op == 'ping':
            return dict(time=now(), protocolVersion=1), b''
        if op == 'cancel':
            target = args.get('id', args.get('requestId'))
            with self.requests_lock:
                item = self.requests.get(target)
                if item:
                    item.set()
            return dict(canceled=item is not None), b''
        if op == 'close':
            self.stopping.set()
            self.build_cancel.set()
            with self.requests_lock:
                for item in self.requests.values():
                    item.set()
            return dict(closed=True), b''
        if op == 'build_cancel':
            return self.build_cancel_op(args, cancel, payload)
        if op == 'synctex_view':
            return self.synctex(args, cancel, False)
        if op == 'synctex_edit':
            return self.synctex(args, cancel, True)
        allowed = {'hello', 'open_root', 'list_dir', 'stat_many', 'read_range', 'read_text', 'save_text',
                   'create', 'rename', 'trash', 'restore', 'search_text', 'scan_step', 'transaction_status',
                   'apply_proposal', 'undo_transaction', 'comments_read', 'comments_update', 'project_read',
                   'project_update', 'build_start', 'build_status', 'artifact_manifest', 'build_validate',
                   'save_text_begin', 'save_text_chunk', 'save_text_commit', 'save_text_abort', 'canonical_path',
                   'args_begin', 'args_chunk', 'args_execute', 'args_abort',
                   'asset_import_begin', 'asset_import_chunk', 'asset_import_commit', 'asset_import_abort',
                   'command_start', 'command_status', 'command_cancel'}
        require(op in allowed, 'UNKNOWN_OPERATION', 'Unsupported operation')
        if args.get('_agentPolicy') and op in ('read_text', 'read_range', 'list_dir', 'search_text', 'stat_many'):
            with self.mutations:
                return getattr(self, op)(args, cancel, payload)
        return getattr(self, op)(args, cancel, payload)

    def handle(self, request, cancel, payload, semaphore):
        try:
            result, raw = self.dispatch(request, cancel, payload)
            self.reply(request, result, raw)
        except Failure as exc:
            self.reply(request, error=exc.value)
        except FileNotFoundError as exc:
            self.reply(request, error=dict(code='NOT_FOUND', message=str(exc), retryable=False))
        except PermissionError as exc:
            self.reply(request, error=dict(code='PERMISSION_DENIED', message=str(exc), retryable=False))
        except (ValueError, UnicodeError, TypeError, KeyError) as exc:
            self.reply(request, error=dict(code='INVALID_ARGUMENT', message=str(exc), retryable=False))
        except OSError as exc:
            self.reply(request, error=dict(code='IO_ERROR', message=str(exc), retryable=False))
        except Exception as exc:
            self.reply(request, error=dict(code='INTERNAL_ERROR', message=str(exc), retryable=False))
        finally:
            with self.requests_lock:
                self.requests.pop(request.get('id'), None)
            semaphore.release()

    def shutdown(self):
        self.stopping.set()
        self.build_cancel.set()
        with self.command_lock:
            commands = list(self.commands.values())
            for record in commands:
                record['cancel'].set()
        with self.requests_lock:
            for item in self.requests.values():
                item.set()
        with self.process_lock:
            processes = list(self.processes)
        for process in processes:
            self.kill_process(process)
        for record in commands:
            record['done'].wait()
        with self.mutations:
            for upload in self.uploads.values():
                if upload['kind'] == 'asset':
                    self.asset_cleanup(upload)
                else:
                    with contextlib.suppress(FileNotFoundError):
                        upload['path'].unlink()
            self.uploads.clear()
        thread = self.queued_thread
        if thread is not None and thread is not threading.current_thread():
            thread.join()


def read_exact(stream, length):
    data = bytearray()
    while len(data) < length:
        part = stream.read(length - len(data))
        if not part:
            if not data:
                raise EOFError()
            raise Failure('PROTOCOL_TRUNCATED', 'Unexpected EOF inside a frame')
        data.extend(part)
    return bytes(data)


def main():
    require(os.name == 'posix' and sys.version_info >= (3, 9), 'HOST_UNSUPPORTED', 'Worker requires POSIX Python >=3.9')
    worker = Worker()
    semaphore = threading.BoundedSemaphore(8)
    executor = concurrent.futures.ThreadPoolExecutor(max_workers=8, thread_name_prefix='texypaper')
    with worker.output_lock:
        sys.stdout.buffer.write(b'TEXYPAPER/1\n')
        sys.stdout.buffer.flush()
    try:
        while not worker.stopping.is_set():
            header_length = struct.unpack('!I', read_exact(sys.stdin.buffer, 4))[0]
            require(0 < header_length <= HEADER_LIMIT, 'PROTOCOL_LIMIT', 'Header exceeds 64 KiB')
            request = json.loads(read_exact(sys.stdin.buffer, header_length).decode('utf-8'))
            require(isinstance(request, dict), 'PROTOCOL_INVALID', 'Request header must be an object')
            require(isinstance(request.get('id'), (str, int)) and not isinstance(request.get('id'), bool), 'PROTOCOL_INVALID', 'Request requires a string/integer ID')
            require((isinstance(request['id'], str) and len(request['id']) <= 128)
                    or (isinstance(request['id'], int) and 0 <= request['id'] <= 18446744073709551615),
                    'PROTOCOL_INVALID', 'Request ID exceeds its bound')
            payload_length = struct.unpack('!I', read_exact(sys.stdin.buffer, 4))[0]
            require(payload_length <= PAYLOAD_LIMIT, 'PROTOCOL_LIMIT', 'Payload exceeds 1 MiB')
            raw = read_exact(sys.stdin.buffer, payload_length) if payload_length else b''
            request_id = request['id']
            with worker.requests_lock:
                require(request_id not in worker.requests, 'PROTOCOL_INVALID', 'Duplicate in-flight request ID')
            if request.get('op') in ('cancel', 'build_cancel', 'close', 'ping'):
                try:
                    result, payload = worker.dispatch(request, threading.Event(), raw)
                    worker.reply(request, result, payload)
                except Failure as exc:
                    worker.reply(request, error=exc.value)
                continue
            if not semaphore.acquire(blocking=False):
                worker.reply(request, error=dict(code='WORKER_BUSY', message='Eight requests are already in flight; retry after a reply', retryable=True))
                continue
            cancel = threading.Event()
            with worker.requests_lock:
                worker.requests[request_id] = cancel
            executor.submit(worker.handle, request, cancel, raw, semaphore)
    except EOFError:
        pass
    except (Failure, ValueError, UnicodeError, OSError) as exc:
        print('TexyPaper protocol terminated: ' + str(exc), file=sys.stderr, flush=True)
    finally:
        worker.shutdown()
        executor.shutdown(wait=True, cancel_futures=True)


if __name__ == '__main__':
    main()
