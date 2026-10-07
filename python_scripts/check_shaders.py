#!/usr/bin/env python3
"""Guard against a backtick inside a GLSL template literal.

Shader source is held in JS template literals, so a stray backtick in a
comment -- the natural way to quote an identifier -- silently ends the string
and the whole module fails to parse with a confusing error pointing at the
word that followed it. This has bitten three times; run it after editing any
shader.
"""
import glob
import os
import re
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'src')
BLOCK = re.compile(r'/\* glsl \*/`(.*?)`;', re.S)

bad = 0
files = sorted(glob.glob(os.path.join(ROOT, '*.js')))
for path in files:
    with open(path, encoding='utf-8') as fh:
        src = fh.read()
    for m in BLOCK.finditer(src):
        if '`' in m.group(1):
            line = src[:m.start()].count('\n') + 1
            print('stray backtick in the GLSL block at %s:%d'
                  % (os.path.relpath(path), line))
            bad += 1

print('checked %d modules, %d bad block(s)' % (len(files), bad))
sys.exit(1 if bad else 0)
