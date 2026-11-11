'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { abrirBase, versionEsquema, tablas } = require('../src/base');
const { VERSION_ESQUEMA } = require('../src/esquema');

/** Base en memoria con el esquema listo. */
function baseDePrueba() {
  return abrirBase();
}

/** Inserta un profesional y un paciente minimos y devuelve sus ids. */
function semilla(base) {
  const profesional = base
    .prepare('INSERT INTO profesional (documento, nombre, especialidad) VALUES (?, ?, ?)')
    .run('1090', 'Ana Rojas', 'Medicina general');
  const paciente = base
    .prepare('INSERT INTO paciente (documento, nombre) VALUES (?, ?)')
    .run('7950', 'Carlos Perez');
  return {
    profesionalId: Number(profesional.lastInsertRowid),
    pacienteId: Number(paciente.lastInsertRowid),
  };
}

function insertarCita(base, datos) {
  return base
    .prepare(
      `INSERT INTO cita
         (codigo, profesional_id, paciente_id, fecha, hora_inicio, hora_fin, estado, motivo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      datos.codigo,
      datos.profesionalId,
      datos.pacienteId,
      datos.fecha,
      datos.horaInicio,
      datos.horaFin,
      datos.estado ?? 'pendiente',
      datos.motivo ?? null,
    );
}

test('el esquema crea las cinco tablas del negocio', () => {
  const base = baseDePrueba();
  assert.deepEqual(tablas(base), ['bloque', 'cita', 'horario', 'paciente', 'profesional']);
  assert.equal(versionEsquema(base), VERSION_ESQUEMA);
  base.close();
});

test('abrir dos veces sobre el mismo archivo no falla ni duplica tablas', () => {
  const carpeta = fs.mkdtempSync(path.join(os.tmpdir(), 'turnos-'));
  const ruta = path.join(carpeta, 'agenda.db');

  const primera = abrirBase(ruta);
  semilla(primera);
  primera.close();

  const segunda = abrirBase(ruta);
  assert.equal(tablas(segunda).length, 5);
  assert.equal(segunda.prepare('SELECT count(*) AS n FROM profesional').get().n, 1);
  segunda.close();

  fs.rmSync(carpeta, { recursive: true, force: true });
});

test('rechaza una hora que no cumple HH:MM', () => {
  const base = baseDePrueba();
  const { profesionalId } = semilla(base);
  const insertar = base.prepare(
    'INSERT INTO horario (profesional_id, dia_semana, hora_inicio, hora_fin) VALUES (?, ?, ?, ?)',
  );

  assert.throws(() => insertar.run(profesionalId, 1, '8:00', '12:00'), /CHECK/);
  assert.throws(() => insertar.run(profesionalId, 1, '08:00', '24:00'), /CHECK/);
  assert.throws(() => insertar.run(profesionalId, 1, '08:00', '12:60'), /CHECK/);
  base.close();
});

test('rechaza un horario que termina antes de empezar', () => {
  const base = baseDePrueba();
  const { profesionalId } = semilla(base);
  assert.throws(
    () =>
      base
        .prepare('INSERT INTO horario (profesional_id, dia_semana, hora_inicio, hora_fin) VALUES (?, ?, ?, ?)')
        .run(profesionalId, 2, '15:00', '09:00'),
    /CHECK/,
  );
  base.close();
});

test('el dia de la semana solo admite de 1 a 7', () => {
  const base = baseDePrueba();
  const { profesionalId } = semilla(base);
  const insertar = base.prepare(
    'INSERT INTO horario (profesional_id, dia_semana, hora_inicio, hora_fin) VALUES (?, ?, ?, ?)',
  );
  assert.throws(() => insertar.run(profesionalId, 0, '08:00', '09:00'), /CHECK/);
  assert.throws(() => insertar.run(profesionalId, 8, '08:00', '09:00'), /CHECK/);
  insertar.run(profesionalId, 7, '08:00', '09:00');
  base.close();
});

test('el documento del profesional es unico', () => {
  const base = baseDePrueba();
  semilla(base);
  assert.throws(
    () =>
      base
        .prepare('INSERT INTO profesional (documento, nombre, especialidad) VALUES (?, ?, ?)')
        .run('1090', 'Otra persona', 'Odontologia'),
    /UNIQUE/,
  );
  base.close();
});

test('el estado de la cita solo acepta los valores previstos', () => {
  const base = baseDePrueba();
  const { profesionalId, pacienteId } = semilla(base);
  assert.throws(
    () =>
      insertarCita(base, {
        codigo: 'C-1',
        profesionalId,
        pacienteId,
        fecha: '2026-11-12',
        horaInicio: '09:00',
        horaFin: '09:30',
        estado: 'en_espera',
      }),
    /CHECK/,
  );
  base.close();
});

test('una fecha con formato distinto no entra en la cita', () => {
  const base = baseDePrueba();
  const { profesionalId, pacienteId } = semilla(base);
  assert.throws(
    () =>
      insertarCita(base, {
        codigo: 'C-2',
        profesionalId,
        pacienteId,
        fecha: '12/11/2026',
        horaInicio: '09:00',
        horaFin: '09:30',
      }),
    /CHECK/,
  );
  base.close();
});

test('dos citas vivas no comparten el mismo cupo', () => {
  const base = baseDePrueba();
  const { profesionalId, pacienteId } = semilla(base);
  const comun = {
    profesionalId,
    pacienteId,
    fecha: '2026-11-12',
    horaInicio: '09:00',
    horaFin: '09:30',
  };

  insertarCita(base, { ...comun, codigo: 'C-3' });
  assert.throws(() => insertarCita(base, { ...comun, codigo: 'C-4' }), /UNIQUE/);
  base.close();
});

test('una cita cancelada libera el cupo y se conserva en el historico', () => {
  const base = baseDePrueba();
  const { profesionalId, pacienteId } = semilla(base);
  const comun = {
    profesionalId,
    pacienteId,
    fecha: '2026-11-12',
    horaInicio: '10:00',
    horaFin: '10:30',
  };

  const primera = insertarCita(base, { ...comun, codigo: 'C-5' });
  base
    .prepare("UPDATE cita SET estado = 'cancelada' WHERE id = ?")
    .run(Number(primera.lastInsertRowid));

  insertarCita(base, { ...comun, codigo: 'C-6' });

  const filas = base
    .prepare('SELECT codigo, estado FROM cita ORDER BY codigo')
    .all()
    .map((fila) => ({ ...fila }));
  assert.deepEqual(filas, [
    { codigo: 'C-5', estado: 'cancelada' },
    { codigo: 'C-6', estado: 'pendiente' },
  ]);
  base.close();
});

test('dos profesionales si pueden atender a la misma hora', () => {
  const base = baseDePrueba();
  const { pacienteId } = semilla(base);
  const segundo = base
    .prepare('INSERT INTO profesional (documento, nombre, especialidad) VALUES (?, ?, ?)')
    .run('2090', 'Luis Mora', 'Pediatria');
  const segundoId = Number(segundo.lastInsertRowid);
  const primero = base.prepare('SELECT id FROM profesional WHERE documento = ?').get('1090');

  const comun = { pacienteId, fecha: '2026-11-12', horaInicio: '11:00', horaFin: '11:30' };
  insertarCita(base, { ...comun, codigo: 'C-7', profesionalId: Number(primero.id) });
  insertarCita(base, { ...comun, codigo: 'C-8', profesionalId: segundoId });

  assert.equal(base.prepare('SELECT count(*) AS n FROM cita').get().n, 2);
  base.close();
});

test('no se puede citar a un profesional que no existe', () => {
  const base = baseDePrueba();
  const { pacienteId } = semilla(base);
  assert.throws(
    () =>
      insertarCita(base, {
        codigo: 'C-9',
        profesionalId: 999,
        pacienteId,
        fecha: '2026-11-12',
        horaInicio: '09:00',
        horaFin: '09:30',
      }),
    /FOREIGN KEY/,
  );
  base.close();
});

test('el bloque guarda el motivo y suelta la agenda al borrarlo', () => {
  const base = baseDePrueba();
  const { profesionalId } = semilla(base);
  base
    .prepare('INSERT INTO bloque (profesional_id, fecha, hora_inicio, hora_fin, motivo) VALUES (?, ?, ?, ?, ?)')
    .run(profesionalId, '2026-11-13', '08:00', '11:00', 'Cirugia programada');

  const bloque = { ...base.prepare('SELECT motivo, hora_inicio, hora_fin FROM bloque').get() };
  assert.deepEqual(bloque, { motivo: 'Cirugia programada', hora_inicio: '08:00', hora_fin: '11:00' });

  base.prepare('DELETE FROM bloque WHERE profesional_id = ?').run(profesionalId);
  assert.equal(base.prepare('SELECT count(*) AS n FROM bloque').get().n, 0);
  base.close();
});

test('borrar un profesional arrastra sus horarios', () => {
  const base = baseDePrueba();
  const { profesionalId } = semilla(base);
  base
    .prepare('INSERT INTO horario (profesional_id, dia_semana, hora_inicio, hora_fin) VALUES (?, ?, ?, ?)')
    .run(profesionalId, 3, '08:00', '12:00');

  base.prepare('DELETE FROM profesional WHERE id = ?').run(profesionalId);
  assert.equal(base.prepare('SELECT count(*) AS n FROM horario').get().n, 0);
  base.close();
});

test('borrar un profesional con citas se rechaza', () => {
  const base = baseDePrueba();
  const { profesionalId, pacienteId } = semilla(base);
  insertarCita(base, {
    codigo: 'C-10',
    profesionalId,
    pacienteId,
    fecha: '2026-11-12',
    horaInicio: '09:00',
    horaFin: '09:30',
  });

  assert.throws(() => base.prepare('DELETE FROM profesional WHERE id = ?').run(profesionalId), /FOREIGN KEY/);
  base.close();
});

test('una actualizacion de la cita refresca la marca de tiempo', () => {
  const base = baseDePrueba();
  const { profesionalId, pacienteId } = semilla(base);
  const cita = insertarCita(base, {
    codigo: 'C-11',
    profesionalId,
    pacienteId,
    fecha: '2026-11-12',
    horaInicio: '09:00',
    horaFin: '09:30',
  });
  const id = Number(cita.lastInsertRowid);

  base.prepare("UPDATE cita SET actualizada_en = '2000-01-01T00:00:00Z' WHERE id = ?").run(id);
  base.prepare("UPDATE cita SET motivo = 'Control' WHERE id = ?").run(id);

  const fila = base.prepare('SELECT motivo, actualizada_en FROM cita WHERE id = ?').get(id);
  assert.equal(fila.motivo, 'Control');
  assert.notEqual(fila.actualizada_en, '2000-01-01T00:00:00Z');
  assert.match(fila.actualizada_en, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  base.close();
});
