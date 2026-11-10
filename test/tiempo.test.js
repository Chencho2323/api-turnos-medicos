'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { aMinutos, aHora, validarFecha } = require('../src/tiempo');

test('convierte una hora a minutos desde la medianoche', () => {
  assert.equal(aMinutos('00:00'), 0);
  assert.equal(aMinutos('08:30'), 510);
  assert.equal(aMinutos('23:59'), 1439);
});

test('rechaza horas con formato invalido', () => {
  assert.throws(() => aMinutos('8:30'), /Hora invalida/);
  assert.throws(() => aMinutos('24:00'), /Hora invalida/);
  assert.throws(() => aMinutos('12:60'), /Hora invalida/);
  assert.throws(() => aMinutos(null), /La hora debe venir como texto/);
});

test('devuelve la hora de vuelta sin perder el relleno con cero', () => {
  assert.equal(aHora(0), '00:00');
  assert.equal(aHora(510), '08:30');
  assert.equal(aHora(1439), '23:59');
});

test('el ida y vuelta entre minutos y hora se conserva', () => {
  for (let minutos = 0; minutos < 1440; minutos += 17) {
    assert.equal(aMinutos(aHora(minutos)), minutos);
  }
});

test('rechaza minutos fuera del dia', () => {
  assert.throws(() => aHora(-1), /fuera de rango/);
  assert.throws(() => aHora(1440), /fuera de rango/);
  assert.throws(() => aHora(90.5), /entero/);
});

test('acepta fechas reales y rechaza las que no existen', () => {
  assert.equal(validarFecha('2026-11-10'), '2026-11-10');
  assert.throws(() => validarFecha('2026-02-30'), /no existe/);
  assert.throws(() => validarFecha('10/11/2026'), /Fecha invalida/);
});
