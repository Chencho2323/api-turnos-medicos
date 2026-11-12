'use strict';

/**
 * Nucleo de disponibilidad de la agenda.
 *
 * La disponibilidad se calcula, no se guarda. Cada consulta parte del horario
 * semanal del profesional, le quita los bloqueos puntuales y las citas vivas
 * del dia, y parte lo que queda en cupos de la duracion pedida.
 *
 * Todo se resuelve en minutos desde la medianoche. Asi el solapamiento es una
 * resta y no hay que pelear con zonas horarias ni con el orden del texto.
 */

const { aMinutos, aHora, validarFecha } = require('./tiempo');

/** Duracion minima aceptada, en minutos. */
const DURACION_MINIMA = 5;

/** Duracion maxima aceptada, en minutos (una jornada completa). */
const DURACION_MAXIMA = 12 * 60;

/** Estados de cita que todavia ocupan cupo en la agenda. */
const ESTADOS_VIVOS = ['pendiente', 'confirmada', 'atendida', 'no_asistio'];

/**
 * Convierte una fecha AAAA-MM-DD al dia de la semana ISO (1 lunes ... 7 domingo).
 * @param {string} fecha
 * @returns {number}
 */
function diaSemanaIso(fecha) {
  validarFecha(fecha);
  const [anio, mes, dia] = fecha.split('-').map(Number);
  const diaJs = new Date(Date.UTC(anio, mes - 1, dia)).getUTCDay();
  return diaJs === 0 ? 7 : diaJs;
}

/**
 * Valida la duracion de una cita.
 * @param {number} duracionMinutos
 * @returns {number} la duracion ya validada
 */
function validarDuracion(duracionMinutos) {
  if (!Number.isInteger(duracionMinutos)) {
    throw new Error('La duracion de la cita debe ser un numero entero de minutos');
  }
  if (duracionMinutos < DURACION_MINIMA) {
    throw new Error(
      `La duracion minima de una cita es de ${DURACION_MINIMA} minutos`,
    );
  }
  if (duracionMinutos > DURACION_MAXIMA) {
    throw new Error(
      `La duracion maxima de una cita es de ${DURACION_MAXIMA} minutos`,
    );
  }
  return duracionMinutos;
}

/**
 * Ventanas de atencion del profesional para una fecha concreta, ya recortadas
 * por la vigencia del horario.
 * @param {import('node:sqlite').DatabaseSync} base
 * @param {number} profesionalId
 * @param {string} fecha
 * @returns {{inicio: number, fin: number}[]} minutos desde la medianoche
 */
function franjasDelDia(base, profesionalId, fecha) {
  const dia = diaSemanaIso(fecha);
  const filas = base
    .prepare(
      `SELECT hora_inicio, hora_fin
         FROM horario
        WHERE profesional_id = ?
          AND dia_semana = ?
          AND (vigente_desde IS NULL OR vigente_desde <= ?)
          AND (vigente_hasta IS NULL OR vigente_hasta >= ?)
        ORDER BY hora_inicio`,
    )
    .all(profesionalId, dia, fecha, fecha);

  return filas
    .map((fila) => ({ inicio: aMinutos(fila.hora_inicio), fin: aMinutos(fila.hora_fin) }))
    .filter((franja) => franja.fin > franja.inicio);
}

/**
 * Ocupaciones del dia: citas vivas y bloqueos. Devuelve los intervalos en
 * minutos, sin importar de que tabla vienen.
 * @param {import('node:sqlite').DatabaseSync} base
 * @param {number} profesionalId
 * @param {string} fecha
 * @param {{excluirCitaId?: number}} [opciones]
 * @returns {{inicio: number, fin: number, origen: string}[]}
 */
function ocupacionesDelDia(base, profesionalId, fecha, opciones = {}) {
  const marcas = ESTADOS_VIVOS.map(() => '?').join(', ');
  const excluir = opciones.excluirCitaId ?? null;

  const citas = base
    .prepare(
      `SELECT hora_inicio, hora_fin
         FROM cita
        WHERE profesional_id = ?
          AND fecha = ?
          AND estado IN (${marcas})
          AND (? IS NULL OR id <> ?)
        ORDER BY hora_inicio`,
    )
    .all(profesionalId, fecha, ...ESTADOS_VIVOS, excluir, excluir);

  const bloqueos = base
    .prepare(
      `SELECT hora_inicio, hora_fin
         FROM bloque
        WHERE profesional_id = ?
          AND fecha = ?
        ORDER BY hora_inicio`,
    )
    .all(profesionalId, fecha);

  return [
    ...citas.map((fila) => ({
      inicio: aMinutos(fila.hora_inicio),
      fin: aMinutos(fila.hora_fin),
      origen: 'cita',
    })),
    ...bloqueos.map((fila) => ({
      inicio: aMinutos(fila.hora_inicio),
      fin: aMinutos(fila.hora_fin),
      origen: 'bloqueo',
    })),
  ];
}

/**
 * Indica si dos intervalos se pisan. Dos citas que se tocan (una termina justo
 * cuando empieza la otra) no se consideran solapadas.
 * @param {{inicio: number, fin: number}} a
 * @param {{inicio: number, fin: number}} b
 * @returns {boolean}
 */
function seSolapan(a, b) {
  return a.inicio < b.fin && b.inicio < a.fin;
}

/**
 * Comprueba si un intervalo choca con alguna cita viva o algun bloqueo del
 * profesional en esa fecha.
 * @param {import('node:sqlite').DatabaseSync} base
 * @param {{profesionalId: number, fecha: string, horaInicio: string, horaFin: string,
 *          excluirCitaId?: number}} datos
 * @returns {boolean}
 */
function haySolapamiento(base, datos) {
  validarFecha(datos.fecha);
  const intervalo = {
    inicio: aMinutos(datos.horaInicio),
    fin: aMinutos(datos.horaFin),
  };
  if (intervalo.fin <= intervalo.inicio) {
    throw new Error('La hora de fin debe ser posterior a la hora de inicio');
  }

  return ocupacionesDelDia(base, datos.profesionalId, datos.fecha, {
    excluirCitaId: datos.excluirCitaId,
  }).some((ocupacion) => seSolapan(intervalo, ocupacion));
}

/**
 * Lista los cupos libres del profesional en una fecha, con la duracion pedida.
 * Los cupos arrancan junto al inicio de cada franja y avanzan en pasos de la
 * misma duracion; un cupo que se sale de la franja no se ofrece.
 * @param {import('node:sqlite').DatabaseSync} base
 * @param {{profesionalId: number, fecha: string, duracionMinutos: number}} datos
 * @returns {{horaInicio: string, horaFin: string}[]}
 */
function cuposDisponibles(base, datos) {
  validarFecha(datos.fecha);
  const duracion = validarDuracion(datos.duracionMinutos);

  const franjas = franjasDelDia(base, datos.profesionalId, datos.fecha);
  if (franjas.length === 0) {
    return [];
  }

  const ocupaciones = ocupacionesDelDia(base, datos.profesionalId, datos.fecha);
  const cupos = [];

  for (const franja of franjas) {
    for (let inicio = franja.inicio; inicio + duracion <= franja.fin; inicio += duracion) {
      const intervalo = { inicio, fin: inicio + duracion };
      const libre = !ocupaciones.some((ocupacion) => seSolapan(intervalo, ocupacion));
      if (libre) {
        cupos.push({
          horaInicio: aHora(intervalo.inicio),
          horaFin: aHora(intervalo.fin),
        });
      }
    }
  }

  return cupos;
}

/**
 * Verifica que un intervalo quepa completo dentro de una franja de atencion.
 * @param {import('node:sqlite').DatabaseSync} base
 * @param {{profesionalId: number, fecha: string, horaInicio: string, horaFin: string}} datos
 * @returns {boolean}
 */
function dentroDeHorario(base, datos) {
  validarFecha(datos.fecha);
  const intervalo = {
    inicio: aMinutos(datos.horaInicio),
    fin: aMinutos(datos.horaFin),
  };
  if (intervalo.fin <= intervalo.inicio) {
    throw new Error('La hora de fin debe ser posterior a la hora de inicio');
  }

  return franjasDelDia(base, datos.profesionalId, datos.fecha).some(
    (franja) => intervalo.inicio >= franja.inicio && intervalo.fin <= franja.fin,
  );
}

/**
 * Revisa si un intervalo se puede reservar. Devuelve el veredicto y el motivo
 * en texto para que la capa HTTP lo pueda mostrar tal cual.
 * @param {import('node:sqlite').DatabaseSync} base
 * @param {{profesionalId: number, fecha: string, horaInicio: string, horaFin: string,
 *          excluirCitaId?: number}} datos
 * @returns {{disponible: boolean, motivo?: string}}
 */
function verificarCupo(base, datos) {
  if (!dentroDeHorario(base, datos)) {
    return { disponible: false, motivo: 'El horario solicitado esta fuera de la atencion del profesional' };
  }
  if (haySolapamiento(base, datos)) {
    return { disponible: false, motivo: 'El horario solicitado se cruza con otra cita o un bloqueo' };
  }
  return { disponible: true };
}

module.exports = {
  DURACION_MINIMA,
  DURACION_MAXIMA,
  ESTADOS_VIVOS,
  diaSemanaIso,
  validarDuracion,
  franjasDelDia,
  ocupacionesDelDia,
  seSolapan,
  haySolapamiento,
  cuposDisponibles,
  dentroDeHorario,
  verificarCupo,
};
