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
// LLAMADAS A LA API (Apps Script) — mismo patrón que la app de rollos
// ==========================================================
async function apiPost(accion, datos) {
  const empresaActiva = obtenerEmpresaActiva();
  const body = Object.assign({ accion: accion }, datos);
  if (empresaActiva && body.empresa === undefined) body.empresa = empresaActiva;
  const resp = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(body),
  });
  const json = await resp.json();
  if (!json.ok) throw new Error(json.error || "Error desconocido");
  return json.data;
}

async function apiGet(accion, params) {
  const empresaActiva = obtenerEmpresaActiva();
  const base = Object.assign({ accion: accion }, params || {});
  if (empresaActiva && base.empresa === undefined) base.empresa = empresaActiva;
  const qs = new URLSearchParams(base);
  const resp = await fetch(API_URL + "?" + qs.toString());
  const json = await resp.json();
  if (!json.ok) throw new Error(json.error || "Error desconocido");
  return json.data;
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

  return { usuario, mod, empresas, empresaActual };
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
function buscarEncabezado(obj, prefijo) {
  return Object.keys(obj || {}).find((h) => h.toLowerCase().startsWith(prefijo.toLowerCase()));
}
