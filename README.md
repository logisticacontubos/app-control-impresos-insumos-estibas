# Control de Impresos - Insumos - Estibas

Misma arquitectura que tu app de rollos (`app-trazabilidad-rollos`): páginas
HTML sueltas + CSS + JS, sin proceso de build, subidas directo a Vercel como
sitio estático. El backend es un Google Apps Script publicado como Web App
dentro de tu propio `Control_Impresos_Insumos_Estibas.xlsx` (Google Sheets),
igual que en la otra app.

## Archivos

```
ciie-app/
├── index.html              (login por PIN)
├── home.html                (selector de empresa si aplica + selector de módulo)
├── modulo.html               (acciones disponibles dentro de un módulo, según tu rol)
├── nueva-requisicion.html     (crear requisición)
├── bodega.html                (entregar + devoluciones, según el módulo)
├── inventario.html            (niveles de stock)
├── compras.html                (vista de compras + editar umbrales)
├── assets/
│   ├── logo-contubos.png
│   └── logo-tecnipapel.png
├── css/
│   └── styles.css
└── js/
    └── app.js                  (sesión, permisos, llamadas a la API)
```

Las pantallas de módulo (`modulo.html`, `nueva-requisicion.html`, `bodega.html`,
`inventario.html`, `compras.html`) reciben el módulo por la URL, ej:
`modulo.html?modulo=insumos` — así no hay que repetir un juego de páginas por
cada módulo (Impresos / Insumos / Estibas), es la misma página parametrizada.
Igual que en tu app de rollos, el color de marca (`--magenta`) se pisa por
JavaScript según la empresa activa (rojo Contubos / verde Tecnipapel), sin
tocar el CSS.

`apps-script/Code.gs` no va en Vercel — se pega directo en tu Google Sheets
(ver paso 1 abajo).

## 1. Publicar el backend (Apps Script) — igual que en la app de rollos

1. Abre tu Google Sheets `Control_Impresos_Insumos_Estibas`.
2. Extensiones → Apps Script.
3. Borra el contenido de `Code.gs` que aparece por defecto y pega todo el
   contenido del archivo `apps-script/Code.gs` que te mandé.
4. Arriba a la derecha, botón **Implementar → Nueva implementación**.
5. Tipo: **Aplicación web**. Ejecutar como: **Yo**. Quién tiene acceso:
   **Cualquier persona** (así la app puede llamarla sin que cada usuario
   tenga que iniciar sesión en Google).
6. Implementar → copia la **URL de la aplicación web** que te da (termina en
   `/exec`) — es tu `API_URL`.
7. Cada vez que edites `Code.gs`, tienes que hacer **Implementar → Administrar
   implementaciones → editar (lápiz) → Nueva versión → Implementar** para que
   los cambios se reflejen (igual que en la app de rollos).

## 2. Requisito en tu Sheets — hoja Usuarios

Debe existir una hoja **Usuarios** con columnas `PIN`, `Nombre`, `Area`, `Rol`,
`Empresa` (tal como ya la dejaste). En **Rol**, usa una palabra que contenga:
"Producción", "Bodega"/"Logística", "Compras", o "Admin"/"Supervisor"/"Jefe de
Logística". En **Empresa**: `Contubos`, `Tecnipapel`, o `Ambas`.

## 3. Conectar la app al backend

Abre `js/app.js` y en la primera línea útil pega tu URL:

```js
const API_URL = "https://script.google.com/macros/s/TU_ID/exec";
```

## 4. Subir a GitHub y desplegar en Vercel

```bash
git init
git add .
git commit -m "Primera versión"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/TU_REPO.git
git push -u origin main
```

En vercel.com → **Add New → Project** → selecciona el repo. Como no hay
build (es HTML plano), Vercel lo detecta solo como sitio estático — no hace
falta configurar nada más. Deploy.

Cualquier cambio futuro: editas el HTML/CSS/JS, `git add . && git commit -m
"..." && git push`, y Vercel despliega solo.

## Pendiente

- Insumos y Estibas: en cuanto completes el stock y los niveles
  óptimo/ajustado/crítico en Sheets, la app los toma automáticamente.
- Si más adelante quieres separar los ítems "Ambas" en dos filas por
  empresa, aquí no hay que tocar nada de código — es un tema de cómo
  cargas los datos en Sheets.
