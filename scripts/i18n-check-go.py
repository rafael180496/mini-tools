#!/usr/bin/env python3
"""Mensajes de error del backend escritos a mano, sin backend/i18n (fase 7 de
.claude/specs/i18n.md).

Cuenta, por archivo .go (sin tests), las llamadas fmt.Errorf("…") y
errors.New("…") cuyo texto —quitados los verbos de formato— tiene letras: esos
mensajes le llegan a la interfaz con String(e) y tienen que salir de un
i18n.Msg{ES, EN}. Mismo trinquete que el chequeo del frontend: la línea base
(scripts/i18n-baseline-go.txt) solo puede bajar.

Uso: i18n-check-go.py [--update] [--list archivo.go]
"""
import os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASELINE = os.path.join(ROOT, 'scripts', 'i18n-baseline-go.txt')
CALL = re.compile(r'\b(?:fmt\.Errorf|errors\.New)\(\s*("(?:[^"\\\n]|\\.)*"|`[^`]*`)')
VERB = re.compile(r'%[-+# 0-9.*]*[a-zA-Z%]')
SKIP_DIRS = {'node_modules', 'frontend', 'build', 'releases', '.git', '.codegraph'}


def texts(path):
    out = []
    with open(path, encoding='utf-8') as f:
        for n, line in enumerate(f, 1):
            s = line.lstrip()
            if s.startswith('//'):
                continue
            for m in CALL.finditer(line):
                lit = m.group(1)[1:-1]
                if re.search(r'[^\W\d_]{2,}', VERB.sub('', lit)):
                    out.append((n, lit[:90]))
    return out


def files():
    for d, dirs, fs in os.walk(ROOT):
        dirs[:] = [x for x in dirs if x not in SKIP_DIRS and not x.startswith('.')]
        for f in fs:
            p = os.path.join(d, f)
            rel = os.path.relpath(p, ROOT)
            if f.endswith('.go') and not f.endswith('_test.go') and not rel.startswith('backend/i18n/') and not rel.startswith('scripts/'):
                yield rel


def main():
    args = sys.argv[1:]
    if args[:1] == ['--list']:
        for n, t in texts(os.path.join(ROOT, args[1])):
            print(f'{args[1]}:{n}  {t}')
        return 0
    counts = {}
    for rel in files():
        c = len(texts(os.path.join(ROOT, rel)))
        if c:
            counts[rel] = c
    total = sum(counts.values())
    if args[:1] == ['--update']:
        with open(BASELINE, 'w') as f:
            f.write('# Mensajes de error del backend que todavía no pasan por backend/i18n.\n'
                    '# Generado por scripts/i18n-check.sh --update. Solo puede bajar.\n')
            for rel, c in sorted(counts.items(), key=lambda kv: -kv[1]):
                f.write(f'{c} {rel}\n')
        print(f'i18n (Go): línea base actualizada — {total} mensajes pendientes en {len(counts)} archivos')
        return 0
    base = {}
    if os.path.exists(BASELINE):
        for line in open(BASELINE):
            m = re.match(r'^(\d+)\s+(.+)$', line.strip())
            if m:
                base[m.group(2)] = int(m.group(1))
    worse = [(r, c) for r, c in counts.items() if c > base.get(r, 0)]
    if worse:
        print('i18n (Go): mensaje de error nuevo sin backend/i18n (ver .claude/rules/conventions.md, «Textos de la interfaz»):', file=sys.stderr)
        for r, c in worse:
            print(f'  {r}: {c} (línea base {base.get(r, 0)})', file=sys.stderr)
            for n, t in texts(os.path.join(ROOT, r))[:8]:
                print(f'    {n}: {t}', file=sys.stderr)
        return 1
    better = [r for r in base if counts.get(r, 0) < base[r]]
    print(f'i18n (Go): {total} mensajes pendientes en {len(counts)} archivos' + (f' — bajaron {len(better)}; corré con --update' if better else ''))
    return 0


sys.exit(main())
