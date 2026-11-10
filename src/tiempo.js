'use strict';

/**
 * Utilidades de hora para la agenda.
 *
 * Todas las horas se manejan como minutos desde la medianoche para poder
 * sumar, restar y comparar sin sorpresas de zonas horarias. El formato que
 * viaja hacia afuera, y el que se guarda, es siempre "HH:MM" en 24 horas.
 */

const PATRON_HORA = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;

/**
 * Convierte "HH:MM" a minutos desde la medianoche.
 * @param {string} hora
 * @returns {number}
 */
function aMinutos(hora) {
  if (typeof hora !== 'string') {
    throw new Error('La hora debe venir como texto en formato HH:MM');
  }
  const partes = PATRON_HORA.exec(hora);
  if (!partes) {
    throw new Error(`Hora invalida: "${hora}". Se espera HH:MM entre 00:00 y 23:59`);
  }
  return Number(partes[1]) * 60 + Number(partes[2]);
}

/**
 * Convierte minutos desde la medianoche a "HH:MM".
 * @param {number} minutos
 * @returns {string}
 */
function aHora(minutos) {
  if (!Number.isInteger(minutos)) {
    throw new Error('Los minutos deben ser un entero');
  }
  if (minutos < 0 || minutos >= 24 * 60) {
    throw new Error(`Minutos fuera de rango: ${minutos}. Deben estar entre 0 y 1439`);
  }
  const horas = Math.floor(minutos / 60);
  const resto = minutos % 60;
  return `${String(horas).padStart(2, '0')}:${String(resto).padStart(2, '0')}`;
}

/**
 * Valida una fecha en formato AAAA-MM-DD y descarta dias que no existen
 * (por ejemplo 2026-02-30).
 * @param {string} fecha
 * @returns {string} la misma fecha, ya validada
 */
function validarFecha(fecha) {
  if (typeof fecha !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
    throw new Error(`Fecha invalida: "${fecha}". Se espera AAAA-MM-DD`);
  }
  const [anio, mes, dia] = fecha.split('-').map(Number);
  const referencia = new Date(Date.UTC(anio, mes - 1, dia));
  const existe =
    referencia.getUTCFullYear() === anio &&
    referencia.getUTCMonth() === mes - 1 &&
    referencia.getUTCDate() === dia;
  if (!existe) {
    throw new Error(`La fecha ${fecha} no existe en el calendario`);
  }
  return fecha;
}

module.exports = { aMinutos, aHora, validarFecha };
