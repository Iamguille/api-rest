const express = require("express");
const {
    default: makeWASocket,
    DisconnectReason,
    useMultiFileAuthState,
    delay,
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const crypto = require("crypto");
require("dotenv").config();

// Inicializar la aplicación Express
const app = express();
const PORT = process.env.PORT || 3000;

// Configuración mejorada del logger
const logger = {
    level: "error",
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: console.warn,
    error: console.error,
    fatal: console.error,
    child: () => logger,
};

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Almacenamiento de sesiones activas
const activeSessions = new Map();

// Función para generar API Key
function generateApiKey() {
    return crypto.randomBytes(16).toString("hex");
}

// Cargar sesiones existentes al iniciar
async function loadExistingSessions() {
    const sessionsDir = "./sessions";
    if (!fs.existsSync(sessionsDir)) {
        fs.mkdirSync(sessionsDir, { recursive: true });
        return;
    }

    const sessionDirs = fs.readdirSync(sessionsDir);
    for (const dir of sessionDirs) {
        const sessionPath = path.join(sessionsDir, dir);
        if (fs.statSync(sessionPath).isDirectory()) {
            try {
                console.log(`Cargando sesión existente: ${dir}`);
                await connectToWhatsApp(dir, true);
            } catch (error) {
                console.error(`Error al cargar sesión ${dir}:`, error);
            }
        }
    }
}

// Función para configurar y conectar el cliente de WhatsApp
async function connectToWhatsApp(apiKey, isReconnecting = false) {
    try {
        const authDir = path.join("./sessions", apiKey);
        if (!fs.existsSync(authDir)) {
            if (isReconnecting) {
                throw new Error("Directorio de sesión no encontrado");
            }
            fs.mkdirSync(authDir, { recursive: true });
        }

        const { state, saveCreds } = await useMultiFileAuthState(authDir);

        const client = makeWASocket({
            printQRInTerminal: true,
            auth: state,
            browser: ["Whatsapp API", "Chrome", "3.0.0"],
            markOnlineOnConnect: true,
            syncFullHistory: false,
            logger: logger,
            getMessage: async () => ({}),
            connectTimeoutMs: 60_000,
            keepAliveIntervalMs: 30_000,
        });

        // Guardar las credenciales cuando hay cambios
        client.ev.on("creds.update", saveCreds);

        // Manejar la conexión
        client.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect, qr } = update;
            const session = activeSessions.get(apiKey) || {};

            if (qr) {
                console.log(`QR Code generado para sesión ${apiKey}`);
                session.qr = qr;
                session.lastActivity = Date.now();
                activeSessions.set(apiKey, session);
            }

            if (connection === "close") {
                const shouldReconnect =
                    lastDisconnect?.error instanceof Boom &&
                    lastDisconnect.error.output.statusCode !==
                        DisconnectReason.loggedOut;

                console.log(
                    `Conexión cerrada para sesión ${apiKey}, reconectando:`,
                    shouldReconnect,
                );

                if (shouldReconnect) {
                    await delay(5000);
                    await connectToWhatsApp(apiKey, true);
                } else {
                    session.connectionReady = false;
                    activeSessions.set(apiKey, session);
                    console.log(
                        `Sesión ${apiKey} cerrada, escanea el código QR nuevamente`,
                    );
                }
            } else if (connection === "open") {
                session.connectionReady = true;
                session.qr = null;
                session.client = client;
                session.lastActivity = Date.now();
                activeSessions.set(apiKey, session);
                console.log(
                    `Conexión establecida con éxito para sesión ${apiKey}`,
                );
            }
        });

        // Almacenar la sesión
        activeSessions.set(apiKey, {
            client,
            qr: null,
            connectionReady: false,
            lastActivity: Date.now(),
        });

        return activeSessions.get(apiKey);
    } catch (error) {
        console.error(
            `Error en la conexión de WhatsApp para sesión ${apiKey}:`,
            error,
        );
        throw error;
    }
}

// Limpiador de sesiones inactivas
setInterval(
    () => {
        const now = Date.now();
        const inactiveThreshold = 24 * 60 * 60 * 1000; // 24 horas de inactividad

        for (const [apiKey, session] of activeSessions.entries()) {
            if (now - session.lastActivity > inactiveThreshold) {
                console.log(`Cerrando sesión inactiva: ${apiKey}`);
                session.client?.end();
                activeSessions.delete(apiKey);

                // Opcional: eliminar directorio de sesión
                const authDir = path.join("./sessions", apiKey);
                if (fs.existsSync(authDir)) {
                    fs.rmSync(authDir, { recursive: true });
                }
            }
        }
    },
    60 * 60 * 1000,
); // Revisar cada hora

// Rutas de la API

// Ruta principal
app.get("/", (req, res) => {
    res.send(
        "API de WhatsApp con Baileys (Multisesión) funcionando correctamente",
    );
});

// Crear nueva sesión o reconectar una existente
app.post("/create-session", async (req, res) => {
    try {
        const { apiKey } = req.body;

        // Si se proporciona una apiKey, intentar reconectar
        if (apiKey) {
            const sessionPath = path.join("./sessions", apiKey);
            if (fs.existsSync(sessionPath)) {
                const session = await connectToWhatsApp(apiKey, true);
                return res.status(200).json({
                    success: true,
                    apiKey,
                    qr: session.qr,
                    message: "Reconectando sesión existente",
                });
            }
        }

        // Crear nueva sesión si no se proporciona apiKey o no existe
        const newApiKey = generateApiKey();
        const session = await connectToWhatsApp(newApiKey);

        res.status(201).json({
            success: true,
            apiKey: newApiKey,
            qr: session.qr,
            message: "Nueva sesión creada. Escanea el código QR para conectar.",
        });
    } catch (error) {
        console.error("Error al crear/reconectar sesión:", error);
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

// Obtener estado de sesión y QR
app.get("/session-status/:apiKey", async (req, res) => {
    try {
        const { apiKey } = req.params;
        let session = activeSessions.get(apiKey);

        // Si no hay sesión activa pero existe el directorio, intentar reconectar
        if (!session && fs.existsSync(path.join("./sessions", apiKey))) {
            try {
                session = await connectToWhatsApp(apiKey, true);
            } catch (error) {
                console.error(`Error al reconectar sesión ${apiKey}:`, error);
            }
        }

        if (!session) {
            return res.status(404).json({ error: "Sesión no encontrada" });
        }

        res.status(200).json({
            status: session.connectionReady ? "conectado" : "desconectado",
            qr: session.qr,
            lastActivity: session.lastActivity,
        });
    } catch (error) {
        console.error("Error al obtener estado de sesión:", error);
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

// Enviar mensaje
app.post("/send-message/:apiKey", async (req, res) => {
    try {
        const { apiKey } = req.params;
        const { number, message } = req.body;

        if (!number || !message) {
            return res
                .status(400)
                .json({ error: "Número y mensaje son obligatorios" });
        }

        let session = activeSessions.get(apiKey);

        // Intentar reconectar si la sesión no está activa pero existe
        if (
            (!session || !session.connectionReady) &&
            fs.existsSync(path.join("./sessions", apiKey))
        ) {
            try {
                session = await connectToWhatsApp(apiKey, true);
            } catch (error) {
                console.error(`Error al reconectar sesión ${apiKey}:`, error);
            }
        }

        if (!session || !session.client) {
            return res.status(404).json({ error: "Sesión no encontrada" });
        }

        if (!session.connectionReady) {
            return res
                .status(503)
                .json({ error: "Cliente de WhatsApp no está conectado" });
        }

        // Formatear el número según los estándares de WhatsApp
        let formattedNumber = number;
        if (!formattedNumber.includes("@")) {
            formattedNumber = `${formattedNumber.replace(/[^\d]/g, "")}@s.whatsapp.net`;
        }

        // Verificar si el número existe en WhatsApp
        const [result] = await session.client.onWhatsApp(formattedNumber);
        if (!result || !result.exists) {
            return res
                .status(404)
                .json({ error: "El número no existe en WhatsApp" });
        }

        // Enviar el mensaje
        const response = await session.client.sendMessage(formattedNumber, {
            text: message,
        });

        // Actualizar última actividad
        session.lastActivity = Date.now();
        activeSessions.set(apiKey, session);

        res.status(200).json({
            success: true,
            message: "Mensaje enviado correctamente",
            details: response,
        });
    } catch (error) {
        console.error("Error al enviar mensaje:", error);
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

// Enviar PDF
app.post("/send-pdf/:apiKey", async (req, res) => {
    try {
        const { apiKey } = req.params;
        const { number, pdfUrl, message } = req.body;

        if (!number || !pdfUrl) {
            return res
                .status(400)
                .json({ error: "Número y URL del PDF son obligatorios" });
        }

        let session = activeSessions.get(apiKey);

        // Intentar reconectar si la sesión no está activa pero existe
        if (
            (!session || !session.connectionReady) &&
            fs.existsSync(path.join("./sessions", apiKey))
        ) {
            try {
                session = await connectToWhatsApp(apiKey, true);
            } catch (error) {
                console.error(`Error al reconectar sesión ${apiKey}:`, error);
            }
        }

        if (!session || !session.client) {
            return res.status(404).json({ error: "Sesión no encontrada" });
        }

        if (!session.connectionReady) {
            return res
                .status(503)
                .json({ error: "Cliente de WhatsApp no está conectado" });
        }

        // Formatear el número
        let formattedNumber = number;
        if (!formattedNumber.includes("@")) {
            formattedNumber = `${formattedNumber.replace(/[^\d]/g, "")}@s.whatsapp.net`;
        }

        // Enviar el PDF
        const response = await session.client.sendMessage(formattedNumber, {
            document: { url: pdfUrl },
            mimetype: "application/pdf",
            fileName: "documento.pdf",
            message: message || "",
        });

        // Actualizar última actividad
        session.lastActivity = Date.now();
        activeSessions.set(apiKey, session);

        res.status(200).json({
            success: true,
            message: "PDF enviado correctamente",
            details: response,
        });
    } catch (error) {
        console.error("Error al enviar PDF:", error);
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

// Cerrar sesión
app.delete("/close-session/:apiKey", async (req, res) => {
    try {
        const { apiKey } = req.params;
        const session = activeSessions.get(apiKey);

        if (!session) {
            return res.status(404).json({ error: "Sesión no encontrada" });
        }

        await session.client.end();
        activeSessions.delete(apiKey);

        res.status(200).json({
            success: true,
            message: "Sesión cerrada correctamente",
        });
    } catch (error) {
        console.error("Error al cerrar sesión:", error);
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

// Iniciar el servidor y cargar sesiones existentes
app.listen(PORT, async () => {
    console.log(
        `Servidor API de WhatsApp (Multisesión) iniciado en el puerto ${PORT}`,
    );

    // Crear directorio de sesiones si no existe
    if (!fs.existsSync("./sessions")) {
        fs.mkdirSync("./sessions", { recursive: true });
    }

    // Cargar sesiones existentes al iniciar
    await loadExistingSessions();
});

// Iniciar el servidor
app.listen(port, () => {
  console.log(`Servidor REST corriendo en http://localhost:${port}`);
});

