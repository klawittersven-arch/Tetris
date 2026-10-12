/*
 * Verbindung über einen öffentlichen MQTT-Nachrichtenserver (WebSocket).
 * Beamer und Handys sprechen nicht direkt miteinander, sondern schicken sich
 * Nachrichten über den Server – das funktioniert auch in Schulnetzen, die
 * direkte Verbindungen zwischen Geräten blockieren.
 */
(function (root) {
  'use strict';

  // Kostenlose öffentliche Server ohne Anmeldung; der zweite ist die Reserve
  const BROKERS = {
    h: 'wss://broker.hivemq.com:8884/mqtt',
    e: 'wss://broker.emqx.io:8084/mqtt',
  };
  const ORDER = ['h', 'e'];
  const BASE = 'tetris-klassenturnier/v1';

  function brokerUrl(key) {
    return BROKERS[key] || key;
  }

  function topics(room) {
    const r = `${BASE}/${room}`;
    return {
      host: `${r}/h`,                  // Handys -> Beamer
      all: `${r}/a`,                   // Beamer -> alle Handys
      client: id => `${r}/c/${id}`,    // Beamer -> ein Handy
    };
  }

  function connect(url, opts) {
    return root.mqtt.connect(url, Object.assign({
      clientId: 'tk_' + Math.random().toString(36).slice(2, 12),
      clean: true,
      keepalive: 20,
      reconnectPeriod: 2000,
      connectTimeout: 8000,
    }, opts || {}));
  }

  root.TetrisNet = { BROKERS, ORDER, brokerUrl, topics, connect };
})(window);
