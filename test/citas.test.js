'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { abrirBase } = require('../src/base');
const { diaSemanaIso, cuposDisponibles } = require('../src/disponibilidad');
const {
  ErrorAgenda,
  crearCita,
  reprogramarCita,
  cancelarCita,
  obtenerCita,
  siguienteCodigo,
} = require('../src/citas');

/** Lunes 9 de noviembre de 2026. */
const FECHA = '2026-11-09';

/** Martes 10 de noviembre de 2026. */
const OTRA_FECHA = '2026-11-10';

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

function agregarHorario(base, profesionalId, horaInicio, horaFin, fecha = FECHA) {
  return base
    .prepare(
      `INSERT INTO horario (profesional_id, dia_semana, hora_inicio, hora_fin)
       VALUES (?, ?, ?, ?)`,
    )
    .run(profesionalId, diaSemanaIso(fecha), horaInicio, horaFin);
}

function citaValida(extra = {}) {
  return {
    profesionalId: extra.profesionalId,
    pacienteId: extra.pacienteId,
    fecha: extra.fecha ?? FECHA,
    horaInicio: extra.horaInicio ?? '09:00',
    horaFin: extra.horaFin ?? '09:30',
    motivo: extra.motivo,
  };
}

test('crearCita guarda la cita en estado pendiente y devuelve los nombres', () => {
  const { base, profesionalId, pacienteId } = baseDePrueba();
  agregarHorario(base, profesionalId, '08:00', '12:00');

  const cita = crearCita(base, {
    ...citaValida({ profesionalId, pacienteId }),
    motivo: 'Control de rutina',
  });

  assert.equal(cita.estado, 'pendiente');
  assert.equal(cita.fecha, FECHA);
  assert.equal(cita.horaInicio, '09:00');
  assert.equal(cita.profesional, 'Ana Rojas');
  assert.equal(cita.paciente, 'Carlos Perez');
  assert.equal(cita.pacienteDocumento, '7950');
  assert.equal(cita.motivo, 'Control de rutina');
  assert.match(cita.codigo, /^C-20261109-0001$/);
  base.close();
});

test('el codigo de la cita avanza por dia y no se repite', () => {
  const { base, profesionalId, pacienteId } = baseDePrueba();
  agregarHorario(base, profesionalId, '08:00', '12:00');
  agregarHorario(base, profesionalId, '08:00', '12:00', OTRA_FECHA);

  const primera = crearCita(base, citaValida({ profesionalId, pacienteId, horaInicio: '08:00', horaFin: '08:30' }));
  const segunda = crearCita(base, citaValida({ profesionalId, pacienteId, horaInicio: '08:30', horaFin: '09:00' }));
  const otroDia = crearCita(base, citaValida({ profesionalId, pacienteId, fecha: OTRA_FECHA }));

  assert.equal(primera.codigo, 'C-20261109-0001');
  assert.equal(segunda.codigo, 'C-20261109-0002');
  assert.equal(otroDia.codigo, 'C-20261110-0001');
  assert.equal(siguienteCodigo(base, FECHA), 'C-20261109-0003');
  base.close();
});

test('crearCita rechaza un horario fuera de la atencion', () => {
  const { base, profesionalId, pacienteId } = baseDePrueba();
  agregarHorario(base, profesionalId, '08:00', '12:00');

  assert.throws(
    () => crearCita(base, citaValida({ profesionalId, pacienteId, horaInicio: '11:45', horaFin: '12:15' })),
    (error) => {
      assert.ok(error instanceof ErrorAgenda);
      assert.equal(error.codigo, 'cupo_no_disponible');
      assert.equal(error.estado, 409);
      assert.match(error.message, /fuera de la atencion/);
      return true;
    },
  );
  base.close();
});

test('crearCita rechaza el cruce con otra cita viva', () => {
  const { base, profesionalId, pacienteId } = baseDePrueba();
  agregarHorario(base, profesionalId, '08:00', '12:00');
  crearCita(base, citaValida({ profesionalId, pacienteId }));

  assert.throws(
    () => crearCita(base, citaValida({ profesionalId, pacienteId, horaInicio: '09:15', horaFin: '09:45' })),
    /se cruza con otra cita/,
  );
  // Tocar el borde si se permite.
  const siguiente = crearCita(
    base,
    citaValida({ profesionalId, pacienteId, horaInicio: '09:30', horaFin: '10:00' }),
  );
  assert.equal(siguiente.horaInicio, '09:30');
  base.close();
});

test('crearCita distingue profesional y paciente inexistentes o inactivos', () => {
  const { base, profesionalId, pacienteId } = baseDePrueba();
  agregarHorario(base, profesionalId, '08:00', '12:00');

  assert.throws(
    () => crearCita(base, citaValida({ profesionalId: 999, pacienteId })),
    (error) => error.codigo === 'profesional_no_encontrado' && error.estado === 404,
  );
  assert.throws(
    () => crearCita(base, citaValida({ profesionalId, pacienteId: 999 })),
    (error) => error.codigo === 'paciente_no_encontrado' && error.estado === 404,
  );

  base.prepare('UPDATE paciente SET activo = 0 WHERE id = ?').run(pacienteId);
  assert.throws(
    () => crearCita(base, citaValida({ profesionalId, pacienteId })),
    (error) => error.codigo === 'paciente_inactivo' && error.estado === 409,
  );
  base.close();
});

test('crearCita valida fecha real y orden del intervalo', () => {
  const { base, profesionalId, pacienteId } = baseDePrueba();
  agregarHorario(base, profesionalId, '08:00', '12:00');

  assert.throws(
    () => crearCita(base, citaValida({ profesionalId, pacienteId, fecha: '2026-02-30' })),
    /no existe en el calendario/,
  );
  assert.throws(
    () => crearCita(base, citaValida({ profesionalId, pacienteId, horaInicio: '10:00', horaFin: '09:00' })),
    /posterior a la hora de inicio/,
  );
  // Una cita de 3 minutos no llega al minimo de 5.
  assert.throws(
    () => crearCita(base, citaValida({ profesionalId, pacienteId, horaInicio: '10:00', horaFin: '10:03' })),
    /duracion minima/,
  );
  base.close();
});

test('reprogramarCita mueve la cita y no choca consigo misma', () => {
  const { base, profesionalId, pacienteId } = baseDePrueba();
  agregarHorario(base, profesionalId, '08:00', '12:00');
  const cita = crearCita(base, citaValida({ profesionalId, pacienteId }));

  // Mismo horario: es un cambio de cero minutos y tiene que pasar.
  const igual = reprogramarCita(base, cita.id, {
    fecha: FECHA,
    horaInicio: '09:00',
    horaFin: '09:30',
  });
  assert.equal(igual.horaInicio, '09:00');

  const movida = reprogramarCita(base, cita.id, {
    fecha: FECHA,
    horaInicio: '11:00',
    horaFin: '11:30',
    motivo: 'Cambio de hora pedido por el paciente',
  });
  assert.equal(movida.horaInicio, '11:00');
  assert.equal(movida.motivo, 'Cambio de hora pedido por el paciente');
  assert.equal(movida.codigo, cita.codigo);

  // El cupo viejo quedo libre.
  const cupos = cuposDisponibles(base, {
    profesionalId,
    fecha: FECHA,
    duracionMinutos: 30,
  }).map((cupo) => cupo.horaInicio);
  assert.ok(cupos.includes('09:00'));
  assert.ok(!cupos.includes('11:00'));
  base.close();
});

test('reprogramarCita rechaza el horario ocupado por otra cita', () => {
  const { base, profesionalId, pacienteId } = baseDePrueba();
  agregarHorario(base, profesionalId, '08:00', '12:00');
  const primera = crearCita(base, citaValida({ profesionalId, pacienteId, horaInicio: '09:00', horaFin: '09:30' }));
  crearCita(base, citaValida({ profesionalId, pacienteId, horaInicio: '10:00', horaFin: '10:30' }));

  assert.throws(
    () => reprogramarCita(base, primera.id, { fecha: FECHA, horaInicio: '10:00', horaFin: '10:30' }),
    /se cruza con otra cita/,
  );
  assert.equal(obtenerCita(base, primera.id).horaInicio, '09:00');
  base.close();
});

test('reprogramarCita solo acepta citas vivas', () => {
  const { base, profesionalId, pacienteId } = baseDePrueba();
  agregarHorario(base, profesionalId, '08:00', '12:00');
  const cita = crearCita(base, citaValida({ profesionalId, pacienteId }));
  cancelarCita(base, cita.id);

  assert.throws(
    () => reprogramarCita(base, cita.id, { fecha: FECHA, horaInicio: '10:00', horaFin: '10:30' }),
    (error) => error.codigo === 'estado_no_reprogramable' && error.estado === 409,
  );
  assert.throws(
    () => reprogramarCita(base, 4321, { fecha: FECHA, horaInicio: '10:00', horaFin: '10:30' }),
    (error) => error.codigo === 'cita_no_encontrada' && error.estado === 404,
  );
  base.close();
});

test('cancelarCita conserva el registro y libera el cupo', () => {
  const { base, profesionalId, pacienteId } = baseDePrueba();
  agregarHorario(base, profesionalId, '08:00', '12:00');
  const cita = crearCita(base, citaValida({ profesionalId, pacienteId }));

  const cancelada = cancelarCita(base, cita.id, { motivo: 'El paciente no puede asistir' });
  assert.equal(cancelada.estado, 'cancelada');
  assert.equal(cancelada.motivo, 'El paciente no puede asistir');
  // Sigue en la tabla: hay historico.
  assert.equal(obtenerCita(base, cita.id).codigo, cita.codigo);

  // El cupo vuelve a ofrecerse y se puede reservar de nuevo.
  const cupos = cuposDisponibles(base, { profesionalId, fecha: FECHA, duracionMinutos: 30 })
    .map((cupo) => cupo.horaInicio);
  assert.ok(cupos.includes('09:00'));

  const nueva = crearCita(base, citaValida({ profesionalId, pacienteId }));
  assert.equal(nueva.horaInicio, '09:00');
  assert.notEqual(nueva.codigo, cita.codigo);
  base.close();
});

test('cancelarCita no deja cancelar dos veces ni una cita ya atendida', () => {
  const { base, profesionalId, pacienteId } = baseDePrueba();
  agregarHorario(base, profesionalId, '08:00', '12:00');
  const cita = crearCita(base, citaValida({ profesionalId, pacienteId }));
  cancelarCita(base, cita.id);

  assert.throws(
    () => cancelarCita(base, cita.id),
    (error) => error.codigo === 'cita_ya_cancelada' && error.estado === 409,
  );

  const atendida = crearCita(base, citaValida({ profesionalId, pacienteId, horaInicio: '10:00', horaFin: '10:30' }));
  base.prepare("UPDATE cita SET estado = 'atendida' WHERE id = ?").run(atendida.id);
  assert.throws(
    () => cancelarCita(base, atendida.id),
    (error) => error.codigo === 'estado_no_cancelable',
  );
  base.close();
});

test('cancelarCita sin motivo propio conserva el de la cita', () => {
  const { base, profesionalId, pacienteId } = baseDePrueba();
  agregarHorario(base, profesionalId, '08:00', '12:00');
  const cita = crearCita(base, {
    ...citaValida({ profesionalId, pacienteId }),
    motivo: 'Control de rutina',
  });

  const cancelada = cancelarCita(base, cita.id);
  assert.equal(cancelada.motivo, 'Control de rutina');
  assert.equal(cancelada.estado, 'cancelada');
  base.close();
});
