'use strict';

/**
 * Esquema de la agenda.
 *
 * Cinco tablas sostienen el resto del sistema:
 *
 * - profesional: quien atiende. La agenda siempre cuelga de uno.
 * - paciente: quien reserva. Se guarda el documento como llave natural.
 * - horario: ventana semanal de atencion del profesional, por dia.
 * - bloque: ocupacion puntual de la agenda que no es una cita (cirugia,
 *   reunion, incapacidad). Quita disponibilidad en una fecha concreta.
 * - cita: la reserva. El estado manda: una cita cancelada no ocupa cupo.
 *
 * Las horas viajan como "HH:MM" y la base las compara como texto. Con ese
 * formato el orden alfabetico coincide con el orden del reloj, asi que las
 * consultas de solapamiento se resuelven sin convertir nada.
 */

const VERSION_ESQUEMA = 1;

/**
 * Condicion que valida una columna de hora en formato HH:MM de 00:00 a 23:59.
 * GLOB no admite alternancia, por eso el rango de las horas se comprueba
 * aparte con BETWEEN sobre los dos primeros caracteres.
 * @param {string} columna
 * @returns {string}
 */
function horaValida(columna) {
  return (
    `${columna} GLOB '[0-2][0-9]:[0-5][0-9]'` +
    ` AND substr(${columna}, 1, 2) BETWEEN '00' AND '23'`
  );
}

/**
 * Condicion que valida una columna de fecha en formato AAAA-MM-DD. No
 * comprueba que el dia exista (2026-02-30 pasa); de eso se encarga
 * validarFecha en tiempo.js antes de escribir.
 * @param {string} columna
 * @returns {string}
 */
function fechaValida(columna) {
  return `${columna} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`;
}

const AHORA = "strftime('%Y-%m-%dT%H:%M:%SZ', 'now')";

const ESQUEMA = `
CREATE TABLE IF NOT EXISTS profesional (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  documento     TEXT NOT NULL UNIQUE,
  nombre        TEXT NOT NULL,
  especialidad  TEXT NOT NULL,
  correo        TEXT,
  telefono      TEXT,
  activo        INTEGER NOT NULL DEFAULT 1 CHECK (activo IN (0, 1)),
  creado_en     TEXT NOT NULL DEFAULT (${AHORA}),
  CHECK (length(trim(nombre)) > 0),
  CHECK (length(trim(documento)) > 0)
);

CREATE TABLE IF NOT EXISTS paciente (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  documento         TEXT NOT NULL UNIQUE,
  nombre            TEXT NOT NULL,
  correo            TEXT,
  telefono          TEXT,
  fecha_nacimiento  TEXT CHECK (
                      fecha_nacimiento IS NULL OR ${fechaValida('fecha_nacimiento')}
                    ),
  activo            INTEGER NOT NULL DEFAULT 1 CHECK (activo IN (0, 1)),
  creado_en         TEXT NOT NULL DEFAULT (${AHORA}),
  CHECK (length(trim(nombre)) > 0),
  CHECK (length(trim(documento)) > 0)
);

-- 1 = lunes ... 7 = domingo, igual que ISO 8601.
CREATE TABLE IF NOT EXISTS horario (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  profesional_id  INTEGER NOT NULL REFERENCES profesional (id) ON DELETE CASCADE,
  dia_semana      INTEGER NOT NULL CHECK (dia_semana BETWEEN 1 AND 7),
  hora_inicio     TEXT NOT NULL CHECK (${horaValida('hora_inicio')}),
  hora_fin        TEXT NOT NULL CHECK (${horaValida('hora_fin')}),
  vigente_desde   TEXT CHECK (vigente_desde IS NULL OR ${fechaValida('vigente_desde')}),
  vigente_hasta   TEXT CHECK (vigente_hasta IS NULL OR ${fechaValida('vigente_hasta')}),
  creado_en       TEXT NOT NULL DEFAULT (${AHORA}),
  CHECK (hora_inicio < hora_fin),
  CHECK (
    vigente_desde IS NULL OR vigente_hasta IS NULL OR vigente_desde <= vigente_hasta
  ),
  UNIQUE (profesional_id, dia_semana, hora_inicio, hora_fin)
);

CREATE TABLE IF NOT EXISTS bloque (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  profesional_id  INTEGER NOT NULL REFERENCES profesional (id) ON DELETE CASCADE,
  fecha           TEXT NOT NULL CHECK (${fechaValida('fecha')}),
  hora_inicio     TEXT NOT NULL CHECK (${horaValida('hora_inicio')}),
  hora_fin        TEXT NOT NULL CHECK (${horaValida('hora_fin')}),
  motivo          TEXT NOT NULL DEFAULT 'Bloqueo de agenda',
  creado_en       TEXT NOT NULL DEFAULT (${AHORA}),
  CHECK (hora_inicio < hora_fin)
);

CREATE INDEX IF NOT EXISTS idx_bloque_agenda
  ON bloque (profesional_id, fecha);

CREATE TABLE IF NOT EXISTS cita (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo          TEXT NOT NULL UNIQUE,
  profesional_id  INTEGER NOT NULL REFERENCES profesional (id) ON DELETE RESTRICT,
  paciente_id     INTEGER NOT NULL REFERENCES paciente (id) ON DELETE RESTRICT,
  fecha           TEXT NOT NULL CHECK (${fechaValida('fecha')}),
  hora_inicio     TEXT NOT NULL CHECK (${horaValida('hora_inicio')}),
  hora_fin        TEXT NOT NULL CHECK (${horaValida('hora_fin')}),
  estado          TEXT NOT NULL DEFAULT 'pendiente' CHECK (
                    estado IN ('pendiente', 'confirmada', 'atendida', 'cancelada', 'no_asistio')
                  ),
  motivo          TEXT,
  creada_en       TEXT NOT NULL DEFAULT (${AHORA}),
  actualizada_en  TEXT NOT NULL DEFAULT (${AHORA}),
  CHECK (hora_inicio < hora_fin)
);

-- Dos citas vivas no pueden empezar a la misma hora con el mismo profesional.
-- El indice es parcial: una cita cancelada libera el cupo y se conserva para
-- el historico.
CREATE UNIQUE INDEX IF NOT EXISTS idx_cita_cupo
  ON cita (profesional_id, fecha, hora_inicio)
  WHERE estado <> 'cancelada';

CREATE INDEX IF NOT EXISTS idx_cita_paciente
  ON cita (paciente_id, fecha);

CREATE INDEX IF NOT EXISTS idx_cita_agenda
  ON cita (profesional_id, fecha, estado);

CREATE TRIGGER IF NOT EXISTS cita_toca_actualizada_en
AFTER UPDATE ON cita
FOR EACH ROW
WHEN NEW.actualizada_en = OLD.actualizada_en
BEGIN
  UPDATE cita SET actualizada_en = ${AHORA} WHERE id = OLD.id;
END;
`;

module.exports = { ESQUEMA, VERSION_ESQUEMA, horaValida, fechaValida };
