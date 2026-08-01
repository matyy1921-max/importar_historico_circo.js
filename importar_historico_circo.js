const axios = require("axios");
const cheerio = require("cheerio");
const { CookieJar } = require("tough-cookie");
const { wrapper } = require("axios-cookiejar-support");

const BASE_URL = "https://pixelgo.circocrm.com";

const CIRCO_EMAIL = process.env.CIRCO_EMAIL;
const CIRCO_PASSWORD = process.env.CIRCO_PASSWORD;
const CIRCO_WEBAPP_URL = process.env.CIRCO_WEBAPP_URL;
const CIRCO_WEBAPP_SECRET =
  process.env.CIRCO_WEBAPP_SECRET;

/*
 * Para la primera prueba usamos solamente un día.
 * Después lo convertiremos en un rango completo.
 */
const DATE_FROM =
  process.env.CIRCO_DATE_FROM || "2026-05-08";

const DATE_TO =
  process.env.CIRCO_DATE_TO || DATE_FROM;

/*
 * Mapa opcional:
 *
 * {
 *   "DELFI SABO CARLOS ENRIQUE": "Titan",
 *   "AGRO GONZALEZ MARIA CRISTINA": "Titan"
 * }
 */
let CLIENT_MAP = {};

try {
  CLIENT_MAP = JSON.parse(
    process.env.CIRCO_CLIENT_MAP_JSON || "{}"
  );
} catch (error) {
  throw new Error(
    "CIRCO_CLIENT_MAP_JSON no contiene un JSON válido"
  );
}


function validarVariables() {
  const missing = [];

  if (!CIRCO_EMAIL) {
    missing.push("CIRCO_EMAIL");
  }

  if (!CIRCO_PASSWORD) {
    missing.push("CIRCO_PASSWORD");
  }

  if (!CIRCO_WEBAPP_URL) {
    missing.push("CIRCO_WEBAPP_URL");
  }

  if (!CIRCO_WEBAPP_SECRET) {
    missing.push("CIRCO_WEBAPP_SECRET");
  }

  if (missing.length > 0) {
    throw new Error(
      `Faltan variables: ${missing.join(", ")}`
    );
  }
}


function crearClienteHttp() {
  const jar = new CookieJar();

  return wrapper(
    axios.create({
      baseURL: BASE_URL,
      jar,
      withCredentials: true,
      maxRedirects: 5,
      timeout: 180000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
          "AppleWebKit/537.36 (KHTML, like Gecko) " +
          "Chrome/150.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml," +
          "application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "es-AR,es;q=0.9"
      }
    })
  );
}


async function iniciarSesion(client) {
  console.log("Abriendo página de login...");

  const loginPage = await client.get("/hg1/login");

  const $ = cheerio.load(loginPage.data);

  const csrfToken = $(
    'input[name="_token"]'
  ).attr("value");

  if (!csrfToken) {
    throw new Error(
      "No se encontró el token CSRF del login"
    );
  }

  console.log("Token CSRF obtenido.");
  console.log("Iniciando sesión en Circo...");

  const formData = new URLSearchParams();

  formData.append("_token", csrfToken);
  formData.append("email", CIRCO_EMAIL);
  formData.append("password", CIRCO_PASSWORD);

  const loginResponse = await client.post(
    "/hg1/login",
    formData.toString(),
    {
      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded",
        Origin: BASE_URL,
        Referer: `${BASE_URL}/hg1/login`
      }
    }
  );

  const finalUrl =
    loginResponse.request?.res?.responseUrl || "";

  const loginHtml =
    typeof loginResponse.data === "string"
      ? loginResponse.data
      : "";

  const sigueEnLogin =
    finalUrl.includes("/hg1/login") ||
    loginHtml.includes('name="password"');

  if (sigueEnLogin) {
    throw new Error(
      "El usuario o la contraseña no fueron aceptados"
    );
  }

  const verification = await client.get("/hg1");

  const verificationHtml =
    typeof verification.data === "string"
      ? verification.data
      : "";

  if (
    verificationHtml.includes('name="password"') ||
    !verificationHtml.includes(
      "Auditoría HG Cash"
    )
  ) {
    throw new Error(
      "No se pudo confirmar la sesión de Circo"
    );
  }

  console.log("Sesión iniciada correctamente.");
}


async function obtenerResumen(
  client,
  dateFrom,
  dateTo
) {
  console.log(
    `Consultando resumen ${dateFrom} → ${dateTo}...`
  );

  const response = await client.get("/hg1", {
    params: {
      from: dateFrom,
      to: dateTo
    },
    headers: {
      Referer: `${BASE_URL}/hg1`
    }
  });

  if (
    typeof response.data !== "string"
  ) {
    throw new Error(
      "Circo no devolvió una página HTML"
    );
  }

  return response.data;
}


function limpiarTexto(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}


function parsearNumeroArgentino(value) {
  const text = limpiarTexto(value)
    .replace(/ARS/gi, "")
    .replace(/%/g, "")
    .replace(/\s/g, "")
    .replace(/\./g, "")
    .replace(",", ".")
    .replace(/[^\d.-]/g, "");

  if (!text) {
    return 0;
  }

  const number = Number(text);

  return Number.isFinite(number)
    ? number
    : 0;
}


function normalizarTitular(value) {
  return limpiarTexto(value)
    .toUpperCase();
}


function obtenerCliente(titular) {
  const titularNormalizado =
    normalizarTitular(titular);

  /*
   * Primero busca coincidencia exacta.
   */
  if (CLIENT_MAP[titularNormalizado]) {
    return CLIENT_MAP[titularNormalizado];
  }

  /*
   * También admite que el JSON tenga nombres
   * escritos con mayúsculas o espacios distintos.
   */
  for (
    const [accountName, cliente]
    of Object.entries(CLIENT_MAP)
  ) {
    if (
      normalizarTitular(accountName) ===
      titularNormalizado
    ) {
      return String(cliente || "").trim();
    }
  }

  return "";
}


function extraerFilasResumen(
  html,
  fechaConsulta
) {
  const $ = cheerio.load(html);

  const tables = $("table");

  if (tables.length === 0) {
    throw new Error(
      "No se encontró ninguna tabla en /hg1"
    );
  }

  let targetTable = null;

  tables.each((index, table) => {
    const headers = $(table)
      .find("thead th")
      .map((_, element) =>
        limpiarTexto($(element).text())
          .toLowerCase()
      )
      .get();

    const hasCuenta =
      headers.some(header =>
        header === "cuenta"
      );

    const hasEntrante =
      headers.some(header =>
        header.includes("vol. entrante")
      );

    const hasDesvio =
      headers.some(header =>
        header.includes("desvío ars") ||
        header.includes("desvio ars")
      );

    if (
      hasCuenta &&
      hasEntrante &&
      hasDesvio
    ) {
      targetTable = table;
    }
  });

  if (!targetTable) {
    throw new Error(
      "No se encontró la tabla " +
      '"Cuentas por desvío neto"'
    );
  }

  const rows = [];

  $(targetTable)
    .find("tbody tr")
    .each((_, tr) => {
      const cells = $(tr)
        .find("td")
        .map((__, td) =>
          limpiarTexto($(td).text())
        )
        .get();

      /*
       * La tabla tiene:
       *
       * 0 número de fila
       * 1 cuenta
       * 2 TX
       * 3 entrante
       * 4 saliente
       * 5 fee cobrado
       * 6 fee esperado
       * 7 cobrado de más
       * 8 desvío ARS
       * 9 desvío %
       */
      if (cells.length < 10) {
        return;
      }

      const titular = cells[1];

      if (
        !titular ||
        titular.toUpperCase().includes("TOTAL")
      ) {
        return;
      }

      rows.push([
        fechaConsulta,                    // A Fecha
        titular,                         // B Titular
        obtenerCliente(titular),          // C Cliente
        parsearNumeroArgentino(cells[2]), // D TX
        parsearNumeroArgentino(cells[3]), // E Entrante
        parsearNumeroArgentino(cells[4]), // F Saliente
        parsearNumeroArgentino(cells[5]), // G Fee cobrado
        parsearNumeroArgentino(cells[6]), // H Fee esperado
        parsearNumeroArgentino(cells[7]), // I Cobrado de más
        parsearNumeroArgentino(cells[8]), // J Desvío ARS
        parsearNumeroArgentino(cells[9])  // K Desvío %
      ]);
    });

  if (rows.length === 0) {
    throw new Error(
      "La tabla fue encontrada, " +
      "pero no se extrajo ninguna cuenta"
    );
  }

  return rows;
}


function mostrarTotales(rows) {
  const totals = rows.reduce(
    (accumulator, row) => {
      accumulator.tx += Number(row[3]) || 0;
      accumulator.entrante +=
        Number(row[4]) || 0;
      accumulator.saliente +=
        Number(row[5]) || 0;
      accumulator.feeCobrado +=
        Number(row[6]) || 0;
      accumulator.feeEsperado +=
        Number(row[7]) || 0;
      accumulator.cobradoDeMas +=
        Number(row[8]) || 0;
      accumulator.desvioArs +=
        Number(row[9]) || 0;

      return accumulator;
    },
    {
      tx: 0,
      entrante: 0,
      saliente: 0,
      feeCobrado: 0,
      feeEsperado: 0,
      cobradoDeMas: 0,
      desvioArs: 0
    }
  );

  console.log("Totales extraídos:");
  console.log(
    JSON.stringify(totals, null, 2)
  );
}


async function enviarAAppsScript(rows) {
  console.log(
    `Enviando ${rows.length} filas a Apps Script...`
  );

  const response = await axios.post(
    CIRCO_WEBAPP_URL,
    {
      secret: CIRCO_WEBAPP_SECRET,
      mode: "historico_circo",
      rows
    },
    {
      timeout: 120000,
      headers: {
        "Content-Type": "application/json"
      },
      maxRedirects: 5
    }
  );

  const result =
    typeof response.data === "string"
      ? JSON.parse(response.data)
      : response.data;

  console.log(
    "Respuesta de Apps Script:"
  );

  console.log(
    JSON.stringify(result, null, 2)
  );

  if (!result.success) {
    throw new Error(
      result.error ||
      "Apps Script rechazó la importación"
    );
  }

  return result;
}

function parseIsoDate(dateText) {
  const match = String(dateText || "").match(
    /^(\d{4})-(\d{2})-(\d{2})$/
  );

  if (!match) {
    throw new Error(
      `Fecha inválida: ${dateText}. Usá YYYY-MM-DD`
    );
  }

  return new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3])
  );
}


function formatIsoDate(date) {
  const year = date.getFullYear();

  const month = String(
    date.getMonth() + 1
  ).padStart(2, "0");

  const day = String(
    date.getDate()
  ).padStart(2, "0");

  return `${year}-${month}-${day}`;
}


function generarFechas(desde, hasta) {
  const start = parseIsoDate(desde);
  const end = parseIsoDate(hasta);

  if (start > end) {
    throw new Error(
      "CIRCO_DATE_FROM no puede ser posterior a CIRCO_DATE_TO"
    );
  }

  const dates = [];
  const current = new Date(start);

  while (current <= end) {
    dates.push(formatIsoDate(current));
    current.setDate(current.getDate() + 1);
  }

  return dates;
}


function esperar(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}


async function main() {
  validarVariables();

  console.log("================================");
  console.log("IMPORTACIÓN HISTÓRICO CIRCO");
  console.log("================================");
  console.log(`Fecha desde: ${DATE_FROM}`);
  console.log(`Fecha hasta: ${DATE_TO}`);

  const fechas = generarFechas(
    DATE_FROM,
    DATE_TO
  );

  console.log(
    `Días a procesar: ${fechas.length}`
  );

  const client = crearClienteHttp();

  await iniciarSesion(client);

  let totalCuentas = 0;
  let totalInsertadas = 0;
  let totalDuplicadas = 0;
  let totalInvalidas = 0;
  let diasConError = 0;

  for (
    let index = 0;
    index < fechas.length;
    index++
  ) {
    const fecha = fechas[index];

    console.log("");
    console.log(
      `Procesando ${fecha} ` +
      `(${index + 1}/${fechas.length})`
    );

    try {
      const html = await obtenerResumen(
        client,
        fecha,
        fecha
      );

      const rows = extraerFilasResumen(
        html,
        fecha
      );

      console.log(
        `Cuentas extraídas: ${rows.length}`
      );

      mostrarTotales(rows);

      const result =
        await enviarAAppsScript(rows);

      totalCuentas += rows.length;

      totalInsertadas +=
        Number(result.insertedRows) || 0;

      totalDuplicadas +=
        Number(result.duplicateRows) || 0;

      totalInvalidas +=
        Number(result.invalidRows) || 0;

    } catch (error) {
      diasConError++;

      console.error(
        `Error procesando ${fecha}:`
      );

      console.error(
        error.response?.data ||
        error.message ||
        error
      );
    }

    if (index < fechas.length - 1) {
      await esperar(1500);
    }
  }

  console.log("");
  console.log("================================");
  console.log("RESUMEN FINAL");
  console.log("================================");

  console.log(
    JSON.stringify(
      {
        diasProcesados: fechas.length,
        diasConError,
        cuentasExtraidas: totalCuentas,
        filasInsertadas: totalInsertadas,
        filasDuplicadas: totalDuplicadas,
        filasInvalidas: totalInvalidas
      },
      null,
      2
    )
  );

  if (diasConError > 0) {
    throw new Error(
      `La importación terminó con ` +
      `${diasConError} días con error`
    );
  }

  console.log(
    "Importación finalizada correctamente."
  );
}


main().catch(error => {
  console.error("ERROR FINAL:");

  console.error(
    error.response?.data ||
    error.stack ||
    error.message ||
    error
  );

  process.exit(1);
});
