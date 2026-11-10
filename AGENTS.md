# AGENTS.md - api-turnos-medicos

Proyecto del portafolio de inheritdevs. Stack: node. Ciclo de trabajo de la
jornada.

## Ciclo de cada jornada

1. Leer `TAREAS.md` y tomar la **primera** tarea pendiente. Si no hay ninguna,
   no hay trabajo: avisar y terminar. Nunca inventar tareas para llenar commits.
2. Implementar solo el alcance de esa tarea.
3. Correr las pruebas. Si fallan, arreglar; si no se pueden arreglar, revertir
   el cambio y dejar la tarea pendiente con el motivo anotado en `BITACORA.md`.
4. Marcar la tarea: `python3 tools/portfolio/motor.py completar <id>`.
5. Confirmar: `python3 tools/portfolio/motor.py commit "<mensaje>" --push`.

## Reglas

- Un commit por jornada, con mensaje en imperativo y prefijo convencional
  (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`).
- Nada de secretos, credenciales ni datos reales de clientes.
- El README se actualiza cuando cambie el uso de la app.
- El alcance lo decide `TAREAS.md`. Si la tarea es ambigua, se anota y se pide.
- Cero rastro de automatizacion en el repositorio: ni en el README, ni en los
  commits, ni en los topics, ni en el codigo. Solo el trabajo.
- El codigo se escribe en espanol en los comentarios y los mensajes de error
  que veran los usuarios; los nombres de identificadores, commits y documentacion
  tecnica van en espanol tambien, salvo que el estandar del stack lo pida
  distinto.
