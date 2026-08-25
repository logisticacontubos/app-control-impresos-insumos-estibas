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
    empresas: ["Contubos"],
    hasDevolucion: true,
    unitLabel: "kg",
    prefijo: "IMP",
  },
  insumos: {
    inventario: "Insumos_Inventario",
    requisiciones: "Insumos_Requisiciones",
    devoluciones: null,
    empresas: ["Contubos", "Tecnipapel"],
    hasDevolucion: false,
    unitLabel: "un.",
    prefijo: "INS",
  },
  estibas: {
    inventario: "Estibas_Inventario",
    requisiciones: "Estibas_Requisiciones",
    devoluciones: null,
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

function accionCrearRequisicion(p) {
  const mod = MODULES[p.modulo];
  if (!mod) throw new Error("Módulo inválido");
  if (!p.codigo || !p.cantidad) throw new Error("Falta el ítem o la cantidad");

  const hoja = leerHoja(mod.requisiciones);
  const cantSolHeader = buscarEncabezado(hoja.headers, "Cantidad solicitada");
  const id = mod.prefijo + "-" + String(hoja.rows.length + 1).padStart(4, "0");

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

  agregarFila(mod.requisiciones, hoja.headers, fila);
  return { id: id };
}

function accionEntregarRequisicion(p) {
  const mod = MODULES[p.modulo];
  if (!mod) throw new Error("Módulo inválido");
  if (!p.cantidadEntregada || !p.entregadoA) throw new Error("Falta la cantidad o el operario que recibe");

  const hoja = leerHoja(mod.requisiciones);
  const cantEntHeader = buscarEncabezado(hoja.headers, "Cantidad entregada");
  const fila = hoja.rows.find((r) => r["ID"] === p.id);
  if (!fila) throw new Error("Requisición no encontrada");

  const patch = { Estado: "Entregado", "Entregó (bodega)": p.entrego, "Entregado a (producción)": p.entregadoA };
  if (cantEntHeader) patch[cantEntHeader] = p.cantidadEntregada;
  actualizarCeldas(mod.requisiciones, hoja.headers, fila._row, patch);

  ajustarStock(mod.inventario, fila["Código"], -Number(p.cantidadEntregada));
  return { ok: true };
}

function accionDevolverRequisicion(p) {
  const mod = MODULES[p.modulo];
  if (!mod || !mod.hasDevolucion) throw new Error("Este módulo no maneja devoluciones");
  if (!p.cantidadDevuelta || !p.quienDevuelve) throw new Error("Falta la cantidad o quién devuelve");

  const hoja = leerHoja(mod.requisiciones);
  const cantDevHeader = buscarEncabezado(hoja.headers, "Cantidad devuelta");
  const saldoHeader = buscarEncabezado(hoja.headers, "Saldo neto");
  const cantEntHeader = buscarEncabezado(hoja.headers, "Cantidad entregada");
  const fila = hoja.rows.find((r) => r["ID"] === p.id);
  if (!fila) throw new Error("Requisición no encontrada");

  const prevDevuelta = Number(fila[cantDevHeader]) || 0;
  const nuevaDevuelta = prevDevuelta + Number(p.cantidadDevuelta);
  const entregada = Number(fila[cantEntHeader]) || 0;

  const patch = {};
  if (cantDevHeader) patch[cantDevHeader] = nuevaDevuelta;
  if (saldoHeader) patch[saldoHeader] = entregada - nuevaDevuelta;
  actualizarCeldas(mod.requisiciones, hoja.headers, fila._row, patch);

  if (mod.devoluciones) {
    const hojaDev = leerHoja(mod.devoluciones);
    const cantDevDevHeader = buscarEncabezado(hojaDev.headers, "Cantidad devuelta") || "Cantidad devuelta (kg)";
    agregarFila(mod.devoluciones, hojaDev.headers, {
      "ID Requisición": fila["ID"],
      Fecha: fechaHoy(),
      [cantDevDevHeader]: p.cantidadDevuelta,
      "Quién devuelve (producción)": p.quienDevuelve,
      "Recibió (bodega)": p.recibio,
    });
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

function ajustarStock(nombreHoja, codigo, delta) {
  const hoja = leerHoja(nombreHoja);
  const codigoHeader = buscarEncabezado(hoja.headers, "Código");
  const stockHeader = buscarEncabezado(hoja.headers, "Stock actual");
  const fila = hoja.rows.find((r) => r[codigoHeader] === codigo);
  if (!fila || !stockHeader) return;
  const nuevoStock = (Number(fila[stockHeader]) || 0) + delta;
  actualizarCeldas(nombreHoja, hoja.headers, fila._row, { [stockHeader]: nuevoStock });
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

  const rows = [];
  for (let i = headerRowIndex + 1; i < valores.length; i++) {
    const fila = valores[i];
    if (fila.every((c) => c === "" || c === null)) continue;
    const obj = { _row: i + 1 };
    headers.forEach((h, idx) => { if (h) obj[h] = fila[idx]; });
    rows.push(obj);
  }
  return { headers: headers, rows: rows };
}

function agregarFila(nombreHoja, headers, valoresPorEncabezado) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(nombreHoja);
  const fila = headers.map((h) => (valoresPorEncabezado[h] !== undefined ? valoresPorEncabezado[h] : ""));
  sheet.appendRow(fila);
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
