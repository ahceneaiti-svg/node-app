const { Kafka, logLevel } = require('kafkajs');
const nodemailer = require('nodemailer');

const brokers = (process.env.KAFKA_BROKERS || 'localhost:9092').split(',').map((b) => b.trim());
const topic = process.env.KAFKA_TOPIC_USER_CREATED || 'user-created';
const groupId = process.env.KAFKA_GROUP_ID || 'notifier';
const from = process.env.MAIL_FROM || 'no-reply@users-app.local';

const transport = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'localhost',
  port: Number(process.env.SMTP_PORT || 1025),
  secure: process.env.SMTP_SECURE === 'true',
  auth: process.env.SMTP_USER
    ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
    : undefined,
});

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

async function sendWelcome(user) {
  await transport.sendMail({
    from,
    to: user.email,
    subject: 'Bienvenue !',
    text: `Bonjour ${user.name},\n\nVotre compte a bien été créé.\n`,
    html: `<p>Bonjour ${escapeHtml(user.name)},</p><p>Votre compte a bien été créé.</p>`,
  });
}

async function main() {
  const kafka = new Kafka({ clientId: 'notifier', brokers, logLevel: logLevel.WARN });
  const consumer = kafka.consumer({ groupId });
  await consumer.connect();
  await consumer.subscribe({ topic, fromBeginning: true });
  console.log(`notifier prêt (${brokers.join(',')}, topic ${topic}, groupe ${groupId})`);

  await consumer.run({
    // Une exception ici fait rejouer le message (au moins une fois) : l'offset n'est commité qu'après l'envoi.
    eachMessage: async ({ message }) => {
      let user;
      try {
        user = JSON.parse(message.value.toString());
      } catch {
        console.error('message ignoré (JSON invalide)');
        return;
      }
      if (!user.email) {
        console.error('message ignoré (email absent)');
        return;
      }
      await sendWelcome(user);
      console.log(`mail envoyé à ${user.email} (user ${user.id})`);
    },
  });

  const stop = async () => { await consumer.disconnect(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((e) => { console.error(e); process.exit(1); });
