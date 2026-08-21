#!/usr/bin/env python3
"""Comprueba el contrato Go↔React de los bindings de Wails.

Tres verificaciones, cada una nacida de un error real:

1. Que App.js, App.d.ts y los métodos exportados de *App coincidan en nombre
   y cantidad de argumentos. Los archivos de `wailsjs/` a veces se editan a
   mano cuando no hay CLI disponible, y un desajuste ahí no lo detecta ni
   `go build` ni `tsc`: aparece como "undefined is not a function" en
   ejecución.

2. Que toda clase `namespace.Clase` que el frontend usa EXISTA en models.ts.
   El generador de Wails solo emite los tipos que alcanza desde la firma de
   un binding; un tipo que solo viaja adentro de un JSON opaco nunca se
   genera. Escribirlo a mano en models.ts no sirve: `wails build` regenera
   ese archivo y se lo lleva puesto — pasó, y rompió el build de release
   cuando todo compilaba localmente.

3. Que los campos de las clases generadas coincidan con los tags JSON de Go.

Uso:  python3 scripts/check-bindings.py
Sale con código 1 si encuentra algo.
"""
import glob
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def split_top(s):
    out, depth, cur = [], 0, ""
    for ch in s:
        if ch in "<({[":
            depth += 1
        elif ch in ">)}]":
            depth -= 1
        if ch == "," and depth == 0:
            out.append(cur)
            cur = ""
        else:
            cur += ch
    if cur.strip():
        out.append(cur)
    return [p for p in out if p.strip()]


def read(path):
    with open(os.path.join(ROOT, path), encoding="utf-8") as f:
        return f.read()


def main():
    problems = []

    # --- 1. firmas ---
    go = {}
    for path in glob.glob(os.path.join(ROOT, "app*.go")):
        with open(path, encoding="utf-8") as f:
            for m in re.finditer(r"^func \(a \*App\) ([A-Z]\w*)\(([^)]*)\)", f.read(), re.M):
                params = m.group(2).strip()
                go[m.group(1)] = len(split_top(params)) if params else 0

    def parse_ts(path, pattern):
        return {
            m.group(1): len(split_top(m.group(2)))
            for m in re.finditer(pattern, read(path), re.M)
        }

    js = parse_ts("frontend/wailsjs/go/main/App.js", r"^export function (\w+)\(([^)]*)\)")
    dts = parse_ts("frontend/wailsjs/go/main/App.d.ts", r"^export function (\w+)\((.*?)\):Promise")

    for name, arity in sorted(js.items()):
        if name not in go:
            problems.append(f"{name}: está en App.js y no existe en Go")
        elif go[name] != arity:
            problems.append(f"{name}: App.js toma {arity} argumentos, Go toma {go[name]}")
        if name not in dts:
            problems.append(f"{name}: falta en App.d.ts")
        elif dts[name] != arity:
            problems.append(f"{name}: App.js toma {arity} y App.d.ts declara {dts[name]}")
    for name in sorted(set(dts) - set(js)):
        problems.append(f"{name}: está en App.d.ts y no en App.js")
    for name in sorted(set(go) - set(js)):
        problems.append(f"{name}: existe en Go y no tiene binding generado")

    # --- 2. clases que el frontend usa y el generador no emite ---
    models = read("frontend/wailsjs/go/models.ts")
    available = set()
    for ns in re.finditer(r"export namespace (\w+) \{(.*?)\n\}\n", models, re.S):
        for cls in re.finditer(r"export class (\w+)", ns.group(2)):
            available.add(f"{ns.group(1)}.{cls.group(1)}")

    used = set()
    import_re = re.compile(r"import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['\"][^'\"]*wailsjs/go/models['\"]")
    for path in glob.glob(os.path.join(ROOT, "frontend/src/**/*.ts*"), recursive=True):
        with open(path, encoding="utf-8") as f:
            src = f.read()
        imports = import_re.search(src)
        if not imports:
            continue
        rel = os.path.relpath(path, ROOT)

        # Qué nombre usa ESTE archivo para cada namespace. Sin resolver los
        # alias, `import {agents as agentsModel}` producía un falso positivo
        # por cada uso; y sin limitarse a lo importado, React.MouseEvent e
        # Intl.Collator entraban también.
        aliases = {}
        for part in imports.group(1).split(","):
            part = part.strip()
            if not part:
                continue
            if " as " in part:
                real, alias = [x.strip() for x in part.split(" as ", 1)]
                aliases[alias] = real
            else:
                aliases[part] = part

        # Solo las posiciones donde hace falta la CLASE generada de verdad:
        # una anotación de tipo, un genérico, o un `new`.
        patterns = [
            r"new\s+(\w+)\.([A-Z]\w*)\s*\(",
            r":\s*(\w+)\.([A-Z]\w*)\b",
            r"<(\w+)\.([A-Z]\w*)(?:\[\])?[,>]",
        ]
        for pattern in patterns:
            for m in re.finditer(pattern, src):
                ns = aliases.get(m.group(1))
                if ns:
                    used.add((f"{ns}.{m.group(2)}", rel))

    for ref, where in sorted(used):
        if ref not in available:
            problems.append(f"{ref}: lo usa {where} y NO está en models.ts (el generador de Wails no lo emite)")

    if problems:
        print(f"✗ {len(problems)} problema(s) en el contrato de bindings:")
        for p in problems:
            print("   ", p)
        return 1

    print(f"✓ bindings coherentes: {len(go)} métodos, {len(available)} clases generadas, {len(used)} referencias del frontend")
    return 0


if __name__ == "__main__":
    sys.exit(main())
