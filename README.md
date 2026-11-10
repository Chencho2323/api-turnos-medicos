# API de disponibilidad y reserva de citas medicas

Administra la disponibilidad por profesional y hora, reserva citas sin solapamientos, genera recordatorios y expone el historico del paciente. Base de la agenda que hoy es un modulo privado.

![CI](https://github.com/Chencho2323/api-turnos-medicos/actions/workflows/ci.yml/badge.svg)
![Licencia](https://img.shields.io/badge/licencia-MIT-03A8FA?style=flat-square)

**Stack:** Node.js 24 · SQLite · node --test

## Que resuelve

Este repositorio es parte del portafolio publico de
[InheritDevs](https://inheritdevs.com/): software empresarial que funciona en
produccion. El codigo esta aqui para que se pueda leer, ejecutar y auditar.

- Codigo completo, no un ejemplo recortado.
- Pruebas que corren en cada push (`npm test`, `phpunit` o `pytest`, segun el
  stack) y en cada pull request.
- Sin dependencias ocultas: lo que dice el README es lo que hace falta.

## Instalacion

```bash
git clone https://github.com/Chencho2323/api-turnos-medicos.git
cd api-turnos-medicos
```

Los comandos exactos de instalacion y ejecucion estan en la seccion siguiente.

## Uso

La aplicacion expone su funcionalidad por linea de comandos o por HTTP, segun
el caso. Los ejemplos concretos estan en `docs/` o en el `README` ampliado de
cada version.

## Pruebas

```bash
# el comando exacto lo declara el proyecto en verificar.sh
./verificar.sh
```

## Estructura

```
src/        codigo de la aplicacion
test(s)/    pruebas automaticas
docs/       documentacion de uso
```

## Licencia

MIT. Ver `LICENSE`.
