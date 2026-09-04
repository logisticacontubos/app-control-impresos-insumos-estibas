// ==========================================================
// CONFIGURACIÓN
// ==========================================================
// Pega aquí la URL de implementación (Web App) de tu Apps Script (Code.gs)
const API_URL = "https://script.google.com/macros/s/AKfycbzup1pgEC6Pe0XKt1CZVR6VWjCcANGwdOZSFlajSYeGbIdnVstPkSI6NdSsMjO74Deh/exec";

// ==========================================================
// SESIÓN (usuario logueado, guardado en sessionStorage) — igual que la app de rollos
// ==========================================================
function guardarSesion(usuario) {
  sessionStorage.setItem("usuario", JSON.stringify(usuario));
}
function obtenerSesion() {
  const raw = sessionStorage.getItem("usuario");
  return raw ? JSON.parse(raw) : null;
}
function cerrarSesion() {
  sessionStorage.removeItem("usuario");
  sessionStorage.removeItem("empresaActiva");
  sessionStorage.removeItem("moduloActivo");
  window.location.href = "index.html";
}
function requiereSesion() {
  const u = obtenerSesion();
  if (!u) { window.location.href = "index.html"; return null; }
  return u;
}

// ==========================================================
// EMPRESA ACTIVA — igual concepto que en la app de rollos
// ==========================================================
function esMultiEmpresa(usuario) {
  return !!usuario && usuario.empresa === "Ambas";
}
function obtenerEmpresaActiva() {
  const u = obtenerSesion();
  if (!u) return null;
  if (!esMultiEmpresa(u)) return u.empresa;
  return sessionStorage.getItem("empresaActiva") || null;
}
function establecerEmpresaActiva(empresa) {
  sessionStorage.setItem("empresaActiva", empresa);
}

// ==========================================================
// MÓDULO ACTIVO (Impresos / Insumos / Estibas)
// ==========================================================
const MODULOS = {
  impresos: { key: "impresos", label: "Impresos", itemLabel: "Impreso", unitLabel: "kg", empresas: ["Contubos"], hasDevolucion: true },
  insumos: { key: "insumos", label: "Insumos", itemLabel: "Insumo", unitLabel: "un.", empresas: ["Contubos", "Tecnipapel"], hasDevolucion: false },
  estibas: { key: "estibas", label: "Estibas", itemLabel: "Estiba", unitLabel: "un.", empresas: ["Contubos", "Tecnipapel"], hasDevolucion: false },
};
function moduloDesdeURL() {
  const params = new URLSearchParams(window.location.search);
  const key = params.get("modulo");
  return MODULOS[key] || null;
}
function puedeAccederModulo(usuario, moduloKey) {
  if (!usuario) return false;
  if (usuario.empresa === "Ambas") return true;
  return MODULOS[moduloKey].empresas.includes(usuario.empresa);
}
function empresasParaUsuario(usuario, moduloKey) {
  const mod = MODULOS[moduloKey];
  if (usuario.empresa === "Ambas") return mod.empresas;
  return mod.empresas.includes(usuario.empresa) ? [usuario.empresa] : [];
}

// ==========================================================
// ROLES Y PERMISOS
// rol: 'produccion' | 'bodega' | 'compras' | 'admin'
// ==========================================================
function puedeCrearRequisicion(rol) { return rol === "produccion" || rol === "admin"; }
function puedeEntregar(rol) { return rol === "bodega" || rol === "admin"; }
function puedeEditarUmbrales(rol) { return rol === "compras" || rol === "admin"; }
// Ingresar mercancía nueva al inventario: Jefe de Logística (rol "bodega") y
// Supervisor de Inventarios (rol "admin").
function puedeIngresarStock(rol) { return rol === "bodega" || rol === "admin"; }
function puedeVerReportes(rol) { return rol === "compras" || rol === "bodega" || rol === "admin"; }
function vistasParaRol(rol) {
  const VISTAS = {
    produccion: ["produccion", "inventario"],
    bodega: ["bodega", "inventario", "compras"],
    compras: ["inventario", "compras"],
    admin: ["produccion", "bodega", "inventario", "compras"],
  };
  return VISTAS[rol] || [];
}

// ==========================================================
// INDICADOR DE "CARGANDO / PROCESANDO" GLOBAL
// Se muestra automáticamente en CADA llamada a la API (apiGet/apiPost),
// de principio a fin: desde el ingreso del PIN hasta cualquier otra
// acción (crear requisición, entregar, devolver, umbrales, reportes, etc.),
// para que la interfaz nunca se sienta "congelada" entre el click y el resultado.
// ==========================================================
const MENSAJES_CARGA = {
  login: "Verificando...",
  crearRequisicion: "Enviando requisición...",
  entregarRequisicion: "Registrando entrega...",
  devolverRequisicion: "Registrando devolución...",
  actualizarUmbrales: "Guardando cambios...",
  getInventario: "Cargando inventario...",
  getRequisiciones: "Cargando requisiciones...",
  getReporte: "Generando reporte...",
  ingresarStock: "Registrando ingreso...",
  getIngresos: "Cargando ingresos...",
};
let _cargasActivas = 0;
function mostrarCargando(mensaje) {
  _cargasActivas++;
  let el = document.getElementById("loadingOverlay");
  if (!el) {
    el = document.createElement("div");
    el.id = "loadingOverlay";
    el.className = "loading-overlay";
    el.innerHTML = '<div class="spinner"></div><div class="texto"></div>';
    document.body.appendChild(el);
  }
  el.querySelector(".texto").textContent = mensaje || "Procesando...";
  el.style.display = "flex";
}
function ocultarCargando() {
  _cargasActivas = Math.max(0, _cargasActivas - 1);
  if (_cargasActivas > 0) return;
  const el = document.getElementById("loadingOverlay");
  if (el) el.style.display = "none";
}

// ==========================================================
// LLAMADAS A LA API (Apps Script) — mismo patrón que la app de rollos
// ==========================================================
// El tercer parámetro { silencioso: true } es para llamadas de fondo que NO
// deben congelar toda la pantalla con el spinner (ej: el resumen de pendientes
// que se carga solo al entrar a Inicio) — el usuario puede seguir navegando
// mientras esa carga termina, en vez de quedar bloqueado esperándola.
// A veces Google Apps Script termina de ejecutar la función sin ningún error
// (se ve "Completada" en el registro de Ejecuciones), pero la respuesta no le
// llega bien al navegador — llega una página de error en vez del JSON
// esperado. Es un problema intermitente de la infraestructura de Google al
// entregar la respuesta, no un error del código. Como reintentar la MISMA
// petición GET (leer datos) es seguro, pero reintentar un POST (crear/
// entregar/devolver) podría duplicar la operación si la primera sí se
// guardó, aquí solo se reintenta automáticamente cuando es seguro hacerlo.
async function fetchConReintento(hacerFetch, reintentos) {
  let ultimoError;
  for (let intento = 0; intento <= reintentos; intento++) {
    try {
      const resp = await hacerFetch();
      const texto = await resp.text();
      let json;
      try {
        json = JSON.parse(texto);
      } catch (e) {
        throw new Error("La respuesta de Google no fue válida (intenta de nuevo en unos segundos).");
      }
      if (!json.ok) throw new Error(json.error || "Error desconocido");
      return json.data;
    } catch (e) {
      ultimoError = e;
      if (intento < reintentos) await new Promise((r) => setTimeout(r, 900));
    }
  }
  throw ultimoError;
}

async function apiPost(accion, datos, opts) {
  const empresaActiva = obtenerEmpresaActiva();
  const body = Object.assign({ accion: accion }, datos);
  if (empresaActiva && body.empresa === undefined) body.empresa = empresaActiva;
  const silencioso = opts && opts.silencioso;
  if (!silencioso) mostrarCargando(MENSAJES_CARGA[accion] || "Procesando...");
  try {
    // Los POST que SÍ cambian datos (crear/entregar/devolver/ingresar stock)
    // NO se reintentan automáticamente: si la primera petición sí se guardó
    // en la hoja pero la respuesta se perdió, reintentar duplicaría la
    // operación. "login" es la única excepción — es de solo lectura, no
    // cambia nada, así que si el problema intermitente de Google pega justo
    // ahí, es seguro reintentarlo solo en vez de que la persona piense que
    // escribió mal su PIN.
    const reintentos = accion === "login" ? 2 : 0;
    return await fetchConReintento(() => fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(body),
    }), reintentos);
  } finally {
    if (!silencioso) ocultarCargando();
  }
}

async function apiGet(accion, params, opts) {
  const empresaActiva = obtenerEmpresaActiva();
  const base = Object.assign({ accion: accion }, params || {});
  if (empresaActiva && base.empresa === undefined) base.empresa = empresaActiva;
  const qs = new URLSearchParams(base);
  const silencioso = opts && opts.silencioso;
  if (!silencioso) mostrarCargando(MENSAJES_CARGA[accion] || "Cargando...");
  try {
    // Los GET (solo leer datos) sí se reintentan hasta 2 veces — son seguros
    // de repetir porque no cambian nada, así que si el primer intento choca
    // con el problema intermitente de Google, el segundo o tercero casi
    // siempre funciona sin que el usuario note nada.
    return await fetchConReintento(() => fetch(API_URL + "?" + qs.toString()), 2);
  } finally {
    if (!silencioso) ocultarCargando();
  }
}

// ==========================================================
// TEMA POR EMPRESA — mismo mecanismo que tu app de rollos: se pisa la variable
// --magenta (y su sombra) en :root, así que todo lo que ya usa var(--magenta)
// se repinta solo (título, pin-dots, barra de progreso, botones primarios).
// ==========================================================
function aplicarTema(empresa) {
  if (empresa === "Tecnipapel") {
    document.documentElement.style.setProperty("--magenta", "#0E8F5C");
    document.documentElement.style.setProperty("--magenta-sombra", "rgba(14,143,92,0.22)");
  } else {
    document.documentElement.style.setProperty("--magenta", "#D01148");
    document.documentElement.style.setProperty("--magenta-sombra", "rgba(208,17,72,0.22)");
  }
}

// ==========================================================
// PÁGINA DE MÓDULO — valida sesión + acceso al módulo, fija la empresa activa
// y aplica el tema. Se llama al inicio de cada pantalla de módulo.
// ==========================================================
function requiereModulo() {
  const usuario = requiereSesion();
  if (!usuario) return null;
  const mod = moduloDesdeURL();
  if (!mod || !puedeAccederModulo(usuario, mod.key)) { window.location.href = "home.html"; return null; }

  const empresas = empresasParaUsuario(usuario, mod.key);
  let empresaActual = obtenerEmpresaActiva();
  if (!empresaActual || !empresas.includes(empresaActual)) empresaActual = empresas[0];
  establecerEmpresaActiva(empresaActual);
  aplicarTema(empresaActual);
  mostrarUsuarioEnHeader(usuario);
  mostrarLogoEnHeader(empresaActual);
  mostrarBotonActualizar();
  mostrarBotonSalir();

  return { usuario, mod, empresas, empresaActual };
}

// Logo de la empresa (Contubos o Tecnipapel, cada uno con su color de marca) fijo
// en el header de TODAS las pantallas de módulo, para que siempre se vea con
// claridad en qué empresa se está trabajando, no solo por el color de fondo.
function mostrarLogoEnHeader(empresa) {
  const header = document.querySelector("header.topbar");
  if (!header) return;
  let img = header.querySelector(".logo-header");
  if (!img) {
    img = document.createElement("img");
    img.className = "logo-header";
    const back = header.querySelector(".back");
    if (back && back.nextSibling) header.insertBefore(img, back.nextSibling);
    else header.appendChild(img);
  }
  if (empresa === "Tecnipapel") { img.src = "assets/logo-tecnipapel.png"; img.alt = "Tecnipapel"; }
  else { img.src = "assets/logo-contubos.png"; img.alt = "Contubos"; }
}

// Botón "Actualizar" en el header de todas las pantallas de módulo, para
// refrescar los datos (inventario, requisiciones, etc.) sin tener que salir
// y volver a entrar.
function mostrarBotonActualizar() {
  const header = document.querySelector("header.topbar");
  if (!header || header.querySelector(".btn-actualizar")) return;
  const btn = document.createElement("button");
  btn.className = "btn-actualizar";
  btn.title = "Actualizar";
  btn.innerHTML = "&#8635;";
  btn.onclick = () => window.location.reload();
  header.appendChild(btn);
}

// Botón "Salir" (cerrar sesión) en el header de todas las pantallas de
// módulo, al lado del de Actualizar — funciona igual en Contubos y en
// Tecnipapel, y para cualquier usuario, sin tener que volver a Inicio para
// cerrar sesión.
function mostrarBotonSalir() {
  const header = document.querySelector("header.topbar");
  if (!header || header.querySelector(".btn-salir")) return;
  const btn = document.createElement("button");
  btn.className = "btn-actualizar btn-salir";
  btn.title = "Cerrar sesión";
  btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line></svg>';
  btn.onclick = () => cerrarSesion();
  header.appendChild(btn);
}

// Pone el nombre y cargo/rol de quien está conectado en la esquina del header,
// en TODAS las pantallas de módulo (para que siempre se sepa con qué usuario
// se está trabajando, sin tener que volver a home.html a revisarlo).
function mostrarUsuarioEnHeader(usuario) {
  const header = document.querySelector("header.topbar");
  if (!header || header.querySelector(".userchip")) return;
  const chip = document.createElement("div");
  chip.className = "userchip";
  chip.innerHTML = `<div class="nombre">${usuario.nombre}</div><div class="rol">${usuario.cargo || usuario.rol}</div>`;
  header.appendChild(chip);
}

// ==========================================================
// UTILIDADES
// ==========================================================
function fechaHoy() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dia = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dia}`;
}
function mostrarError(elId, msg) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.textContent = msg;
  el.style.display = "block";
}
function ocultarError(elId) {
  const el = document.getElementById(elId);
  if (el) el.style.display = "none";
}
function mostrarToast(mensaje, ms) {
  const el = document.getElementById("toastExito");
  if (!el) return;
  el.textContent = mensaje;
  el.style.display = "block";
  clearTimeout(el._timeout);
  el._timeout = setTimeout(() => { el.style.display = "none"; }, ms || 2200);
}
// Arma las líneas de detalle de una requisición (solicitado, entregado, quién entregó,
// a quién, y devolución si aplica) — se usa igual en modulo.html ("Mis requisiciones")
// y en bodega.html (cola y devoluciones), para que en cualquier parte de la app se vea
// la trazabilidad completa, no solo lo que se pidió.
function detalleRequisicion(r, mod) {
  const cantSolHeader = buscarEncabezado(r, "Cantidad solicitada");
  const cantEntHeader = buscarEncabezado(r, "Cantidad entregada");
  const cantDevHeader = buscarEncabezado(r, "Cantidad devuelta");
  const saldoHeader = buscarEncabezado(r, "Saldo neto");

  const motivoHeader = buscarEncabezado(r, "Motivo");

  const lineas = [];
  const solicitada = Number(r[cantSolHeader]) || 0;
  // Fecha/hora de creación, para poder ver de un vistazo hace cuánto está
  // pendiente una requisición sin tener que entrar al reporte.
  const fechaSol = r["Fecha"] ? r["Fecha"] + (r["Hora"] ? " " + r["Hora"] : "") : "";
  lineas.push(`Solicitó ${r["Solicitó"]} · ${r[cantSolHeader] || 0} ${mod.unitLabel} pedidos${fechaSol ? " · " + fechaSol : ""}`);
  if (motivoHeader && r[motivoHeader]) {
    lineas.push(`Motivo: ${r[motivoHeader]}`);
  }

  if (r.Estado === "Entregado" || r.Estado === "Entregado parcial" || r.Estado === "Cerrada") {
    const cantEnt = r[cantEntHeader];
    const entregado = cantEnt !== undefined && cantEnt !== "" ? Number(cantEnt) : 0;
    // Igual con la entrega: fecha/hora de cuándo se entregó, no solo cuándo
    // se pidió — así queda la trazabilidad completa a la vista, de un
    // vistazo, sin tener que ir al Reporte.
    const fechaEnt = r["Fecha entrega"] ? r["Fecha entrega"] + (r["Hora entrega"] ? " " + r["Hora entrega"] : "") : "";
    lineas.push(`Entregó ${r["Entregó (bodega)"] || "-"} · ${entregado} ${mod.unitLabel} a ${r["Entregado a (producción)"] || "-"}${fechaEnt ? " · " + fechaEnt : ""}`);
    if (r.Estado === "Entregado parcial") {
      const saldo = Math.max(0, solicitada - entregado);
      lineas.push(`Entrega parcial · falta por entregar ${saldo} ${mod.unitLabel}`);
    }
  }

  if (mod.hasDevolucion && cantDevHeader && r[cantDevHeader] !== undefined && r[cantDevHeader] !== "" && Number(r[cantDevHeader]) > 0) {
    lineas.push(`Devolvió ${r[cantDevHeader]} ${mod.unitLabel}${r[saldoHeader] !== undefined && r[saldoHeader] !== "" ? " · saldo neto " + r[saldoHeader] + " " + mod.unitLabel : ""}`);
  }

  return lineas.map((l) => `<p class="op">${l}</p>`).join("");
}

// Los estados con espacio ("Entregado parcial") no sirven directo como nombre
// de clase CSS — esto arma el sufijo de la clase badge-<Estado> sin espacios.
function claseEstado(estado) {
  return (estado || "").toString().trim().replace(/\s+/g, "-");
}

function buscarEncabezado(obj, prefijo) {
  return Object.keys(obj || {}).find((h) => h.toLowerCase().startsWith(prefijo.toLowerCase()));
}
