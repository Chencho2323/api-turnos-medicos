#!/bin/sh
# Verificacion local del proyecto Node.js.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

if [ ! -f package.json ]; then
  echo "SIN_SUITE: todavia no hay package.json (tarea de estructura pendiente)."
  exit 0
fi

if [ ! -d node_modules ]; then
  echo "Instalando dependencias..."
  npm install --no-audit --no-fund
fi

if ! grep -q '"test"' package.json; then
  echo "SIN_SUITE: package.json todavia no declara el script de pruebas."
  exit 0
fi

echo "Corriendo pruebas..."
# La salida se captura para poder distinguir "todo paso" de "no corrio nada".
# Una suite vacia es un fallo: el gate exige al menos una prueba en verde.
SALIDA="$(npm test --silent 2>&1)" || {
  echo "$SALIDA"
  echo "ERROR: las pruebas fallaron." >&2
  exit 1
}
echo "$SALIDA"

# Node 24 reporta el resumen con dos formatos: '# pass N' en el reporter TAP
# y 'i pass N' (con un simbolo delante) en el reporter por defecto. Se busca
# solo el texto "pass N" / "fail N" para no depender del locale: con LC_ALL
# en UTF-8, un rango negado como [^[:alpha:]] no siempre consume el simbolo
# multibyte que imprime el reporter y la linea no coincide.
PASARON="$(printf '%s\n' "$SALIDA" | grep -oE 'pass [0-9]+' | tail -1 | grep -oE '[0-9]+')"
FALLARON="$(printf '%s\n' "$SALIDA" | grep -oE 'fail [0-9]+' | tail -1 | grep -oE '[0-9]+')"

if [ -z "$PASARON" ]; then
  echo "ERROR: no se pudo leer el resumen de las pruebas." >&2
  exit 1
fi
if [ "$PASARON" = "0" ]; then
  echo "ERROR: la suite corrio cero pruebas." >&2
  exit 1
fi
if [ -n "$FALLARON" ] && [ "$FALLARON" != "0" ]; then
  echo "ERROR: hubo $FALLARON prueba(s) fallida(s)." >&2
  exit 1
fi

echo "VERIFICACION: ok ($PASARON prueba(s) en verde)"
