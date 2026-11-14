'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { abrirBase } = require('../src/base');
const { crearCita, cancelarCita, reprogramarCita } = require('../src/citas');
const {
  ANTELACIONES,
  INTENTOS_MAXIMOS,
  desplazar,
  momentoActual,
  programarRecordatorio,
  obtenerRecordatorio,
  recordatoriosDeCita,
  cancelarRecordatorio,
  encolarVencidos,
  obtenerSalida,
  tomarLote,
  marcarEnviada,
  marcarFallida,
  reintentarSalida,
  estadoDeLaCola,
} = require('../src/recordatorios');

/** Lunes 9 de noviembre de 2026. */
const FECHA = '2026-11-09';

/** Base con un profesional, un paciente con contacto y su horario. */
function baseDePrueba() {
  const base = abrirBase();
  const profesional = base
    .prepare('INSERT INTO profesional (documento, nombre, especialidad) VALUES (?, ?, ?)')
    .run('1090', 'Ana Rojas', 'Medicina general');
  const paciente = base
    .prepare('INSERT INTO paciente (documento, nombre, telefono, correo) VALUES (?, ?, ?, ?)')
    .run('7950', 'Carlos Perez', '3001234567', 'carlos@ejemplo.co');

  const profesionalId = Number(profesional.lastInsertRowid);
  for (const dia of [1, 2]) {
    base
      .prepare('INSERT INTO horario (profesional_id, dia_semana, hora_inicio, hora_fin) VALUES (?, ?, ?, ?)')
      .run(profesionalId, dia, '08:00', '12:00');
  }

  return { base, profesionalId, pacienteId: Number(paciente.lastInsertRowid) };
}

function citaDePrueba(base, profesionalId, pacienteId, datos = {}) {
  return crearCita(base, {
    profesionalId,
    pacienteId,
    fecha: datos.fecha ?? FECHA,
    horaInicio: datos.horaInicio ?? '09:00',
    horaFin: datos.horaFin ?? '09:30',
    motivo: 'Control',
  });
}

test('desplazar resta minutos y cruza la medianoche sin perder el dia', () => {
  assert.deepEqual(desplazar('2026-11-09', '09:00', -60), { fecha: '2026-11-09', hora: '08:00' });
  assert.deepEqual(desplazar('2026-11-09', '08:00', -ANTELACIONES.unDia), {
    fecha: '2026-11-08',
    hora: '08:00',
  });
  assert.deepEqual(desplazar('2026-03-01', '00:30', -60), { fecha: '2026-02-28', hora: '23:30' });
  assert.deepEqual(desplazar('2026-11-09', '09:00', 90), { fecha: '2026-11-09', hora: '10:30' });
});

test('programarRecordatorio deja el aviso un dia antes por defecto', () => {
  const { base, profesionalId, pacienteId } = baseDePrueba();
  const cita = citaDePrueba(base, profesionalId, pacienteId);

  const recordatorio = programarRecordatorio(base, { citaId: cita.id });
  assert.equal(recordatorio.canal, 'whatsapp');
  assert.equal(recordatorio.destinatario, '3001234567');
  assert.equal(recordatorio.fechaAviso, '2026-11-08');
  assert.equal(recordatorio.horaAviso, '09:00');
  assert.equal(recordatorio.estado, 'pendiente');
  assert.equal(recordatorio.citaCodigo, cita.codigo);
  assert.match(recordatorio.mensaje, /Ana Rojas/);
  assert.match(recordatorio.mensaje, /09:00/);
  base.close();
});

test('el mensaje usa el contacto que corresponde al canal', () => {
  const { base, profesionalId, pacienteId } = baseDePrueba();
  const cita = citaDePrueba(base, profesionalId, pacienteId);

  const porCorreo = programarRecordatorio(base, {
    citaId: cita.id,
    canal: 'correo',
    antelacionMinutos: ANTELACIONES.tresHoras,
  });
  assert.equal(porCorreo.destinatario, 'carlos@ejemplo.co');
  assert.equal(porCorreo.horaAviso, '06:00');
  base.close();
});

test('sin contacto para el canal se rechaza con motivo', () => {
  const { base, profesionalId, pacienteId } = baseDePrueba();
  const cita = citaDePrueba(base, profesionalId, pacienteId);
  base.prepare('UPDATE paciente SET correo = NULL WHERE id = ?').run(pacienteId);

  assert.throws(
    () => programarRecordatorio(base, { citaId: cita.id, canal: 'correo' }),
    (error) => error.codigo === 'contacto_no_disponible' && error.estado === 409,
  );
  base.close();
});

test('un destinatario explicito gana sobre el contacto guardado', () => {
  const { base, profesionalId, pacienteId } = baseDePrueba();
  const cita = citaDePrueba(base, profesionalId, pacienteId);

  const recordatorio = programarRecordatorio(base, {
    citaId: cita.id,
    destinatario: '3107654321',
  });
  assert.equal(recordatorio.destinatario, '3107654321');
  base.close();
});

test('rechaza canal desconocido, antelacion invalida y cita inexistente', () => {
  const { base, profesionalId, pacienteId } = baseDePrueba();
  const cita = citaDePrueba(base, profesionalId, pacienteId);

  assert.throws(
    () => programarRecordatorio(base, { citaId: cita.id, canal: 'paloma' }),
    (error) => error.codigo === 'canal_invalido',
  );
  assert.throws(
    () => programarRecordatorio(base, { citaId: cita.id, antelacionMinutos: 0 }),
    (error) => error.codigo === 'antelacion_invalida',
  );
  assert.throws(
    () => programarRecordatorio(base, { citaId: cita.id, antelacionMinutos: 8 * 24 * 60 }),
    (error) => error.codigo === 'antelacion_invalida',
  );
  assert.throws(
    () => programarRecordatorio(base, { citaId: 999 }),
    (error) => error.codigo === 'cita_no_encontrada' && error.estado === 404,
  );
  base.close();
});

test('no se puede programar dos veces el mismo aviso ni sobre una cancelada', () => {
  const { base, profesionalId, pacienteId } = baseDePrueba();
  const cita = citaDePrueba(base, profesionalId, pacienteId);

  programarRecordatorio(base, { citaId: cita.id });
  assert.throws(
    () => programarRecordatorio(base, { citaId: cita.id }),
    (error) => error.codigo === 'recordatorio_repetido' && error.estado === 409,
  );

  // El mismo aviso por otro canal si es otro trabajo.
  const porSms = programarRecordatorio(base, { citaId: cita.id, canal: 'sms' });
  assert.equal(porSms.canal, 'sms');

  const otra = citaDePrueba(base, profesionalId, pacienteId, { horaInicio: '10:00', horaFin: '10:30' });
  cancelarCita(base, otra.id);
  assert.throws(
    () => programarRecordatorio(base, { citaId: otra.id }),
    (error) => error.codigo === 'estado_sin_recordatorio' && error.estado === 409,
  );
  base.close();
});

test('cancelar una cita apaga sus recordatorios pendientes', () => {
  const { base, profesionalId, pacienteId } = baseDePrueba();
  const cita = citaDePrueba(base, profesionalId, pacienteId);
  programarRecordatorio(base, { citaId: cita.id });
  programarRecordatorio(base, { citaId: cita.id, canal: 'sms' });

  cancelarCita(base, cita.id, { motivo: 'No puede asistir' });

  const estados = recordatoriosDeCita(base, cita.id).map((r) => r.estado);
  assert.deepEqual(estados, ['cancelado', 'cancelado']);
  base.close();
});

test('reprogramar una cita apaga los avisos viejos y deja programar los nuevos', () => {
  const { base, profesionalId, pacienteId } = baseDePrueba();
  const cita = citaDePrueba(base, profesionalId, pacienteId);
  programarRecordatorio(base, { citaId: cita.id });

  reprogramarCita(base, cita.id, { fecha: '2026-11-10', horaInicio: '09:00', horaFin: '09:30' });

  assert.equal(recordatoriosDeCita(base, cita.id)[0].estado, 'cancelado');
  const nuevo = programarRecordatorio(base, { citaId: cita.id });
  assert.equal(nuevo.fechaAviso, '2026-11-09');
  assert.equal(nuevo.estado, 'pendiente');
  base.close();
});

test('cancelarRecordatorio no deja cancelar uno ya enviado', () => {
  const { base, profesionalId, pacienteId } = baseDePrueba();
  const cita = citaDePrueba(base, profesionalId, pacienteId);
  const recordatorio = programarRecordatorio(base, { citaId: cita.id });

  const salidas = encolarVencidos(base, { ahora: { fecha: '2026-11-09', hora: '00:00' } });
  assert.equal(salidas.length, 1);
  assert.equal(salidas[0].recordatorioId, recordatorio.id);
  marcarEnviada(base, salidas[0].id);

  assert.throws(
    () => cancelarRecordatorio(base, recordatorio.id),
    (error) => error.codigo === 'estado_no_cancelable' && error.estado === 409,
  );
  base.close();
});

test('encolarVencidos solo toma lo que ya llego a su hora', () => {
  const { base, profesionalId, pacienteId } = baseDePrueba();
  const cita = citaDePrueba(base, profesionalId, pacienteId, { horaInicio: '11:00', horaFin: '11:30' });
  programarRecordatorio(base, { citaId: cita.id, antelacionMinutos: ANTELACIONES.mediaHora });

  const temprano = encolarVencidos(base, { ahora: { fecha: '2026-11-09', hora: '10:29' } });
  assert.deepEqual(temprano, []);

  const justo = encolarVencidos(base, { ahora: { fecha: '2026-11-09', hora: '10:30' } });
  assert.equal(justo.length, 1);
  assert.equal(justo[0].canal, 'whatsapp');
  assert.equal(justo[0].estado, 'en_cola');
  assert.match(justo[0].cuerpo, /Carlos|Ana Rojas/);

  // Encolar dos veces no duplica: el recordatorio ya no esta pendiente.
  assert.deepEqual(encolarVencidos(base, { ahora: { fecha: '2026-11-09', hora: '11:00' } }), []);
  assert.equal(obtenerRecordatorio(base, justo[0].recordatorioId).estado, 'en_cola');
  base.close();
});

test('encolarVencidos respeta el limite del lote', () => {
  const { base, profesionalId, pacienteId } = baseDePrueba();
  const cita = citaDePrueba(base, profesionalId, pacienteId);
  programarRecordatorio(base, { citaId: cita.id, canal: 'whatsapp' });
  programarRecordatorio(base, { citaId: cita.id, canal: 'sms' });
  programarRecordatorio(base, { citaId: cita.id, canal: 'llamada' });

  const lote = encolarVencidos(base, {
    ahora: { fecha: '2026-11-09', hora: '08:00' },
    limite: 2,
  });
  assert.equal(lote.length, 2);
  assert.equal(estadoDeLaCola(base).en_cola, 2);
  base.close();
});

test('una cita cancelada despues de vencer no genera mensaje', () => {
  const { base, profesionalId, pacienteId } = baseDePrueba();
  const cita = citaDePrueba(base, profesionalId, pacienteId);
  programarRecordatorio(base, { citaId: cita.id });
  cancelarCita(base, cita.id);

  const salidas = encolarVencidos(base, { ahora: { fecha: '2026-11-10', hora: '00:00' } });
  assert.deepEqual(salidas, []);
  base.close();
});

test('tomarLote saca la salida de la cola y la deja en enviando', () => {
  const { base, profesionalId, pacienteId } = baseDePrueba();
  const cita = citaDePrueba(base, profesionalId, pacienteId);
  programarRecordatorio(base, { citaId: cita.id });
  encolarVencidos(base, { ahora: { fecha: '2026-11-09', hora: '00:00' } });

  const primero = tomarLote(base, { limite: 10 });
  assert.equal(primero.length, 1);
  assert.equal(primero[0].estado, 'enviando');

  // Un segundo proceso no vuelve a agarrar el mismo trabajo.
  assert.deepEqual(tomarLote(base, { limite: 10 }), []);
  base.close();
});

test('marcarEnviada cierra la salida y el recordatorio', () => {
  const { base, profesionalId, pacienteId } = baseDePrueba();
  const cita = citaDePrueba(base, profesionalId, pacienteId);
  const recordatorio = programarRecordatorio(base, { citaId: cita.id });
  const [salida] = encolarVencidos(base, { ahora: { fecha: '2026-11-09', hora: '00:00' } });

  const enviada = marcarEnviada(base, salida.id);
  assert.equal(enviada.estado, 'enviado');
  assert.equal(enviada.intentos, 1);
  assert.match(enviada.enviadoEn, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.equal(obtenerRecordatorio(base, recordatorio.id).estado, 'enviado');

  assert.throws(
    () => marcarEnviada(base, salida.id),
    (error) => error.codigo === 'salida_ya_enviada' && error.estado === 409,
  );
  base.close();
});

test('un fallo devuelve la salida a la cola hasta agotar los intentos', () => {
  const { base, profesionalId, pacienteId } = baseDePrueba();
  const cita = citaDePrueba(base, profesionalId, pacienteId);
  programarRecordatorio(base, { citaId: cita.id });
  const [salida] = encolarVencidos(base, { ahora: { fecha: '2026-11-09', hora: '00:00' } });

  const primero = marcarFallida(base, salida.id, 'Canal sin respuesta');
  assert.equal(primero.estado, 'en_cola');
  assert.equal(primero.intentos, 1);
  assert.equal(primero.ultimoError, 'Canal sin respuesta');

  marcarFallida(base, salida.id, 'Canal sin respuesta');
  const ultimo = marcarFallida(base, salida.id, 'Canal sin respuesta');
  assert.equal(ultimo.estado, 'fallido');
  assert.equal(ultimo.intentos, INTENTOS_MAXIMOS);
  assert.equal(obtenerRecordatorio(base, salida.recordatorioId).estado, 'fallido');

  // Ya no vuelve a salir en un lote automatico.
  assert.deepEqual(tomarLote(base, { limite: 10 }), []);
  base.close();
});

test('reintentarSalida devuelve a la cola solo lo fallido', () => {
  const { base, profesionalId, pacienteId } = baseDePrueba();
  const cita = citaDePrueba(base, profesionalId, pacienteId);
  programarRecordatorio(base, { citaId: cita.id });
  const [salida] = encolarVencidos(base, { ahora: { fecha: '2026-11-09', hora: '00:00' } });

  assert.throws(
    () => reintentarSalida(base, salida.id),
    (error) => error.codigo === 'estado_no_reintentable',
  );

  for (let i = 0; i < INTENTOS_MAXIMOS; i += 1) {
    marcarFallida(base, salida.id, 'Sin senal');
  }

  const reintentada = reintentarSalida(base, salida.id);
  assert.equal(reintentada.estado, 'en_cola');
  assert.equal(reintentada.intentos, 0);
  assert.equal(obtenerRecordatorio(base, salida.recordatorioId).estado, 'en_cola');
  base.close();
});

test('estadoDeLaCola cuenta por estado', () => {
  const { base, profesionalId, pacienteId } = baseDePrueba();
  const cita = citaDePrueba(base, profesionalId, pacienteId);
  programarRecordatorio(base, { citaId: cita.id, canal: 'whatsapp' });
  programarRecordatorio(base, { citaId: cita.id, canal: 'sms' });

  assert.deepEqual(estadoDeLaCola(base), {
    en_cola: 0,
    enviando: 0,
    enviado: 0,
    fallido: 0,
    cancelado: 0,
  });

  const salidas = encolarVencidos(base, { ahora: { fecha: '2026-11-09', hora: '00:00' } });
  marcarEnviada(base, salidas[0].id);

  assert.deepEqual(estadoDeLaCola(base), {
    en_cola: 1,
    enviando: 0,
    enviado: 1,
    fallido: 0,
    cancelado: 0,
  });
  assert.equal(obtenerSalida(base, salidas[0].id).estado, 'enviado');
  base.close();
});

test('momentoActual devuelve fecha y hora en el formato de la tabla', () => {
  const momento = momentoActual(new Date('2026-11-09T14:35:00Z'));
  assert.deepEqual(momento, { fecha: '2026-11-09', hora: '14:35' });
});
