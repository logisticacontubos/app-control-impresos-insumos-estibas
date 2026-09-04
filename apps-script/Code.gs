// ==========================================================
// Control de Impresos - Insumos - Estibas — Backend (Google Apps Script)
// Se pega dentro de tu propio Google Sheets: Extensiones → Apps Script.
// No usa credenciales aparte porque corre con el mismo permiso de tu cuenta de Google.
// ==========================================================

// Nombres EXACTOS de las pestañas de tu Sheets. Si renombras una pestaña, actualízalo aquí.
const USUARIOS_SHEET = "Usuarios";

const MODULES = {
  impresos: {
    inventario: "Impresos_Inventario",
    requisiciones: "Impresos_Requisiciones",
    devoluciones: "Impresos_Devoluciones",
    ingresos: "Impresos_Ingresos",
    empresas: ["Contubos"],
    hasDevolucion: true,
    unitLabel: "kg",
    prefijo: "IMP",
  },
  insumos: {
    inventario: "Insumos_Inventario",
    requisiciones: "Insumos_Requisiciones",
    devoluciones: null,
    ingresos: "Insumos_Ingresos",
    empresas: ["Contubos", "Tecnipapel"],
    hasDevolucion: false,
    unitLabel: "un.",
    prefijo: "INS",
  },
  estibas: {
    inventario: "Estibas_Inventario",
    requisiciones: "Estibas_Requisiciones",
    devoluciones: null,
    ingresos: "Estibas_Ingresos",
    empresas: ["Contubos", "Tecnipapel"],
    hasDevolucion: false,
    unitLabel: "un.",
    prefijo: "EST",
  },
};

// ==========================================================
// ENTRADA (GET y POST) — despacha por "accion", igual que tu app de rollos
// ==========================================================
function doGet(e) {
  return manejar(e.parameter || {});
}

function doPost(e) {
  let body = {};
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return responder(false, null, "Body inválido");
  }
  return manejar(body);
}

function manejar(p) {
  try {
    let data;
    switch (p.accion) {
      case "login": data = accionLogin(p); break;
      case "getInventario": data = accionGetInventario(p); break;
      case "getRequisiciones": data = accionGetRequisiciones(p); break;
      case "crearRequisicion": data = accionCrearRequisicion(p); break;
      case "entregarRequisicion": data = accionEntregarRequisicion(p); break;
      case "devolverRequisicion": data = accionDevolverRequisicion(p); break;
      case "actualizarUmbrales": data = accionActualizarUmbrales(p); break;
      case "getReporte": data = accionGetReporte(p); break;
      case "getPendientesGlobal": data = accionGetPendientesGlobal(p); break;
      case "getBodegaDatos": data = accionGetBodegaDatos(p); break;
      case "ingresarStock": data = accionIngresarStock(p); break;
      case "getIngresos": data = accionGetIngresos(p); break;
      case "getHistorial": data = accionGetHistorial(p); break;
      default: throw new Error("Acción desconocida: " + p.accion);
    }
    return responder(true, data, null);
  } catch (err) {
    return responder(false, null, err.message);
  }
}

function responder(ok, data, error) {
  return ContentService
    .createTextOutput(JSON.stringify({ ok: ok, data: data, error: error }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ==========================================================
// ACCIONES
// ==========================================================
function accionLogin(p) {
  const pin = (p.pin || "").toString().trim();
  const hoja = leerHoja(USUARIOS_SHEET);
  const u = hoja.rows.find((r) => (r["PIN"] || "").toString().trim() === pin);
  if (!u) throw new Error("PIN no encontrado");
  return {
    pin: u["PIN"],
    nombre: u["Nombre"],
    cargo: u["Area"] || u["Cargo"] || "",
    rol: normalizarRol(u["Rol"]),
    empresa: u["Empresa"],
  };
}

function accionGetInventario(p) {
  const mod = MODULES[p.modulo];
  if (!mod) throw new Error("Módulo inválido");
  const hoja = leerHoja(mod.inventario);
  let rows = hoja.rows;
  if (p.empresa) {
    rows = rows.filter((r) => !r["Empresa"] || r["Empresa"] === p.empresa || r["Empresa"] === "Ambas");
  }
  return { items: rows, unitLabel: mod.unitLabel };
}

function accionGetRequisiciones(p) {
  const mod = MODULES[p.modulo];
  if (!mod) throw new Error("Módulo inválido");
  const hoja = leerHoja(mod.requisiciones);
  let rows = hoja.rows;
  if (p.empresa) rows = rows.filter((r) => !r["Empresa"] || r["Empresa"] === p.empresa);
  return { items: rows };
}

// La pantalla de Bodega necesita la cola de requisiciones Y el inventario (para
// mostrar cuánto hay disponible al momento de entregar). En vez de que el front
// haga las 2 llamadas al mismo tiempo (lo que puede saturar el límite de
// ejecuciones simultáneas de Apps Script y hacer que una de las 2 falle o se
// demore mucho), se traen las 2 juntas en una sola llamada/ejecución.
function accionGetBodegaDatos(p) {
  const mod = MODULES[p.modulo];
  if (!mod) throw new Error("Módulo inválido");
  const reqData = accionGetRequisiciones(p);
  const invData = accionGetInventario(p);
  return { requisiciones: reqData.items, inventario: invData.items, unitLabel: mod.unitLabel };
}

// Trae los pendientes de los TRES módulos en una sola llamada (en vez de que el
// front tenga que hacer 3 llamadas separadas a Apps Script, una por módulo —
// cada llamada a un Web App de Apps Script tiene una latencia fija importante,
// así que juntarlas en una sola es la mejora de velocidad más grande posible
// para la pantalla de Inicio).
function accionGetPendientesGlobal(p) {
  const resultado = {};
  Object.keys(MODULES).forEach((key) => {
    const mod = MODULES[key];
    const hoja = leerHoja(mod.requisiciones);
    let rows = hoja.rows;
    if (p.empresa) rows = rows.filter((r) => !r["Empresa"] || r["Empresa"] === p.empresa);
    resultado[key] = rows.filter((r) => r.Estado === "Pendiente" || r.Estado === "Entregado parcial");
  });
  return resultado;
}

function accionCrearRequisicion(p) {
  const mod = MODULES[p.modulo];
  if (!mod) throw new Error("Módulo inválido");
  if (!p.codigo || !p.cantidad) throw new Error("Falta el ítem o la cantidad");
  if (Number(p.cantidad) <= 0) throw new Error("La cantidad debe ser mayor a cero");

  // En Estibas es obligatorio explicar el motivo/uso (ej: "se va a cortar familia,
  // se necesitan 40 estibas 115x115"), para que bodega y producción sepan a qué
  // pedido/necesidad va ligada la requisición.
  if (p.modulo === "estibas" && !(p.motivo || "").toString().trim()) {
    throw new Error("El motivo de la requisición de estibas es obligatorio");
  }

  // No se puede pedir más de lo que hay en stock — si el ítem no tiene stock en tu
  // hoja de Inventario (columna vacía), se deja pasar sin validar para no bloquear
  // mientras terminas de cargar los datos de Insumos/Estibas.
  const hojaInv = leerHoja(mod.inventario);
  const codigoInvHeader = buscarEncabezado(hojaInv.headers, "Código");
  const stockHeader = buscarEncabezado(hojaInv.headers, "Stock actual");
  const codigoBuscado = String(p.codigo || "").trim().toLowerCase();
  const itemInv = hojaInv.rows.find((r) => String(r[codigoInvHeader] || "").trim().toLowerCase() === codigoBuscado);
  if (itemInv && stockHeader && itemInv[stockHeader] !== "" && itemInv[stockHeader] !== null) {
    const stockActual = Number(itemInv[stockHeader]) || 0;
    if (Number(p.cantidad) > stockActual) {
      throw new Error("No hay suficiente stock. Disponible: " + stockActual + " " + mod.unitLabel + ".");
    }
  }

  const hoja = leerHoja(mod.requisiciones);
  const cantSolHeader = buscarEncabezado(hoja.headers, "Cantidad solicitada");
  const motivoHeader = buscarEncabezado(hoja.headers, "Motivo");
  // El ID se calcula a partir del número más alto que ya exista con este
  // prefijo (ej. "IMP-0007" -> el siguiente es "IMP-0008"), en vez de contar
  // cuántas filas hay (hoja.rows.length + 1). Contar filas se rompe si alguna
  // vez se borró una fila a mano o si el orden quedó desordenado por un
  // filtro — puede volver a generar un ID que ya existe, y entonces 2
  // requisiciones distintas quedan con el mismo ID (como pasó con "IMP-0005"
  // repetido en dos filas), haciendo que el sistema actualice la fila
  // equivocada al entregar.
  let maxNum = 0;
  hoja.rows.forEach((r) => {
    const m = String(r["ID"] || "").match(new RegExp("^" + mod.prefijo + "-(\\d+)$"));
    if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10));
  });
  const id = mod.prefijo + "-" + String(maxNum + 1).padStart(4, "0");

  const fila = {
    ID: id,
    Fecha: fechaHoy(),
    "Código": p.codigo,
    Referencia: p.referencia || "",
    "Solicitó": p.solicito,
    Cargo: p.cargo || "",
    Estado: "Pendiente",
  };
  if (hoja.headers.indexOf("Empresa") !== -1) fila["Empresa"] = p.empresa || "";
  if (cantSolHeader) fila[cantSolHeader] = p.cantidad;
  if (motivoHeader) fila[motivoHeader] = p.motivo || "";
  // "Hora" es el nombre exacto de columna (no un prefijo) para no confundirla
  // con "Hora entrega", que es otra columna distinta.
  if (hoja.headers.indexOf("Hora") !== -1) fila["Hora"] = horaAhora();

  agregarFila(mod.requisiciones, hoja, fila);
  return { id: id };
}

function accionEntregarRequisicion(p) {
  const mod = MODULES[p.modulo];
  if (!mod) throw new Error("Módulo inválido");
  if (!p.cantidadEntregada || !p.entregadoA) throw new Error("Falta la cantidad o el operario que recibe");

  const hoja = leerHoja(mod.requisiciones);
  const cantEntHeader = buscarEncabezado(hoja.headers, "Cantidad entregada");
  const cantSolHeader = buscarEncabezado(hoja.headers, "Cantidad solicitada");
  // Comparación tolerante a espacios (ej. "IMP-0005 " vs "IMP-0005"), igual
  // que se hizo con los códigos, para que no falle por un detalle así.
  const idBuscado = String(p.id || "").trim();
  const fila = hoja.rows.find((r) => String(r["ID"] || "").trim() === idBuscado);
  // Se deja un registro (visible en "Ejecuciones" > clic en la fila > Ver
  // registros) de cada intento de entrega, para poder diagnosticar sin
  // adivinar si algo vuelve a fallar: qué ID se buscó, si se encontró, y qué
  // se calculó.
  Logger.log("entregarRequisicion: modulo=%s id=%s encontrada=%s cantidad=%s entregadoA=%s", p.modulo, idBuscado, !!fila, p.cantidadEntregada, p.entregadoA);
  if (!fila) throw new Error('Requisición "' + idBuscado + '" no encontrada en ' + mod.requisiciones);

  // Las entregas se van acumulando (por si se entrega en varias veces). Si lo
  // acumulado todavía no cubre lo solicitado, la requisición queda "Entregado
  // parcial" y sigue visible en la cola de pendientes por el saldo que falta,
  // en vez de cerrarse como si ya estuviera completa.
  const entregadaPrevia = cantEntHeader ? (Number(fila[cantEntHeader]) || 0) : 0;
  const nuevaEntregada = redondear2(entregadaPrevia + Number(p.cantidadEntregada));
  const solicitada = cantSolHeader ? redondear2(Number(fila[cantSolHeader]) || 0) : 0;
  // Se compara redondeado a 2 decimales: si no, entregar exactamente lo
  // solicitado en kg (ej. 57.5) puede quedar como "Entregado parcial" por
  // errores de precisión de punto flotante (57.5 vs 57.499999999999996) y la
  // requisición nunca se cierra ni desaparece de la cola de pendientes.
  const estado = solicitada > 0 && nuevaEntregada < solicitada ? "Entregado parcial" : "Entregado";

  const patch = { Estado: estado, "Entregó (bodega)": p.entrego, "Entregado a (producción)": p.entregadoA };
  if (cantEntHeader) patch[cantEntHeader] = nuevaEntregada;
  // Guarda fecha y hora en que se hizo la entrega (puede ser muy distinta a la
  // fecha en que se creó la requisición) — el Reporte y KPI's usa esta fecha, no
  // la de creación, para calcular el consumo del período, y la hora sirve para
  // la trazabilidad completa (quién entregó, cuándo, a quién).
  const fechaEntHeader = buscarEncabezado(hoja.headers, "Fecha entrega");
  if (fechaEntHeader) patch[fechaEntHeader] = fechaHoy();
  if (hoja.headers.indexOf("Hora entrega") !== -1) patch["Hora entrega"] = horaAhora();
  actualizarCeldas(mod.requisiciones, hoja.headers, fila._row, patch);

  const stockOk = ajustarStock(mod.inventario, fila["Código"], -Number(p.cantidadEntregada));
  return {
    ok: true,
    estado: estado,
    saldoPendiente: Math.max(0, solicitada - nuevaEntregada),
    // Si el código de la requisición no coincide con ninguno en la hoja de
    // Inventario (por espacios de más, mayúsculas distintas, etc.), el stock
    // NO se descuenta — antes esto fallaba en silencio y parecía que el
    // inventario "no se movía". Ahora se avisa en la respuesta para que se
    // note de inmediato en vez de descubrirlo días después.
    advertenciaStock: stockOk ? "" : 'No se pudo descontar el stock: el código "' + fila["Código"] + '" no se encontró (o no tiene columna "Stock actual") en el inventario de este módulo.',
  };
}

function accionDevolverRequisicion(p) {
  const mod = MODULES[p.modulo];
  if (!mod || !mod.hasDevolucion) throw new Error("Este módulo no maneja devoluciones");
  if (!p.cantidadDevuelta || !p.quienDevuelve) throw new Error("Falta la cantidad o quién devuelve");

  const hoja = leerHoja(mod.requisiciones);
  const cantDevHeader = buscarEncabezado(hoja.headers, "Cantidad devuelta");
  const saldoHeader = buscarEncabezado(hoja.headers, "Saldo neto");
  const cantEntHeader = buscarEncabezado(hoja.headers, "Cantidad entregada");
  const idBuscado = String(p.id || "").trim();
  const fila = hoja.rows.find((r) => String(r["ID"] || "").trim() === idBuscado);
  if (!fila) throw new Error('Requisición "' + idBuscado + '" no encontrada en ' + mod.requisiciones);

  const prevDevuelta = Number(fila[cantDevHeader]) || 0;
  const nuevaDevuelta = prevDevuelta + Number(p.cantidadDevuelta);
  const entregada = Number(fila[cantEntHeader]) || 0;

  const patch = {};
  if (cantDevHeader) patch[cantDevHeader] = nuevaDevuelta;
  if (saldoHeader) patch[saldoHeader] = entregada - nuevaDevuelta;
  if (hoja.headers.indexOf("Fecha devolución") !== -1) patch["Fecha devolución"] = fechaHoy();
  if (hoja.headers.indexOf("Hora devolución") !== -1) patch["Hora devolución"] = horaAhora();
  // Se guarda también quién devolvió y quién recibió directamente en la fila de
  // la requisición (además del registro en la hoja de Devoluciones), para que
  // el reporte pueda mostrar la trazabilidad completa sin tener que cruzar hojas.
  if (hoja.headers.indexOf("Quién devuelve (producción)") !== -1) patch["Quién devuelve (producción)"] = p.quienDevuelve;
  if (hoja.headers.indexOf("Recibió (bodega)") !== -1) patch["Recibió (bodega)"] = p.recibio;
  actualizarCeldas(mod.requisiciones, hoja.headers, fila._row, patch);

  if (mod.devoluciones) {
    const hojaDev = leerHoja(mod.devoluciones);
    const cantDevDevHeader = buscarEncabezado(hojaDev.headers, "Cantidad devuelta") || "Cantidad devuelta (kg)";
    const filaDev = {
      "ID Requisición": fila["ID"],
      Fecha: fechaHoy(),
      [cantDevDevHeader]: p.cantidadDevuelta,
      "Quién devuelve (producción)": p.quienDevuelve,
      "Recibió (bodega)": p.recibio,
    };
    if (hojaDev.headers.indexOf("Hora") !== -1) filaDev["Hora"] = horaAhora();
    agregarFila(mod.devoluciones, hojaDev, filaDev);
  }

  ajustarStock(mod.inventario, fila["Código"], Number(p.cantidadDevuelta));
  return { ok: true };
}

function accionActualizarUmbrales(p) {
  const mod = MODULES[p.modulo];
  if (!mod) throw new Error("Módulo inválido");
  const hoja = leerHoja(mod.inventario);
  const codigoHeader = buscarEncabezado(hoja.headers, "Código");
  const fila = hoja.rows.find((r) => r[codigoHeader] === p.codigo);
  if (!fila) throw new Error("Ítem no encontrado");

  const patch = {};
  const optimoHeader = buscarEncabezado(hoja.headers, "Óptimo");
  const ajustadoHeader = buscarEncabezado(hoja.headers, "Ajustado");
  const criticoHeader = buscarEncabezado(hoja.headers, "Crítico");
  if (p.optimo !== undefined && optimoHeader) patch[optimoHeader] = p.optimo;
  if (p.ajustado !== undefined && ajustadoHeader) patch[ajustadoHeader] = p.ajustado;
  if (p.critico !== undefined && criticoHeader) patch[criticoHeader] = p.critico;

  actualizarCeldas(mod.inventario, hoja.headers, fila._row, patch);
  return { ok: true };
}

// Ingreso de mercancía nueva al inventario (compras/pedidos que llegan), con
// trazabilidad: queda registrado en una hoja "<Módulo>_Ingresos" (se crea
// sola la primera vez que se usa, con sus encabezados) quién ingresó cuánto,
// de qué ítem, cuándo, y una observación libre (ej. proveedor, número de
// factura). El stock del inventario sube de inmediato con la cantidad
// ingresada. Pensado para Jefe de Logística y Supervisor de Inventarios
// (roles "bodega" y "admin" en el sistema).
function accionIngresarStock(p) {
  const mod = MODULES[p.modulo];
  if (!mod) throw new Error("Módulo inválido");
  if (!p.codigo || !p.cantidad) throw new Error("Falta el ítem o la cantidad");
  if (Number(p.cantidad) <= 0) throw new Error("La cantidad debe ser mayor a cero");
  if (!p.ingreso) throw new Error("Falta quién registra el ingreso");

  const hojaInv = leerHoja(mod.inventario);
  const codigoInvHeader = buscarEncabezado(hojaInv.headers, "Código");
  const refInvHeader = buscarEncabezado(hojaInv.headers, "Referencia");
  const codigoBuscado = String(p.codigo || "").trim().toLowerCase();
  const itemInv = hojaInv.rows.find((r) => String(r[codigoInvHeader] || "").trim().toLowerCase() === codigoBuscado);
  if (!itemInv) throw new Error('El código "' + p.codigo + '" no existe en el inventario de este módulo.');

  const stockOk = ajustarStock(mod.inventario, itemInv[codigoInvHeader], Number(p.cantidad));

  const hojaIng = obtenerOCrearHoja(mod.ingresos, ["ID", "Fecha", "Hora", "Código", "Referencia", "Cantidad", "Ingresó", "Empresa", "Observación"]);
  let maxNum = 0;
  hojaIng.rows.forEach((r) => {
    const m = String(r["ID"] || "").match(new RegExp("^" + mod.prefijo + "-ING-(\\d+)$"));
    if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10));
  });
  const id = mod.prefijo + "-ING-" + String(maxNum + 1).padStart(4, "0");

  const fila = {
    ID: id,
    Fecha: fechaHoy(),
    Hora: horaAhora(),
    "Código": itemInv[codigoInvHeader],
    Referencia: refInvHeader ? itemInv[refInvHeader] : "",
    Cantidad: Number(p.cantidad),
    "Ingresó": p.ingreso,
    Empresa: p.empresa || "",
    "Observación": p.observacion || "",
  };
  agregarFila(mod.ingresos, hojaIng, fila);

  return { ok: true, id: id, stockOk: stockOk };
}

// Historial de ingresos de un módulo (para poder consultarlo, no solo
// registrarlo), más reciente primero.
function accionGetIngresos(p) {
  const mod = MODULES[p.modulo];
  if (!mod) throw new Error("Módulo inválido");
  const hoja = obtenerOCrearHoja(mod.ingresos, ["ID", "Fecha", "Hora", "Código", "Referencia", "Cantidad", "Ingresó", "Empresa", "Observación"]);
  let rows = hoja.rows;
  if (p.empresa) rows = rows.filter((r) => !r["Empresa"] || r["Empresa"] === p.empresa);
  rows = rows.slice().sort((a, b) => String(b["Fecha"] + " " + b["Hora"]).localeCompare(String(a["Fecha"] + " " + a["Hora"])));
  return { items: rows };
}

// La pantalla de "Historial de movimientos" necesita requisiciones E
// ingresos juntos para mostrar la trazabilidad completa en un solo lugar —
// se traen los dos en una sola llamada/ejecución, en vez de 2 llamadas
// simultáneas desde el front (mismo motivo que getBodegaDatos: evitar 2
// ejecuciones en paralelo contra Apps Script).
function accionGetHistorial(p) {
  const mod = MODULES[p.modulo];
  if (!mod) throw new Error("Módulo inválido");
  const reqData = accionGetRequisiciones(p);
  const ingData = accionGetIngresos(p);
  return { requisiciones: reqData.items, ingresos: ingData.items, unitLabel: mod.unitLabel };
}

// Reporte: inventario actual (para los KPI de estado) + consumo (kg/unidades entregados)
// agrupado por ítem dentro de un rango de fechas [desde, hasta] (ambas inclusive, formato
// yyyy-mm-dd). Si no se manda desde/hasta, toma todas las requisiciones entregadas.
function accionGetReporte(p) {
  const mod = MODULES[p.modulo];
  if (!mod) throw new Error("Módulo inválido");

  const hojaInv = leerHoja(mod.inventario);
  let itemsInv = hojaInv.rows;
  if (p.empresa) itemsInv = itemsInv.filter((r) => !r["Empresa"] || r["Empresa"] === p.empresa || r["Empresa"] === "Ambas");

  const codigoInvHeader = buscarEncabezado(hojaInv.headers, "Código");
  const refInvHeader = buscarEncabezado(hojaInv.headers, "Referencia");

  const hojaReq = leerHoja(mod.requisiciones);
  let reqs = hojaReq.rows;
  if (p.empresa) reqs = reqs.filter((r) => !r["Empresa"] || r["Empresa"] === p.empresa);

  // El rango de fechas se compara contra la fecha "relevante" de cada requisición:
  // si ya se entregó (total o parcial), es la fecha en que se entregó — no la
  // fecha en que se creó el pedido, que puede ser de días antes. Si todavía está
  // pendiente, se usa la fecha de creación (es lo único que hay). Así, si hoy
  // entregas un pedido que se creó la semana pasada, el reporte de "Hoy" sí lo
  // cuenta como consumo de hoy.
  const fechaEntHeader = buscarEncabezado(hojaReq.headers, "Fecha entrega");
  const entregadaEstados = ["Entregado", "Entregado parcial", "Cerrada"];
  function fechaRelevante(r) {
    if (entregadaEstados.indexOf(r.Estado) !== -1 && fechaEntHeader && r[fechaEntHeader]) return String(r[fechaEntHeader]);
    return String(r["Fecha"] || "");
  }
  if (p.desde) reqs = reqs.filter((r) => fechaRelevante(r) >= p.desde);
  if (p.hasta) reqs = reqs.filter((r) => fechaRelevante(r) <= p.hasta);

  const cantEntHeader = buscarEncabezado(hojaReq.headers, "Cantidad entregada");
  const entregadas = reqs.filter((r) => entregadaEstados.indexOf(r.Estado) !== -1);

  const consumoPorItem = {};
  entregadas.forEach((r) => {
    const codigo = r["Código"];
    const cant = Number(r[cantEntHeader]) || 0;
    if (!consumoPorItem[codigo]) consumoPorItem[codigo] = { codigo: codigo, referencia: r["Referencia"], cantidad: 0 };
    consumoPorItem[codigo].cantidad += cant;
  });
  const consumo = Object.values(consumoPorItem).sort((a, b) => b.cantidad - a.cantidad);
  const totalConsumido = consumo.reduce((s, c) => s + c.cantidad, 0);

  const optimoHeader = buscarEncabezado(hojaInv.headers, "Óptimo");
  const ajustadoHeader = buscarEncabezado(hojaInv.headers, "Ajustado");
  const criticoHeader = buscarEncabezado(hojaInv.headers, "Crítico");

  // Lista cruda de requisiciones del período, con TODA la trazabilidad (quién
  // solicitó y cuándo, quién entregó y cuándo, a quién, faltante/sobrante y
  // devolución si aplica) — para el detalle del reporte, no solo el resumen
  // agregado de consumo.
  const cantSolHeader = buscarEncabezado(hojaReq.headers, "Cantidad solicitada");
  const motivoHeader = buscarEncabezado(hojaReq.headers, "Motivo");
  const cantDevHeader = buscarEncabezado(hojaReq.headers, "Cantidad devuelta");
  const saldoHeader = buscarEncabezado(hojaReq.headers, "Saldo neto");
  const requisicionesDetalle = reqs.map((r) => {
    const solicitada = cantSolHeader ? Number(r[cantSolHeader]) || 0 : 0;
    const entregadaNum = cantEntHeader ? Number(r[cantEntHeader]) || 0 : 0;
    const huboEntrega = entregadaEstados.indexOf(r.Estado) !== -1;
    return {
      id: r["ID"],
      fecha: r["Fecha"],
      hora: r["Hora"] || "",
      codigo: r["Código"],
      referencia: r["Referencia"],
      solicito: r["Solicitó"],
      cargo: r["Cargo"] || "",
      cantidadSolicitada: cantSolHeader ? r[cantSolHeader] : "",
      entrego: r["Entregó (bodega)"] || "",
      entregadoA: r["Entregado a (producción)"] || "",
      fechaEntrega: r["Fecha entrega"] || "",
      horaEntrega: r["Hora entrega"] || "",
      cantidadEntregada: cantEntHeader ? r[cantEntHeader] : "",
      diferencia: huboEntrega ? (solicitada - entregadaNum) : "",
      cantidadDevuelta: cantDevHeader ? (r[cantDevHeader] || "") : "",
      saldoNeto: saldoHeader ? (r[saldoHeader] || "") : "",
      quienDevuelve: r["Quién devuelve (producción)"] || "",
      recibioDevolucion: r["Recibió (bodega)"] || "",
      fechaDevolucion: r["Fecha devolución"] || "",
      estado: r["Estado"],
      motivo: motivoHeader ? r[motivoHeader] : "",
    };
  });

  return {
    unitLabel: mod.unitLabel,
    inventario: itemsInv,
    consumo: consumo,
    totalConsumido: totalConsumido,
    totalRequisiciones: reqs.length,
    requisicionesEntregadas: entregadas.length,
    itemsOptimo: itemsInv.filter((it) => it["Estado"] === "Óptimo").length,
    itemsAjustado: itemsInv.filter((it) => it["Estado"] === "Ajustado").length,
    itemsCritico: itemsInv.filter((it) => it["Estado"] === "Crítico").length,
    itemsCero: itemsInv.filter((it) => it["Estado"] === "Cero").length,
    requisiciones: requisicionesDetalle,
  };
}

function ajustarStock(nombreHoja, codigo, delta) {
  const hoja = leerHoja(nombreHoja);
  const codigoHeader = buscarEncabezado(hoja.headers, "Código");
  const stockHeader = buscarEncabezado(hoja.headers, "Stock actual");
  // Comparación "tolerante": recorta espacios y no distingue mayúsculas/
  // minúsculas, para que un código escrito como "INS-001 " (con espacio de
  // más) o "ins-001" en una de las dos hojas sí siga emparejando con
  // "INS-001" en la otra. Antes una comparación estricta (===) hacía que el
  // stock simplemente no se tocara, sin ningún aviso.
  const buscado = String(codigo || "").trim().toLowerCase();
  const fila = hoja.rows.find((r) => String(r[codigoHeader] || "").trim().toLowerCase() === buscado);
  if (!fila || !stockHeader) return false;
  const nuevoStock = redondear2((Number(fila[stockHeader]) || 0) + delta);
  actualizarCeldas(nombreHoja, hoja.headers, fila._row, { [stockHeader]: nuevoStock });
  return true;
}

function redondear2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// ==========================================================
// ROLES — mismo mapeo que la app de rollos, ajustado a los roles de esta app
// ==========================================================
function normalizarRol(rawRol) {
  const r = (rawRol || "").toString().trim().toLowerCase();
  if (r.indexOf("produc") !== -1) return "produccion";
  if (r.indexOf("bodega") !== -1 || r.indexOf("log") !== -1) return "bodega";
  if (r.indexOf("compra") !== -1) return "compras";
  if (r.indexOf("admin") !== -1 || r.indexOf("supervisor") !== -1 || r.indexOf("jefe de log") !== -1) return "admin";
  return r;
}

// ==========================================================
// ACCESO A HOJAS — por nombre de encabezado, no por letra de columna
// ==========================================================
function leerHoja(nombre) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(nombre);
  if (!sheet) throw new Error('No existe la hoja "' + nombre + '"');
  const valores = sheet.getDataRange().getValues();
  if (valores.length === 0) return { headers: [], rows: [] };

  let headerRowIndex = 0;
  for (let i = 0; i < Math.min(valores.length, 5); i++) {
    const noVacias = valores[i].filter((c) => c !== "" && c !== null).length;
    if (noVacias >= 2) { headerRowIndex = i; break; }
  }
  const headers = valores[headerRowIndex].map((h) => (h || "").toString().trim());

  // Los datos deben ser contiguos justo debajo del encabezado: en cuanto se
  // encuentra una fila completamente vacía, se deja de leer. Esto es a propósito
  // — así, si más abajo en la misma hoja hay notas o texto suelto (fuera de la
  // tabla de datos), no se confunden con filas de datos ni afectan el conteo
  // de filas (que se usa para generar el siguiente ID).
  const rows = [];
  for (let i = headerRowIndex + 1; i < valores.length; i++) {
    const fila = valores[i];
    if (fila.every((c) => c === "" || c === null)) break;
    const obj = { _row: i + 1 };
    headers.forEach((h, idx) => { if (h) obj[h] = formatearCelda(fila[idx], h); });
    rows.push(obj);
  }
  return { headers: headers, rows: rows, headerRowIndex: headerRowIndex };
}

// Igual que leerHoja(nombre), pero si la pestaña todavía no existe la crea
// sola con la fila de encabezados dada — se usa para las hojas de trazabilidad
// (como "<Módulo>_Ingresos") que no tienen por qué existir de antemano en tu
// Sheets: la primera vez que alguien registra un ingreso, aparece la pestaña
// lista, sin que tengas que crearla a mano.
function obtenerOCrearHoja(nombre, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(nombre);
  if (!sheet) {
    sheet = ss.insertSheet(nombre);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight("bold");
  }
  return leerHoja(nombre);
}

// "hoja" es el objeto que ya devolvió leerHoja(nombreHoja) en quien llama a esta
// función — se reutiliza en vez de volver a leer toda la hoja de nuevo aquí
// adentro (antes se leía dos veces por cada fila agregada: una en la función
// que llama y otra aquí, duplicando el tiempo de esa operación).
function agregarFila(nombreHoja, hoja, valoresPorEncabezado) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(nombreHoja);
  const fila = hoja.headers.map((h) => (valoresPorEncabezado[h] !== undefined ? valoresPorEncabezado[h] : ""));

  // No se usa appendRow(): esa función agrega la fila después de la ÚLTIMA fila
  // con contenido en TODA la hoja, así que si más abajo hay texto suelto (notas,
  // comentarios), la fila nueva termina metida ahí, no justo debajo de los datos.
  // En cambio, se calcula exactamente la siguiente fila vacía justo después del
  // último dato real (usando la misma lectura "contigua" de leerHoja) y se
  // escribe ahí directamente.
  const siguienteFila = hoja.headerRowIndex + 1 + hoja.rows.length + 1;
  sheet.getRange(siguienteFila, 1, 1, fila.length).setValues([fila]);
}

function actualizarCeldas(nombreHoja, headers, numeroFila, valoresPorEncabezado) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(nombreHoja);
  Object.keys(valoresPorEncabezado).forEach((header) => {
    const col = headers.indexOf(header);
    if (col === -1) return;
    sheet.getRange(numeroFila, col + 1).setValue(valoresPorEncabezado[header]);
  });
}

function buscarEncabezado(headers, prefijo) {
  return headers.find((h) => h.toLowerCase().indexOf(prefijo.toLowerCase()) === 0);
}

function fechaHoy() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
}

function horaAhora() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "HH:mm");
}

// Si una celda de fecha/hora tiene formato de Fecha en la hoja, Google Sheets la
// entrega como un objeto Date real (aunque se haya guardado como texto), y eso
// se ve feísimo en la app ("2026-08-25T07:00:00.000Z"). Esto la vuelve a dejar
// como texto legible: yyyy-MM-dd para columnas de fecha, HH:mm para las de hora.
function formatearCelda(valor, nombreHeader) {
  if (!(valor instanceof Date)) return valor;
  const esHora = nombreHeader.toLowerCase().indexOf("hora") !== -1;
  return Utilities.formatDate(valor, Session.getScriptTimeZone(), esHora ? "HH:mm" : "yyyy-MM-dd");
}
