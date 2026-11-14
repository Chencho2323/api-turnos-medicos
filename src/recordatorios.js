'use strict';

/**
 * Recordatorios de cita y cola de salida.
 *
 * Un recordatorio no se envia desde la agenda: se programa sobre una cita viva
 * y, cuando llega su hora, se encola. La cola es una tabla aparte para que el
 * proceso que entrega los mensajes pueda correr en otro sitio y para que un
 * canal caido no tumbe una reserva.
 *
 * El momento del aviso se calcula restando la antelacion a la hora de la cita.
 * Se hace con Date en UTC porque la resta puede cruzar la medianoche y restar
 * sobre "HH:MM" a mano se rompe en ese caso.
 */

const { aMinutos, aHora, validarFecha } = require('./tiempo');
const { ErrorAgenda, obtenerCita } = require('./citas');

/** Canales que la cola sabe entregar. */
const CANALES = ['whatsapp', 'sms', 'correo', 'llamada'];

/** Antelaciones habituales, en minutos. */
const ANTELACIONES = {
  unDia: 24 * 60,
  tresHoras: 3 * 60,
  unaHora: 60,
  mediaHora: 30,
};

/** Antelacion por defecto cuando quien llama no dice nada. */
const ANTELACION_POR_DEFECTO = ANTELACIONES.unDia;

/** Estados de cita que admiten recordatorio. */
const ESTADOS_CON_RECORDATORIO = ['pendiente', 'confirmada'];

/** Intentos antes de dar una salida por fallida. */
const INTENTOS_MAXIMOS = 3;

/**
 * Suma (o resta, con delta negativo) minutos a una fecha y hora sueltas.
 * @param {string} fecha AAAA-MM-DD
 * @param {string} hora HH:MM
 * @param {number} delta minutos
 * @returns {{fecha: string, hora: string}}
 */
function desplazar(fecha, hora, delta) {
  validarFecha(fecha);
  const [anio, mes, dia] = fecha.split('-').map(Number);
  const instante = new Date(Date.UTC(anio, mes - 1, dia, 0, aMinutos(hora) + delta));
  const nuevaFecha = instante.toISOString().slice(0, 10);
  const nuevaHora = aHora(instante.getUTCHours() * 60 + instante.getUTCMinutes());
  return { fecha: nuevaFecha, hora: nuevaHora };
}

/**
 * Momento actual en fecha y hora sueltas, para comparar contra la tabla sin
 * depender del formato que use SQLite en ese ambiente.
 * @param {Date} [ahora]
 * @returns {{fecha: string, hora: string}}
 */
function momentoActual(ahora = new Date()) {
  const fecha = ahora.toISOString().slice(0, 10);
  const hora = aHora(ahora.getUTCHours() * 60 + ahora.getUTCMinutes());
  return { fecha, hora };
}

/**
 * Texto por defecto del aviso. Va de usted porque lo lee el paciente.
 * @param {object} cita
 * @returns {string}
 */
function mensajePorDefecto(cita) {
  return (
    `Le recordamos su cita con ${cita.profesional} el ${cita.fecha} ` +
    `a las ${cita.horaInicio}. Si no puede asistir, avisenos con anticipacion.`
  );
}

/**
 * Busca el dato de contacto del paciente segun el canal.
 * @param {import('node:sqlite').DatabaseSync} base
 * @param {number} pacienteId
 * @param {string} canal
 * @returns {string|null}
 */
function contactoDelPaciente(base, pacienteId, canal) {
  const fila = base
    .prepare('SELECT telefono, correo FROM paciente WHERE id = ?')
    .get(pacienteId);
  if (!fila) return null;
  if (canal === 'correo') return fila.correo ?? null;
  return fila.telefono ?? null;
}

/**
 * Valida un canal contra la lista conocida.
 * @param {string} canal
 * @returns {string}
 */
function validarCanal(canal) {
  if (!CANALES.includes(canal)) {
    throw new ErrorAgenda(
      `Canal desconocido: "${canal}". Se admite ${CANALES.join(', ')}`,
      { codigo: 'canal_invalido', estado: 400 },
    );
  }
  return canal;
}

/**
 * Programa un recordatorio para una cita viva.
 *
 * @param {import('node:sqlite').DatabaseSync} base
 * @param {{citaId: number, canal?: string, antelacionMinutos?: number,
 *          destinatario?: string, mensaje?: string}} datos
 * @returns {object} el recordatorio creado
 */
function programarRecordatorio(base, datos) {
  const cita = obtenerCita(base, datos.citaId);
  if (!cita) {
    throw new ErrorAgenda(`No existe la cita ${datos.citaId}`, {
      codigo: 'cita_no_encontrada',
      estado: 404,
    });
  }
  if (!ESTADOS_CON_RECORDATORIO.includes(cita.estado)) {
    throw new ErrorAgenda(
      `La cita ${cita.codigo} esta ${cita.estado} y no admite recordatorio`,
      { codigo: 'estado_sin_recordatorio', estado: 409 },
    );
  }

  const canal = validarCanal(datos.canal ?? 'whatsapp');
  const antelacion = datos.antelacionMinutos ?? ANTELACION_POR_DEFECTO;
  if (!Number.isInteger(antelacion) || antelacion <= 0) {
    throw new ErrorAgenda('La antelacion debe ser un entero de minutos mayor que cero', {
      codigo: 'antelacion_invalida',
      estado: 400,
    });
  }
  if (antelacion > 7 * 24 * 60) {
    throw new ErrorAgenda('La antelacion no puede superar una semana', {
      codigo: 'antelacion_invalida',
      estado: 400,
    });
  }

  const { fecha, hora } = desplazar(cita.fecha, cita.horaInicio, -antelacion);

  const destinatario = typeof datos.destinatario === 'string' && datos.destinatario.trim() !== ''
    ? datos.destinatario.trim()
    : contactoDelPaciente(base, cita.pacienteId, canal);
  if (!destinatario) {
    throw new ErrorAgenda(
      `El paciente ${cita.paciente} no tiene contacto para ${canal}`,
      { codigo: 'contacto_no_disponible', estado: 409 },
    );
  }

  const mensaje = typeof datos.mensaje === 'string' && datos.mensaje.trim() !== ''
    ? datos.mensaje.trim()
    : mensajePorDefecto(cita);

  const repetido = base
    .prepare(
      `SELECT id FROM recordatorio
        WHERE cita_id = ? AND canal = ? AND fecha_aviso = ? AND hora_aviso = ?`,
    )
    .get(cita.id, canal, fecha, hora);
  if (repetido) {
    throw new ErrorAgenda('Ese recordatorio ya esta programado para la cita', {
      codigo: 'recordatorio_repetido',
      estado: 409,
    });
  }

  const resultado = base
    .prepare(
      `INSERT INTO recordatorio (cita_id, canal, destinatario, fecha_aviso, hora_aviso, mensaje)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(cita.id, canal, destinatario, fecha, hora, mensaje);

  return obtenerRecordatorio(base, Number(resultado.lastInsertRowid));
}

/** Fila de recordatorio con los datos de la cita que hacen falta afuera. */
const CONSULTA_RECORDATORIO = `
  SELECT r.id, r.cita_id, r.canal, r.destinatario, r.fecha_aviso, r.hora_aviso,
         r.mensaje, r.estado, r.creado_en, r.actualizado_en,
         c.codigo AS cita_codigo, c.fecha AS cita_fecha, c.hora_inicio AS cita_hora_inicio
    FROM recordatorio r
    JOIN cita c ON c.id = r.cita_id
   WHERE r.id = ?
`;

/**
 * Pasa una fila de recordatorio al formato de la API.
 * @param {object} fila
 * @returns {object|null}
 */
function aRecordatorio(fila) {
  if (!fila) return null;
  return {
    id: Number(fila.id),
    citaId: Number(fila.cita_id),
    citaCodigo: fila.cita_codigo,
    citaFecha: fila.cita_fecha,
    citaHoraInicio: fila.cita_hora_inicio,
    canal: fila.canal,
    destinatario: fila.destinatario,
    fechaAviso: fila.fecha_aviso,
    horaAviso: fila.hora_aviso,
    mensaje: fila.mensaje,
    estado: fila.estado,
    creadoEn: fila.creado_en,
    actualizadoEn: fila.actualizado_en,
  };
}

/**
 * Devuelve un recordatorio por id.
 * @param {import('node:sqlite').DatabaseSync} base
 * @param {number} recordatorioId
 * @returns {object|null}
 */
function obtenerRecordatorio(base, recordatorioId) {
  if (!Number.isInteger(recordatorioId)) {
    throw new ErrorAgenda('El identificador del recordatorio debe ser un entero', {
      codigo: 'identificador_invalido',
      estado: 400,
    });
  }
  return aRecordatorio(base.prepare(CONSULTA_RECORDATORIO).get(recordatorioId));
}

/**
 * Lista los recordatorios de una cita, opcionalmente filtrados por estado.
 * @param {import('node:sqlite').DatabaseSync} base
 * @param {number} citaId
 * @param {{estado?: string}} [opciones]
 * @returns {object[]}
 */
function recordatoriosDeCita(base, citaId, opciones = {}) {
  const filas = opciones.estado
    ? base
        .prepare(
          `SELECT r.id FROM recordatorio r
            WHERE r.cita_id = ? AND r.estado = ?
            ORDER BY r.fecha_aviso, r.hora_aviso, r.id`,
        )
        .all(citaId, opciones.estado)
    : base
        .prepare(
          `SELECT r.id FROM recordatorio r
            WHERE r.cita_id = ?
            ORDER BY r.fecha_aviso, r.hora_aviso, r.id`,
        )
        .all(citaId);
  return filas.map((fila) => obtenerRecordatorio(base, Number(fila.id)));
}

/**
 * Cancela un recordatorio que todavia no salio.
 * @param {import('node:sqlite').DatabaseSync} base
 * @param {number} recordatorioId
 * @returns {object}
 */
function cancelarRecordatorio(base, recordatorioId) {
  const recordatorio = obtenerRecordatorio(base, recordatorioId);
  if (!recordatorio) {
    throw new ErrorAgenda(`No existe el recordatorio ${recordatorioId}`, {
      codigo: 'recordatorio_no_encontrado',
      estado: 404,
    });
  }
  if (['enviado', 'cancelado'].includes(recordatorio.estado)) {
    throw new ErrorAgenda(
      `El recordatorio ${recordatorioId} esta ${recordatorio.estado} y no se puede cancelar`,
      { codigo: 'estado_no_cancelable', estado: 409 },
    );
  }

  base
    .prepare(
      `UPDATE recordatorio
          SET estado = 'cancelado',
              actualizado_en = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
        WHERE id = ?`,
    )
    .run(recordatorioId);

  // Si ya estaba en la cola, el envio tambien se cancela.
  base
    .prepare("UPDATE salida SET estado = 'cancelado' WHERE recordatorio_id = ? AND estado = 'en_cola'")
    .run(recordatorioId);

  return obtenerRecordatorio(base, recordatorioId);
}

/**
 * Cancela todos los recordatorios vivos de una cita. Se usa cuando la cita se
 * cancela: no tiene sentido avisar de algo que ya no va a pasar.
 * @param {import('node:sqlite').DatabaseSync} base
 * @param {number} citaId
 * @returns {number} cuantos quedaron cancelados
 */
function cancelarRecordatoriosDeCita(base, citaId) {
  const vivos = recordatoriosDeCita(base, citaId).filter(
    (recordatorio) => !['enviado', 'cancelado'].includes(recordatorio.estado),
  );
  for (const recordatorio of vivos) {
    cancelarRecordatorio(base, recordatorio.id);
  }
  return vivos.length;
}

/**
 * Vacía en la cola de salida los recordatorios cuyo momento ya llego. Solo se
 * encola si la cita sigue viva: una cita cancelada entre la programacion y la
 * hora del aviso no genera mensaje.
 *
 * @param {import('node:sqlite').DatabaseSync} base
 * @param {{ahora?: {fecha: string, hora: string}, limite?: number}} [opciones]
 * @returns {object[]} las salidas creadas
 */
function encolarVencidos(base, opciones = {}) {
  const ahora = opciones.ahora ?? momentoActual();
  const limite = opciones.limite ?? 100;
  if (!Number.isInteger(limite) || limite <= 0) {
    throw new ErrorAgenda('El limite debe ser un entero mayor que cero', {
      codigo: 'limite_invalido',
      estado: 400,
    });
  }

  const marcas = ESTADOS_CON_RECORDATORIO.map(() => '?').join(', ');
  const vencidos = base
    .prepare(
      `SELECT r.id
         FROM recordatorio r
         JOIN cita c ON c.id = r.cita_id
        WHERE r.estado = 'pendiente'
          AND c.estado IN (${marcas})
          AND (r.fecha_aviso < ? OR (r.fecha_aviso = ? AND r.hora_aviso <= ?))
        ORDER BY r.fecha_aviso, r.hora_aviso, r.id
        LIMIT ?`,
    )
    .all(...ESTADOS_CON_RECORDATORIO, ahora.fecha, ahora.fecha, ahora.hora, limite);

  const salidas = [];
  const insertar = base.prepare(
    'INSERT INTO salida (recordatorio_id, canal, destinatario, cuerpo) VALUES (?, ?, ?, ?)',
  );
  const marcar = base.prepare(
    `UPDATE recordatorio
        SET estado = 'en_cola', actualizado_en = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE id = ?`,
  );

  for (const fila of vencidos) {
    const recordatorio = obtenerRecordatorio(base, Number(fila.id));
    const resultado = insertar.run(
      recordatorio.id,
      recordatorio.canal,
      recordatorio.destinatario,
      recordatorio.mensaje,
    );
    marcar.run(recordatorio.id);
    salidas.push(obtenerSalida(base, Number(resultado.lastInsertRowid)));
  }

  // Una cita cancelada deja sus recordatorios pendientes sin destino.
  base
    .prepare(
      `UPDATE recordatorio
          SET estado = 'cancelado',
              actualizado_en = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
        WHERE estado = 'pendiente'
          AND cita_id IN (SELECT id FROM cita WHERE estado NOT IN (${marcas}))`,
    )
    .run(...ESTADOS_CON_RECORDATORIO);

  return salidas;
}

/** Fila de salida con lo que necesita el entregador. */
const CONSULTA_SALIDA = `
  SELECT id, recordatorio_id, canal, destinatario, cuerpo, estado, intentos,
         ultimo_error, creado_en, enviado_en
    FROM salida
   WHERE id = ?
`;

/**
 * Pasa una fila de salida al formato de la API.
 * @param {object} fila
 * @returns {object|null}
 */
function aSalida(fila) {
  if (!fila) return null;
  return {
    id: Number(fila.id),
    recordatorioId: Number(fila.recordatorio_id),
    canal: fila.canal,
    destinatario: fila.destinatario,
    cuerpo: fila.cuerpo,
    estado: fila.estado,
    intentos: Number(fila.intentos),
    ultimoError: fila.ultimo_error ?? null,
    creadoEn: fila.creado_en,
    enviadoEn: fila.enviado_en ?? null,
  };
}

/**
 * Devuelve una salida por id.
 * @param {import('node:sqlite').DatabaseSync} base
 * @param {number} salidaId
 * @returns {object|null}
 */
function obtenerSalida(base, salidaId) {
  if (!Number.isInteger(salidaId)) {
    throw new ErrorAgenda('El identificador de la salida debe ser un entero', {
      codigo: 'identificador_invalido',
      estado: 400,
    });
  }
  return aSalida(base.prepare(CONSULTA_SALIDA).get(salidaId));
}

/**
 * Toma un lote de la cola y lo deja en estado "enviando" para que nadie mas
 * lo agarre. Es la parte que hace que dos procesos puedan correr a la vez.
 * @param {import('node:sqlite').DatabaseSync} base
 * @param {{limite?: number}} [opciones]
 * @returns {object[]}
 */
function tomarLote(base, opciones = {}) {
  const limite = opciones.limite ?? 20;
  if (!Number.isInteger(limite) || limite <= 0) {
    throw new ErrorAgenda('El limite debe ser un entero mayor que cero', {
      codigo: 'limite_invalido',
      estado: 400,
    });
  }

  const filas = base
    .prepare("SELECT id FROM salida WHERE estado = 'en_cola' ORDER BY id LIMIT ?")
    .all(limite);

  const marcar = base.prepare("UPDATE salida SET estado = 'enviando' WHERE id = ? AND estado = 'en_cola'");
  const lote = [];
  for (const fila of filas) {
    const resultado = marcar.run(Number(fila.id));
    if (Number(resultado.changes) === 1) {
      lote.push(obtenerSalida(base, Number(fila.id)));
    }
  }
  return lote;
}

/**
 * Marca una salida como entregada y su recordatorio como enviado.
 * @param {import('node:sqlite').DatabaseSync} base
 * @param {number} salidaId
 * @returns {object}
 */
function marcarEnviada(base, salidaId) {
  const salida = obtenerSalida(base, salidaId);
  if (!salida) {
    throw new ErrorAgenda(`No existe la salida ${salidaId}`, {
      codigo: 'salida_no_encontrada',
      estado: 404,
    });
  }
  if (salida.estado === 'enviado') {
    throw new ErrorAgenda(`La salida ${salidaId} ya estaba marcada como enviada`, {
      codigo: 'salida_ya_enviada',
      estado: 409,
    });
  }

  base
    .prepare(
      `UPDATE salida
          SET estado = 'enviado',
              intentos = intentos + 1,
              ultimo_error = NULL,
              enviado_en = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
        WHERE id = ?`,
    )
    .run(salidaId);
  base
    .prepare(
      `UPDATE recordatorio
          SET estado = 'enviado',
              actualizado_en = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
        WHERE id = ?`,
    )
    .run(salida.recordatorioId);

  return obtenerSalida(base, salidaId);
}

/**
 * Registra un intento fallido. Mientras queden intentos la salida vuelve a la
 * cola; agotados, queda fallida y el recordatorio igual, para que se pueda
 * revisar a mano.
 * @param {import('node:sqlite').DatabaseSync} base
 * @param {number} salidaId
 * @param {string} error texto del fallo
 * @returns {object}
 */
function marcarFallida(base, salidaId, error) {
  const salida = obtenerSalida(base, salidaId);
  if (!salida) {
    throw new ErrorAgenda(`No existe la salida ${salidaId}`, {
      codigo: 'salida_no_encontrada',
      estado: 404,
    });
  }
  if (['enviado', 'cancelado'].includes(salida.estado)) {
    throw new ErrorAgenda(
      `La salida ${salidaId} esta ${salida.estado} y no admite un fallo`,
      { codigo: 'estado_no_actualizable', estado: 409 },
    );
  }

  const intentos = salida.intentos + 1;
  const estado = intentos >= INTENTOS_MAXIMOS ? 'fallido' : 'en_cola';
  const detalle = typeof error === 'string' && error.trim() !== ''
    ? error.trim().slice(0, 500)
    : 'Fallo sin detalle';

  base
    .prepare('UPDATE salida SET estado = ?, intentos = ?, ultimo_error = ? WHERE id = ?')
    .run(estado, intentos, detalle, salidaId);

  if (estado === 'fallido') {
    base
      .prepare(
        `UPDATE recordatorio
            SET estado = 'fallido',
                actualizado_en = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
          WHERE id = ?`,
      )
      .run(salida.recordatorioId);
  }

  return obtenerSalida(base, salidaId);
}

/**
 * Reintenta a mano una salida fallida: vuelve a la cola y sus intentos se
 * reinician, porque el operador ya sabe que el problema estaba en otra parte.
 * @param {import('node:sqlite').DatabaseSync} base
 * @param {number} salidaId
 * @returns {object}
 */
function reintentarSalida(base, salidaId) {
  const salida = obtenerSalida(base, salidaId);
  if (!salida) {
    throw new ErrorAgenda(`No existe la salida ${salidaId}`, {
      codigo: 'salida_no_encontrada',
      estado: 404,
    });
  }
  if (salida.estado !== 'fallido') {
    throw new ErrorAgenda(`La salida ${salidaId} no esta fallida`, {
      codigo: 'estado_no_reintentable',
      estado: 409,
    });
  }

  base
    .prepare("UPDATE salida SET estado = 'en_cola', intentos = 0 WHERE id = ?")
    .run(salidaId);
  base
    .prepare(
      `UPDATE recordatorio
          SET estado = 'en_cola',
              actualizado_en = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
        WHERE id = ?`,
    )
    .run(salida.recordatorioId);

  return obtenerSalida(base, salidaId);
}

/**
 * Resumen de la cola por estado, sin contar lo ya entregado en el detalle.
 * @param {import('node:sqlite').DatabaseSync} base
 * @returns {{en_cola: number, enviando: number, enviado: number, fallido: number, cancelado: number}}
 */
function estadoDeLaCola(base) {
  const resumen = { en_cola: 0, enviando: 0, enviado: 0, fallido: 0, cancelado: 0 };
  const filas = base
    .prepare('SELECT estado, count(*) AS total FROM salida GROUP BY estado')
    .all();
  for (const fila of filas) {
    if (Object.prototype.hasOwnProperty.call(resumen, fila.estado)) {
      resumen[fila.estado] = Number(fila.total);
    }
  }
  return resumen;
}

module.exports = {
  CANALES,
  ANTELACIONES,
  ANTELACION_POR_DEFECTO,
  ESTADOS_CON_RECORDATORIO,
  INTENTOS_MAXIMOS,
  desplazar,
  momentoActual,
  mensajePorDefecto,
  programarRecordatorio,
  obtenerRecordatorio,
  recordatoriosDeCita,
  cancelarRecordatorio,
  cancelarRecordatoriosDeCita,
  encolarVencidos,
  obtenerSalida,
  tomarLote,
  marcarEnviada,
  marcarFallida,
  reintentarSalida,
  estadoDeLaCola,
};
