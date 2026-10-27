'use strict';
// Idioma de la interfaz (español / inglés). La app se escribe en español; en inglés este módulo traduce
// el texto visible (nodos de texto y atributos placeholder/title/aria-label/alt) con un diccionario y
// patrones, y vuelve al original al regresar a español. Los nombres de áreas, checklists, preguntas y
// textos capturados por los usuarios no se traducen: son datos.
(function () {
  var CLAVE = 'a5s.idioma';
  var lang = 'es';
  try { if (localStorage.getItem(CLAVE) === 'en') lang = 'en'; } catch (e) { /* sin almacenamiento */ }

  // ---------- texto completo (se compara sin espacios en los extremos) ----------
  var EXACT = {
    // generales
    'Auditorías': 'Audits', 'Auditorías 5S': '5S Audits', 'Calidad · 5S': 'Quality · 5S', 'Planta': 'Plant', 'Elige la planta.': 'Choose the plant.',
    'Cambiar de área': 'Change area', 'Cerrar sesión': 'Sign out', 'Administrador': 'Administrator', 'Lobby': 'Lobby', 'Secciones': 'Sections',
    'Inicio': 'Home', 'Tablero': 'Dashboard', 'Gemba': 'Gemba', 'Datos': 'Data', 'Admin': 'Admin',
    'Cancelar': 'Cancel', 'Aceptar': 'OK', 'Continuar': 'Continue', 'Entendido': 'Got it', 'Reintentar': 'Retry', 'Guardar': 'Save', 'Cerrar': 'Close',
    'Editar': 'Edit', 'Eliminar': 'Delete', 'Duplicar': 'Duplicate', 'Borrar': 'Delete', 'Descartar': 'Discard', 'Quitar': 'Remove', 'Subir': 'Move up', 'Bajar': 'Move down',
    'Activa': 'Active', 'Activo': 'Active', 'Desactivado': 'Disabled', 'Desactivar': 'Deactivate', 'Reactivar': 'Reactivate', 'Desactivar área': 'Deactivate area', 'Reactivar área': 'Reactivate area',
    'Nombre': 'Name', 'Correo': 'Email', 'Estado': 'Status', 'Estatus': 'Status', 'Fecha': 'Date', 'Fechas': 'Dates', 'Semana': 'Week', 'Mes': 'Month', 'Año': 'Year',
    'Todos': 'All', 'Buscar': 'Search', 'Buscar área': 'Search area', 'Limpiar': 'Clear', 'Ver más': 'See more', 'Imprimir lista': 'Print list',
    'Sí': 'Yes', 'No': 'No', 'Hoy': 'Today', 'Solo lectura': 'Read-only',
    // red / sincronización
    'Sin conexión': 'Offline', 'Sincronizando…': 'Syncing…', 'Sincronización': 'Synchronization', 'Sin sincronizar': 'Not synced',
    'Error al sincronizar': 'Sync error', 'Borrador': 'Draft',
    'Sin conexión con el servidor.': 'No connection to the server.',
    'Sin conexión: se enviará al reconectar.': 'Offline: it will be sent when the connection returns.',
    'No hay conexión con el servidor. Para iniciar sesión se necesita red.': 'No connection to the server. A network is required to sign in.',
    'Tu sesión venció. Inicia sesión de nuevo; tus capturas locales se conservan.': 'Your session expired. Sign in again; your local captures are kept.',
    'El almacenamiento del navegador no está disponible; los datos solo viven en memoria. No cierres esta pestaña hasta sincronizar.': 'Browser storage is not available; data only lives in memory. Do not close this tab until it syncs.',
    'Sin conexión: el CSV se descarga desde el servidor.': 'Offline: the CSV is downloaded from the server.',
    // login
    'Elige tu área': 'Choose your area', 'Elegir otra área': 'Choose another area', 'Volver a elegir área': 'Back to choosing an area', 'Entrar': 'Sign in',
    'Soy administrador': 'I am an administrator', 'Entrar como administrador': 'Sign in as administrator', 'Contraseña de administrador': 'Administrator password',
    'Contraseña de lobby': 'Lobby password', 'Pantalla lobby': 'Lobby screen', 'Entrar al dashboard': 'Enter the dashboard', 'Usuario lobby': 'Lobby user',
    'PIN de 4 a 6 dígitos': '4 to 6 digit PIN', '4 a 6 dígitos': '4 to 6 digits', 'PIN': 'PIN',
    'Aún no hay áreas dadas de alta. El administrador debe crearlas (botón "Soy administrador").': 'There are no areas yet. The administrator must create them ("I am an administrator" button).',
    'Área o PIN incorrectos. Revisa el PIN (4 a 6 dígitos).': 'Wrong area or PIN. Check the PIN (4 to 6 digits).',
    'Contraseña de administrador incorrecta.': 'Wrong administrator password.',
    'Esta área aún no tiene PIN. Pide al administrador que lo establezca.': 'This area does not have a PIN yet. Ask the administrator to set one.',
    'Esta área está desactivada. Pide al administrador que la reactive.': 'This area is deactivated. Ask the administrator to reactivate it.',
    // inicio del área
    'Esta semana': 'This week', 'Debes auditar': 'You must audit', 'Pendientes de semanas anteriores': 'Pending from previous weeks', 'Auditorías realizadas': 'Completed audits',
    'Auditorías atrasadas': 'Overdue audits', 'Sin configuración': 'No configuration', 'Sin rotación todavía': 'No rotation yet', 'Sin auditoría esta semana': 'No audit this week',
    'Tu auditoría de la semana está completa': 'Your audit for the week is complete', 'Aún no inicia': 'Not started yet',
    'Programada': 'Scheduled', 'Atrasada': 'Overdue', 'Pendiente': 'Pending', 'Sin asignar': 'Unassigned', 'Completada': 'Completed', 'Completadas': 'Completed', 'Atrasadas': 'Overdue', 'Programadas': 'Scheduled',
    'A tiempo': 'On time', 'Fuera de tiempo': 'Late', 'Entrega': 'Delivery', 'Resultado': 'Result', 'Área auditada': 'Audited area', 'Área auditora': 'Auditing area',
    'Tu área ya no existe en la configuración vigente. Pide al administrador que revise la configuración.': 'Your area no longer exists in the current configuration. Ask the administrator to review it.',
    // auditoría
    'Auditoría no encontrada': 'Audit not found', 'El ID no existe en la rotación vigente.': 'The ID does not exist in the current rotation.',
    'Esa semana no tiene asignación para esta área.': 'That week has no assignment for this area.',
    'Esta auditoría es de otra área': 'This audit belongs to another area', 'Primero la atrasada': 'Overdue one first',
    'Revisar y continuar': 'Review and continue', 'Finalizar y guardar': 'Finish and save', 'Finalizar auditoría': 'Finish audit',
    'Datos de la auditoría (solo lectura)': 'Audit data (read-only)', 'Resumen de la auditoría': 'Audit summary',
    'Nivel: pendiente': 'Level: pending', 'Todo listo para revisar y continuar.': 'All set to review and continue.',
    'Persona que audita': 'Person auditing', 'Responsable de 5S': 'Person responsible for 5S', 'Nómina del auditado': 'Auditee payroll number',
    'Número de nómina del auditado': 'Auditee payroll number', 'Número de nómina del auditado (obligatorio)': 'Auditee payroll number (required)',
    'Escribe el número de nómina del auditado.': 'Enter the auditee payroll number.', 'Solo dígitos.': 'Digits only.', 'Ej. 1234567': 'e.g. 1234567',
    'Abre la auditoría desde el inicio.': 'Open the audit from the start.', 'Hallazgos y acciones': 'Findings and actions', 'Auditado': 'Audited',
    'Calificación': 'Score', 'Checklist': 'Checklist', 'Finalizada': 'Finished', 'Fecha de auditoría': 'Audit date', 'Sección auditada': 'Audited section', 'Máquina auditada': 'Audited machine',
    'Auditoría finalizada. Enviando al servidor…': 'Audit finished. Sending to the server…', 'Auditoría finalizada. Se enviará cuando haya conexión.': 'Audit finished. It will be sent when there is a connection.',
    'Esta auditoría ya fue finalizada y no se puede modificar.': 'This audit was already finished and cannot be modified.',
    'Imprimir / guardar PDF': 'Print / save PDF', 'No se pudo abrir el reporte': 'Could not open the report', 'Acumulado': 'Cumulative',
    // hallazgos
    'Hallazgo borrado.': 'Finding deleted.', 'Foto del hallazgo': 'Finding photo', 'Ver foto': 'View photo', 'Foto': 'Photo', 'Foto del problema': 'Problem photo',
    'Área del hallazgo': 'Finding area', 'Qué se observó': 'What was observed', 'Tomar o elegir foto': 'Take or choose photo', 'Vista previa de la foto': 'Photo preview',
    'Cambiar foto': 'Change photo', 'Guardar hallazgo': 'Save finding', 'Descartar hallazgo': 'Discard finding', 'Borrar hallazgo': 'Delete finding',
    'No se pudo leer la foto.': 'Could not read the photo.', 'Filtrar por área': 'Filter by area', 'Filtrar por estatus': 'Filter by status',
    'Ese hallazgo no existe.': 'That finding does not exist.', 'No hay foto para ese hallazgo.': 'There is no photo for that finding.',
    // datos / respaldo
    'Descargar CSV': 'Download CSV', 'CSV descargado.': 'CSV downloaded.', 'Archivo de respaldo': 'Backup file', 'Respaldo local (plan B)': 'Local backup (plan B)',
    'Descargar respaldo local': 'Download local backup', 'Respaldo descargado.': 'Backup downloaded.', 'Elige primero un archivo de respaldo.': 'Choose a backup file first.',
    'Importar y fusionar': 'Import and merge', 'Borrar datos locales': 'Delete local data', 'Sí, borrar datos locales': 'Yes, delete local data', 'Datos locales borrados.': 'Local data deleted.',
    'El archivo no es un JSON válido.': 'The file is not valid JSON.',
    'El archivo no es un respaldo de Auditorías 5S (falta "tipo": "a5s-respaldo-1").': 'The file is not a 5S Audits backup (missing "tipo": "a5s-respaldo-1").',
    // tablero
    'Ciclo completo': 'Full cycle', 'Todo el ciclo': 'Whole cycle', 'Ciclo': 'Cycle', 'Semanal': 'Weekly', 'Anual': 'Yearly', 'Periodo anterior': 'Previous period', 'Periodo siguiente': 'Next period',
    'Tipo de periodo': 'Period type', 'Valor del periodo': 'Period value', 'Nivel': 'Level', 'Nivel promedio': 'Average level', 'Realizadas': 'Completed', 'Asignadas': 'Assigned',
    'Ver gráfica': 'View chart', 'Ver como tabla': 'View as table', '% a tiempo': '% on time', 'Semáforo': 'Traffic light', 'Recibidas': 'Received', 'Promedio': 'Average', 'Última': 'Latest',
    'Áreas activas': 'Active areas', 'Área': 'Area', 'Hallazgos': 'Findings', 'Audita a': 'Audits', 'Audita': 'Audits', 'Auditada': 'Audited', 'Tiempo': 'Time',
    'Más rápida': 'Fastest', 'Recibido': 'Received', 'Actual': 'Current', 'Semana en curso del ciclo': 'Current cycle week', 'Ciclo terminado': 'Cycle finished',
    'Auditorías programadas a la fecha': 'Audits scheduled to date', 'realizadas a tiempo ÷ realizadas': 'completed on time ÷ completed', 'realizadas ÷ (realizadas + atrasadas)': 'completed ÷ (completed + overdue)',
    'auditorías realizadas': 'audits completed', 'pendientes en plazo': 'pending within deadline', 'áreas con atraso': 'areas overdue',
    'del total programado a la fecha': 'of the total scheduled to date', 'Cumplimiento de auditorías': 'Audit compliance', 'Entregas a tiempo': 'On-time deliveries',
    'Nivel promedio de la planta': 'Plant average level', 'Cumplimiento (%)': 'Compliance (%)', 'Significado de los colores': 'Color legend',
    'Ejecutivo': 'Executive', 'Dashboard ejecutivo · Auditorías 5S': 'Executive dashboard · 5S Audits', 'Semáforo de auditorías': 'Audit traffic light',
    'Tendencia semanal del cumplimiento (porcentaje) y del nivel promedio (1S a 5S)': 'Weekly trend of compliance (percentage) and average level (1S to 5S)',
    'Calificación que recibió el área como área auditada: promedio del periodo': 'Score the area received as the audited area: period average',
    'Calificación que recibió el área (nivel y número)': 'Score the area received (level and number)', 'Aún sin calificación recibida': 'No score received yet',
    'El ciclo de auditorías aún no inicia: todavía no hay métricas.': 'The audit cycle has not started yet: there are no metrics yet.',
    'Seleccionar': 'Sort', 'Ordenar': 'Set in order', 'Estandarizar': 'Standardize', 'Sostener': 'Sustain',
    'Sin resultados.': 'No results.', ' · borrador': ' · draft', 'Estatus de la auditoría': 'Audit status', 'Audita a:': 'Audits:',
    // admin
    'Administración': 'Administration', 'Áreas y usuarios': 'Areas and users', 'Ciclo y rotación': 'Cycle and rotation', 'Tiempos de captura': 'Capture times', 'Servidor': 'Server',
    'Checklists y preguntas': 'Checklists and questions', 'Nuevo checklist': 'New checklist', 'Preguntas': 'Questions', 'Suma': 'Total', 'Áreas que lo usan': 'Areas using it',
    'Nombre del checklist': 'Checklist name', 'Código del checklist': 'Checklist code', 'Formato del checklist': 'Checklist format', 'Agregar a la lista': 'Add to the list', 'Guardar checklist': 'Save checklist',
    'Código nuevo': 'New code', 'Nombre del área': 'Area name', '+ Agregar fila': '+ Add row', 'Agregar áreas': 'Add areas', 'Guardar áreas': 'Save areas', 'Agregar las pegadas': 'Add the pasted ones',
    'PIN de las áreas': 'Area PINs', 'Generar PIN para áreas sin PIN': 'Generate PINs for areas without one', 'Restablecer todos los PIN': 'Reset all PINs', 'Restablecer todos': 'Reset all',
    'PIN generados': 'Generated PINs', 'Todas las áreas ya tienen PIN.': 'All areas already have a PIN.', 'Con PIN': 'Has PIN', 'Sin PIN': 'No PIN', 'Cambiar PIN': 'Change PIN', 'Poner PIN': 'Set PIN',
    'Usuario': 'User', 'Exportar a Excel': 'Export to Excel', 'Excel descargado.': 'Excel downloaded.', 'Imprimir': 'Print',
    'Estos PIN se muestran una sola vez. Imprímelos o anótalos ahora; no se pueden volver a consultar (sí se pueden restablecer).': 'These PINs are shown only once. Print or write them down now; they cannot be viewed again (they can be reset).',
    'Se generará un PIN nuevo para TODAS las áreas activas y las sesiones abiertas se cerrarán. ¿Continuar?': 'A new PIN will be generated for ALL active areas and open sessions will be closed. Continue?',
    'Nueva contraseña de lobby': 'New lobby password', 'Mínimo 4 caracteres': 'At least 4 characters', 'Con contraseña': 'Has password', 'Sin contraseña': 'No password',
    'Cambiar contraseña': 'Change password', 'Establecer contraseña': 'Set password', 'Generar contraseña': 'Generate password',
    'Enviar correo de prueba': 'Send test email', 'Correo (Microsoft Graph)': 'Email (Microsoft Graph)', 'No se pudo consultar el estado del correo.': 'Could not check the email status.',
    ' Faltan las variables GRAPH_* en el servidor.': ' The GRAPH_* variables are missing on the server.',
    'Guardar secciones': 'Save sections', 'Parámetros guardados.': 'Parameters saved.', 'Guardar parámetros': 'Save parameters', 'Nombre del programa': 'Program name',
    'Días para completar cada auditoría': 'Days to complete each audit', 'Fecha de inicio del ciclo': 'Cycle start date', 'Rehacer toda': 'Redo entire rotation',
    'Cambiar la fecha de inicio': 'Change the start date', 'Cambiar fecha de inicio': 'Change start date', 'Desde 2S': 'From 2S',
    'Escribe el nombre de al menos un área.': 'Enter the name of at least one area.',
    'Primero crea al menos un checklist en la pestaña "Checklists y preguntas".': 'First create at least one checklist in the "Checklists and questions" tab.',
    'La fecha de inicio ya era esa; no hubo cambios.': 'The start date was already that; no changes.',
    // servidor
    'Aún no hay configuración. El administrador debe importarla.': 'There is no configuration yet. The administrator must import it.',
    'Base de datos no disponible.': 'Database not available.', 'La base de datos no está disponible. Inténtalo en un momento.': 'The database is not available. Try again in a moment.',
    'Elige una planta.': 'Choose a plant.', 'Error interno del servidor.': 'Internal server error.', 'Este usuario solo puede ver el dashboard.': 'This user can only view the dashboard.',
    'Inicia sesión para continuar.': 'Sign in to continue.', 'La configuración tiene errores. Corrígelos y vuelve a importar.': 'The configuration has errors. Fix them and import again.',
    'La contraseña de lobby cambió. Inicia sesión de nuevo.': 'The lobby password changed. Sign in again.', 'No tienes acceso al dashboard de lobby.': 'You do not have access to the lobby dashboard.',
    'Origen no permitido.': 'Origin not allowed.', 'Ruta no encontrada.': 'Route not found.', 'Solo el administrador puede hacer esto.': 'Only the administrator can do this.',
    'Tu PIN cambió o el área ya no existe. Inicia sesión de nuevo.': 'Your PIN changed or the area no longer exists. Sign in again.', 'Tu sesión venció. Inicia sesión de nuevo.': 'Your session expired. Sign in again.',
    'Solo puedes ver los reportes de tu área.': 'You can only view the reports of your area.', 'El área no existe.': 'The area does not exist.', 'El checklist no existe.': 'The checklist does not exist.',
    'Esa auditoría no se ha guardado en el servidor.': 'That audit has not been saved on the server.', 'Ese ID no existe en la rotación de esta configuración.': 'That ID does not exist in the rotation of this configuration.',
    'ID de auditoría inválido. Formato esperado: S03-A12.': 'Invalid audit ID. Expected format: S03-A12.', 'ID de hallazgo inválido.': 'Invalid finding ID.', 'Ese ID de hallazgo ya existe.': 'That finding ID already exists.',
    'El correo no es válido.': 'The email is not valid.', 'El nombre no puede quedar vacío.': 'The name cannot be empty.', 'El PIN debe tener de 4 a 6 dígitos.': 'The PIN must have 4 to 6 digits.',
    'La contraseña de lobby debe tener entre 4 y 72 caracteres.': 'The lobby password must be between 4 and 72 characters.',
    'La fecha de inicio debe tener formato yyyy-mm-dd y ser una fecha válida.': 'The start date must have the format yyyy-mm-dd and be a valid date.',
    'Indica al menos un área ({ areas: [{ nombre, checklist }] }).': 'Provide at least one area ({ areas: [{ nombre, checklist }] }).',
    'Se admiten máximo 99 áreas (el ID de auditoría usa 2 dígitos).': 'A maximum of 99 areas is allowed (the audit ID uses 2 digits).',
    'El correo no está configurado en el servidor (variables GRAPH_*).': 'Email is not configured on the server (GRAPH_* variables).',
    'No hay correo de administrador configurado (MAIL_ADMIN).': 'No administrator email is configured (MAIL_ADMIN).',
    // login / inicio / tablero / gemba
    'Inicia sesión con el área que va a auditar.': 'Sign in with the area that will audit.', 'Elige tu área…': 'Choose your area…', 'Cambiar de planta': 'Change plant',
    'PIN (4 a 6 dígitos)': 'PIN (4 to 6 digits)', 'Iniciar auditoría': 'Start audit', 'Continuar auditoría': 'Continue audit', 'Ver reporte': 'View report',
    'Mis métricas': 'My metrics', 'Tu cumplimiento con las auditorías que te tocan y los resultados que has recibido.': 'Your compliance with the audits assigned to you and the results you have received.',
    'Auditorías programadas en la semana': 'Audits scheduled this week', 'Todos los hallazgos registrados en piso.': 'All findings recorded on the floor.', 'Todas las áreas': 'All areas',
    'Todavía no hay hallazgos.': 'There are no findings yet.', 'Tablero de cumplimiento': 'Compliance dashboard', 'Qué áreas están cumpliendo con las auditorías que les toca hacer.': 'Which areas are meeting the audits they are due to do.',
    'Reporte de auditoría 5S': '5S audit report',
    // captura
    'Fecha de la auditoría (hoy)': 'Audit date (today)', 'Persona que audita (obligatorio)': 'Person auditing (required)', 'Responsable de 5S del área auditada': 'Person responsible for 5S of the audited area',
    'Nombre completo': 'Full name', 'Qué se encontró': 'What was found', 'Qué se hará para corregirlo (opcional)': 'What will be done to fix it (optional)', 'Acción correctiva (opcional)': 'Corrective action (optional)',
    'Salir al inicio (el borrador se guarda solo)': 'Exit to home (the draft saves itself)', 'Hallazgo': 'Finding', 'Acción correctiva': 'Corrective action',
    // admin
    'Aquí se da de alta todo: áreas y sus usuarios, checklists con sus preguntas, el ciclo y la rotación. No hay que importar archivos.': 'Everything is set up here: areas and their users, checklists with their questions, the cycle and the rotation. There is no need to import files.',
    'Una fila por área. Cada área es también un usuario: al crearla se genera su PIN. La rotación se recalcula sola (si el ciclo ya inició, las semanas que ya comenzaron no se tocan).': 'One row per area. Each area is also a user: its PIN is generated when it is created. The rotation recalculates itself (if the cycle has started, weeks that already began are not touched).',
    'El PIN (4 a 6 dígitos) es la contraseña de cada área. Al cambiarlo se cierran las sesiones abiertas de esa área.': 'The PIN (4 to 6 digits) is each area\'s password. Changing it closes that area\'s open sessions.',
    'Usuario especial para la pantalla del lobby: solo ve el semáforo de qué áreas ya hicieron su auditoría. Entra desde la pantalla de acceso con "Pantalla lobby".': 'Special user for the lobby screen: it only sees the traffic light of which areas have done their audit. It signs in from the access screen with "Lobby screen".',
    'Ver el dashboard': 'View the dashboard', 'Contraseña': 'Password', 'Parámetros': 'Parameters', 'Rotación': 'Rotation',
    'Avisa por correo de los hallazgos Gemba (al área del problema y al administrador), recuerda las auditorías por vencer o atrasadas y manda el resumen semanal. El correo de cada área se captura en la tabla de áreas.': 'Sends email about Gemba findings (to the problem area and the administrator), reminds about audits that are due or overdue, and sends the weekly summary. Each area\'s email is entered in the areas table.',
    'Faltan las variables GRAPH_* en el servidor.': 'The GRAPH_* variables are missing on the server.', 'correo@empresa.com': 'email@company.com',
    'Días para completar cada auditoría (fecha límite = inicio de semana + días)': 'Days to complete each audit (deadline = start of week + days)',
    'Nueva fecha de inicio (semana 1)': 'New start date (week 1)', 'Recalcular rotación futura': 'Recalculate future rotation', 'Ver una semana': 'View a week',
    'Nueva fecha de inicio del ciclo': 'New cycle start date', 'Semana de la rotación': 'Rotation week',
    'El tiempo de captura es un dato exclusivo del administrador: ni las áreas que auditan ni las auditadas lo ven, y no sale en el CSV. Mide solo actividad real (las pausas largas no cuentan).': 'Capture time is exclusive to the administrator: neither the auditing nor the audited areas see it, and it is not in the CSV. It measures only real activity (long pauses do not count).',
    'Más lenta': 'Slowest', 'Auditorías con tiempo medido': 'Audits with measured time', 'Promedio por área que audita': 'Average per auditing area', 'Sin tiempos medidos en este periodo.': 'No measured times in this period.',
    'Auditorías finalizadas': 'Finished audits', 'No hay auditorías finalizadas en este periodo.': 'There are no finished audits in this period.',
    'Respaldo y bitácora': 'Backup and log', 'Descargar respaldo de la base (.sql)': 'Download database backup (.sql)', 'Ver bitácora': 'View log',
    'Avanzado: importar una configuración completa desde un archivo': 'Advanced: import a full configuration from a file',
    'No es necesario para usar la app. Reemplaza las áreas, checklists y rotación con los de un archivo JSON (formato a5s-config-1).': 'Not needed to use the app. Replaces the areas, checklists and rotation with those of a JSON file (a5s-config-1 format).',
    'Importar configuración': 'Import configuration', 'Archivo de configuración JSON': 'JSON configuration file',
    'Sincronización, exportación y respaldo de este equipo.': 'Synchronization, export and backup of this device.',
    'Descarga desde el servidor todas las auditorías finalizadas, con el formato de la hoja de respuestas (se abre en Excel con acentos).': 'Downloads all finished audits from the server, in the answer sheet format (opens in Excel with accents).',
    'Desde (opcional)': 'From (optional)',
    'Guarda en un archivo JSON todo lo capturado en este equipo, o importa uno de otro equipo. Al importar se fusiona por ID: no se pisa nada que ya esté finalizado.': 'Saves everything captured on this device in a JSON file, or imports one from another device. Importing merges by ID: nothing already finished is overwritten.',
    'Elimina de este equipo las capturas guardadas, la configuración en caché y la sesión. No borra nada del servidor.': 'Removes the saved captures, the cached configuration and the session from this device. It does not delete anything from the server.',
    // idioma
    'Acción correctiva:': 'Corrective action:', 'Hallazgo:': 'Finding:', 'Punto': 'Point', 'Máx.': 'Max.', 'Rehacer toda la rotación': 'Redo entire rotation',
    'Esta auditoría aún no se ha sincronizado con el servidor; se enviará en cuanto haya conexión.': 'This audit has not been synced with the server yet; it will be sent as soon as there is a connection.',
    'Idioma': 'Language'
  };

  var MESES = { enero: 'January', febrero: 'February', marzo: 'March', abril: 'April', mayo: 'May', junio: 'June', julio: 'July', agosto: 'August', septiembre: 'September', octubre: 'October', noviembre: 'November', diciembre: 'December' };
  var MES_CORTO = { ene: 'Jan', feb: 'Feb', mar: 'Mar', abr: 'Apr', may: 'May', jun: 'Jun', jul: 'Jul', ago: 'Aug', sep: 'Sep', oct: 'Oct', nov: 'Nov', dic: 'Dec' };

  function pl(n, s, p) { return Number(n) === 1 ? s : p; }

  // ---------- patrones con números/nombres (se prueban en orden) ----------
  var PATTERNS = [
    [/^Calidad · 5S · (.+)$/, 'Quality · 5S · $1'],
    [/^Semana (\d+) de (\d+)$/, 'Week $1 of $2'],
    [/^Del (.+) · fecha límite (.+)$/, 'From $1 · deadline $2'],
    [/^Reporte de auditoría 5S · (.+)$/, '5S audit report · $1'],
    [/^Área auditada: ([^·]+?)( · .+)?$/, function (m, a, resto) { return 'Audited area: ' + a + (resto ? ' · ' + resto.slice(3).split(' · ').map(function (p) { return traducir(p); }).join(' · ') : ''); }],
    [/^Sección: (.+)$/, 'Section: $1'],
    [/^Máquina: (.+)$/, 'Machine: $1'],
    [/^Responsable de 5S: (.+)$/, 'Person responsible for 5S: $1'],
    [/^Audita: (.+)$/, 'Auditor: $1'],
    [/^(\d+) \(límite (.+)\)$/, '$1 (due $2)'],
    [/^Calificación (.+) de (\d+)$/, 'Score $1 of $2'],
    [/^Puntaje del punto (\d+)$/, 'Score of point $1'],
    [/^Hallazgo del punto (\d+) \(obligatorio\)$/, 'Finding of point $1 (required)'],
    [/^Acción correctiva del punto (\d+) \(opcional\)$/, 'Corrective action of point $1 (optional)'],
    [/^Máximo (\d+) puntos?$/, function (m, n) { return 'Maximum ' + n + ' ' + pl(n, 'point', 'points'); }],
    [/^Faltan (\d+) puntos? por contestar y captura quién audita\.$/, function (m, n) { return n + ' ' + pl(n, 'point', 'points') + ' left to answer and enter who audits.'; }],
    [/^[Ff]alta el hallazgo en (\d+) puntos? \((.+)\)( y captura quién audita)?\.$/, function (m, n, l, q) { return 'Finding missing in ' + n + ' ' + pl(n, 'point', 'points') + ' (' + l + ')' + (q ? ' and enter who audits' : '') + '.'; }],
    [/^[Ff]alta el hallazgo en (\d+) puntos? \((.+)\)\.$/, 'Finding missing in $1 points ($2).'],
    [/^Áreas \((\d+) activas de (\d+)\)$/, 'Areas ($1 active of $2)'],
    [/^Hoy el ciclo inicia el (.+)\. Cambiarla recorre las fechas de todas las semanas y sus fechas límite sin tocar la rotación ni los checklists\.$/, 'Today the cycle starts on $1. Changing it shifts the dates of all weeks and their deadlines without touching the rotation or the checklists.'],
    [/^La semana 1 comenzaría el (.+) y la última \((\d+)\) vencería el (.+)\.$/, 'Week 1 would start on $1 and the last one ($2) would be due on $3.'],
    [/^(\d+) semanas para (\d+) áreas activas\. Se genera sola: nadie se audita a sí misma, cada área recibe una sola auditora por semana y ninguna pareja se repite\.$/, '$1 weeks for $2 active areas. It generates itself: nobody audits itself, each area receives a single auditor per week and no pair repeats.'],
    [/^"Rehacer toda" está deshabilitado porque ya hay (\d+) auditoría\(s\) capturadas\.$/, '"Redo entire rotation" is disabled because there are already $1 captured audit(s).'],
    [/^Área (\S+) · Cambiar de área$/, 'Area $1 · Change area'],
    [/^Planta (.+)$/, 'Plant $1'],
    [/^Área (.+)\. Cambiar de área$/, 'Area $1. Change area'],
    [/^(Administrador|Lobby)\. Cerrar sesión$/, function (m, a) { return (a === 'Administrador' ? 'Administrator' : 'Lobby') + '. Sign out'; }],
    [/^(.+) \(último uso\)$/, '$1 (last used)'],
    [/^Sin conexión · (\d+) pendientes?$/, function (m, n) { return 'Offline · ' + n + ' pending'; }],
    [/^(\d+) pendientes?$/, '$1 pending'],
    [/^Sincronizando (\d+)…$/, 'Syncing $1…'],
    [/^Error (\d+)$/, 'Error $1'],
    [/^Hay (\d+) capturas? sin sincronizar de esta área\. Se conservan en este equipo y se enviarán cuando esta área vuelva a iniciar sesión con conexión\.$/, function (m, n) { return 'There ' + pl(n, 'is 1 capture', 'are ' + n + ' captures') + ' not synced from this area. ' + pl(n, 'It is', 'They are') + ' kept on this device and will be sent when this area signs in again with a connection.'; }],
    [/^Se cerrará la sesión de esta área en este equipo\.$/, 'This area will be signed out on this device.'],
    [/^Primero haz la atrasada de la semana (\d+)$/, 'Do the overdue week $1 first'],
    [/^Primero la semana (\d+)$/, 'Week $1 first'],
    [/^Semana (\d+) en curso$/, 'Week $1 in progress'],
    [/^Semana (\d+) del año · (.+) al (.+) \(semana (\d+) del ciclo\)$/, 'Week $1 of the year · $2 to $3 (cycle week $4)'],
    [/^Semana (\d+): (.+)$/, 'Week $1: $2'],
    [/^Semana (\d+) · (.+)$/, 'Week $1 · $2'],
    [/^Semana (\d+) \((.+)\)$/, 'Week $1 ($2)'],
    [/^Semana (\d+)$/, 'Week $1'],
    [/^Año (\d+)$/, 'Year $1'],
    [/^Debes auditar: (.+)$/, 'You must audit: $1'],
    [/^hoy (.+)$/, 'today $1'],
    [/^Fecha límite: (.+)$/, 'Deadline: $1'],
    [/^límite (.+)$/, 'due $1'],
    [/^El ciclo de auditorías comienza el (.+)\.$/, 'The audit cycle starts on $1.'],
    [/^La semana (\d+) comienza el (.+)\.$/, 'Week $1 starts on $2.'],
    [/^(.+) corresponde a (.+)\. Inicia sesión con esa área para capturarla\.$/, '$1 belongs to $2. Sign in with that area to capture it.'],
    [/^Tienes atrasada la auditoría de la semana (\d+) \((.+)\)\. Hazla primero y después podrás hacer la de la semana (\d+)\.$/, 'You have the audit of week $1 overdue ($2). Do it first, then you can do the one for week $3.'],
    [/^Tienes atrasada la auditoría de la semana (\d+) \((.+)\)\. Haz primero la atrasada y después (.+)\.$/, 'You have the audit of week $1 overdue ($2). Do the overdue one first, then $3.'],
    [/^Área que audita · (.+)$/, 'Auditing area · $1'],
    [/^Área auditada · (.+)$/, 'Audited area · $1'],
    [/^Responsable de (.+)$/, 'Person responsible for $1'],
    [/^Máquina a auditar en (.+) \(obligatorio\)$/, 'Machine to audit in $1 (required)'],
    [/^(\d+) de (\d+) puntos contestados$/, '$1 of $2 points answered'],
    [/^(.+) de (.+) puntos · (.+)$/, '$1 of $2 points · $3'],
    [/^Nivel (\d)$/, 'Level $1'],
    [/^Nivel ([\dS]+) \((.+)\)$/, 'Level $1 ($2)'],
    [/^Nivel: (.+)$/, 'Level: $1'],
    [/^Nivel promedio: (.+)$/, 'Average level: $1'],
    [/^Faltan (\d+) puntos? por contestar$/, function (m, n) { return n + ' ' + pl(n, 'point', 'points') + ' left to answer'; }],
    [/^elige la máquina a auditar$/, 'choose the machine to audit'],
    [/^(.+) y (elige la máquina a auditar)$/, '$1 and choose the machine to audit'],
    [/^Punto (\d+) · (.+) · (\d+)\/(\d+)$/, 'Point $1 · $2 · $3/$4'],
    [/^Calificación (.+) \((.+)\)\. Una auditoría finalizada ya no se puede editar\. ¿Finalizar y guardar\?$/, 'Score $1 ($2). A finished audit can no longer be edited. Finish and save?'],
    [/^La auditoría (.+) \((.+)\) ya la finalizó otro equipo(.*) el (.+)\. Se conservó la primera; tu captura de este equipo no se guardó\.$/, 'Audit $1 ($2) was already finished by another device$3 on $4. The first one was kept; your capture from this device was not saved.'],
    [/^Calificación (.+)$/, 'Score $1'],
    [/^Última sincronización: (.+)\.$/, 'Last sync: $1.'],
    [/^Hay (\d+) capturas? pendientes? de enviar\.?$/, 'There ' + 'are $1 captures pending to send.'],
    [/^Importado: (\d+) nuevas, (\d+) actualizadas, (\d+) omitidas\.$/, 'Imported: $1 new, $2 updated, $3 skipped.'],
    [/^ID de este equipo: (.+)$/, 'This device ID: $1'],
    [/^Hay (\d+) capturas? que todavía NO se ha(?:n)? enviado al servidor y se perder(?:á|án) para siempre\. Descarga el respaldo local antes si las necesitas\.$/, function (m, n) { return 'There ' + pl(n, 'is 1 capture', 'are ' + n + ' captures') + ' that ' + pl(n, 'has', 'have') + ' NOT been sent to the server yet and will be lost forever. Download the local backup first if you need ' + pl(n, 'it', 'them') + '.'; }],
    [/^Semana (\d+) \((.+) – (.+)\)$/, 'Week $1 ($2 – $3)'],
    [/^Semana (\d+) · (.+) – (.+)$/, 'Week $1 · $2 – $3'],
    [/^Semáforo de auditorías, (.+)$/, 'Audit traffic light, $1'],
    [/^Actualizado (.+)$/, 'Updated $1'],
    [/^Sin conexión: se muestran los datos guardados el (.+)\.$/, 'Offline: showing data saved on $1.'],
    [/^Sin conexión: datos guardados el (.+)\.$/, 'Offline: data saved on $1.'],
    [/^(\d+) de (\d+)$/, '$1 of $2'],
    [/^Sin auditoría que hacer esa semana · (.+)$/, 'No audit to do that week · $1'],
    [/^Recibió (.+)$/, 'Received $1'],
    [/^(.+): (a tiempo|fuera de tiempo|programada|atrasada|pendiente|completada|sin asignar)(.*)$/i, function (m, a, t, r) { var T = { 'a tiempo': 'on time', 'fuera de tiempo': 'late', programada: 'scheduled', atrasada: 'overdue', pendiente: 'pending', completada: 'completed', 'sin asignar': 'unassigned' }; return a + ': ' + T[t.toLowerCase()] + r.replace('(fuera de tiempo)', '(late)'); }],
    [/^Cumplimiento: (.+)$/, 'Compliance: $1'],
    [/^Realizadas (\d+) de (\d+) · atrasadas (\d+)$/, 'Completed $1 of $2 · overdue $3'],
    [/^Dashboard ejecutivo$/, 'Executive dashboard'],
    [/^(.+) · semana en curso (.+) de (\d+)(.*)$/, '$1 · current week $2 of $3$4'],
    [/^Secciones de (.+)\. Cada semana la auditora revisa una distinta, en este orden \(las inactivas se saltan\)\. Cambiar el orden o las activas cambia la sección de las semanas aún no auditadas\.$/, 'Sections of $1. Each week the auditing area reviews a different one, in this order (inactive ones are skipped). Changing the order or the active ones changes the section of the weeks not yet audited.'],
    [/^Nombre de la sección (\d+)$/, 'Name of section $1'],
    [/^Máquinas de la sección (\d+)$/, 'Machines of section $1'],
    [/^Secciones · (.+)$/, 'Sections · $1'],
    [/^Secciones \((\d+)\)$/, 'Sections ($1)'],
    [/^Secciones de (.+) guardadas\.$/, 'Sections of $1 saved.'],
    [/^Nombre del área nueva (\d+)$/, 'New area name $1'],
    [/^Checklist del área nueva (\d+)$/, 'New area checklist $1'],
    [/^Quitar la fila (\d+)$/, 'Remove row $1'],
    [/^Nombre de (.+)$/, 'Name of $1'],
    [/^Correo de (.+)$/, 'Email of $1'],
    [/^Checklist de (.+)$/, 'Checklist of $1'],
    [/^Nuevo PIN para (.+)$/, 'New PIN for $1'],
    [/^PIN de (.+) guardado\. Sus sesiones abiertas se cerraron\.$/, 'PIN of $1 saved. Its open sessions were closed.'],
    [/^(.+) actualizada\.(.*)$/, '$1 updated.$2'],
    [/^(.+) (desactivada|reactivada)\.(.*)$/, function (m, a, e, r) { return a + ' ' + (e === 'desactivada' ? 'deactivated' : 'reactivated') + '.' + r; }],
    [/^(.+) dejará de poder entrar y saldrá de la rotación de las semanas que aún no inician\. Lo ya capturado se conserva\.$/, '$1 will no longer be able to sign in and will leave the rotation of weeks that have not started. What was already captured is kept.'],
    [/^(.+) volverá a entrar y a participar en la rotación de las semanas futuras\.$/, '$1 will be able to sign in again and take part in the rotation of future weeks.'],
    [/^Contraseña generada para lobby \(se muestra una sola vez\): (.+)$/, 'Lobby password generated (shown only once): $1'],
    [/^Correo de prueba enviado a (.+)\.$/, 'Test email sent to $1.'],
    [/^Suma (\d+) \/ 100$/, 'Total $1 / 100'],
    [/^Faltan (\d+) para 100$/, '$1 left to reach 100'],
    [/^Se conservaron (\d+) auditorías capturadas\.$/, '$1 captured audits were kept.'],
    [/^Hay (\d+) auditorías?(.*)$/, 'There ' + 'are $1 audits$2'],
    [/^Solo (.+) puede registrar esta auditoría\.$/, 'Only $1 can record this audit.'],
    [/^La semana (\d+) aún no inicia \((.+)\)\.$/, 'Week $1 has not started yet ($2).'],
    [/^La semana debe estar entre 1 y (\d+)\.$/, 'The week must be between 1 and $1.'],
    [/^Ya existe un checklist con el código (.+)\.$/, 'A checklist with code $1 already exists.'],
    [/^(\d+) d$/, '$1 d']
  ];

  function traducirMeses(t) {
    return t
      .replace(/\b(Enero|Febrero|Marzo|Abril|Mayo|Junio|Julio|Agosto|Septiembre|Octubre|Noviembre|Diciembre|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\b/g, function (w) {
        var en = MESES[w.toLowerCase()];
        return w.charAt(0) === w.charAt(0).toUpperCase() ? en : en.toLowerCase();
      })
      .replace(/(\d{1,2}) (ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic)\b/g, function (m, d, mes) { return d + ' ' + MES_CORTO[mes]; });
  }

  function traducir(texto) {
    if (lang !== 'en' || !texto) return texto;
    var m = /^(\s*)([\s\S]*?)(\s*)$/.exec(texto);
    var ini = m[1], core = m[2], fin = m[3];
    if (!core) return texto;
    var res = null;
    if (Object.prototype.hasOwnProperty.call(EXACT, core)) res = EXACT[core];
    else {
      for (var i = 0; i < PATTERNS.length; i++) {
        if (PATTERNS[i][0].test(core)) { res = core.replace(PATTERNS[i][0], PATTERNS[i][1]); break; }
      }
    }
    if (res === null && core.indexOf(' · ') > 0) {
      // textos compuestos "a · b · c": se traduce cada tramo
      res = core.split(' · ').map(function (p) { return traducir(p); }).join(' · ');
    }
    if (res === null) res = core;
    res = traducirMeses(res);
    // los fragmentos de un patrón pueden ser a su vez textos conocidos (nombres de estatus, etc.)
    return ini + res + fin;
  }
  window.t = function (s) { return lang === 'en' ? traducir(String(s)) : s; };

  // ---------- recorrido del DOM ----------
  var ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];
  var textoOrig = new WeakMap();   // nodo de texto -> { orig, out }
  var attrOrig = new WeakMap();    // elemento -> { attr: { orig, out } }
  var SALTAR = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1 };

  function nodoTexto(n) {
    var reg = textoOrig.get(n);
    if (lang === 'en') {
      if (reg && n.data === reg.out) return;            // ya traducido por nosotros
      var orig = n.data, out = traducir(orig);
      textoOrig.set(n, { orig: orig, out: out });
      if (out !== orig) n.data = out;
    } else if (reg) {
      if (n.data === reg.out) n.data = reg.orig;
      textoOrig.delete(n);
    }
  }
  function atributos(el) {
    var mapa = attrOrig.get(el);
    for (var i = 0; i < ATTRS.length; i++) {
      var a = ATTRS[i];
      if (!el.hasAttribute || !el.hasAttribute(a)) continue;
      var v = el.getAttribute(a);
      var reg = mapa && mapa[a];
      if (lang === 'en') {
        if (reg && v === reg.out) continue;
        var out = traducir(v);
        if (!mapa) { mapa = {}; attrOrig.set(el, mapa); }
        mapa[a] = { orig: v, out: out };
        if (out !== v) el.setAttribute(a, out);
      } else if (reg) {
        if (v === reg.out) el.setAttribute(a, reg.orig);
        delete mapa[a];
      }
    }
  }
  function recorrer(raiz) {
    if (!raiz) return;
    if (raiz.nodeType === 3) { if (!raiz.parentNode || !SALTAR[raiz.parentNode.nodeName]) nodoTexto(raiz); return; }
    if (raiz.nodeType !== 1) return;
    atributos(raiz);        // el placeholder de un textarea sí se traduce; su contenido no
    if (SALTAR[raiz.nodeName]) return;
    for (var h = raiz.firstChild; h; h = h.nextSibling) recorrer(h);
    if (raiz.nodeName === 'SELECT' || raiz.nodeName === 'INPUT') return;
  }

  var observador = null, ocupado = false;
  function aplicar() {
    if (ocupado) return;
    ocupado = true;
    try {
      document.documentElement.lang = lang === 'en' ? 'en' : 'es-MX';
      document.title = lang === 'en' ? '5S Audits' : 'Auditorías 5S';
      recorrer(document.body);
      botones();
    } finally { ocupado = false; }
  }

  // ---------- botón de idioma (se agrega a cada cabecera .top) ----------
  function crearBoton() {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn ghost sm idioma-btn';
    b.setAttribute('data-idioma', '1');
    b.style.minWidth = '44px'; b.style.fontWeight = '700'; // style-src-attr permite atributos de estilo (el CSP no deja <style> sin nonce)
    b.setAttribute('aria-label', lang === 'en' ? 'Language: English. Switch to Spanish' : 'Idioma: español. Cambiar a inglés');
    b.title = lang === 'en' ? 'Cambiar a español' : 'Switch to English';
    b.textContent = lang === 'en' ? 'ES' : 'EN';
    b.addEventListener('click', function () { cambiarIdioma(lang === 'en' ? 'es' : 'en'); });
    return b;
  }
  function botones() {
    var cabeceras = document.querySelectorAll('header.top');
    for (var i = 0; i < cabeceras.length; i++) {
      var c = cabeceras[i], previo = c.querySelector('[data-idioma]');
      if (previo) {
        // solo se escribe si cambió: cada escritura dispara el observador y de otro modo habría un bucle
        var txt = lang === 'en' ? 'ES' : 'EN';
        var etq = lang === 'en' ? 'Language: English. Switch to Spanish' : 'Idioma: español. Cambiar a inglés';
        var tit = lang === 'en' ? 'Cambiar a español' : 'Switch to English';
        if (previo.textContent !== txt) previo.textContent = txt;
        if (previo.getAttribute('aria-label') !== etq) previo.setAttribute('aria-label', etq);
        if (previo.getAttribute('title') !== tit) previo.setAttribute('title', tit);
        attrOrig.delete(previo);
        continue;
      }
      var sp = c.querySelector('.spacer');
      var b = crearBoton();
      if (sp && sp.nextSibling) c.insertBefore(b, sp.nextSibling); else c.appendChild(b);
    }
  }
  function cambiarIdioma(nuevo) {
    lang = nuevo;
    try { localStorage.setItem(CLAVE, lang); } catch (e) { /* sin almacenamiento */ }
    aplicar();
  }
  window.a5sIdioma = function () { return lang; };
  window.a5sCambiarIdioma = cambiarIdioma;

  // alert/confirm también se muestran en el idioma activo
  var alertOrig = window.alert, confirmOrig = window.confirm;
  window.alert = function (m) { return alertOrig.call(window, window.t(m)); };
  window.confirm = function (m) { return confirmOrig.call(window, window.t(m)); };

  function iniciar() {
    aplicar();
    observador = new MutationObserver(function (muts) {
      if (ocupado) return;
      ocupado = true;
      try {
        for (var i = 0; i < muts.length; i++) {
          var m = muts[i];
          if (m.type === 'characterData') { if (lang === 'en') nodoTexto(m.target); }
          else if (m.type === 'attributes') { if (lang === 'en') atributos(m.target); }
          else for (var j = 0; j < m.addedNodes.length; j++) recorrer(m.addedNodes[j]);
        }
        botones();
      } finally { ocupado = false; }
    });
    observador.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar); else iniciar();
})();
