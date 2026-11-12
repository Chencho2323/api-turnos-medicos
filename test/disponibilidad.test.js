'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { abrirBase } = require('../src/base');
const {
  DURACION_MINIMA,
  diaSemanaIso,
  validarDuracion,
  franjasDelDia,
  cuposDisponibles,
  seSolapan,
  haySolapamiento,
  dentroDeHorario,
  verificarCupo,
} = require('../src/disponibilidad');

/** Lunes 9 de noviembre de 2026. */
const FECHA = '2026-11-09';

/** Base con un profesional y un paciente minimos. */
function baseDePrueba() {
  const base = abrirBase();
  const profesional = base
    .prepare('INSERT INTO profesional (documento, nombre, especialidad) VALUES (?, ?, ?)')
    .run('1090', 'Ana Rojas', 'Medicina general');
  const paciente = base
    .prepare('INSERT INTO paciente (documento, nombre) VALUES (?, ?)')
    .run('7950', 'Carlos Perez');
  return {
    base,
    profesionalId: Number(profesional.lastInsertRowid),
    pacienteId: Number(paciente.lastInsertRowid),
  };
}

/** Inserta una franja de atencion en el dia de la semana de FECHA. */
function agregarHorario(base, profesionalId, horaInicio, horaFin, extra = {}) {
  return base
    .prepare(
      `INSERT INTO horario (profesional_id, dia_semana, hora_inicio, hora_fin, vigente_desde, vigente_hasta)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      profesionalId,
      diaSemanaIso(FECHA),
      horaInicio,
      horaFin,
      extra.vigenteDesde ?? null,
      extra.vigenteHasta ?? null,
    );
}

/** Inserta una cita en FECHA. */
function agregarCita(base, profesionalId, pacienteId, horaInicio, horaFin, estado = 'pendiente') {
  const codigo = `C-${horaInicio.replace(':', '')}-${estado}`;
  return base
    .prepare(
      `INSERT INTO cita (codigo, profesional_id, paciente_id, fecha, hora_inicio, hora_fin, estado)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(codigo, profesionalId, pacienteId, FECHA, horaInicio, horaFin, estado);
}

/** Inserta un bloqueo en FECHA. */
function agregarBloqueo(base, profesionalId, horaInicio, horaFin) {
  return base
    .prepare(
      `INSERT INTO bloque (profesional_id, fecha, hora_inicio, hora_fin, motivo)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(profesionalId, FECHA, horaInicio, horaFin, 'Reunion');
}

/** Deja las horas de una lista de cupos para comparar sin ruido. */
function horas(cupos) {
  return cupos.map((cupo) => cupo.horaInicio);
}

test('el dia de la semana se calcula en formato ISO', () => {
  assert.equal(diaSemanaIso('2026-11-09'), 1);
  assert.equal(diaSemanaIso('2026-11-12'), 4);
  assert.equal(diaSemanaIso('2026-11-15'), 7);
  assert.throws(() => diaSemanaIso('2026-02-30'), /no existe en el calendario/);
});

test('la duracion debe ser un entero dentro del rango admitido', () => {
  assert.equal(validarDuracion(30), 30);
  assert.throws(() => validarDuracion(0), /duracion minima/);
  assert.throws(() => validarDuracion(-15), /duracion minima/);
  assert.throws(() => validarDuracion(20.5), /numero entero/);
  assert.throws(() => validarDuracion(24 * 60), /duracion maxima/);
  assert.equal(DURACION_MINIMA, 5);
});

test('las franjas respetan la vigencia del horario', () => {
  const { base, profesionalId } = baseDePrueba();
  agregarHorario(base, profesionalId, '08:00', '09:00');
  agregarHorario(base, profesionalId, '09:00', '10:00', { vigenteDesde: '2026-11-10' });
  agregarHorario(base, profesionalId, '10:00', '11:00', { vigenteHasta: '2026-11-08' });

  const franjas = franjasDelDia(base, profesionalId, FECHA);
  assert.deepEqual(franjas, [{ inicio: 8 * 60, fin: 9 * 60 }]);
  base.close();
});

test('sin horario para el dia no hay cupos', () => {
  const { base, profesionalId } = baseDePrueba();
  agregarHorario(base, profesionalId, '09:00', '12:00');
  assert.deepEqual(cuposDisponibles(base, { profesionalId, fecha: '2026-11-10', duracionMinutos: 30 }), []);
  base.close();
});

test('una franja de tres horas produce seis cupos de treinta minutos', () => {
  const { base, profesionalId } = baseDePrueba();
  agregarHorario(base, profesionalId, '09:00', '12:00');

  const cupos = cuposDisponibles(base, { profesionalId, fecha: FECHA, duracionMinutos: 30 });
  assert.deepEqual(horas(cupos), ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30']);
  assert.deepEqual(cupos[0], { horaInicio: '09:00', horaFin: '09:30' });
  base.close();
});

test('un cupo que no cabe entero en la franja no se ofrece', () => {
  const { base, profesionalId } = baseDePrueba();
  agregarHorario(base, profesionalId, '09:00', '10:10');

  const cupos = cuposDisponibles(base, { profesionalId, fecha: FECHA, duracionMinutos: 30 });
  assert.deepEqual(horas(cupos), ['09:00', '09:30']);
  base.close();
});

test('dos franjas del mismo dia se recorren por separado', () => {
  const { base, profesionalId } = baseDePrueba();
  agregarHorario(base, profesionalId, '08:00', '09:00');
  agregarHorario(base, profesionalId, '14:00', '15:00');

  const cupos = cuposDisponibles(base, { profesionalId, fecha: FECHA, duracionMinutos: 30 });
  assert.deepEqual(horas(cupos), ['08:00', '08:30', '14:00', '14:30']);
  base.close();
});

test('una cita viva quita su cupo y una cancelada lo libera', () => {
  const { base, profesionalId, pacienteId } = baseDePrueba();
  agregarHorario(base, profesionalId, '09:00', '11:00');
  agregarCita(base, profesionalId, pacienteId, '09:30', '10:00');
  agregarCita(base, profesionalId, pacienteId, '10:30', '11:00', 'cancelada');

  const cupos = cuposDisponibles(base, { profesionalId, fecha: FECHA, duracionMinutos: 30 });
  assert.deepEqual(horas(cupos), ['09:00', '10:00', '10:30']);
  base.close();
});

test('los bloqueos quitan disponibilidad igual que las citas', () => {
  const { base, profesionalId } = baseDePrueba();
  agregarHorario(base, profesionalId, '09:00', '11:00');
  agregarBloqueo(base, profesionalId, '10:00', '10:30');

  const cupos = cuposDisponibles(base, { profesionalId, fecha: FECHA, duracionMinutos: 30 });
  assert.deepEqual(horas(cupos), ['09:00', '09:30', '10:30']);
  base.close();
});

test('una cita de cuarenta minutos tumba los dos cupos de media hora que pisa', () => {
  const { base, profesionalId, pacienteId } = baseDePrueba();
  agregarHorario(base, profesionalId, '09:00', '11:00');
  agregarCita(base, profesionalId, pacienteId, '09:20', '10:00');

  const cupos = cuposDisponibles(base, { profesionalId, fecha: FECHA, duracionMinutos: 30 });
  assert.deepEqual(horas(cupos), ['10:00', '10:30']);
  base.close();
});

test('dos intervalos que se tocan no se solapan', () => {
  assert.equal(seSolapan({ inicio: 540, fin: 570 }, { inicio: 570, fin: 600 }), false);
  assert.equal(seSolapan({ inicio: 540, fin: 600 }, { inicio: 570, fin: 630 }), true);
  assert.equal(seSolapan({ inicio: 570, fin: 600 }, { inicio: 540, fin: 600 }), true);
});

test('el solapamiento ignora la cita que se esta reprogramando', () => {
  const { base, profesionalId, pacienteId } = baseDePrueba();
  const cita = agregarCita(base, profesionalId, pacienteId, '09:00', '09:30');
  const citaId = Number(cita.lastInsertRowid);

  const datos = {
    profesionalId,
    fecha: FECHA,
    horaInicio: '09:00',
    horaFin: '09:30',
  };
  assert.equal(haySolapamiento(base, datos), true);
  assert.equal(haySolapamiento(base, { ...datos, excluirCitaId: citaId }), false);
  base.close();
});

test('un intervalo cruzando el mediodia queda fuera de horario', () => {
  const { base, profesionalId } = baseDePrueba();
  agregarHorario(base, profesionalId, '08:00', '12:00');
  agregarHorario(base, profesionalId, '14:00', '18:00');

  assert.equal(
    dentroDeHorario(base, { profesionalId, fecha: FECHA, horaInicio: '11:30', horaFin: '14:30' }),
    false,
  );
  assert.equal(
    dentroDeHorario(base, { profesionalId, fecha: FECHA, horaInicio: '11:30', horaFin: '12:00' }),
    true,
  );
  assert.equal(
    dentroDeHorario(base, { profesionalId, fecha: FECHA, horaInicio: '07:30', horaFin: '08:00' }),
    false,
  );
  base.close();
});

test('verificarCupo explica el motivo del rechazo', () => {
  const { base, profesionalId, pacienteId } = baseDePrueba();
  agregarHorario(base, profesionalId, '09:00', '11:00');
  agregarCita(base, profesionalId, pacienteId, '09:30', '10:00');

  assert.deepEqual(
    verificarCupo(base, { profesionalId, fecha: FECHA, horaInicio: '09:30', horaFin: '10:00' }),
    { disponible: false, motivo: 'El horario solicitado se cruza con otra cita o un bloqueo' },
  );
  assert.deepEqual(
    verificarCupo(base, { profesionalId, fecha: FECHA, horaInicio: '08:00', horaFin: '08:30' }),
    { disponible: false, motivo: 'El horario solicitado esta fuera de la atencion del profesional' },
  );
  assert.deepEqual(
    verificarCupo(base, { profesionalId, fecha: FECHA, horaInicio: '10:00', horaFin: '10:30' }),
    { disponible: true },
  );
  base.close();
});
