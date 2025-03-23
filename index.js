const express = require('express');
const bodyParser = require('body-parser');
const { create, ev } = require('@wppconnect-team/wppconnect');

const app = express();
const port = 3000;

app.use(bodyParser.json());

let client; // Almacenará la instancia del cliente de WhatsApp

// Iniciar la sesión de WhatsApp
create({
    session: 'mySession', // Nombre de la sesión
    catchQR: (base64Qr) => {
        console.log('Escanea este código QR para iniciar sesión:');
        console.log(base64Qr); // Muestra el QR en la consola
    },
    statusFind: (statusSession) => {
        console.log('Estado de la sesión:', statusSession);
        if (statusSession === 'isLogged') {
            console.log('Sesión iniciada correctamente');
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

// Endpoint para enviar mensajes
app.post('/send-message', async (req, res) => {
    const { number, message } = req.body;

    if (!number || !message) {
        return res.status(400).json({ error: 'Número y mensaje son requeridos' });
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

// Iniciar el servidor
app.listen(port, () => {
    console.log(`Servidor REST corriendo en http://localhost:${port}`);
});
