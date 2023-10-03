import client from "prom-client";
import http from "http";
import mqtt from "mqtt";

const metricsServer = http.createServer((__req, res) => {
  res.setHeader("Content-Type", client.register.contentType);
  res.writeHead(200);
  client.register.metrics().then((s) => {
    res.end(s);
  });
});

metricsServer.listen(8080, "0.0.0.0");

const mqttClient = mqtt.connect("mqtt://10.60.1.15:1883");
mqttClient.subscribe("#"); // All

const metrics: { [guageKey: string]: client.Gauge<"room"> } = {};
const metricRooms: [string, string][] = [];
const lastUpdate: { [string: string]: number } = {};

function getMetric(name: string) {
  if (!(name in metrics)) {
    metrics[name] = new client.Gauge({
      name: name,
      help: name,
      labelNames: ["room"] as const,
    });
  }
  return metrics[name]!;
}

function logMetric(name: string, room: string, value: number) {
  getMetric(`mqtt_${name}`).set({ room }, value);
  if (!metricRooms.some((entry) => entry[0] === name && entry[1] === room)) {
    metricRooms.push([name, room]);
  }
  lastUpdate[`mqtt_${name}_${room}`] = new Date().getTime();
}

mqttClient.on("message", (topic, message) => {
  const topicParts = topic.split("/");
  if (topicParts[0] === "ESP32Env" && topicParts.length === 3) {
    const room = topicParts[1]!;
    const name = topicParts[2]!;
    logMetric(name, room, parseFloat(message.toString()));
  }
});

// Remove a metric if we haven't seen an update in this amount of time
const WATCHDOG_INTERVAL = 30_000;

setInterval(() => {
  for (const entry of [...metricRooms]) {
    const name = entry[0];
    const room = entry[1];

    if (
      new Date().getTime() - lastUpdate[`mqtt_${name}_${room}`]! >
      WATCHDOG_INTERVAL
    ) {
      getMetric(`mqtt_${name}`).remove({ room });
      metricRooms.splice(metricRooms.indexOf(entry), 1);
      delete lastUpdate[`mqtt_${name}_${room}`];
    }
  }
}, WATCHDOG_INTERVAL);
