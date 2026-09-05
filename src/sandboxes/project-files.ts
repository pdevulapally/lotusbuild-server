/** Linux descriptor-relative access: no symlink traversal or Git-internal file access. */
export const projectFilesScript = String.raw`
import os, sys, stat, json, base64, subprocess, errno
p = json.loads(os.environ["LOTUSBUILD_FILE_REQUEST"])
root = p["root"]
budget = p["budget"]
def directory(parts):
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in parts:
            if part in ("", "."): continue
            if part == "..": raise ValueError("Parent traversal is forbidden")
            nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = nxt
        return fd
    except:
        os.close(fd)
        raise
rootfd = directory(root.split("/"))
def relative(path):
    if not path.startswith(root.rstrip("/") + "/") and path != root:
        raise ValueError("Path leaves project")
    parts = path[len(root):].strip("/").split("/")
    if any(x == ".." or x.lower() == ".git" for x in parts):
        raise ValueError("Git internals and parent traversal are forbidden")
    return [x for x in parts if x not in ("", ".")]
def scoped_dir(parts, create=False):
    fd = os.dup(rootfd)
    try:
        for part in parts:
            if create:
                try: os.mkdir(part, dir_fd=fd)
                except FileExistsError: pass
            nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = nxt
        return fd
    except:
        os.close(fd)
        raise
def opened(path, write=False):
    parts = relative(path)
    if not parts: raise ValueError("Expected a file")
    parent = scoped_dir(parts[:-1], write)
    try:
        flags = os.O_NOFOLLOW | os.O_NONBLOCK | (os.O_WRONLY | os.O_CREAT if write else os.O_RDONLY)
        fd = os.open(parts[-1], flags, 0o600, dir_fd=parent)
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            os.close(fd)
            raise ValueError("Only regular files with one link are supported")
        return fd
    finally: os.close(parent)
def emit(value):
    raw = value.encode("utf-8")
    if len(raw) > budget: raise ValueError("Result exceeds transport budget; narrow the operation")
    sys.stdout.buffer.write(raw)
op = p["op"]
if op == "write":
    content = base64.b64decode(p["data"], validate=True)
    if len(content) > budget: raise ValueError("File exceeds write budget")
    fd = opened(p["path"], True)
    try:
        os.ftruncate(fd, 0)
        with os.fdopen(fd, "wb", closefd=False) as out: out.write(content)
    finally: os.close(fd)
    emit("{}")
elif op in ("read", "range"):
    fd = opened(p["path"])
    try:
        before = os.fstat(fd)
        if op == "read":
            if before.st_size > budget: raise ValueError("File exceeds edit budget")
            with os.fdopen(os.dup(fd), "rb") as src: text = src.read(budget + 1).decode("utf-8")
            answer = {"text": text}
        else:
            import codecs
            decoder = codecs.getincrementaldecoder("utf-8")("strict")
            start = max(0, p["offset"] - 1)
            end = p["offset"] + p["limit"] + 1
            total = 0
            pieces = []
            remaining = before.st_size
            while remaining:
                data = os.read(fd, min(65536, remaining))
                if not data: raise ValueError("File changed during read")
                remaining -= len(data)
                chunk = decoder.decode(data, final=remaining == 0).encode("utf-16-le")
                units = len(chunk) // 2
                a, b = max(0, start-total), min(units, end-total)
                if b > a: pieces.append(chunk[a*2:b*2])
                total += units
            answer = {"text": b"".join(pieces).decode("utf-16-le", "surrogatepass"), "start": start, "total": total}
        after = os.fstat(fd)
        if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
            raise ValueError("File changed during read")
        emit(json.dumps(answer))
    finally: os.close(fd)
else:
    scope = scoped_dir(relative(p["path"]))
    os.fchdir(scope)
    try:
        g = os.stat(".git", dir_fd=rootfd, follow_symlinks=False)
        if not stat.S_ISDIR(g.st_mode): raise ValueError("External Git directories are forbidden")
        isgit = True
    except FileNotFoundError: isgit = False
    glob = p.get("glob", "")
    if not isgit and glob: raise ValueError("glob requires a Git working tree")
    if isgit:
        cmd = ["git", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--"]
        if glob: cmd.append(glob)
        with subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL) as child:
            raw = child.stdout.read(budget + 1)
            if len(raw) > budget:
                child.kill()
                raise ValueError("File listing exceeds budget; narrow the scope")
            if child.wait() != 0: raise ValueError("Git listing failed")
        names = [x.decode("utf-8") for x in raw.split(b"\0") if x]
    else:
        names = []
        size = 0
        for base, dirs, files in os.walk(".", followlinks=False):
            dirs[:] = [x for x in dirs if x.lower() != ".git"]
            for name in files:
                path = os.path.join(base, name)[2:]
                size += len(path.encode("utf-8")) + 1
                if size > budget: raise ValueError("File listing exceeds budget; narrow the scope")
                names.append(path)
    output = []
    size = 0
    for name in sorted(set(names), key=lambda x: x.encode("utf-8")):
        try: fd = opened(p["path"].rstrip("/") + "/" + name)
        except OSError as e:
            if e.errno in (errno.ELOOP, errno.ENOTDIR, errno.ENOENT): continue
            raise
        try:
            if op == "list": records = [name + "\0"]
            else:
                records = []
                with os.fdopen(os.dup(fd), "rb") as src:
                    for number, line in enumerate(iter(lambda: src.readline(budget + 1), b""), 1):
                        if len(line) > budget: raise ValueError("Line exceeds search budget; use ranged read")
                        if b"\0" in line: records = []; break
                        if p["query"].encode("utf-8") in line:
                            record = name + "\0" + str(number) + ":" + line.rstrip(b"\n").decode("utf-8") + "\n"
                            records.append(record)
                            if sum(len(r.encode("utf-8")) for r in records) > budget: raise ValueError("Search exceeds budget; narrow the scope")
            for record in records:
                size += len(record.encode("utf-8"))
                if size > budget: raise ValueError("Result exceeds transport budget; narrow the scope")
                output.append(record)
        finally: os.close(fd)
    emit(("LOTUSBUILD_MATCHES_START\n" if op == "search" else "") + "".join(output))
    os.close(scope)
os.close(rootfd)
`;
