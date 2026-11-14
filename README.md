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

## Citas

Reservar, mover y cancelar pasa por el mismo control de cupo: si el nucleo
dice que no, la cita no se escribe.

```js
const { crearCita, reprogramarCita, cancelarCita } = require('./src');

const cita = crearCita(base, {
  profesionalId: 1,
  pacienteId: 7,
  fecha: '2026-11-09',
  horaInicio: '09:30',
  horaFin: '10:00',
  motivo: 'Control de rutina',
});

// Mismo profesional y paciente, otro horario.
reprogramarCita(base, cita.id, {
  fecha: '2026-11-09',
  horaInicio: '11:00',
  horaFin: '11:30',
});

// Cancelar no borra: el estado pasa a cancelada y el cupo queda libre.
const cancelada = cancelarCita(base, cita.id, { motivo: 'El paciente no puede' });
```

Reglas que aplica el ciclo de la cita:

- El codigo es `C-AAAAMMDD-NNNN`, consecutivo por dia.
- Solo se reprograma o se cancela una cita pendiente o confirmada.
- Cancelar dos veces, o cancelar una cita atendida, se rechaza con un error
  de negocio.
- Los errores de negocio salen como `ErrorAgenda`, con `codigo` y el estado
  HTTP sugerido en `estado`.

## Recordatorios y cola de salida

Un recordatorio cuelga de una cita viva y guarda cuando hay que avisar, por que
canal y con que texto. El aviso no se envia desde la agenda: al llegar su hora
pasa a una cola de salida que otro proceso consume. Asi un canal caido no
tumba una reserva.

```js
const { programarRecordatorio, encolarVencidos, tomarLote, marcarEnviada } = require('./src');

// Un dia antes de la cita, por WhatsApp, al telefono del paciente.
const aviso = programarRecordatorio(base, { citaId: cita.id });

// Al llegar la hora, lo vencido entra a la cola.
const salidas = encolarVencidos(base);

// El entregador toma el lote, lo envia y marca el resultado.
for (const salida of tomarLote(base, { limite: 20 })) {
  marcarEnviada(base, salida.id);
}
```

Reglas que aplica:

- Antelaciones: un dia, tres horas, una hora o media hora
  (`ANTELACIONES`); por defecto un dia.
- Canales: WhatsApp, SMS, correo y llamada. El destinatario sale del telefono
  o del correo del paciente, segun el canal, y se puede pasar explicito.
- Cancelar o reprogramar una cita apaga sus avisos pendientes: un mensaje
  sobre un horario que ya no existe no sale.
- Una salida fallida vuelve a la cola hasta tres intentos (`INTENTOS_MAXIMOS`)
  y despues queda `fallido` para revisarla a mano con `reintentarSalida`.
- `estadoDeLaCola(base)` devuelve el conteo por estado.

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
