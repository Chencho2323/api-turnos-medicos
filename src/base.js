'use strict';

/**
 * Apertura de la base y aplicacion del esquema.
 *
 * Se usa node:sqlite, que viene con Node 24: no hay dependencias nativas que
 * compilar. La base guarda su version en PRAGMA user_version para poder
 * migrar despues sin adivinar en que punto quedo un archivo viejo.
 */

const { DatabaseSync } = require('node:sqlite');
const { ESQUEMA, VERSION_ESQUEMA } = require('./esquema');

const RUTA_POR_DEFECTO = ':memory:';

/**
 * Abre (o crea) la base y deja el esquema aplicado.
 * @param {string} [ruta] ruta del archivo; sin argumento la base vive en memoria
 * @returns {DatabaseSync}
 */
function abrirBase(ruta = RUTA_POR_DEFECTO) {
  const base = new DatabaseSync(ruta);

  // Sin esto SQLite ignora las llaves foraneas y quedan citas huerfanas.
  base.exec('PRAGMA foreign_keys = ON');
  base.exec(ESQUEMA);
  base.exec(`PRAGMA user_version = ${VERSION_ESQUEMA}`);

  return base;
}

/**
 * Devuelve la version del esquema que trae el archivo abierto.
 * @param {DatabaseSync} base
 * @returns {number}
 */
function versionEsquema(base) {
  const fila = base.prepare('PRAGMA user_version').get();
  return Number(fila.user_version);
}

/**
 * Lista las tablas de negocio, sin las internas de SQLite.
 * @param {DatabaseSync} base
 * @returns {string[]}
 */
function tablas(base) {
  return base
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((fila) => fila.name);
}

module.exports = { abrirBase, versionEsquema, tablas, RUTA_POR_DEFECTO };
