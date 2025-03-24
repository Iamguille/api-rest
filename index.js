const express = require('express');
const bodyParser = require('body-parser');
const { create, ev } = require('@wppconnect-team/wppconnect');
const path = require('path');
const os = require('os');

const app = express();
const port = 3000;

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public'))); // Para servir archivos estáticos como el QR

let client; // Almacenará la instancia del cliente de WhatsApp

// Obtener la IP local
function getLocalIP() {
  const ifaces = os.networkInterfaces();
  let localIP = '';
  
  for (const iface in ifaces) {
    for (const ifaceDetails of ifaces[iface]) {
      if (ifaceDetails.family === 'IPv4' && !ifaceDetails.internal) {
        localIP = ifaceDetails.address;
        break;
      }
    }
  }
  
  return localIP;
}

// Iniciar la sesión de WhatsApp
function startWhatsApp() {
  create({
    session: 'mySession', // Nombre de la sesión
    catchQR: (base64Qr) => {
      console.log('Escanea este código QR para iniciar sesión:');
      // Guardar el QR en una ruta accesible para la web
      const fs = require('fs');
      const qrPath = path.join(__dirname, 'public', 'qr.png');
      fs.writeFileSync(qrPath, base64Qr, 'base64');
      console.log('QR guardado en: ' + qrPath);
    },
    statusFind: (statusSession) => {
      console.log('Estado de la sesión:', statusSession);
      if (statusSession === 'isLogged') {
        console.log('Sesión iniciada correctamente');
      } else if (statusSession === 'disconnected') {
        console.log('La sesión se ha desconectado. Intentando reconectar...');
        startWhatsApp(); // Reintentar la conexión automáticamente
      }
    },
    puppeteerOptions: { headless: true }, // Ejecutar en modo sin interfaz gráfica
  })
  .then((wppClient) => {
    client = wppClient;
    console.log('Cliente de WhatsApp listo');
  })
  .catch((err) => {
    console.error('Error al iniciar la sesión:', err);
  });
}

// Llamar a la función para iniciar la sesión
startWhatsApp();

// Endpoint para enviar mensajes
app.post('/send-message', async (req, res) => {
    const { number, message } = req.body;
  
    // Verificar si falta el número o el mensaje
    if (!number) {
      return res.status(400).json({ error: 'El número de teléfono es requerido' });
    }
  
    if (!message) {
      return res.status(400).json({ error: 'El mensaje es requerido' });
    }
  
    try {
      const formattedNumber = `${number}@c.us`; // Formato de número de WhatsApp
      await client.sendText(formattedNumber, message);
      res.json({ success: true, message: 'Mensaje enviado' });
    } catch (error) {
      console.error('Error al enviar el mensaje:', error);
      res.status(500).json({ error: 'Error al enviar el mensaje', details: error });
    }
  });
  
// Página para ver y escanear el QR
app.get('/qr', (req, res) => {
  const localIP = getLocalIP(); // Obtener la IP local
  const serverAddress = req.headers.host || `${localIP}:${port}`; // Obtener el dominio o IP:puerto

  res.send(`
    <html>
      <head><title>Escanea el QR de WhatsApp</title></head>
      <body>
        <h1>Escanea este código QR para iniciar sesión</h1>
        <h2>Api For @Guillermo Ortiz:</h2>
        <img src="/qr.png" alt="QR para escanear" style="width: 300px; height: 300px;"/>
        <p>Si no ves el QR, espera un momento hasta que se genere.</p>
        <h2>Accede a través de esta dirección:</h2>
        <p>Dirección del servidor: <strong>${serverAddress}</strong></p>
      </body>
    </html>
  `);
});

// Iniciar el servidor
app.listen(port, () => {
  console.log(`Servidor REST corriendo en http://localhost:${port}`);
});

