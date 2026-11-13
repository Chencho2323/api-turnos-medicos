'use strict';

/**
 * Punto de entrada del paquete.
 *
 * La aplicacion se arma por capas: primero el manejo de horas y fechas, luego
 * el almacenamiento, despues las reglas de disponibilidad y por ultimo el
 * servidor HTTP. Aqui solo se expone lo que ya existe.
 */

const tiempo = require('./tiempo');
const base = require('./base');
const esquema = require('./esquema');
const disponibilidad = require('./disponibilidad');
const citas = require('./citas');

module.exports = { ...tiempo, ...base, ...esquema, ...disponibilidad, ...citas };
