const { Kafka, logLevel } = require('kafkajs');

const brokers = (process.env.KAFKA_BROKERS || '').split(',').map((b) => b.trim()).filter(Boolean);
const topic = process.env.KAFKA_TOPIC_USER_CREATED || 'user-created';

let producer = null;
let connected = false;

// Kafka est optionnel : sans KAFKA_BROKERS l'API fonctionne sans notifications.
// La connexion se fait en arrière-plan : Kafka indisponible ne bloque ni le démarrage ni les requêtes.
async function connect() {
  if (!brokers.length) {
    console.log('Kafka désactivé (KAFKA_BROKERS non défini)');
    return;
  }
  const kafka = new Kafka({
    clientId: 'back-node',
    brokers,
    logLevel: logLevel.NOTHING,
    retry: { retries: 3 },
  });
  producer = kafka.producer({ allowAutoTopicCreation: true });
  producer.on(producer.events.DISCONNECT, () => { connected = false; });
  for (;;) {
    try {
      await producer.connect();
      connected = true;
      console.log(`Kafka prêt (${brokers.join(',')}, topic ${topic})`);
      return;
    } catch (err) {
      console.log(`Kafka indisponible: ${err.message}`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

// Ne lève jamais : un échec Kafka ne doit pas faire échouer la création de l'utilisateur.
async function publishUserCreated(user) {
  if (!producer || !connected) {
    console.error(`Événement non publié (Kafka indisponible), user ${user.id}`);
    return;
  }
  try {
    await producer.send({
      topic,
      messages: [{
        key: String(user.id),
        value: JSON.stringify({
          id: user.id,
          name: user.name,
          email: user.email,
          createdAt: user.created_at,
        }),
      }],
    });
  } catch (err) {
    console.error(`Échec publication Kafka, user ${user.id}: ${err.message}`);
  }
}

module.exports = { connect, publishUserCreated };
