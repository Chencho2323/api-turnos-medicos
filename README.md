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

## Disponibilidad

La agenda no guarda cupos: los calcula. Sobre el horario semanal del
profesional se descuentan los bloqueos y las citas vivas, y lo que sobra se
parte en cupos de la duracion pedida.

```js
const { abrirBase, cuposDisponibles, verificarCupo } = require('./src');

const base = abrirBase('agenda.db');

// Cupos de 30 minutos para el lunes 9 de noviembre de 2026.
const cupos = cuposDisponibles(base, {
  profesionalId: 1,
  fecha: '2026-11-09',
  duracionMinutos: 30,
});

// Antes de reservar: veredicto y motivo en texto.
const veredicto = verificarCupo(base, {
  profesionalId: 1,
  fecha: '2026-11-09',
  horaInicio: '09:30',
  horaFin: '10:00',
});
```

Reglas que aplica el nucleo:

- Un cupo tiene que caber entero dentro de una franja de atencion.
- Dos intervalos que se tocan no se solapan; solo cuenta el cruce real.
- Las citas canceladas no ocupan cupo, para no perder el historico.
- La duracion va de 5 minutos a 12 horas.
- Al reprogramar se pasa `excluirCitaId` para que la propia cita no se
  estorbe.

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
