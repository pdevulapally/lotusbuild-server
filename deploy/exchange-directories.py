"""Linux atomic exchange, retaining the existing active directory pathname."""
import ctypes
import os
import pathlib
import sys

check = '--check' in sys.argv[1:]
paths = [pathlib.Path(x) for x in sys.argv[1:] if x != '--check']
if len(paths) != 2:
    raise SystemExit('Two directories required')
active, candidate = paths
parent = pathlib.Path('/home/preet/apps').resolve(strict=True)
if any(p.is_symlink() or not p.is_dir() or p.resolve().parent != parent for p in paths):
    raise SystemExit('Directories must be real direct children of the deployment parent')
if active.name != 'lotusbuild-server' or not candidate.name.startswith('.lotusbuild-candidate-'):
    raise SystemExit('Unexpected deployment directory')
if os.stat(active).st_dev != os.stat(candidate).st_dev:
    raise SystemExit('Atomic exchange requires one filesystem')
libc = ctypes.CDLL(None, use_errno=True)
exchange = libc.renameat2
exchange.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
exchange.restype = ctypes.c_int
if not check:
    if exchange(-100, os.fsencode(active), -100, os.fsencode(candidate), 2) != 0:
        raise OSError(ctypes.get_errno(), 'Atomic directory exchange failed')
