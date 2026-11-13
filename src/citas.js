'use strict';

/**
 * Ciclo de vida de una cita: crear, reprogramar y cancelar.
 *
 * El nucleo de disponibilidad dice si un intervalo cabe; este modulo es el
 * que escribe. La regla de oro es que una cita cancelada no se borra: cambia
 * de estado y libera el cupo. Asi el paciente conserva su historico y el
 * indice parcial de la tabla sigue haciendo su trabajo.
 *
 * Los errores que puede corregir quien llama (un horario ocupado, una cita
 * que no existe) salen como ErrorAgenda con un estado HTTP sugerido, para que
 * la capa de arriba no tenga que adivinar.
 */

const { aMinutos, validarFecha } = require('./tiempo');
const { validarDuracion, verificarCupo } = require('./disponibilidad');

/** Estados desde los que todavia se puede mover una cita. */
const ESTADOS_REPROGRAMABLES = ['pendiente', 'confirmada'];

/** Estados desde los que se puede cancelar. */
const ESTADOS_CANCELABLES = ['pendiente', 'confirmada'];

/**
 * Error de negocio de la agenda. Lleva el codigo y el estado HTTP sugerido
 * para que la capa HTTP responda sin traducir mensajes a mano.
 */
class ErrorAgenda extends Error {
  /**
   * @param {string} mensaje texto que puede ver el usuario
   * @param {{codigo?: string, estado?: number}} [opciones]
   */
  constructor(mensaje, opciones = {}) {
    super(mensaje);
    this.name = 'ErrorAgenda';
    this.codigo = opciones.codigo ?? 'solicitud_invalida';
    this.estado = opciones.estado ?? 400;
  }
}

/** Fila de cita tal como viaja hacia afuera, con nombres resueltos. */
const CONSULTA_CITA = `
  SELECT c.id, c.codigo, c.fecha, c.hora_inicio, c.hora_fin, c.estado, c.motivo,
         c.creada_en, c.actualizada_en,
         c.profesional_id, p.nombre AS profesional_nombre, p.especialidad,
         c.paciente_id, pa.nombre AS paciente_nombre, pa.documento AS paciente_documento
    FROM cita c
    JOIN profesional p ON p.id = c.profesional_id
    JOIN paciente pa ON pa.id = c.paciente_id
   WHERE c.id = ?
`;

/**
 * Pasa una fila de SQLite al formato de la API (nombres en camelCase).
 * @param {object} fila
 * @returns {object}
 */
function aCita(fila) {
  if (!fila) return null;
  return {
    id: Number(fila.id),
    codigo: fila.codigo,
    fecha: fila.fecha,
    horaInicio: fila.hora_inicio,
    horaFin: fila.hora_fin,
    estado: fila.estado,
    motivo: fila.motivo ?? null,
    profesionalId: Number(fila.profesional_id),
    profesional: fila.profesional_nombre,
    especialidad: fila.especialidad,
    pacienteId: Number(fila.paciente_id),
    paciente: fila.paciente_nombre,
    pacienteDocumento: fila.paciente_documento,
    creadaEn: fila.creada_en,
    actualizadaEn: fila.actualizada_en,
  };
}

/**
 * Busca una cita por id y la devuelve en formato de la API.
 * @param {import('node:sqlite').DatabaseSync} base
 * @param {number} citaId
 * @returns {object|null}
 */
function obtenerCita(base, citaId) {
  if (!Number.isInteger(citaId)) {
    throw new ErrorAgenda('El identificador de la cita debe ser un entero');
  }
  return aCita(base.prepare(CONSULTA_CITA).get(citaId));
}

/**
 * Igual que obtenerCita, pero revienta si la cita no existe.
 * @param {import('node:sqlite').DatabaseSync} base
 * @param {number} citaId
 * @returns {object}
 */
function exigirCita(base, citaId) {
  const cita = obtenerCita(base, citaId);
  if (!cita) {
    throw new ErrorAgenda(`No existe la cita ${citaId}`, {
      codigo: 'cita_no_encontrada',
      estado: 404,
    });
  }
  return cita;
}

/**
 * Comprueba que el profesional exista y este activo.
 * @param {import('node:sqlite').DatabaseSync} base
 * @param {number} profesionalId
 * @returns {object}
 */
function exigirProfesional(base, profesionalId) {
  const fila = base
    .prepare('SELECT id, nombre, activo FROM profesional WHERE id = ?')
    .get(profesionalId);
  if (!fila) {
    throw new ErrorAgenda(`No existe el profesional ${profesionalId}`, {
      codigo: 'profesional_no_encontrado',
      estado: 404,
    });
  }
  if (Number(fila.activo) !== 1) {
    throw new ErrorAgenda(`El profesional ${fila.nombre} no esta atendiendo`, {
      codigo: 'profesional_inactivo',
      estado: 409,
    });
  }
  return fila;
}

/**
 * Comprueba que el paciente exista y este activo.
 * @param {import('node:sqlite').DatabaseSync} base
 * @param {number} pacienteId
 * @returns {object}
 */
function exigirPaciente(base, pacienteId) {
  const fila = base
    .prepare('SELECT id, nombre, activo FROM paciente WHERE id = ?')
    .get(pacienteId);
  if (!fila) {
    throw new ErrorAgenda(`No existe el paciente ${pacienteId}`, {
      codigo: 'paciente_no_encontrado',
      estado: 404,
    });
  }
  if (Number(fila.activo) !== 1) {
    throw new ErrorAgenda(`El paciente ${fila.nombre} esta inactivo`, {
      codigo: 'paciente_inactivo',
      estado: 409,
    });
  }
  return fila;
}

/**
 * Valida el intervalo y devuelve su duracion en minutos.
 * @param {string} horaInicio
 * @param {string} horaFin
 * @returns {number}
 */
function validarIntervalo(horaInicio, horaFin) {
  const inicio = aMinutos(horaInicio);
  const fin = aMinutos(horaFin);
  if (fin <= inicio) {
    throw new ErrorAgenda('La hora de fin debe ser posterior a la hora de inicio');
  }
  return validarDuracion(fin - inicio);
}

/**
 * Arma el codigo legible de la cita: C-AAAAMMDD-NNNN, consecutivo por dia.
 * Si el consecutivo ya esta tomado (por ejemplo, una cita borrada a mano en
 * un ambiente de pruebas) avanza hasta encontrar uno libre.
 * @param {import('node:sqlite').DatabaseSync} base
 * @param {string} fecha
 * @returns {string}
 */
function siguienteCodigo(base, fecha) {
  const marca = fecha.replace(/-/g, '');
  const prefijo = `C-${marca}-`;
  const ultima = base
    .prepare('SELECT codigo FROM cita WHERE codigo LIKE ? ORDER BY codigo DESC LIMIT 1')
    .get(`${prefijo}%`);

  let consecutivo = 1;
  if (ultima) {
    const numero = Number(ultima.codigo.slice(prefijo.length));
    if (Number.isInteger(numero)) consecutivo = numero + 1;
  }

  const existe = base.prepare('SELECT 1 AS hay FROM cita WHERE codigo = ?');
  for (;;) {
    const codigo = `${prefijo}${String(consecutivo).padStart(4, '0')}`;
    if (!existe.get(codigo)) return codigo;
    consecutivo += 1;
  }
}

/**
 * Revisa el cupo y lanza el error con el motivo si no se puede reservar.
 * @param {import('node:sqlite').DatabaseSync} base
 * @param {{profesionalId: number, fecha: string, horaInicio: string, horaFin: string,
 *          excluirCitaId?: number}} datos
 */
function exigirCupo(base, datos) {
  const veredicto = verificarCupo(base, datos);
  if (!veredicto.disponible) {
    throw new ErrorAgenda(veredicto.motivo, {
      codigo: 'cupo_no_disponible',
      estado: 409,
    });
  }
}

/**
 * Agenda una cita nueva en estado pendiente.
 * @param {import('node:sqlite').DatabaseSync} base
 * @param {{profesionalId: number, pacienteId: number, fecha: string,
 *          horaInicio: string, horaFin: string, motivo?: string}} datos
 * @returns {object} la cita creada
 */
function crearCita(base, datos) {
  exigirProfesional(base, datos.profesionalId);
  exigirPaciente(base, datos.pacienteId);
  validarFecha(datos.fecha);
  validarIntervalo(datos.horaInicio, datos.horaFin);
  exigirCupo(base, datos);

  const motivo = typeof datos.motivo === 'string' && datos.motivo.trim() !== ''
    ? datos.motivo.trim()
    : null;
  const codigo = siguienteCodigo(base, datos.fecha);

  const resultado = base
    .prepare(
      `INSERT INTO cita (codigo, profesional_id, paciente_id, fecha, hora_inicio, hora_fin, motivo)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      codigo,
      datos.profesionalId,
      datos.pacienteId,
      datos.fecha,
      datos.horaInicio,
      datos.horaFin,
      motivo,
    );

  return obtenerCita(base, Number(resultado.lastInsertRowid));
}

/**
 * Mueve una cita viva a otro horario. El profesional y el paciente no cambian:
 * para eso se cancela y se agenda de nuevo.
 * @param {import('node:sqlite').DatabaseSync} base
 * @param {number} citaId
 * @param {{fecha: string, horaInicio: string, horaFin: string, motivo?: string}} datos
 * @returns {object} la cita actualizada
 */
function reprogramarCita(base, citaId, datos) {
  const cita = exigirCita(base, citaId);
  if (!ESTADOS_REPROGRAMABLES.includes(cita.estado)) {
    throw new ErrorAgenda(
      `La cita ${cita.codigo} esta ${cita.estado} y no se puede reprogramar`,
      { codigo: 'estado_no_reprogramable', estado: 409 },
    );
  }

  validarFecha(datos.fecha);
  validarIntervalo(datos.horaInicio, datos.horaFin);
  // excluirCitaId evita que la propia cita, todavia en la tabla con su horario
  // viejo, se cuente como un cruce contra si misma.
  exigirCupo(base, {
    profesionalId: cita.profesionalId,
    fecha: datos.fecha,
    horaInicio: datos.horaInicio,
    horaFin: datos.horaFin,
    excluirCitaId: cita.id,
  });

  const motivo = typeof datos.motivo === 'string' && datos.motivo.trim() !== ''
    ? datos.motivo.trim()
    : cita.motivo;

  base
    .prepare(
      `UPDATE cita
          SET fecha = ?, hora_inicio = ?, hora_fin = ?, motivo = ?, actualizada_en = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
        WHERE id = ?`,
    )
    .run(datos.fecha, datos.horaInicio, datos.horaFin, motivo, cita.id);

  return obtenerCita(base, cita.id);
}

/**
 * Cancela una cita. No se borra: pasa a estado cancelada y queda en el
 * historico, sin ocupar cupo.
 * @param {import('node:sqlite').DatabaseSync} base
 * @param {number} citaId
 * @param {{motivo?: string}} [opciones]
 * @returns {object} la cita cancelada
 */
function cancelarCita(base, citaId, opciones = {}) {
  const cita = exigirCita(base, citaId);
  if (cita.estado === 'cancelada') {
    throw new ErrorAgenda(`La cita ${cita.codigo} ya estaba cancelada`, {
      codigo: 'cita_ya_cancelada',
      estado: 409,
    });
  }
  if (!ESTADOS_CANCELABLES.includes(cita.estado)) {
    throw new ErrorAgenda(
      `La cita ${cita.codigo} esta ${cita.estado} y no se puede cancelar`,
      { codigo: 'estado_no_cancelable', estado: 409 },
    );
  }

  const motivo = typeof opciones.motivo === 'string' && opciones.motivo.trim() !== ''
    ? opciones.motivo.trim()
    : cita.motivo;

  base
    .prepare(
      `UPDATE cita
          SET estado = 'cancelada', motivo = ?, actualizada_en = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
        WHERE id = ?`,
    )
    .run(motivo, cita.id);

  return obtenerCita(base, cita.id);
}

module.exports = {
  ESTADOS_REPROGRAMABLES,
  ESTADOS_CANCELABLES,
  ErrorAgenda,
  obtenerCita,
  siguienteCodigo,
  crearCita,
  reprogramarCita,
  cancelarCita,
};
